// DSG Call Schedule — sync/snapshot guard regression test (Phase 1)
//
// Loads the REAL config.js (with helpers.js, like the app) into a Node vm
// context and behavior-tests the data-loss safeguards where they live:
//
//   A. payloadLooksWiped() against the two HISTORICAL wipe shapes (dug from
//      git history, not invented):
//        shape 1 — the literal {} blob the original resetAllData wrote
//                  (commit 88e1bba, 2026-04-19: upsert {id:"main", data:{}}
//                  inside an empty catch);
//        shape 2 — the May/June 2026 decay class (config.js "DATA-LOSS
//                  SAFEGUARDS" header): LOAD is permissive, AUTOSAVE was
//                  unconditional, so a transiently-empty render autosaved a
//                  buildStateBundle() full of INIT_* defaults with empty
//                  schedule/vacations/appShifts over the real blob.
//      Plus the documented MUST-SAVE boundaries (clearSchedule keeps
//      vacations/appShifts; the 2026-07-18 digest payload had a real
//      schedule and was correctly NOT treated as a wipe).
//   B. snapshots.capture(): a FAILED source read returns ok:false (the
//      hollow-gate FINDING B fixed in PR #21) — failure must never look
//      like "nothing to snapshot"; genuine empty still skips with ok:true;
//      a failed insert is ok:false; success folds schedule_weeks into the
//      snapshot body.
//   C. snapshots.restore(): refuses empty snapshots, refuses to run without
//      the app's CAS applier, and ABORTS BEFORE ANY WRITE when the
//      before-restore capture fails (asserted on the recorded request log,
//      not just the return value).
//   D. snapshots.captureIfStale(): fresh-skip vs stale-capture, and a failed
//      list() must fail toward CAPTURING, never toward skipping.
//   E. One-shot wipe authorization (allowWipeSaveRef /
//      intentionalScheduleWipeRef) — SOURCE TRIPWIRES ONLY. The grant/
//      consume logic lives inline in the index-source.html component and
//      cannot be behavior-tested from Node without extracting it (that is
//      Phase 2). These tripwires pin the wiring: the gate condition exists
//      at both save paths, consume follows grant, the factory-reset failure
//      path restores the refs, and the counts of grant/consume sites are
//      exact — so deleting or duplicating an authorization site fails CI
//      and forces a deliberate review. If you add a LEGITIMATE site, update
//      the pinned count here in the same PR, with a comment saying why.
//
// Run: node test/sync-guards.js   (exit 0 = pass, 1 = regression)
// CI runs this on every push alongside the generator regression test.
// Do NOT weaken these assertions to make a failing guard change pass.

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

// ─── Load the real app modules as browser globals ───
const sandbox = {
  console,
  window: {},
  document: undefined,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  // Each test installs its own stub via setFetch(); anything that fetches
  // before that is a bug in the test.
  fetch: () => { throw new Error("fetch called before a stub was installed"); },
  navigator: { userAgent: "node-test" },
  setTimeout, clearTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ["helpers.js", "config.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
}
const app = vm.runInContext("({ payloadLooksWiped, snapshots, INIT_SURGEONS, INIT_APPS, holidayRate })", sandbox);
const { payloadLooksWiped, snapshots, INIT_SURGEONS, INIT_APPS, holidayRate } = app;
if (typeof payloadLooksWiped !== "function" || !snapshots) {
  console.error("FAIL: guards not found after loading config.js");
  process.exit(1);
}
const setFetch = (fn) => { sandbox.fetch = fn; };

// ─── Tiny check harness (mirrors generator-regression.js conventions) ───
const failures = [];
let checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log(`  ✓ ${name}`); }
  else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); failures.push(name); }
}

// ─── Fetch stub: ordered routes + a full request log ───
// route: { m: "GET"|"POST"|..., url: substring, status, json, throw: Error }
function stubFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ url: String(url), method, body: opts.body });
    for (const r of routes) {
      if (method === (r.m || "GET") && String(url).includes(r.url)) {
        if (r.throw) throw r.throw;
        const status = r.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => r.json,
          text: async () => (r.text !== undefined ? r.text : JSON.stringify(r.json ?? "")),
        };
      }
    }
    throw new Error(`fetch stub: unmatched ${method} ${url}`);
  };
  fn.calls = calls;
  setFetch(fn);
  return fn;
}
const writesIn = (fn) => fn.calls.filter(c => c.method !== "GET");

// ══════════════════════════════════════════════════════════════
// A. payloadLooksWiped — historical wipe shapes + must-save boundaries
// ══════════════════════════════════════════════════════════════
console.log("\nA. payloadLooksWiped");

// Historical shape 1 — the literal {} blob (original resetAllData, commit
// 88e1bba 2026-04-19: `upsert({ id: "main", data: {}, ... })` in an empty
// catch). This is the exact object that hit the DB.
check("shape 1: literal {} (old Reset button blob) → wiped", payloadLooksWiped({}) === true);

// Historical shape 2 — May/June 2026 transient-empty autosave: a full
// buildStateBundle() where the defaults are all "present" (roster, counts,
// period settings) but every piece of operational data is empty. Mirrors
// index-source.html buildStateBundle()'s keys — if that shape changes, update
// this mirror in the same PR.
const transientEmptyAutosave = {
  surgeons: INIT_SURGEONS, apps: INIT_APPS,
  vacations: {}, noCallDays: {},
  backupMondays: [], fierceBackup: [],
  schedule: {}, priorCounts: {}, year1Counts: {},
  startMonth: 4, startYear: 2026, numWeeks: 14,
  holidayAssignments: {}, startMondayOverride: null, pendingLocks: {},
};
check("shape 2: defaults-only autosave (May/June 2026 decay) → wiped",
  payloadLooksWiped(transientEmptyAutosave) === true);

check("null → wiped", payloadLooksWiped(null) === true);
check("non-object → wiped", payloadLooksWiped("x") === true);

const WEEK = { dayCall: "s1", mon: "s2", tue: "s3", wed: "s4", thu: "s5", wknd: "s6" };
check("real schedule → NOT wiped",
  payloadLooksWiped({ ...transientEmptyAutosave, schedule: { "2026-01-05": WEEK } }) === false);

// clearSchedule keeps vacations/appShifts — a legitimate clear MUST save
// (documented on the function itself; a guard that blocks it breaks the app).
check("clearSchedule shape (empty schedule, real vacations) → NOT wiped",
  payloadLooksWiped({ ...transientEmptyAutosave, vacations: { s5: [["2026-09-12", "2026-09-21"]] } }) === false);
check("appShifts-only payload → NOT wiped",
  payloadLooksWiped({ ...transientEmptyAutosave, appShifts: { "2026-01-05": { day: "a1" } } }) === false);

// 2026-07-18 digest-incident boundary: that payload carried a REAL schedule
// with an empty vacations mirror — correctly NOT a wipe (the guard letting it
// save was right; the poisonable mirror itself was retired in PR #18).
check("digest-incident shape (real schedule, empty vacations) → NOT wiped",
  payloadLooksWiped({ ...transientEmptyAutosave, schedule: { "2026-07-13": WEEK } }) === false);

// ── Why the state bundle KEEPS schedule/vacations/noCallDays ──
// The blob write paths strip all three before the upsert, which makes them
// look like removable write-only mirrors. They are not: this predicate reads
// bundle.schedule/.vacations, so a bundle stripped of them classifies as
// wiped — real data may sit safely in schedule_weeks/time_off, but every
// autosave would hit the empty-save gate and ALL saves (blob AND
// schedule_weeks, whose sync call sits behind the same gate) would block,
// silently, forever. This check pins that failure by construction — it is
// the recorded reason the 2026-08-08 mirror-retirement idea was cancelled.
// (A dataCounts-marker guard that lifts this dependency was built, verified,
// and PARKED with that cancellation — see REMAINING-WORK.)
const mirrorStripped = { ...transientEmptyAutosave };
delete mirrorStripped.schedule;
delete mirrorStripped.vacations;
delete mirrorStripped.noCallDays;
check("bundle stripped of the mirror keys → wiped (why the keys must stay in the bundle)",
  payloadLooksWiped(mirrorStripped) === true);

// Sections B–E are async (stubbed fetch); a harness crash is a FAILURE, not
// a silent exit — the catch at the bottom exits 1.
(async function main() {

// ══════════════════════════════════════════════════════════════
// B. snapshots.capture — failure ≠ empty (PR #21 FINDING B regression)
// ══════════════════════════════════════════════════════════════
console.log("\nB. snapshots.capture");
const REAL_BLOB = { surgeons: INIT_SURGEONS, vacations: { s5: [["2026-09-12", "2026-09-21"]] } };
const BLOB_ROW = [{ data: REAL_BLOB, updated_at: "2026-07-30T12:00:00Z" }];
const WEEK_ROWS = [{ week_monday: "2026-01-05", data: WEEK }];
// Real time_off columns (person_id/kind/start_date/end_date/id — NOT
// surgeon_id/type): a wrong-column fixture here would fail the fold-content
// assertion against CORRECT code.
const TIME_OFF_ROWS = [
  { id: 11, person_id: "s5", kind: "vacation", start_date: "2026-09-12", end_date: "2026-09-21" },
  { id: 12, person_id: "s3", kind: "nocall",   start_date: "2026-09-14", end_date: "2026-09-14" },
];

await (async () => {
  // 1. Failed source read → ok:false. Pre-PR#21 this returned {ok:true,
  //    skipped} and the capture-failure-BLOCKS-the-action gate was hollow.
  let f = stubFetch([{ m: "GET", url: "call_schedule_data", status: 500, text: "boom" }]);
  let r = await snapshots.capture("test");
  check("failed source read (500) → ok:false", r.ok === false, JSON.stringify(r));
  check("failed source read → no insert attempted", writesIn(f).length === 0);

  // 2. Network throw → ok:false.
  stubFetch([{ m: "GET", url: "call_schedule_data", throw: new TypeError("Failed to fetch") }]);
  r = await snapshots.capture("test");
  check("source read network throw → ok:false", r.ok === false);

  // 3. Genuine empty (200 + no row, schedule_weeks AND time_off empty) →
  //    ok:true skipped — an empty DB must NOT block a legitimate reset.
  f = stubFetch([
    { m: "GET", url: "call_schedule_data", json: [] },
    { m: "GET", url: "schedule_weeks", json: [] },
    { m: "GET", url: "time_off", json: [] },
  ]);
  r = await snapshots.capture("test");
  check("genuine empty (200+[]) → ok:true, skipped", r.ok === true && r.skipped === "empty_or_missing", JSON.stringify(r));
  check("genuine empty → nothing written", writesIn(f).length === 0);

  // 4. Success: real blob + schedule_weeks + time_off → insert carries
  //    reason, BOTH folds, and source_updated_at.
  f = stubFetch([
    { m: "GET", url: "call_schedule_data", json: BLOB_ROW },
    { m: "GET", url: "schedule_weeks", json: WEEK_ROWS },
    { m: "GET", url: "time_off", json: TIME_OFF_ROWS },
    { m: "POST", url: "call_schedule_snapshots", status: 201, json: [] },
  ]);
  r = await snapshots.capture("unit_test");
  const ins = writesIn(f)[0];
  const insBody = ins ? JSON.parse(ins.body) : null;
  check("real data → ok:true", r.ok === true, JSON.stringify(r));
  check("snapshot insert body: reason + source_updated_at",
    insBody && insBody.reason === "unit_test" && insBody.source_updated_at === "2026-07-30T12:00:00Z");
  check("snapshot insert body: schedule_weeks folded into data.schedule",
    insBody && insBody.data && insBody.data.schedule && insBody.data.schedule["2026-01-05"] && insBody.data.schedule["2026-01-05"].dayCall === "s1");
  // Request-log proof the time_off fetch actually FIRED: the fold is
  // best-effort, so a broken wiring (e.g. buildTimeOffMaps missing at
  // config.js top level) would be swallowed by its catch and every other
  // check would still pass — this is the assertion that catches it.
  check("capture fetched time_off (request log)",
    f.calls.some(c => c.method === "GET" && c.url.includes("time_off")));
  check("snapshot insert body: time_off folded into data.vacations/noCallDays",
    insBody && insBody.data &&
    insBody.data.vacations && Array.isArray(insBody.data.vacations.s5) &&
    insBody.data.vacations.s5[0] && insBody.data.vacations.s5[0][0] === "2026-09-12" && insBody.data.vacations.s5[0][1] === "2026-09-21" &&
    insBody.data.noCallDays && Array.isArray(insBody.data.noCallDays.s3) &&
    insBody.data.noCallDays.s3[0] && insBody.data.noCallDays.s3[0][0] === "2026-09-14",
    ins ? ins.body.slice(0, 300) : "no insert");

  // 5. Insert failure → ok:false (a snapshot that wasn't written must not
  //    report ok — that's the same hollow-gate class as FINDING B).
  stubFetch([
    { m: "GET", url: "call_schedule_data", json: BLOB_ROW },
    { m: "GET", url: "schedule_weeks", json: WEEK_ROWS },
    { m: "GET", url: "time_off", json: TIME_OFF_ROWS },
    { m: "POST", url: "call_schedule_snapshots", status: 401, text: "jwt expired" },
  ]);
  r = await snapshots.capture("test");
  check("failed insert (401) → ok:false", r.ok === false, JSON.stringify(r));

  // 6. schedule_weeks read fails but blob is real → best-effort: still
  //    snapshots the blob (documented behavior). time_off succeeds here so
  //    the check isolates the schedule_weeks failure.
  f = stubFetch([
    { m: "GET", url: "call_schedule_data", json: BLOB_ROW },
    { m: "GET", url: "schedule_weeks", status: 500, text: "boom" },
    { m: "GET", url: "time_off", json: [] },
    { m: "POST", url: "call_schedule_snapshots", status: 201, json: [] },
  ]);
  r = await snapshots.capture("test");
  check("schedule_weeks fetch fails, blob real → still ok:true (best-effort)", r.ok === true);

  // 7. time_off read fails but blob is real → same best-effort contract,
  //    symmetric with 6.
  f = stubFetch([
    { m: "GET", url: "call_schedule_data", json: BLOB_ROW },
    { m: "GET", url: "schedule_weeks", json: WEEK_ROWS },
    { m: "GET", url: "time_off", status: 500, text: "boom" },
    { m: "POST", url: "call_schedule_snapshots", status: 201, json: [] },
  ]);
  r = await snapshots.capture("test");
  check("time_off fetch fails, blob real → still ok:true (best-effort)", r.ok === true, JSON.stringify(r));
})();

// ══════════════════════════════════════════════════════════════
// C. snapshots.restore — refuses empty; capture-failure BLOCKS; CAS-only
// ══════════════════════════════════════════════════════════════
console.log("\nC. snapshots.restore");
const GOOD_SNAP = [{ id: 7, reason: "manual", created_at: "2026-07-29T00:00:00Z",
  data: { surgeons: INIT_SURGEONS, vacations: { s5: [["2026-09-12", "2026-09-21"]] }, schedule: { "2026-01-05": WEEK } } }];
const snapUrl = "call_schedule_snapshots?id=eq.";

await (async () => {
  const noop = async () => ({ ok: true });

  let r = await snapshots.restore(null, noop);
  check("no snapshot id → ok:false", r.ok === false);

  r = await snapshots.restore(7, undefined);
  check("no applySchedule fn → ok:false (refuses to bypass the CAS path)",
    r.ok === false && /refusing to bypass/.test(r.error || ""), JSON.stringify(r));

  stubFetch([{ m: "GET", url: snapUrl, status: 500, text: "boom" }]);
  r = await snapshots.restore(7, noop);
  check("snapshot fetch failure → ok:false", r.ok === false);

  stubFetch([{ m: "GET", url: snapUrl, json: [] }]);
  r = await snapshots.restore(7, noop);
  check("snapshot not found (200+[]) → ok:false", r.ok === false);

  // Restore-refuses-empty: BOTH historical wipe shapes as snapshot bodies.
  for (const [label, wiped] of [["{} snapshot", {}], ["defaults-only snapshot", transientEmptyAutosave]]) {
    let f = stubFetch([{ m: "GET", url: snapUrl, json: [{ id: 7, reason: "x", created_at: "c", data: wiped }] }]);
    let applied = 0;
    r = await snapshots.restore(7, async () => { applied++; return { ok: true }; });
    check(`restore refuses empty (${label}) → ok:false`,
      r.ok === false && /looks empty/.test(r.error || ""), JSON.stringify(r));
    check(`restore refuses empty (${label}) → zero writes, applier never called`,
      writesIn(f).length === 0 && applied === 0);
  }

  // Capture-failure-BLOCKS-restore: good snapshot, before_restore capture
  // fails → abort with NOTHING written and the applier never called.
  let f = stubFetch([
    { m: "GET", url: snapUrl, json: GOOD_SNAP },
    { m: "GET", url: "call_schedule_data", status: 500, text: "boom" }, // pre-capture source read fails
  ]);
  let applied = 0;
  r = await snapshots.restore(7, async () => { applied++; return { ok: true }; });
  check("pre-restore capture fails → ok:false, restore aborted",
    r.ok === false && /aborted/.test(r.error || ""), JSON.stringify(r));
  check("pre-restore capture fails → ZERO writes issued, applier never called",
    writesIn(f).length === 0 && applied === 0,
    `writes=${JSON.stringify(writesIn(f).map(c => c.url))} applied=${applied}`);

  // Fold-failed snapshot (a capture whose table folds BOTH failed is
  // blob-only: config keys, no schedule, no vacations). Nothing restorable
  // is inside — restore must REFUSE on content, or the applier would run
  // with wipe authorization armed on an empty schedule and delete every
  // schedule_weeks row.
  f = stubFetch([{ m: "GET", url: snapUrl, json: [{ id: 7, reason: "x", created_at: "c",
    data: { surgeons: INIT_SURGEONS, backupMondays: ["2026-05-25"], numWeeks: 14 } }] }]);
  applied = 0;
  r = await snapshots.restore(7, async () => { applied++; return { ok: true }; });
  check("fold-failed (blob-only) snapshot → REFUSED on content",
    r.ok === false && /looks empty/.test(r.error || "") && applied === 0 && writesIn(f).length === 0,
    JSON.stringify(r));

  // Blob write fails → ok:false and the schedule applier is never reached.
  f = stubFetch([
    { m: "GET", url: snapUrl, json: GOOD_SNAP },
    { m: "GET", url: "call_schedule_data", json: BLOB_ROW },
    { m: "GET", url: "schedule_weeks", json: WEEK_ROWS },
    { m: "GET", url: "time_off", json: [] },
    { m: "POST", url: "call_schedule_snapshots", status: 201, json: [] },
    { m: "POST", url: "call_schedule_data", status: 401, text: "jwt expired" },
  ]);
  applied = 0;
  r = await snapshots.restore(7, async () => { applied++; return { ok: true }; });
  check("blob write fails → ok:false, applier never called", r.ok === false && applied === 0, JSON.stringify(r));

  // applySchedule failure is reported, with blobRestored flagged.
  stubFetch([
    { m: "GET", url: snapUrl, json: GOOD_SNAP },
    { m: "GET", url: "call_schedule_data", json: BLOB_ROW },
    { m: "GET", url: "schedule_weeks", json: WEEK_ROWS },
    { m: "GET", url: "time_off", json: [] },
    { m: "POST", url: "call_schedule_snapshots", status: 201, json: [] },
    { m: "POST", url: "call_schedule_data", status: 201, json: [] },
  ]);
  r = await snapshots.restore(7, async () => ({ ok: false, error: "CAS conflict" }));
  check("applier failure → ok:false + blobRestored:true",
    r.ok === false && r.blobRestored === true && /CAS conflict/.test(r.error || ""), JSON.stringify(r));

  // Full success: pre-capture ok → blob written WITHOUT schedule key →
  // applier called with the snapshot's schedule.
  f = stubFetch([
    { m: "GET", url: snapUrl, json: GOOD_SNAP },
    { m: "GET", url: "call_schedule_data", json: BLOB_ROW },
    { m: "GET", url: "schedule_weeks", json: WEEK_ROWS },
    { m: "GET", url: "time_off", json: [] },
    { m: "POST", url: "call_schedule_snapshots", status: 201, json: [] },
    { m: "POST", url: "call_schedule_data", status: 201, json: [] },
  ]);
  let appliedSchedule = null;
  r = await snapshots.restore(7, async (s) => { appliedSchedule = s; return { ok: true }; });
  const blobWrite = writesIn(f).find(c => c.url.includes("call_schedule_data"));
  const blobBody = blobWrite ? JSON.parse(blobWrite.body) : null;
  check("success → ok:true", r.ok === true, JSON.stringify(r));
  check("success → blob written without schedule key (schedule goes via CAS applier)",
    blobBody && blobBody.data && !("schedule" in blobBody.data));
  check("success → applier received the snapshot's schedule",
    appliedSchedule && appliedSchedule["2026-01-05"] && appliedSchedule["2026-01-05"].dayCall === "s1");
})();

// ══════════════════════════════════════════════════════════════
// D. captureIfStale — a failed list() must fail toward CAPTURING
// ══════════════════════════════════════════════════════════════
console.log("\nD. snapshots.captureIfStale");
await (async () => {
  // Fresh newest snapshot → skip without touching capture.
  let f = stubFetch([
    { m: "GET", url: "call_schedule_snapshots?select=", json: [{ created_at: new Date().toISOString() }] },
  ]);
  let r = await snapshots.captureIfStale("periodic", 6);
  check("newest < maxAge → ok:true, skipped:fresh", r.ok === true && r.skipped === "fresh", JSON.stringify(r));
  check("fresh skip → nothing written", writesIn(f).length === 0);

  // Stale newest → capture path runs.
  stubFetch([
    { m: "GET", url: "call_schedule_snapshots?select=", json: [{ created_at: "2026-01-01T00:00:00Z" }] },
    { m: "GET", url: "call_schedule_data", json: BLOB_ROW },
    { m: "GET", url: "schedule_weeks", json: WEEK_ROWS },
    { m: "GET", url: "time_off", json: [] },
    { m: "POST", url: "call_schedule_snapshots", status: 201, json: [] },
  ]);
  r = await snapshots.captureIfStale("periodic", 6);
  check("stale newest → capture runs, ok:true", r.ok === true && !r.skipped, JSON.stringify(r));

  // list() failure (returns null) must NOT read as "fresh" — it proceeds to
  // capture (fail toward more backups, never fewer).
  stubFetch([
    { m: "GET", url: "call_schedule_snapshots?select=", status: 500, text: "boom" },
    { m: "GET", url: "call_schedule_data", json: BLOB_ROW },
    { m: "GET", url: "schedule_weeks", json: WEEK_ROWS },
    { m: "GET", url: "time_off", json: [] },
    { m: "POST", url: "call_schedule_snapshots", status: 201, json: [] },
  ]);
  r = await snapshots.captureIfStale("periodic", 6);
  check("list() fails → still attempts capture (fails toward capturing)", r.ok === true && !r.skipped, JSON.stringify(r));
})();

// ══════════════════════════════════════════════════════════════
// E. One-shot wipe authorization — SOURCE TRIPWIRES (behavior = Phase 2)
// ══════════════════════════════════════════════════════════════
console.log("\nE. one-shot wipe authorization (source tripwires on index-source.html)");
const src = fs.readFileSync(path.join(ROOT, "index-source.html"), "utf8");
const count = (needle) => src.split(needle).length - 1;

// The empty-save gate must guard BOTH blob save paths (debounced autosave +
// the immediate flush path). Exactly 2 — a third path means a new save site
// that must consciously adopt the guard.
const GATE = "payloadLooksWiped(payload) && everHadRealDataRef.current && !allowWipeSaveRef.current";
check("empty-save gate present at exactly 2 save paths", count(GATE) === 2, `found ${count(GATE)}`);

// Exactly ONE grant site (factory reset). A new `= true` site is a new wipe
// authorization — the tripwire forces that to be a reviewed decision.
check("allowWipeSaveRef granted at exactly 1 site", count("allowWipeSaveRef.current = true") === 1,
  `found ${count("allowWipeSaveRef.current = true")}`);

// Consume sites: the post-gate consume + the factory-reset failure restore.
check("allowWipeSaveRef cleared at exactly 2 sites (consume + failure-restore)",
  count("allowWipeSaveRef.current = false") === 2, `found ${count("allowWipeSaveRef.current = false")}`);

// The consume must come AFTER the gate in the autosave body — a consume
// before the gate would let a blocked save eat the authorization.
check("consume follows the gate (order)", src.indexOf(GATE) < src.indexOf("allowWipeSaveRef.current = false"));

// Factory-reset FAILURE must restore the refs (PR #23): the adjacent
// disarm-undo pair after the single grant site.
const grantIdx = src.indexOf("allowWipeSaveRef.current = true");
const restorePair = /allowWipeSaveRef\.current = false;[\s\S]{0,200}everHadRealDataRef\.current = true;/;
check("factory-reset failure path restores the guard refs (adjacent pair)",
  restorePair.test(src.slice(grantIdx)), "expected `= false` then everHadRealDataRef `= true` after the grant");

// year2Counts stays retired (2026-08-06): the setter must never be
// reintroduced. Deliberately counts `setYear2Counts` — NOT the bare
// `year2Counts` substring — so the retirement tombstone COMMENTS (which
// name the identifier for future readers) can never flip this check.
check("year2Counts stays retired (no setYear2Counts in source)",
  count("setYear2Counts") === 0, `found ${count("setYear2Counts")}`);

// Restore honesty (2026-08-08): snapshots now CONTAIN vacations/no-call
// (the capture time_off fold) but restore deliberately does NOT write them
// back to time_off. That half-capability must be stated to the person
// restoring — in the confirm dialog AND the post-restore report — never
// discovered later. Pins the exact caveat phrase at both surfaces.
check("restore states the time-off caveat at both surfaces (confirm + report)",
  count("re-entered or recovered manually") === 2, `found ${count("re-entered or recovered manually")}`);

// intentionalScheduleWipeRef (the schedule_weeks full-delete authorization):
// gate present; the grant census NAMES its three sites so a future fourth
// grant without a matching disarm fails loudly rather than arithmetically.
check("schedule-wipe gate present", count("!intentionalScheduleWipeRef.current") >= 1);
check("intentionalScheduleWipeRef granted at exactly the 3 known sites: clearSchedule, factory reset, restore applier — a 4th grant needs its own disarm story AND this census updated",
  count("intentionalScheduleWipeRef.current = true") === 3, `found ${count("intentionalScheduleWipeRef.current = true")}`);
check("intentionalScheduleWipeRef consumed at exactly 2 sites (unconditional syncSchedWeeks consume + restore's finally)",
  count("intentionalScheduleWipeRef.current = false") === 2, `found ${count("intentionalScheduleWipeRef.current = false")}`);

// BEHAVIOR: the empty-reset dangle (fixed 2026-08-08). The consume used to be
// conditional on (wipingAll || wipingMost); wipingAll needs baseCount > 0, so
// reset/clear against an ALREADY-EMPTY schedule left the ref armed — silently
// pre-authorizing the next accidental wipe-shaped call. Extract the REAL
// syncSchedWeeks from the component source and drive that exact case:
// prev = {}, currentSchedule = {}, ref armed → the ref must read false after,
// with zero network traffic. A source pin cannot catch a future early return
// added above the consume; executing the function catches it by construction.
await (async () => {
  const nsrc = src.replace(/\r\n/g, "\n");
  const START = "const syncSchedWeeks = async (currentSchedule) => {";
  const END = `catch (e) { console.error("schedule_weeks dual-write error", e); showToast("Couldn't save schedule changes — check your connection.", "error"); }
  };`;
  const s = nsrc.indexOf(START), e = nsrc.indexOf(END);
  if (s === -1 || e === -1) { check("syncSchedWeeks extractable for execution", false, "anchors not found"); return; }
  const fnSrc = nsrc.slice(s, e + END.length);
  let h;
  try {
    h = vm.runInContext(`(function(){
      const SCHED_DUAL_WRITE = false, SCHED_READ_TABLE = true;
      const SUPABASE_URL = "https://stub.invalid";
      const dbAuthHeaders = () => ({});
      const schedWeeksSyncRef = { current: {} };          // prev = {} (empty table baseline)
      const schedWeekVersionsRef = { current: {} };
      const intentionalScheduleWipeRef = { current: true }; // ARMED — the dangle setup
      const userProfile = null;
      const netCalls = [];
      const fetch = (...a) => { netCalls.push(a); throw new Error("unexpected network in {}->{} scenario"); };
      const setSaveError = () => {}, setSaveStatus = () => {}, setSchedule = () => {}, showToast = () => {};
      const loadSchedFromTable = async () => null;
      ${fnSrc}
      return { syncSchedWeeks, intentionalScheduleWipeRef, netCalls };
    })()`, sandbox);
  } catch (ex) { check("syncSchedWeeks compiles standalone", false, String(ex)); return; }
  await h.syncSchedWeeks({});
  check("empty reset consumes the wipe authorization (prev {} → current {}, ref armed → false)",
    h.intentionalScheduleWipeRef.current === false,
    `ref still ${JSON.stringify(h.intentionalScheduleWipeRef.current)} after syncSchedWeeks({}) on an empty baseline`);
  check("the {}→{} scenario issues ZERO network calls", h.netCalls.length === 0,
    `unexpected calls: ${h.netCalls.length}`);
})();

// ══════════════════════════════════════════════════════════════
// E2. Member session: blob leg gated, weeks leg NEVER coupled to it
// ══════════════════════════════════════════════════════════════
// The 2026-08-17 incident. call_schedule_data / call_schedule_config are
// scheduler-only at the DB (is_scheduler_or_admin() = role IN
// ('scheduler','admin')); the client attempted both from every session.
// Members got a 403 every 60s (loadTimeOff allocates fresh maps on each poll,
// dirtying the autosave deps in a session where the user touched nothing).
// WORSE: the blob upsert THREW, so syncSchedWeeks — the only steady-state
// writer of schedule_weeks — never ran. A member's two-way swap or trade
// acceptance was applied in the UI, reported "Save failed", and never reached
// the database. These checks pin BOTH halves of the fix.
console.log("\nE2. member blob gating + leg decoupling");

// ── The headline regression test, executed on the REAL autosave body ──
// Extract the debounced save callback and run it with a member context whose
// blob write is denied. The weeks leg MUST still fire.
await (async () => {
  const nsrc = src.replace(/\r\n/g, "\n");
  const START = "      allowWipeSaveRef.current = false; // consume one-shot bypass";
  const END = "    }, 800);";
  const s = nsrc.indexOf(START), e = nsrc.indexOf(END, s);
  if (s === -1 || e === -1) { check("autosave save-body extractable", false, "anchors not found"); return; }
  const bodySrc = nsrc.slice(s, e);

  const run = async (canWrite, blobOutcome) => {
    const harness = vm.runInContext(`(function(){
      return async function(canWriteBlob, blobOutcome){
        const calls = { weeks: 0, blob: 0, toasts: [], status: [] };
        const payload = { schedule: { "2026-08-17": { dayCall: "s1" } }, surgeons: [1] };
        const allowWipeSaveRef = { current: false };
        const everHadRealDataRef = { current: true };
        const pendingSaveRef = { current: payload };
        const lastSyncRef = { current: null };
        const payloadLooksWiped = () => false;
        const syncSchedWeeks = () => { calls.weeks++; };
        const supabase = { from: () => ({ upsert: async () => { calls.blob++; return blobOutcome; } }) };
        const setSaveError = () => {};
        const setSaveStatus = (s) => { calls.status.push(s); };
        const showToast = (m) => { calls.toasts.push(String(m)); };
        // The extracted body contains bare \`return\` statements (empty-save
        // guard, the blob gate). Run it inside its own function so those exit
        // only the body, and the recorder still comes back.
        await (async () => {
          ${bodySrc}
        })();
        return calls;
      };
    })()`, sandbox);
    return harness(canWrite, blobOutcome);
  };

  const denial = { error: '{"code":"42501","message":"new row violates row-level security policy for table \\"call_schedule_data\\""}' };

  // 1. MEMBER: blob leg must not be attempted at all; weeks leg must fire.
  const member = await run(false, denial);
  check("member: schedule_weeks write STILL happens (the data-loss regression test)",
    member.weeks === 1, `weeks writes = ${member.weeks}`);
  check("member: ZERO blob write attempts", member.blob === 0);
  check("member: no save-failure toast, no red status churn",
    member.toasts.length === 0 && member.status.length === 0,
    `toasts=${JSON.stringify(member.toasts)} status=${JSON.stringify(member.status)}`);

  // 2. SCHEDULER whose blob write FAILS: weeks leg must STILL fire (the
  //    coupling also bit schedulers on any transient 5xx).
  const schedFail = await run(true, { error: "500 upstream boom" });
  check("scheduler + failed blob: weeks leg still fired (decoupled both directions)",
    schedFail.weeks === 1, `weeks writes = ${schedFail.weeks}`);
  check("scheduler + failed blob: connection toast (not a permissions one)",
    schedFail.toasts.some(t => /check your connection/.test(t)));

  // 3. SCHEDULER, blob DENIED by RLS: must read as permissions, never as
  //    "retrying" (nothing retries on a timer) and never as connectivity.
  const schedDenied = await run(true, denial);
  check("RLS denial classified as permissions (body 42501, not status code)",
    schedDenied.toasts.some(t => /permission/i.test(t)) &&
    !schedDenied.toasts.some(t => /check your connection/.test(t)),
    JSON.stringify(schedDenied.toasts));
  check("RLS denial never renders 'Save failed — retrying…'",
    !schedDenied.status.some(s => /retrying/.test(s)), JSON.stringify(schedDenied.status));

  // 4. SCHEDULER, blob OK: unchanged happy path.
  const schedOk = await run(true, { error: null });
  check("scheduler + blob OK: both legs fire, status 'Saved'",
    schedOk.weeks === 1 && schedOk.status.includes("Saved"));
})();

// ── Baseline-ref invariant: now load-bearing ──
// With syncSchedWeeks running in member sessions, the only thing stopping
// every member's phone from echo-writing the table on every adopted foreign
// change is that the adoption sites update schedWeeksSyncRef alongside
// setSchedule. Execute the REAL syncSchedWeeks with state == baseline.
await (async () => {
  const nsrc = src.replace(/\r\n/g, "\n");
  const START = "const syncSchedWeeks = async (currentSchedule) => {";
  const END = `catch (e) { console.error("schedule_weeks dual-write error", e); showToast("Couldn't save schedule changes — check your connection.", "error"); }
  };`;
  const s = nsrc.indexOf(START), e = nsrc.indexOf(END);
  if (s === -1 || e === -1) { check("syncSchedWeeks extractable (adoption test)", false, "anchors not found"); return; }
  const fnSrc = nsrc.slice(s, e + END.length);
  const adopted = { "2026-08-17": { dayCall: "s1", nights: { mon: "s2" } } };
  const h = vm.runInContext(`(function(){
    const SCHED_DUAL_WRITE = false, SCHED_READ_TABLE = true;
    const SUPABASE_URL = "https://stub.invalid";
    const dbAuthHeaders = () => ({});
    const adopted = ${JSON.stringify(adopted)};
    // Exactly what the realtime handler does: state AND baseline updated together.
    const schedWeeksSyncRef = { current: JSON.parse(JSON.stringify(adopted)) };
    const schedWeekVersionsRef = { current: { "2026-08-17": 3 } };
    const intentionalScheduleWipeRef = { current: false };
    const userProfile = { person_id: "s7" };   // a MEMBER
    const netCalls = [];
    const fetch = (...a) => { netCalls.push(a[0]); throw new Error("no network expected"); };
    const setSaveError = () => {}, setSaveStatus = () => {}, setSchedule = () => {}, showToast = () => {};
    const loadSchedFromTable = async () => null;
    ${fnSrc}
    return { syncSchedWeeks, netCalls, adopted };
  })()`, sandbox);
  await h.syncSchedWeeks(h.adopted);
  check("adopted foreign schedule state produces ZERO schedule_weeks writes in a member session",
    h.netCalls.length === 0, `unexpected requests: ${JSON.stringify(h.netCalls)}`);
})();

// Source pins: the gate exists, mirrors the DB predicate, and is applied at
// all three write sites (autosave blob leg, keepalive blob leg, edge-URL).
check("canWriteBlob defined once, mirroring is_scheduler_or_admin()",
  count("const canWriteBlob = isScheduler;") === 1);
check("blob gate applied at exactly 3 sites (autosave, keepalive flush, edge-URL)",
  count("if (!canWriteBlob) return;") === 3, `found ${count("if (!canWriteBlob) return;")}`);
check("weeks leg runs BEFORE the blob gate (decoupling is structural, not incidental)",
  src.replace(/\r\n/g, "\n").indexOf("syncSchedWeeks(payload.schedule);") <
  src.replace(/\r\n/g, "\n").indexOf("if (!canWriteBlob) return;"));

// ══════════════════════════════════════════════════════════════
// F. Christmas standing rule (2026-08-06): FAK covers Eve + Day, capped
// ══════════════════════════════════════════════════════════════
console.log("\nF. Christmas standing rule");

// Tripwires: the lock and its LOUD failure branch must exist. The old code
// was gated `&& fakId` — a failed name lookup silently dissolved the lock
// into the normal rotation (the wipe-guard silent-degradation shape).
check("Christmas lock block present", count('if (hol.name === "Christmas Day") {') >= 1);
check("Christmas lock has a loud failure branch (unresolvable designated surgeon)",
  count('Christmas lock: designated surgeon') >= 1);
check("two-day coverage cap present",
  count('if (hol.name === "Christmas Day" && sA === sB) return coverage;') === 1);
check("lifetimeCt dedupes collapsed pairs",
  count("h.surgeonB && h.surgeonB !== h.surgeonA") === 1);

// BEHAVIOR: extract the REAL buildCoverage from the component source and
// execute it (helpers' parse/addD/fmt are already in this sandbox). The cap
// must yield EXACTLY 2 coverage days for every Christmas weekday placement —
// without it, a Tuesday Christmas (2029) walks to Saturday: six solo days.
(() => {
  // CRLF-normalize before extraction: the working copy uses \r\n and the end
  // anchor spans a line break (learned the hard way — indexOf missed).
  const nsrc = src.replace(/\r\n/g, "\n");
  const START = "const buildCoverage = (hol, sA, sB) => {";
  const END = "return coverage;\n    };";
  const s = nsrc.indexOf(START), e = nsrc.indexOf(END);
  if (s === -1 || e === -1) { check("buildCoverage extractable for execution", false, "anchors not found"); return; }
  const fnSrc = nsrc.slice(s, e + END.length);
  let buildCoverage;
  try {
    buildCoverage = vm.runInContext(
      `(function(){ const DAYNAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]; ${fnSrc} return buildCoverage; })()`,
      sandbox
    );
  } catch (ex) { check("buildCoverage compiles standalone", false, String(ex)); return; }
  // Dec 25 weekday walk: 2026 Fri, 2027 Sat, 2028 Mon, 2029 Tue (the six-day
  // trap), 2030 Wed, 2031 Thu — every shape must cap at 2.
  for (let y = 2026; y <= 2031; y++) {
    const cov = buildCoverage({ name: "Christmas Day", date: `${y}-12-25` }, "s6", "s6");
    check(`Christmas ${y} coverage is exactly 2 days (got ${cov.length})`, cov.length === 2,
      cov.map(c => `${c.date}:${c.surgeon}`).join(", "));
  }
  // Regression guard the other way: a NORMAL two-surgeon mid-week holiday
  // must still walk past the pair (the cap must not leak beyond sA === sB).
  const normal = buildCoverage({ name: "Christmas Day", date: "2029-12-25" }, "s6", "s4");
  check("cap does not fire for a two-surgeon pair (2029 Tue > 2 days)", normal.length > 2, `got ${normal.length}`);
})();

// ══════════════════════════════════════════════════════════════
// G. Holiday tenure normalization (2026-08-07): rate, never NaN
// ══════════════════════════════════════════════════════════════
console.log("\nG. holiday tenure normalization");

// The zero-eligible new hire is the trap: 0/0 = NaN, and a NaN-returning
// comparator makes Array.sort produce ARBITRARY order with no error — firing
// precisely when a new partner joins. Executed directly (holidayRate is a
// pure config.js function, loaded in this sandbox).
check("holidayRate(0, 0) is 0 — zero-tenure new hire sorts first",
  holidayRate(0, 0) === 0 && !Number.isNaN(holidayRate(0, 0)));
check("holidayRate(5, 0) is 0 — never Infinity on a defensive weird input",
  holidayRate(5, 0) === 0);
check("holidayRate(3, 12) = 0.25 — normal rate math intact",
  holidayRate(3, 12) === 0.25);
check("comparator delta for zero-tenure vs veteran is finite (sort-safe)",
  Number.isFinite(holidayRate(0, 0) - holidayRate(3, 12)));
// Wiring tripwires: pickPair compares RATES (both operands), and ARW's
// start date exists where the eligibility code reads it (INIT_SURGEONS).
check("pickPair compares tenure-normalized rates (2 holidayRate operands)",
  count("holidayRate(lifetimeCt") === 2, `found ${count("holidayRate(lifetimeCt")}`);
check("ARW start date present in INIT_SURGEONS (2023-09-01)",
  INIT_SURGEONS.find(s => s.id === "s7")?.start === "2023-09-01");
check("eligibility loop present (eligibleCt built from holiday dates)",
  count("eligibleCt[id][h.type]++") === 1);

// ══════════════════════════════════════════════════════════════
// H. Backup-flag consistency (blob lists vs per-week isBackup/isFierceBackup)
// ══════════════════════════════════════════════════════════════
console.log("\nH. backup-flag consistency");
const { checkBackupFlagConsistency } = require("./consistency-checks");

// Vacuous green: the empty payload fixture is self-consistent.
check("empty payload → no violations",
  checkBackupFlagConsistency(transientEmptyAutosave.schedule, transientEmptyAutosave.backupMondays, transientEmptyAutosave.fierceBackup).violations.length === 0);

// Real green: one backup + one fierce week, lists agree with flags.
const H_WEEKS = {
  "2026-05-18": { ...WEEK, isBackup: false, isFierceBackup: false },
  "2026-05-25": { ...WEEK, isBackup: true, isFierceBackup: false },
  "2026-06-22": { ...WEEK, isBackup: false, isFierceBackup: true },
};
const hOK = checkBackupFlagConsistency(H_WEEKS, ["2026-05-25"], ["2026-06-22"]);
check("consistent schedule/lists → no violations", hOK.violations.length === 0, hOK.violations.join("; "));

// Red proofs — one per direction per flag; each must name the exact Monday.
const hA = checkBackupFlagConsistency(
  { ...H_WEEKS, "2026-05-25": { ...WEEK, isBackup: false, isFierceBackup: false } },
  ["2026-05-25"], ["2026-06-22"]);
check("listed backup Monday with isBackup:false → 1 violation naming it",
  hA.violations.length === 1 && hA.violations[0].includes("2026-05-25"), hA.violations.join("; "));
const hB = checkBackupFlagConsistency(H_WEEKS, [], ["2026-06-22"]);
check("isBackup:true week missing from backupMondays → 1 violation naming it",
  hB.violations.length === 1 && hB.violations[0].includes("2026-05-25"), hB.violations.join("; "));
const hC = checkBackupFlagConsistency(
  { ...H_WEEKS, "2026-06-22": { ...WEEK, isBackup: false, isFierceBackup: false } },
  ["2026-05-25"], ["2026-06-22"]);
check("listed fierce Monday with isFierceBackup:false → 1 violation naming it",
  hC.violations.length === 1 && hC.violations[0].includes("2026-06-22"), hC.violations.join("; "));
const hD = checkBackupFlagConsistency(H_WEEKS, ["2026-05-25"], []);
check("isFierceBackup:true week missing from fierceBackup → 1 violation naming it",
  hD.violations.length === 1 && hD.violations[0].includes("2026-06-22"), hD.violations.join("; "));

// The live 2026-08 trade shape itself: set moved 9/14→9/28, flags frozen —
// both directions of the divergence must surface at once.
const hTrade = checkBackupFlagConsistency(
  { "2026-09-14": { ...WEEK, isBackup: true, isFierceBackup: false },
    "2026-09-28": { ...WEEK, isBackup: false, isFierceBackup: false } },
  ["2026-09-28"], []);
check("the live trade divergence shape → exactly 2 violations",
  hTrade.violations.length === 2, hTrade.violations.join("; "));

// Pin the deliberate NON-violation: a listed Monday with no week is PENDING
// ("marked, applies at next generation") — live lists legitimately extend
// past the generated window (e.g. fierceBackup 2026-12-07 as of 2026-08).
// Flagging it would poison every live audit with false positives.
const hPend = checkBackupFlagConsistency(H_WEEKS, ["2026-05-25", "2027-01-04"], ["2026-06-22"]);
check("listed Monday with no week → pending, NOT a violation",
  hPend.violations.length === 0 && hPend.pending.length === 1 && hPend.pending[0].includes("2027-01-04"),
  hPend.violations.concat(hPend.pending).join("; "));

// Source tripwire: the four Settings handlers keep BOTH representations in
// step via setWeekFlag (mark/unmark × backup/fierce). If the flag half is
// ever removed, this goes red; a legitimate new call site updates the count
// in the same PR.
check("setWeekFlag wired at exactly 4 handler sites",
  count("setWeekFlag(") === 4, `found ${count("setWeekFlag(")}`);

// ══════════════════════════════════════════════════════════════
// I. Signup email guard (PR #24) — the PROTECTIVE branch, finally exercised
// ══════════════════════════════════════════════════════════════
// JH's 2026-08-08 signup only proved the benign populate-on-empty path; the
// branch PR #24 exists for (an email the scheduler already entered survives
// a fresh signup) had never executed anywhere. Extract the REAL guard block
// from the component source and drive all its branches.
console.log("\nI. signup email guard (PR #24)");
await (async () => {
  const nsrc = src.replace(/\r\n/g, "\n");
  const START = 'if (signupPersonId !== "admin" && authEmail) {';
  const END = `showToast("Couldn't verify your notification email — open Settings → Notification Settings and enter it there.", "error");
            }
          }`;
  const s = nsrc.indexOf(START), e = nsrc.indexOf(END);
  if (s === -1 || e === -1) { check("signup guard extractable for execution", false, "anchors not found"); return; }
  if (nsrc.indexOf(START, s + 1) !== -1) { check("signup guard START anchor unique", false, "multiple matches"); return; }
  const guardSrc = nsrc.slice(s, e + END.length);
  let runGuard;
  try {
    runGuard = vm.runInContext(`(async function(signupPersonId, authEmail, fetch){
      const SUPABASE_URL = "https://stub.invalid";
      const dbAuthHeaders = () => ({});
      const saved = [], toasts = [], fetches = [];
      const wrappedFetch = fetch; // capture; re-alias below so the block's bare fetch logs
      const saveNotifPref = (sid, updates, source) => { saved.push({ sid, updates, source }); };
      const showToast = (m, t) => { toasts.push(String(m)); };
      fetch = async (...a) => { fetches.push(a[0]); return wrappedFetch(...a); };
      ${guardSrc}
      return { saved, toasts, fetches };
    })`, sandbox);
  } catch (ex) { check("signup guard compiles standalone", false, String(ex)); return; }

  const ok200 = (rows) => async () => ({ ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) });
  const fail500 = async () => ({ ok: false, status: 500, json: async () => null, text: async () => "boom" });

  // 1. PROTECTIVE branch: scheduler-entered email exists → the guard must
  //    write NOTHING (zero saveNotifPref calls, only the one guard GET) —
  //    which is what "the stored email survives byte-identical" means.
  let r = await runGuard("s5", "reh.new@example.test", ok200([{ email: "scheduler.entered@example.test" }]));
  check("existing email → ZERO writes (stored address survives byte-identical)",
    r.saved.length === 0 && r.toasts.length === 0 && r.fetches.length === 1,
    `saved=${JSON.stringify(r.saved)} toasts=${r.toasts.length} fetches=${r.fetches.length}`);

  // 2. POPULATE branch (the benign path JH's signup proved live): genuinely
  //    empty slot → exactly one populate carrying the signup email + the
  //    "signup" audit source.
  r = await runGuard("a5", "jh.signup@example.test", ok200([]));
  check("empty slot → exactly one populate with the signup email + source 'signup'",
    r.saved.length === 1 && r.saved[0].sid === "a5" &&
    r.saved[0].updates.email === "jh.signup@example.test" && r.saved[0].updates.email_notifs === true &&
    r.saved[0].source === "signup",
    JSON.stringify(r.saved));

  // 3. FAIL-LOUD branch (the PR #24 reversal): a failed guard read writes
  //    NOTHING and surfaces a toast — never populate-on-failure.
  r = await runGuard("s5", "reh.new@example.test", fail500);
  check("failed guard read → zero writes + loud toast (never populate-on-failure)",
    r.saved.length === 0 && r.toasts.length === 1, `saved=${r.saved.length} toasts=${r.toasts.length}`);

  // 4. Admin accounts skip the guard entirely (no read, no write).
  r = await runGuard("admin", "admin@example.test", ok200([]));
  check("admin signup → guard skipped entirely", r.saved.length === 0 && r.fetches.length === 0);
})();

// Audit wiring pins (2026-08-08): notification_preferences now audits both
// writers. Comment-immune code needles.
check("prefs save audits via the latest-closure bridge (1 site)",
  count("auditRef.current.logAudit(") === 1, `found ${count("auditRef.current.logAudit(")}`);
check("signup populate passes the 'signup' audit source (1 site)",
  count(', "signup");') === 1, `found ${count(', "signup");')}`);
check("latest-closure bridge assignment present",
  count("auditRef.current = { logAudit, nameOf };") === 1, `found ${count("auditRef.current = { logAudit, nameOf };")}`);
// audit_log's SELECT policy is USING(true) for all authenticated users
// (verified live 2026-08-08) while notification_preferences reads are
// owner-or-scheduler scoped — the audit payload must therefore never carry
// the plaintext address. Pins the masked-only contract.
check("prefs audit never logs the plaintext email (masked only)",
  count("email: row.email") === 0 && count("email_masked") >= 1,
  `plaintext sites=${count("email: row.email")} masked sites=${count("email_masked")}`);

// ─── Verdict ───
console.log(`\n${checks} checks, ${failures.length} failure(s)`);
if (failures.length) {
  console.error("\nFAIL — sync/snapshot guard regression:");
  failures.forEach(f => console.error("  • " + f));
  process.exit(1);
}
console.log("PASS — all sync/snapshot guards hold.");

})().catch(e => {
  console.error("\nFAIL — harness crashed (this is a failure, not a skip):", e);
  process.exit(1);
});
