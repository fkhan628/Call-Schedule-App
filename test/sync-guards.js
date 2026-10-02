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
// E3. OR board (?public=1&view=or) is a LAYER on public mode, not a mode
// ══════════════════════════════════════════════════════════════
// The charge-nurse view must inherit every public-mode gate — above all the
// write guards. These pins fail if someone ever gives it an independent
// identity (e.g. `view === "or"` without `public === "1"`, or an isOrView
// branch on a write path).
console.log("\nE3. OR board layering");

check("isOrView requires public=1 (cannot be entered without public mode)",
  /params\.get\("public"\)\s*===\s*"1"\s*&&\s*params\.get\("view"\)\s*===\s*"or"/.test(src),
  "isOrView must AND public=1 with view=or");
check("appOffVisible derives from isPublicMode/isOrView only (1 definition)",
  count("const appOffVisible = !isPublicMode || isOrView;") === 1,
  `found ${count("const appOffVisible = !isPublicMode || isOrView;")}`);
check("appOffVisible used at exactly 4 sites (2 fetch, 2 render)",
  count("appOffVisible") === 5, // 1 definition + 4 uses
  `found ${count("appOffVisible")} occurrences (expect 5 = 1 def + 4 uses)`);

// The four write guards must still key on isPublicMode ALONE — never on the
// OR flag, which would let a nurse's link write.
check("all 4 public-mode write guards remain `if (isPublicMode) return;`",
  count("if (isPublicMode) return;") === 4, `found ${count("if (isPublicMode) return;")}`);
check("isOrView never appears on a write path (no isOrView in any write guard)",
  !/isOrView[^\n]*\breturn;/.test(src) && !/if\s*\(\s*!?\s*isOrView\s*\)\s*\{?\s*(await|supabase|fetch)/.test(src));
// The day-off SAVE path stays internal regardless of the flag.
check("day-off save still gated on appDayOffLoaded (edit gate untouched)",
  count("if (!appDayOffLoaded)") >= 1);

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

// ─── J. Spacing-exception disclosure (2026-08-31, follows PR #46) ───
// The preview modal lists any same-surgeon service-week pair ≤ MIN_DC_GAP
// that survived the generator's soft floor, so the scheduler publishes
// knowingly. Cross-file dependency: the babel bundle reads generator.js's
// top-level MIN_DC_GAP global — these pins fail the build if either side
// drifts. Behavior itself is exercised extraction-executed in the PR's
// verification (MCC seam pair + Thanksgiving attribution + loud-failure
// path); these are the wiring pins.
{
  const gensrc = fs.readFileSync(path.join(ROOT, "generator.js"), "utf8");
  check("generator.js still defines the MIN_DC_GAP global the client reads",
    /const MIN_DC_GAP = 2;/.test(gensrc));
  check("disclosure computation keys on MIN_DC_GAP (no copied constant)",
    /w - last\[id\]\.w <= MIN_DC_GAP/.test(src));
  const compIdx = src.indexOf("const spacingNotes = (() => {");
  const rendIdx = src.indexOf("spacingNotes.length > 0 && (");
  const acceptIdx = src.indexOf("<button onClick={acceptPreview}");
  check("disclosure computed and rendered inside the preview modal, above the calendar grid",
    compIdx !== -1 && rendIdx !== -1 && acceptIdx !== -1 && compIdx < acceptIdx && rendIdx > acceptIdx
      && rendIdx < src.indexOf("{/* Preview Calendar Grid */}"),
    `comp=${compIdx} accept=${acceptIdx} render=${rendIdx}`);
  check("disclosure failure path pushes a visible warning, never returns silence",
    /spacing check itself failed/.test(src));
}

// ─── K. Trade-acceptance time re-validation (owner ruling 2026-09-06) ───
// A trade can be accepted days after it was proposed; the pickers filter at
// PROPOSE time (#49) and acceptTradeRequest re-validates at ACCEPT time.
// TWO-SIDED, extraction-executed: the real handler body is sliced from
// index-source.html and run with a recording fetch — a stale acceptance must
// refuse loudly with ZERO writes, and a valid one must still land (the
// status PATCH is attempted and the swap is applied). Companion source pins
// cover the other two accept paths (executeTwoWaySwap, the emergency
// one-way call site), which share the same message and helper.
{
  const START = "const acceptTradeRequest = useCallback(async (req) => {";
  const END = "}, [schedule, surgeons, pushUndo, addNotification, sendEmailNotif, detectCascadeChanges, schedulerAdminIds, silvisActive, silvisBlock, silvisRefuse]);";
  const s0 = src.indexOf(START), e0 = src.indexOf(END, s0);
  if (s0 === -1 || e0 === -1) { check("accept-trade handler extractable for execution", false, "anchors not found"); }
  else if (src.indexOf(START, s0 + 1) !== -1) { check("accept-trade START anchor unique", false, "multiple matches"); }
  else {
    const body = src.slice(s0 + START.length, e0);
    let acceptFn;
    try {
      acceptFn = vm.runInContext(`(function (env) {
        const { schedule, surgeons, showToast, detectCascadeChanges, setTradeRequests, logAudit,
                pushUndo, setSchedule, addNotification, sendEmailNotif, schedulerAdminIds, confirm,
                silvisActive, silvisBlock, silvisRefuse } = env;
        return (async (req) => {${body}});
      })`, sandbox, { filename: "accept-trade-extract.js" });
      check("accept-trade handler compiles standalone", true);
    } catch (ex) { check("accept-trade handler compiles standalone", false, String(ex)); }
    if (acceptFn) {
      const { fmt: F, addD: A } = vm.runInContext("({ fmt, addD })", sandbox);
      const mkEnv = () => {
        const log = { toasts: [], schedWrites: 0, undo: 0 };
        return { log, env: {
          schedule: {},
          surgeons: [{ id: "s1", name: "AAA" }, { id: "s2", name: "BBB" }],
          showToast: (msg, kind) => log.toasts.push({ msg, kind }),
          detectCascadeChanges: () => [],
          setTradeRequests: () => {},
          logAudit: () => {},
          pushUndo: () => { log.undo++; },
          setSchedule: () => { log.schedWrites++; },
          addNotification: async () => {},
          sendEmailNotif: () => {},
          schedulerAdminIds: [],
          confirm: () => true,
          // silvisBusy (section O owns its behavior): inert here
          silvisActive: false, silvisBlock: () => null, silvisRefuse: () => false,
        } };
      };
      const baseReq = (weekMon, retWeek) => ({
        id: 9, from_surgeon_id: "s1", to_surgeon_id: "s2",
        from_surgeon_name: "AAA", to_surgeon_name: "BBB",
        week_monday: weekMon, shift_key: "tue", shift_label: "Tue Night",
        return_week: retWeek || null, return_shift: retWeek ? "wed" : null,
      });
      const pastMon = F(A(new Date(), -21));
      const futureMon = F(A(new Date(), 14));
      // RED: stale primary leg → loud refusal, zero writes of any kind
      let t = mkEnv();
      let fetchStub = stubFetch([]); // any fetch would throw "unmatched" — none may happen
      await acceptFn(t.env)(baseReq(pastMon));
      check("stale trade (primary leg elapsed) → refused with ZERO writes",
        writesIn(fetchStub).length === 0 && fetchStub.calls.length === 0 && t.log.schedWrites === 0 && t.log.undo === 0
        && t.log.toasts.length === 1 && /already passed/.test(t.log.toasts[0].msg),
        JSON.stringify(t.log.toasts));
      // RED: stale RETURN leg with a valid primary → same refusal
      t = mkEnv();
      fetchStub = stubFetch([]);
      await acceptFn(t.env)(baseReq(futureMon, pastMon));
      check("stale trade (return leg elapsed) → refused with ZERO writes",
        fetchStub.calls.length === 0 && t.log.schedWrites === 0
        && t.log.toasts.length === 1 && /already passed/.test(t.log.toasts[0].msg));
      // GREEN: valid future trade → status PATCH attempted and swap applied
      t = mkEnv();
      t.env.schedule = { [futureMon]: { dayCall: "s9", nights: { tue: "s1", wed: "s2" }, off: null } };
      fetchStub = stubFetch([{ m: "PATCH", url: "shift_trade_requests", json: [{ id: 9 }] }]);
      await acceptFn(t.env)(baseReq(futureMon));
      check("valid future trade → status PATCH attempted and swap applied",
        writesIn(fetchStub).length === 1 && t.log.schedWrites === 1 && t.log.undo === 1
        && !t.log.toasts.some(x => /already passed/.test(x.msg)),
        `writes=${writesIn(fetchStub).length} sched=${t.log.schedWrites} toasts=${JSON.stringify(t.log.toasts)}`);
    }
  }
}
// ─── L. Dated slot labels (2026-09-06): one owner for the date ───
// slotLabel() composes every dated shift label THROUGH shiftStartDate, so a
// rendered date can never disagree with the validation gating that slot.
// Two-sided: the behavior checks pin the exact composition (and a
// deliberately Monday-dated hand-roll must NOT match), and the source pins
// go red if a converted render site regresses to bare SHIFT_LABELS or a
// future site hand-rolls its own date math.
{
  const { slotLabel: SL, shiftStartDate: SSD } = vm.runInContext("({ slotLabel, shiftStartDate })", sandbox);
  check("slotLabel + shiftStartDate exported from helpers", typeof SL === "function" && typeof SSD === "function");
  if (typeof SL === "function") {
    // 2026-09-14 is a Monday. Expected labels are EXACT.
    const M = "2026-09-14";
    const expected = {
      dayCall: "Service Wk of Sep 14",
      mon: "Mon Sep 14 — Night", tue: "Tue Sep 15 — Night",
      wed: "Wed Sep 16 — Night", thu: "Thu Sep 17 — Night",
      wknd: "Wknd — Fri Sep 18",
    };
    for (const [sk, want] of Object.entries(expected)) {
      check(`slotLabel(${sk}) = "${want}"`, SL(M, sk) === want, `got "${SL(M, sk)}"`);
    }
    check("slotLabel accepts the lock UI's legacy 'dc' key", SL(M, "dc") === expected.dayCall, SL(M, "dc"));
    // Each label's date must be shiftStartDate's date — checked structurally,
    // not just via the table above (guards a future edit to either side).
    for (const sk of ["mon", "tue", "wed", "thu", "wknd"]) {
      const d = new Date(SSD(M, sk) + "T12:00:00");
      check(`slotLabel(${sk}) carries shiftStartDate's day-of-month (${d.getDate()})`,
        SL(M, sk).includes(` ${d.getDate()}`), SL(M, sk));
    }
    // NEGATIVE control: the pre-#51 hand-roll (week-Monday-dated "Sep 14 —
    // Thu Night") must NOT equal the composed label — proves these checks
    // can actually tell a hand-rolled label from the real one.
    check("Monday-dated hand-roll for thu does NOT match slotLabel",
      SL(M, "thu") !== "Sep 14 — Thu Night" && SL(M, "thu").includes("17"));
  }
  // Source pins on the converted render sites.
  check("no bare SHIFT_LABELS option lists remain in shift dropdowns",
    count("{SHIFT_LABELS[sk]}</option>") === 0, `found ${count("{SHIFT_LABELS[sk]}</option>")}`);
  check("week editor slot rows label via slotLabel, not SHIFT_LABELS",
    count("{SHIFT_LABELS[nk]||nk}</label>") === 0 && count('slotLabel(mondayStr, nk)') === 1);
  // LEDGER — every slotLabel call site in index-source.html, by the PR that
  // added it. Update BOTH the number and this comment when a PR adds more.
  //   12  PR #51  pickers, week-editor rows, suggestions header, lock picker
  //  + 4  PR #53  both request cards: primary leg + return leg
  //  + 5  this PR swap family: 2 candidate-card pushes + 3 return-swap labels
  //  ---
  //   21  (swapMsg/cascadeMsg call slotLabel INSIDE helpers.js, so they add
  //        no call sites here — that is the point of composing them there)
  // 21 converted sites (#51) + 2 silvisBusy reason strings (2026-09-24: the
  // shared silvisBlock reason and the editor's override-aware dayCall reason).
  check("slotLabel used at exactly the 21 converted sites + 2 silvisBusy reasons",
    count("slotLabel(") === 23, `found ${count("slotLabel(")}`);
  // The member opts builders were the LAST hand-rolled date math: their old
  // label dated a night by the week's MONDAY ("Sep 7 — Thu Night" for a
  // Thursday shift on Sep 10), which actively misled on the member-facing
  // trade surface. Both their label AND their upcoming-only filter now go
  // through the helpers, so no weekday-offset map should remain anywhere.
  check("no inline weekday-offset date math remains in the app source",
    count("{mon:0,tue:1,wed:2,thu:3,wknd:4}") === 0, `found ${count("{mon:0,tue:1,wed:2,thu:3,wknd:4}")}`);
  check("member opts builders filter via shiftStartDate (3 sites)",
    count("shiftStartDate(m, sk)") === 3, `found ${count("shiftStartDate(m, sk)")}`);
  check("member opts builders label via slotLabel (3 sites)",
    count("slotLabel(m, sk)") === 3, `found ${count("slotLabel(m, sk)")}`);

  // BEHAVIOR: extraction-execute the real member opts builder ("Your shift to
  // swap") against a synthetic week and assert the rendered strings.
  const bStart = src.indexOf("const opts = [];", src.indexOf("Your shift to swap"));
  const bEnd = src.indexOf("const curVal", bStart);
  if (bStart === -1 || bEnd === -1) { check("member opts builder extractable", false, "anchors not found"); }
  else {
    const body = src.slice(bStart, bEnd).split("mySurgeon").join("WHO");
    let optsFn;
    try {
      optsFn = vm.runInContext(`(function (schedule, WHO, todayStr) { ${body}; return opts; })`, sandbox, { filename: "member-opts-extract.js" });
      check("member opts builder compiles standalone", true);
    } catch (ex) { check("member opts builder compiles standalone", false, String(ex)); }
    if (optsFn) {
      // Week of Mon 2026-09-07; the member holds every slot in it.
      const M = "2026-09-07";
      const sched = { [M]: { dayCall: "sX", nights: { mon: "sX", tue: "sX", wed: "sX", thu: "sX", wknd: "sX" } } };
      const byKey = {};
      optsFn(sched, "sX", "2026-09-01").forEach(o => { byKey[o.value.split("|")[1]] = o.label; });
      check('member opts: Thursday night reads "Thu Sep 10 — Night" (was the misleading "Sep 7 — Thu Night")',
        byKey.thu === "Thu Sep 10 — Night", `got "${byKey.thu}"`);
      check('member opts: weekend reads "Wknd — Fri Sep 11"', byKey.wknd === "Wknd — Fri Sep 11", `got "${byKey.wknd}"`);
      check('member opts: service week reads "Service Wk of Sep 7"', byKey.dayCall === "Service Wk of Sep 7", `got "${byKey.dayCall}"`);
      // NEGATIVE control: no non-Monday slot may carry the week's Monday date.
      check("member opts: no night/weekend label carries the week's Monday date",
        ["tue", "wed", "thu", "wknd"].every(sk => byKey[sk] && !byKey[sk].includes("Sep 7")),
        JSON.stringify(byKey));
      // Suffixes survive the conversion (backup + current-week markers).
      // today === the Monday itself: the service week has NOT started
      // elapsing (shiftStartDate is not < today), so it survives the filter
      // and carries "(this week)". One day later it is correctly gone —
      // the partially-elapsed rule from #49.
      const sched2 = { [M]: { isBackup: true, dayCall: "sX", nights: {} } };
      check("member opts: a service week is dropped once it has started (today = Mon+1)",
        optsFn(sched2, "sX", "2026-09-08").length === 0);
      const bk = optsFn(sched2, "sX", M)[0];
      check("member opts: (Backup) and (this week) suffixes survive",
        bk && bk.label === "Service Wk of Sep 7 (Backup) (this week)", bk && bk.label);
    }
  }
}

// ─── M. Trade message composers (2026-09-07) ───
// One composition per trade event, shared by in-app + push + email, with
// every date routed through slotLabel → shiftStartDate. Fixtures are trade
// #5's REAL data (the first member accept, verified end to end) plus a
// one-way trade. The negative control is the whole point: for a night or
// weekend leg the composed string must NOT contain the week-Monday date
// literal — that was the defect (a Thursday shift printed as its Monday).
{
  const { tradeProposeMsg: PM, tradeAcceptMsg: AM, tradeDeclineMsg: DM } =
    vm.runInContext("({ tradeProposeMsg, tradeAcceptMsg, tradeDeclineMsg })", sandbox);
  check("all three trade composers exported from helpers",
    [PM, AM, DM].every(f => typeof f === "function"));
  if (typeof AM === "function") {
    // Trade #5 exactly as the row records it: FAK (from) gives Thu of week
    // 2026-09-14 to KJH (to); FAK takes KJH's Wed of the same week.
    const T5 = {
      from_surgeon_name: "FAK", to_surgeon_name: "KJH",
      week_monday: "2026-09-14", shift_key: "thu",
      return_week: "2026-09-14", return_shift: "wed",
    };
    const ONEWAY = { ...T5, return_week: null, return_shift: null };

    check("accept names BOTH legs, each dated to its own shift",
      AM(T5) === "KJH accepted the trade: KJH takes Thu Sep 17 — Night; FAK takes Wed Sep 16 — Night",
      AM(T5));
    check("propose names both legs in proposal tense",
      PM(T5) === "FAK proposed a trade: KJH would take Thu Sep 17 — Night; FAK would take Wed Sep 16 — Night",
      PM(T5));
    check("decline names both legs in counterfactual tense",
      DM(T5) === "KJH declined the trade: KJH would have taken Thu Sep 17 — Night; FAK would have taken Wed Sep 16 — Night",
      DM(T5));

    // NEGATIVE CONTROL — the defect this replaces. Week-Monday is Sep 14;
    // neither leg (Thu Sep 17, Wed Sep 16) may print it.
    for (const [name, msg] of [["propose", PM(T5)], ["accept", AM(T5)], ["decline", DM(T5)]]) {
      check(`${name}: no leg carries the week-Monday date ("Sep 14")`,
        !msg.includes("Sep 14"), msg);
      check(`${name}: no raw ISO week-Monday leaks ("2026-09-14")`,
        !msg.includes("2026-09-14"), msg);
    }

    // One-way trades degrade EXPLICITLY, never back into the old one-leg look.
    for (const [name, msg] of [["propose", PM(ONEWAY)], ["accept", AM(ONEWAY)], ["decline", DM(ONEWAY)]]) {
      check(`${name}: one-way says so explicitly`,
        msg.includes("(one-way — no return shift)"), msg);
      check(`${name}: one-way still dates its single leg correctly`,
        msg.includes("Thu Sep 17 — Night") && !msg.includes("Sep 14"), msg);
    }

    // Channel parity: the composed string is what in-app/push carry AND what
    // the email payload sends as `detail`, at all three sites.
    check("each event composes ONCE and reuses it (3 named consts)",
      count("const proposeMsg = tradeProposeMsg(req);") === 1
      && count("const acceptMsg = tradeAcceptMsg(req);") === 1
      && count("const declineMsg = tradeDeclineMsg(req);") === 1);
    check("all three email payloads carry detail: <composed>",
      count("detail: proposeMsg }") === 1 && count("detail: acceptMsg }") === 1
      && count("detail: declineMsg }") === 1);
    check("no trade string still interpolates shift_label with a week date",
      count("${req.shift_label} (${req.week_monday})") === 0,
      `found ${count("${req.shift_label} (${req.week_monday})")}`);
    check("both request cards render the return leg (or say one-way)",
      count("(one-way — no return shift)") >= 1 && count("(one-way)") >= 1);
  }
}

// ─── N. Swap family: swapMsg / cascadeMsg (2026-09-07) ───
// The swap-suggestion tool was the last surface speaking in undated labels
// and week-Monday dates, and the cascade path gave the least notice to the
// one person who was not party to the trade. Same doctrine as section M.
// NOTE on the negative control: dayCall legs are EXEMPT because the
// week-Monday IS the correct date for a whole-week shift ("Service Wk of
// Oct 19"); only night/weekend legs must never show it.
{
  const { swapMsg: SM, cascadeMsg: CM } = vm.runInContext("({ swapMsg, cascadeMsg })", sandbox);
  check("swap-family composers exported from helpers",
    typeof SM === "function" && typeof CM === "function");
  if (typeof SM === "function") {
    // Week of Mon 2026-10-19: Tue = Oct 20, Thu = Oct 22, Fri(wknd) = Oct 23.
    const TWO = { targetMon: "2026-10-19", targetShift: "tue", oldName: "FAK", newName: "REH",
                  returnMon: "2026-10-19", returnShift: "thu" };
    const ONE = { ...TWO, returnMon: null, returnShift: null };
    const WKND = { ...TWO, targetShift: "wknd", returnShift: "thu" };
    const DC = { ...TWO, targetShift: "dayCall", returnMon: null, returnShift: null };

    check("swap two-way names both legs, each dated to its own shift",
      SM(TWO) === "REH takes Tue Oct 20 — Night; FAK takes Thu Oct 22 — Night", SM(TWO));
    check("swap one-way degrades explicitly",
      SM(ONE) === "REH takes Tue Oct 20 — Night (one-way — no return shift)", SM(ONE));
    check("swap weekend leg dates to its Friday",
      SM(WKND).startsWith("REH takes Wknd — Fri Oct 23"), SM(WKND));
    check("swap dayCall leg names the WEEK (Monday is correct here)",
      SM(DC).startsWith("REH takes Service Wk of Oct 19"), SM(DC));

    // NEGATIVE CONTROL — night/weekend legs only; dayCall exempt by design.
    for (const [name, msg] of [["two-way", SM(TWO)], ["one-way", SM(ONE)], ["weekend", SM(WKND)]]) {
      check(`swap ${name}: no night/weekend leg carries the week-Monday ("Oct 19")`,
        !msg.includes("Oct 19"), msg);
      check(`swap ${name}: no raw ISO week-Monday leaks`,
        !msg.includes("2026-10-19"), msg);
    }

    check("cascade string is dated and reads as a sentence",
      CM({ week: "2026-10-19", shiftKey: "tue", fromName: "REH", toName: "FAK" })
        === "Tue Oct 20 — Night moved from REH to FAK due to a trade",
      CM({ week: "2026-10-19", shiftKey: "tue", fromName: "REH", toName: "FAK" }));
    check("cascade: no week-Monday on a night leg",
      !CM({ week: "2026-10-19", shiftKey: "thu", fromName: "A", toName: "B" }).includes("Oct 19"));
  }

  // The old forms must be GONE.
  check("no '(wk of ${targetMon})' swap form remains",
    count("(wk of ${targetMon})") === 0, `found ${count("(wk of ${targetMon})")}`);
  check("no '(${otherMon})' return-swap label form remains",
    count("(${otherMon})`") === 0, `found ${count("(${otherMon})`")}`);
  check("candidate cards push dated labels, not bare ones",
    count('candShiftsThisWeek.push("Service Week")') === 0
    && count("candShiftsThisWeek.push(SHIFT_LABELS[sk])") === 0
    && count('candShiftsThisWeek.push(slotLabel(mondayStr, "dayCall"))') === 1
    && count("candShiftsThisWeek.push(slotLabel(mondayStr, sk))") === 1);
  check("cascade path now sends an email (it previously sent none)",
    count("detail: cascadeDetail }") === 1);
  check("executeSwap composes once and reuses it for in-app + email",
    count("const swapDetail = swapMsg({") === 1 && count("detail: swapDetail }") === 1);
  // ABSENCE pin — the effect-unobservable write must not come back silently.
  check('the discarded reasons.push("Already on service week") is gone',
    count('reasons.push("Already on service week")') === 0);
  check("its removal is documented where it sat (hard-exclusion comment)",
    /No reason push here ON PURPOSE/.test(src));
  // Polish: one composition per event at all three trade sites.
  check("accept composes exactly once (matching propose/decline)",
    count("tradeAcceptMsg(req)") === 1, `found ${count("tradeAcceptMsg(req)")}`);
  check("audit lines are the composed sentence alone (no stuttering prefix)",
    count("`Proposed trade — ") === 0 && count("`Declined trade — ") === 0
    && count("`Accepted trade — ") === 0);
}

// Source pins for the two sibling accept paths + the shared helper.
{
  const helpersSrc = fs.readFileSync(path.join(ROOT, "helpers.js"), "utf8");
  check("shiftStartDate helper defined once in helpers.js",
    (helpersSrc.match(/function shiftStartDate\(/g) || []).length === 1);
  check("the elapsed-trade message appears at exactly 3 accept paths",
    count('"This trade\'s shift has already passed — propose a new one."') === 3,
    `found ${count('"This trade\'s shift has already passed — propose a new one."')}`);
  check("executeTwoWaySwap re-validates before pushUndo",
    /executeTwoWaySwap = useCallback\(\(targetMon[\s\S]{0,900}shiftStartDate\(targetMon, targetShift\)[\s\S]{0,900}pushUndo\(schedule\);/.test(src)); // window 400→900 for the silvisBusy block (2026-09-24); order unchanged
}

// ─── O. silvisBusy (2026-09-24, revised after the post-merge review): FAK's Silvis primary days block Davenport call ───
// FAK is also primary trauma call at Silvis (separate app + Supabase project).
// On a Silvis PRIMARY day D (one 24h shift, 07:00 D → 07:00 D+1) no Davenport
// call of his may overlap. The GENERATOR side is pinned two-sided in
// test/generator-regression.js scenario E. This section pins the APP side:
//   O1. the pure feed helpers (silvis-feed.js, loaded into the sandbox as the
//       classic script it is): the 07:00→07:00 slot table (weekend = Fri +
//       Sun, NOT Saturday — Sat 07:00→Sun 07:00 is the service week's), the
//       [D,D] no-call range shape, sfHeldDays precedence (holiday > override
//       > slot) shared by the Warnings net and every refusal, coverage
//       horizon, malformed-row / malformed-rule tolerance, NaN-safe staleness;
//   O2. EXTRACTION-EXECUTED editor refusal: the real saveWeekEdits silvisBusy
//       block plus the real silvisBlock/silvisRefuse bodies run against a
//       fixture — a MEMBER placing FAK on a Silvis day is refused with a
//       modal (every reason, what to do next) and no confirm; a SCHEDULER/
//       ADMIN is asked and may override (audited); the night BEFORE (ends
//       07:00 D) passes; overriding the Silvis day to someone else releases
//       the service week and REMOVING that override re-triggers; a holiday
//       24h held by someone else releases the night; an unchanged placement
//       never re-triggers;
//   O3. FEED FAILURE KEEPS THE CACHE (the contract shared with the Silvis
//       side's east-feed.js): sfLoadFeed rejects on 500 / non-array; the real
//       loadSilvisFeed body never adopts a 200 + [] read (the RLS-denied
//       shape — probe rule) and never calls the rows setter on failure;
//   O4. source pins: the fold goes into `availability` ONLY (never the
//       trailing-edge vacations map), every memoized mutation callback lists
//       the silvis deps (the stale-closure class), marker + card + legend are
//       off in public mode and the generic cell renderer skips Silvis rows,
//       the accept path checks BEFORE the status PATCH, FAK is resolved by
//       roster CODE, exactly 7 refusal sites, feed-health gate + dropped-lock
//       toast in doGenerate, holiday dates via holDatesFor, rule-as-data
//       adopted on poll and restore.
{
  try {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "silvis-feed.js"), "utf8"), sandbox, { filename: "silvis-feed.js" });
    check("silvis-feed.js loads as a classic script after helpers/config (no name collisions)",
      vm.runInContext("typeof fmt === 'function' && typeof parse === 'function' && typeof sfConflict === 'function'", sandbox));
  } catch (ex) { check("silvis-feed.js loads as a classic script after helpers/config", false, String(ex)); }
  const sf = vm.runInContext("({ sfRule, sfRuleActive, sfDaysFromRows, sfBusyRanges, sfSlotDays, sfHeldDays, sfConflictDay, sfConflict, sfBackupNote, sfOverlaps, sfStatus, sfLoadFeed, sfRefreshFeed })", sandbox);
  const SIL = ["2026-01-20", "2026-02-11", "2026-03-13"]; // Tue of a service week, a Wed night, a Fri (weekend)
  const P = new Set(SIL);
  const J = (x) => JSON.stringify(x);

  // O1 — pure helpers
  check("sfSlotDays: service week = Mon..Sat (6 days)",
    J(sf.sfSlotDays("2026-01-19", "dayCall")) === J(["2026-01-19", "2026-01-20", "2026-01-21", "2026-01-22", "2026-01-23", "2026-01-24"]));
  check("sfSlotDays: weekend = Fri + Sun, NOT Saturday",
    J(sf.sfSlotDays("2026-03-09", "wknd")) === J(["2026-03-13", "2026-03-15"]));
  check("sfSlotDays: a weeknight is its own day only", J(sf.sfSlotDays("2026-02-09", "wed")) === J(["2026-02-11"]));
  check("sfSlotDays: the lock UI's 'dc' key = dayCall", J(sf.sfSlotDays("2026-01-19", "dc")) === J(sf.sfSlotDays("2026-01-19", "dayCall")));
  check("sfSlotDays: unknown slot / bad Monday → []", sf.sfSlotDays("2026-01-19", "sat").length === 0 && sf.sfSlotDays("nope", "mon").length === 0);
  check("sfConflict: a Silvis Tuesday blocks that service week and Tue night — not Mon night (ends 07:00 Tue)",
    sf.sfConflict(P, "2026-01-19", "dayCall") === "2026-01-20" && sf.sfConflict(P, "2026-01-19", "tue") === "2026-01-20" && sf.sfConflict(P, "2026-01-19", "mon") === null);
  check("sfConflict: a Silvis Friday blocks the weekend; a Silvis Saturday does not",
    sf.sfConflict(P, "2026-03-09", "wknd") === "2026-03-13" && sf.sfConflict(new Set(["2026-03-14"]), "2026-03-09", "wknd") === null);
  check("sfConflict: an empty/missing set never conflicts", sf.sfConflict(new Set(), "2026-03-09", "wknd") === null && sf.sfConflict(null, "2026-03-09", "wknd") === null);
  check("sfBackupNote: soft — same table, separate set", sf.sfBackupNote(new Set(["2026-03-15"]), "2026-03-09", "wknd") === "2026-03-15");
  check("sfBusyRanges: sorted single-day [D,D] pairs (the no-call shape), junk dropped",
    J(sf.sfBusyRanges(new Set(["2026-03-13", "2026-01-20", "bad"]))) === J([["2026-01-20", "2026-01-20"], ["2026-03-13", "2026-03-13"]]));
  // sfHeldDays — the one precedence rule
  const wkHol = { dayCall: "s6", nights: { tue: "s6" }, holidayCoverage: { "2026-01-20": { surgeonId: "s3" } }, dayCallOverrides: { "2026-01-22": "s2" } };
  check("sfHeldDays: no week row → the plain slot days", J(sf.sfHeldDays(undefined, "2026-01-19", "tue", "s6")) === J(["2026-01-20"]));
  check("sfHeldDays: a holiday 24h held by someone else removes that day (night and service week)",
    sf.sfHeldDays(wkHol, "2026-01-19", "tue", "s6").length === 0 && !sf.sfHeldDays(wkHol, "2026-01-19", "dayCall", "s6").includes("2026-01-20"));
  check("sfHeldDays: a Service Day overridden to someone else is not his; one overridden TO him stays",
    !sf.sfHeldDays(wkHol, "2026-01-19", "dayCall", "s6").includes("2026-01-22") && sf.sfHeldDays({ dayCallOverrides: { "2026-01-22": "s6" } }, "2026-01-19", "dayCall", "s6").includes("2026-01-22"));
  check("sfHeldDays: a holiday held by HIM does not release the day", sf.sfHeldDays({ holidayCoverage: { "2026-01-20": { surgeonId: "s6" } } }, "2026-01-19", "tue", "s6").length === 1);
  const feedRows = [
    { day: "2026-01-20", primary_code: "fak", backup_code: "XYZ", fetched_at: "2026-09-24T10:00:00Z" },
    { day: "2026-02-11", primary_code: "FAK", backup_code: null, fetched_at: "2026-09-24T11:00:00Z" },
    { day: "2026-02-12", primary_code: "ABC", backup_code: "FAK", fetched_at: "2026-09-24T09:00:00Z" },
    { day: "not-a-date", primary_code: "FAK" }, null,
  ];
  const dsx = sf.sfDaysFromRows(feedRows, "FAK");
  check("sfDaysFromRows: codes case-insensitive, malformed rows ignored, newest fetched_at wins",
    [...dsx.primary].join() === "2026-01-20,2026-02-11" && [...dsx.backup].join() === "2026-02-12" && dsx.fetchedAt === "2026-09-24T11:00:00Z",
    J({ p: [...dsx.primary], b: [...dsx.backup], f: dsx.fetchedAt }));
  check("sfDaysFromRows: coverage horizon from/to = first/last cached day", dsx.from === "2026-01-20" && dsx.to === "2026-02-12", J([dsx.from, dsx.to]));
  check("sfDaysFromRows: no code → nothing matches; no rows → empty sets and no horizon",
    sf.sfDaysFromRows(feedRows, "").primary.size === 0 && sf.sfDaysFromRows(null, "FAK").primary.size === 0 && sf.sfDaysFromRows(null, "FAK").to === null);
  check("sfRuleActive: default on with code FAK; enabled:false or empty code → off",
    sf.sfRuleActive(undefined) && sf.sfRule(undefined).code === "FAK" && sf.sfRuleActive({ code: "FAK" }) && !sf.sfRuleActive({ enabled: false }) && !sf.sfRuleActive({ code: "" }));
  check("sfRule: malformed blob values fail toward OFF / defaults (enabled:\"false\", 0, \"off\"; a string or array rule; a non-string code)",
    !sf.sfRuleActive({ enabled: "false" }) && !sf.sfRuleActive({ enabled: 0 }) && !sf.sfRuleActive({ enabled: "off" })
    && sf.sfRule("garbage").code === "FAK" && sf.sfRule(["x"]).enabled === true && sf.sfRule({ code: { nested: 1 } }).code === "" && sf.sfRule({ code: " fak " }).code === "fak");
  const pub = {
    "2026-01-19": { dayCall: "s6", nights: { mon: "s6", tue: "s1", wed: "s2", thu: "s3", wknd: "s4" }, dayCallOverrides: { "2026-01-20": "s2" } },
    "2026-02-09": { dayCall: "s1", nights: { mon: "s2", tue: "s3", wed: "s6", thu: "s4", wknd: "s5" }, holidayCoverage: { "2026-02-11": { surgeonId: "s1" } } },
    "2026-03-09": { dayCall: "s2", nights: { mon: "s1", tue: "s2", wed: "s3", thu: "s4", wknd: "s6" } },
  };
  const ov = sf.sfOverlaps(pub, P, "s6");
  check("sfOverlaps: overriding the Silvis day AWAY from FAK releases it; his Mon night before it is no overlap", !ov.some(o => o.mondayStr === "2026-01-19"), J(ov));
  check("sfOverlaps: a holiday held by someone else on D removes FAK's night overlap on D", !ov.some(o => o.mondayStr === "2026-02-09"), J(ov));
  check("sfOverlaps: his weekend over a Silvis Friday IS an overlap (and the only one here)", ov.length === 1 && ov[0].slot === "wknd" && ov[0].day === "2026-03-13", J(ov));
  const ov2 = sf.sfOverlaps({ "2026-01-19": { dayCall: "s1", nights: {}, dayCallOverrides: { "2026-01-20": "s6" } } }, P, "s6");
  check("sfOverlaps: a Service Day override TO FAK on a Silvis day is an overlap", ov2.length === 1 && ov2[0].slot === "dayCall" && ov2[0].day === "2026-01-20", J(ov2));
  const ov3 = sf.sfOverlaps({ "2026-02-09": { dayCall: "s1", nights: {}, holidayCoverage: { "2026-02-11": { surgeonId: "s6" } } } }, P, "s6");
  check("sfOverlaps: holiday 24h held by FAK on a Silvis day is an overlap", ov3.length === 1 && ov3[0].slot === "holiday", J(ov3));
  check("sfOverlaps: no id / no days → []", sf.sfOverlaps(pub, P, null).length === 0 && sf.sfOverlaps(pub, new Set(), "s6").length === 0);
  check("sfStatus: 36h threshold; a missing fetched_at is stale",
    !sf.sfStatus("2026-09-24T00:00:00Z", Date.parse("2026-09-25T00:00:00Z")).stale
    && sf.sfStatus("2026-09-24T00:00:00Z", Date.parse("2026-09-26T00:00:00Z")).stale && sf.sfStatus(null).stale);
  check("sfStatus: an unparseable fetched_at fails toward STALE (never NaN-fresh)", sf.sfStatus("not-a-date").stale === true && sf.sfStatus("not-a-date").ageHours === null);

  // O2 — extraction-executed editor refusal (real bodies, fixture data)
  const cut = (START, END, label) => {
    const s0 = src.indexOf(START), e0 = s0 === -1 ? -1 : src.indexOf(END, s0);
    if (s0 === -1 || e0 === -1) { check(`${label} extractable for execution`, false, "anchors not found"); return null; }
    if (src.indexOf(START, s0 + 1) !== -1) { check(`${label} START anchor unique`, false, "multiple matches"); return null; }
    return src.slice(s0 + START.length, e0);
  };
  const blockBody = cut("const silvisBlock = useCallback((id, mondayStr, slotKey, wk) => {", "}, [silvisActive, silvisFakId, silvisDays]);", "silvisBlock");
  const refuseBody = cut("const silvisRefuse = useCallback((reasons) => {", "}, [isScheduler, userProfile]);", "silvisRefuse");
  const editorBody = cut("    // silvisBusy: any change that puts FAK on a Silvis primary day is refused", "    // Safety confirmation if many changes at once", "saveWeekEdits silvisBusy block");
  if (blockBody && refuseBody && editorBody) {
    let mk;
    try {
      mk = vm.runInContext(`(function (env) {
        const { silvisActive, silvisFakId, silvisDays, nameOf, isScheduler, userProfile, showToast, confirm, alert, logAudit } = env;
        const silvisBlock = (id, mondayStr, slotKey, wk) => {${blockBody}};
        const silvisRefuse = (reasons) => {${refuseBody}};
        return (draft, oldWk, mondayStr) => {${editorBody}
          return "CONTINUED"; };
      })`, sandbox, { filename: "silvis-editor-extract.js" });
      check("editor silvisBusy block + silvisBlock/silvisRefuse compile standalone", true);
    } catch (ex) { check("editor silvisBusy block + silvisBlock/silvisRefuse compile standalone", false, String(ex)); }
    if (mk) {
      const FAK = "s6";
      const nameOf = (id) => (id === FAK ? "FAK" : id);
      const days = { primary: P, backup: new Set(), fetchedAt: null };
      const run = (draft, oldWk, mondayStr, opts = {}) => {
        const log = { toasts: [], confirms: [], alerts: [], audits: [] };
        const env = Object.assign({
          silvisActive: true, silvisFakId: FAK, silvisDays: days, nameOf,
          isScheduler: !!opts.scheduler, userProfile: { role: opts.admin ? "admin" : "member" },
          showToast: (m, k) => log.toasts.push({ m, k }),
          confirm: (m) => { log.confirms.push(m); return !!opts.confirmYes; },
          alert: (m) => log.alerts.push(m),
          logAudit: (action, summary, details) => log.audits.push({ action, summary, details }),
        }, opts.env || {});
        let out, threw = null;
        try { out = mk(env)(draft, oldWk, mondayStr); } catch (ex) { threw = String(ex); }
        return { out, log, threw };
      };
      const wk = (o) => Object.assign({ dayCall: "s1", nights: { mon: "s2", tue: "s3", wed: "s4", thu: "s5", wknd: "s7" }, dayCallOverrides: {}, apps: {} }, o || {});
      const base = wk();
      const N = (o) => Object.assign({}, base.nights, o);
      const quiet = (r) => r.log.toasts.length === 0 && r.log.alerts.length === 0 && r.log.confirms.length === 0;
      let r = run(wk({ nights: N({ tue: FAK }) }), base, "2026-01-19");
      check("editor: MEMBER placing FAK on Tue night of a Silvis Tuesday → REFUSED with a modal naming the day and what to do; no confirm, no toast, no save",
        !r.threw && r.out === undefined && r.log.confirms.length === 0 && r.log.toasts.length === 0 && r.log.alerts.length === 1
        && /Silvis PRIMARY on 2026-01-20/.test(r.log.alerts[0]) && /ask the scheduler/.test(r.log.alerts[0]) && r.log.audits.length === 0, r.threw || J(r.log));
      r = run(wk({ nights: N({ tue: FAK }) }), base, "2026-01-19", { scheduler: true });
      check("editor: SCHEDULER is asked with the reason (rule name + day) on screen; declining stops the save and logs nothing",
        !r.threw && r.out === undefined && r.log.confirms.length === 1 && /silvisBusy/.test(r.log.confirms[0]) && /2026-01-20/.test(r.log.confirms[0]) && r.log.alerts.length === 0 && r.log.audits.length === 0, r.threw || J(r.log));
      r = run(wk({ nights: N({ tue: FAK }) }), base, "2026-01-19", { scheduler: true, confirmYes: true });
      check("editor: scheduler override → the save continues and the override is AUDITED (silvis.override)",
        r.out === "CONTINUED" && r.log.confirms.length === 1 && r.log.audits.length === 1 && r.log.audits[0].action === "silvis.override" && /2026-01-20/.test(r.log.audits[0].summary), r.threw || J(r.log));
      r = run(wk({ nights: N({ tue: FAK }) }), base, "2026-01-19", { admin: true, confirmYes: true });
      check("editor: an ADMIN may override too", r.out === "CONTINUED" && r.log.confirms.length === 1, r.threw || J(r.log));
      r = run(wk({ dayCall: FAK }), base, "2026-01-19");
      check("editor: FAK as Service Week over a week holding a Silvis Tuesday → REFUSED",
        r.out === undefined && r.log.alerts.length === 1 && /Silvis PRIMARY on 2026-01-20/.test(r.log.alerts[0]), r.threw || J(r.log));
      r = run(wk({ dayCall: FAK, dayCallOverrides: { "2026-01-20": "s2" } }), base, "2026-01-19");
      check("editor: the same service week with the Silvis day overridden to someone else → allowed (override-aware)",
        r.out === "CONTINUED" && quiet(r), r.threw || J(r.log));
      const released = wk({ dayCall: FAK, dayCallOverrides: { "2026-01-20": "s2" } });
      r = run(wk({ dayCall: FAK, dayCallOverrides: {} }), released, "2026-01-19");
      check("editor: REMOVING the override that had released the Silvis day (dayCall unchanged) → REFUSED (the covered-days diff, not a 'did dayCall change' test)",
        r.out === undefined && r.log.alerts.length === 1 && /Service Day 2026-01-20/.test(r.log.alerts[0]), r.threw || J(r.log));
      r = run(released, released, "2026-01-19");
      check("editor: the released state re-saved unchanged → allowed", r.out === "CONTINUED" && quiet(r), r.threw || J(r.log));
      r = run(wk({ dayCallOverrides: { "2026-01-20": FAK } }), base, "2026-01-19");
      check("editor: a Service Day override TO FAK on a Silvis day → REFUSED",
        r.out === undefined && r.log.alerts.length === 1 && /Service Day 2026-01-20/.test(r.log.alerts[0]), r.threw || J(r.log));
      r = run(wk({ nights: N({ mon: FAK }) }), base, "2026-01-19");
      check("editor: Mon night BEFORE a Silvis Tuesday (ends 07:00 Tue) → allowed — no-call semantics, not vacation semantics",
        r.out === "CONTINUED" && quiet(r), r.threw || J(r.log));
      const holOther = wk({ holidayCoverage: { "2026-01-20": { surgeonId: "s3" } } });
      r = run(wk({ nights: N({ tue: FAK }), holidayCoverage: holOther.holidayCoverage }), holOther, "2026-01-19");
      check("editor: Tue night when the Silvis day is a holiday 24h held by SOMEONE ELSE → allowed (no false refusal; same precedence as the Warnings net)",
        r.out === "CONTINUED" && quiet(r), r.threw || J(r.log));
      r = run(wk({ dayCall: FAK, holidayCoverage: holOther.holidayCoverage }), holOther, "2026-01-19");
      check("editor: Service Week when the Silvis day is a holiday held by someone else → allowed", r.out === "CONTINUED" && quiet(r), r.threw || J(r.log));
      r = run(wk({ nights: N({ wknd: FAK }) }), base, "2026-03-09");
      check("editor: FAK's weekend over a Silvis Friday → REFUSED", r.out === undefined && r.log.alerts.length === 1 && /2026-03-13/.test(r.log.alerts[0]), r.threw || J(r.log));
      r = run(wk({ nights: N({ wknd: FAK }) }), base, "2026-03-09", { env: { silvisDays: { primary: new Set(["2026-03-14"]), backup: new Set(), fetchedAt: null } } });
      check("editor: the weekend when Silvis is only the SATURDAY → allowed (Sat 07:00→Sun 07:00 is the service week's, not the weekend's)",
        r.out === "CONTINUED" && quiet(r), r.threw || J(r.log));
      const had = wk({ nights: N({ tue: FAK }) });
      r = run(had, had, "2026-01-19");
      check("editor: an unchanged pre-existing FAK placement does not re-trigger (only NEW placements)", r.out === "CONTINUED" && quiet(r), r.threw || J(r.log));
      r = run(wk({ nights: N({ tue: FAK }) }), base, "2026-01-19", { env: { silvisActive: false } });
      check("editor: rule inactive (silvisRule.enabled=false / code off roster) → no gate", r.out === "CONTINUED" && quiet(r), r.threw || J(r.log));
      r = run(wk({ nights: N({ tue: "s2" }) }), base, "2026-01-19");
      check("editor: another surgeon on FAK's Silvis day → allowed", r.out === "CONTINUED" && quiet(r), r.threw || J(r.log));
      r = run(wk({ nights: N({ tue: FAK }) }), base, "2026-01-19", { env: { silvisDays: { primary: new Set(), backup: new Set(), fetchedAt: null } } });
      check("editor: an empty primary SET blocks nothing at the editor (feed HEALTH is a separate, always-visible signal: Warnings line + doGenerate gate)", r.out === "CONTINUED" && quiet(r), r.threw || J(r.log));
    }
  }

  // O3 — feed failure keeps the cache
  {
    let rejected = false, seenUrl = "";
    setFetch(async (url) => { seenUrl = String(url); return { ok: false, status: 500, json: async () => ({}) }; });
    try { await sf.sfLoadFeed("https://x.supabase.co", {}); } catch (e) { rejected = /HTTP 500/.test(String(e.message)); }
    check("sfLoadFeed: HTTP 500 → REJECTS (a failed read never resolves to 'no Silvis days')", rejected);
    check("sfLoadFeed reads THIS project's silvis_feed cache (never the Silvis project)", /\/rest\/v1\/silvis_feed\?select=day,primary_code,backup_code,fetched_at/.test(seenUrl), seenUrl);
    setFetch(async () => ({ ok: true, status: 200, json: async () => ({ message: "not an array" }) }));
    rejected = false;
    try { await sf.sfLoadFeed("https://x.supabase.co", {}); } catch (e) { rejected = /non-array/.test(String(e.message)); }
    check("sfLoadFeed: non-array body → rejects", rejected);
    setFetch(async () => ({ ok: false, status: 502, json: async () => ({ error: "silvis fetch failed — cache untouched" }) }));
    rejected = false;
    try { await sf.sfRefreshFeed("https://x.supabase.co", {}); } catch (e) { rejected = /502/.test(String(e.message)) && /cache untouched/.test(String(e.message)); }
    check("sfRefreshFeed: function 502 → rejects carrying the function's reason", rejected);
    setFetch(async () => ({ ok: false, status: 401, json: async () => { throw new Error("no body"); } }));
    rejected = false;
    try { await sf.sfRefreshFeed("https://x.supabase.co", {}); } catch (e) { rejected = /401/.test(String(e.message)); }
    check("sfRefreshFeed: 401 (not signed in) → rejects even with an unparseable body", rejected);
    let seenHeaders = null;
    setFetch(async (url, opts) => { seenHeaders = (opts && opts.headers) || {}; return { ok: true, status: 200, json: async () => ({ ok: true, skipped: true, reason: "cache is 3 min old (< 15)" }) }; });
    const sk = await sf.sfRefreshFeed("https://x.supabase.co", { Authorization: "Bearer t" });
    check("sfRefreshFeed: no force → no x-force-refresh header (the app-load path rides the 15-min gate); a skipped answer resolves",
      sk && sk.skipped === true && !("x-force-refresh" in seenHeaders) && seenHeaders.Authorization === "Bearer t", J(seenHeaders));
    await sf.sfRefreshFeed("https://x.supabase.co", { Authorization: "Bearer t" }, true);
    check("sfRefreshFeed: force=true → x-force-refresh: 1 alongside the auth headers (the Refresh button)",
      seenHeaders["x-force-refresh"] === "1" && seenHeaders.Authorization === "Bearer t", J(seenHeaders));

    const loadBody = (() => {
      const b = cut("  const loadSilvisFeed = async (quiet) => {", "  // Refresh = ask the silvis-feed edge function", "loadSilvisFeed");
      if (b === null) return null;
      const k = b.lastIndexOf("};");
      return k === -1 ? null : b.slice(0, k);
    })();
    let loadFeed = null;
    if (loadBody !== null) {
      try {
        loadFeed = vm.runInContext(`(function (env) {
          const { SUPABASE_URL, dbHeaders, setSilvisRows, setSilvisLoadError, showToast, console, silvisRowsRef, silvisLoadSeqRef } = env;
          return (async (quiet) => {${loadBody}});
        })`, sandbox, { filename: "load-silvis-feed-extract.js" });
        check("loadSilvisFeed compiles standalone", true);
      } catch (ex) { check("loadSilvisFeed compiles standalone", false, String(ex)); }
    }
    if (loadFeed) {
      const ONE = [{ day: "2026-01-20", primary_code: "FAK", backup_code: null, fetched_at: "2026-09-24T10:00:00Z" }];
      const mkEnv = (prior) => {
        const log = { rows: [], errs: [], toasts: [] };
        return { log, env: {
          SUPABASE_URL: "https://x.supabase.co", dbHeaders: {},
          setSilvisRows: (r) => log.rows.push(r), setSilvisLoadError: (e) => log.errs.push(e),
          showToast: (m, k) => log.toasts.push({ m, k }), console: { error: () => {}, warn: () => {}, log: () => {} },
          silvisRowsRef: { current: prior || [] }, silvisLoadSeqRef: { current: 0 },
        } };
      };
      let t = mkEnv();
      setFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
      let ret = await loadFeed(t.env)(false);
      check("loadSilvisFeed: failed read → rows setter NEVER called (cache kept), error recorded, loud toast says 'kept', returns false",
        ret === false && t.log.rows.length === 0 && t.log.errs.length === 1 && typeof t.log.errs[0] === "string" && t.log.toasts.length === 1 && /kept/.test(t.log.toasts[0].m) && t.log.toasts[0].k === "error", J(t.log));
      t = mkEnv();
      setFetch(async () => { throw new Error("network down"); });
      ret = await loadFeed(t.env)(true);
      check("loadSilvisFeed: quiet network failure → still no rows write, no toast, error recorded, returns false", ret === false && t.log.rows.length === 0 && t.log.toasts.length === 0 && t.log.errs.length === 1, J(t.log));
      t = mkEnv();
      setFetch(async () => ({ ok: true, status: 200, json: async () => ONE }));
      ret = await loadFeed(t.env)(true);
      check("loadSilvisFeed: successful read → rows set once, error cleared to null, ref updated, returns true",
        ret === true && t.log.rows.length === 1 && t.log.rows[0].length === 1 && t.log.errs.length === 1 && t.log.errs[0] === null && t.env.silvisRowsRef.current.length === 1, J(t.log));
      t = mkEnv(ONE);
      setFetch(async () => ({ ok: true, status: 200, json: async () => [] }));
      ret = await loadFeed(t.env)(true);
      check("loadSilvisFeed: 200 + [] with a populated cache (the RLS-denied shape — probe rule) → NOT adopted: rows setter never called, error names '0 rows', returns false",
        ret === false && t.log.rows.length === 0 && t.log.errs.length === 1 && /0 rows/.test(String(t.log.errs[0])) && t.env.silvisRowsRef.current.length === 1, J(t.log));
      t = mkEnv([]);
      setFetch(async () => ({ ok: true, status: 200, json: async () => [] }));
      ret = await loadFeed(t.env)(false);
      check("loadSilvisFeed: 200 + [] on a fresh device → still a FAILED read (error set, loud toast), never a silent 'no Silvis call'",
        ret === false && t.log.rows.length === 0 && t.log.errs.length === 1 && t.log.toasts.length === 1, J(t.log));
      // superseded response: a slow read that resolves after a newer one must not win
      t = mkEnv(ONE);
      let resolveSlow;
      const slow = new Promise(res => { resolveSlow = res; });
      setFetch(async () => ({ ok: true, status: 200, json: async () => { await slow; return [{ day: "2026-01-01", primary_code: "OLD", backup_code: null, fetched_at: "2026-09-01T00:00:00Z" }]; } }));
      const p1 = loadFeed(t.env)(true);
      setFetch(async () => ({ ok: true, status: 200, json: async () => ONE }));
      const p2 = loadFeed(t.env)(true);
      await p2; resolveSlow(); await p1;
      check("loadSilvisFeed: a slower, older read that resolves AFTER a newer one is dropped (newest read wins)",
        t.log.rows.length === 1 && t.log.rows[0][0].day === "2026-01-20", J(t.log.rows.map(r => r.map(x => x.day))));
    }
  }

  // O4 — source pins
  check("silvis-feed.js is in the classic-script load list, last", /\['config\.js','helpers\.js','generator\.js','app-styles\.js','silvis-feed\.js'\]/.test(src));
  check("the generator fold goes into `availability` exactly once…",
    count("availability[silvisFakId] = [...(availability[silvisFakId] || []), ...sfBusyRanges(silvisDays.primary)];") === 1 && count("sfBusyRanges(") === 1,
    `sfBusyRanges( ×${count("sfBusyRanges(")}`);
  check("…and generate() still receives the untouched `vacations` map as its trailing-edge (vacationsOnly) argument",
    count("generate(surgeons, mondays, availability, backupMondaySet, priorCounts, prefs, fierceBackupSet, holidayAssignments, pendingLocks, prevWeekSeed, vacations, year1Counts)") === 1
    && count("vacations[silvisFakId]") === 0);
  check("doGenerate: feed-health + coverage gate confirms BEFORE generating; dropped locks are toasted AFTER",
    count("Rule silvisBusy is BLIND for part or all of this period") === 1 && count("NOT honored by the generator") === 1
    && src.indexOf("Rule silvisBusy is BLIND") < src.indexOf("const result = generate(surgeons, mondays, availability") && src.indexOf("const result = generate(surgeons, mondays, availability") < src.indexOf("NOT honored by the generator"));
  check("FAK is resolved by roster CODE (name), never a literal id",
    count('surgeons.find(s => (s.name || "").toUpperCase() === want)') === 1 && !/silvisFakId\s*=\s*["']s\d+["']/.test(src));
  check("the rule is DATA: read from the blob on load AND on poll/realtime, reset on restore, saved back in the bundle",
    count("if (d.silvisRule) setSilvisRule(sfRule(d.silvisRule));") === 2 && count("setSilvisRule(d.silvisRule ? sfRule(d.silvisRule) : SF_RULE_DEFAULT);") === 1 && /\n\s*silvisRule,\r?\n/.test(src));
  // Every memoized mutation callback that consults the rule must list the
  // silvis values in its deps — otherwise its closure freezes on the first
  // render's "feed empty / rule inactive" values and the gate silently never
  // fires (the stale-closure class). Declaration ORDER is §P's job.
  const depsOf = (decl) => {
    const i = src.indexOf(decl); if (i === -1) return null;
    const j = src.indexOf("\n  }, [", i); if (j === -1) return null;
    return src.slice(j, src.indexOf("]);", j) + 3);
  };
  for (const [decl, need] of [
    ["const acceptTradeRequest = useCallback(", ["silvisActive", "silvisBlock", "silvisRefuse"]],
    ["const executeTwoWaySwap = useCallback(", ["silvisActive", "silvisBlock", "silvisRefuse"]],
    ["const findSwapSuggestions = useCallback(", ["silvisActive", "silvisFakId", "silvisDays"]],
    ["const saveWeekEdits = useCallback(", ["silvisActive", "silvisFakId", "silvisDays", "silvisBlock", "silvisRefuse"]],
    ["const swapHolidaySurgeon = useCallback(", ["silvisActive", "silvisFakId", "silvisDays", "silvisRefuse"]],
    ["const generateHolidayAssignments = useCallback(", ["silvisActive", "silvisFakId", "silvisDays"]],
    ["const submitTradeRequest = useCallback(", ["schedule", "silvisActive", "silvisBlock", "silvisRefuse"]],
  ]) {
    const d = depsOf(decl);
    check(`${decl.split(" ")[1]} lists its silvis deps (${need.join(", ")})`, !!d && need.every(n => new RegExp("[\\[, ]" + n + "[,\\]]").test(d)), d || "deps not found");
  }
  check("silvisBlock/silvisRefuse are stable useCallbacks with their own deps",
    count("}, [silvisActive, silvisFakId, silvisDays]);") >= 1 && count("}, [isScheduler, userProfile]);") === 1);
  check("every refusal call site hands silvisBlock the week row (holiday/override precedence): accept ×3, two-way ×2, one-way, lock, pending rows, propose ×2, submit ×2",
    count("silvisBlock(req.to_surgeon_id, req.week_monday, req.shift_key, schedule[req.week_monday])") === 1
    && count("silvisBlock(req.from_surgeon_id, req.return_week, req.return_shift, schedule[req.return_week])") === 1
    && count("silvisBlock(ch.to, ch.week, ch.shiftKey, schedule[ch.week])") === 3
    && count("silvisBlock(candId, targetMon, targetShift, schedule[targetMon])") === 1
    && count("silvisBlock(targetOldId, returnMon, returnShift, schedule[returnMon])") === 1
    && count("silvisBlock(newId, mStr, shift, schedule[mStr])") === 1
    && count("silvisBlock(newLockSurgeon, newLockWeek, newLockSlot, schedule[newLockWeek])") === 1
    && count("silvisBlock(tradeTo, tradeWeek, tradeShift, schedule[tradeWeek])") === 2
    && count("silvisBlock(tradeFrom, tradeReturnWeek, tradeReturnShift, schedule[tradeReturnWeek])") === 2
    && count("silvisBlock(r.to_surgeon_id, r.week_monday, r.shift_key, schedule[r.week_monday])") === 1
    && (src.match(/silvisBlock\([^)]*\)/g) || []).every(c => /schedule\[|, oldWk\)/.test(c) || /silvisBlock\(id, mondayStr, slotKey, wk\)/.test(c)),
    (src.match(/silvisBlock\([^)]*\)/g) || []).filter(c => !/schedule\[|, oldWk\)|slotKey, wk\)/.test(c)).join(" | "));
  check("the generic calendar cell renderer skips Silvis rows (they drew as a bogus 'N FAK' night)",
    count('||e.type==="Holiday"||e.type==="Silvis") return false;') === 1);
  // calData holds DAVENPORT call types only (owner decision 2026-09-24: Silvis
  // days come OFF the calendar; a Show-bar toggle + FAK's Mine section follow
  // and must read silvisDays directly, never through calData). #55 pushed
  // {type:"Silvis"} rows into calData; the cell's generic S/N/W predicate is a
  // DENY-list that renders anything not Svc/Wknd as a NIGHT, so every Silvis
  // day ALSO drew as a purple "N FAK" chip — a Davenport night he did not
  // hold — live 2026.09.24a → 24d, on ?public=1 and the OR board too. The
  // original pin counted a gated marker STRING: true as text, false as
  // behavior. BEHAVIORAL pin: the real calData memo body runs on a fixture
  // and must emit no foreign type and no FAK row on a Silvis date; the
  // positive control runs the VERBATIM generic predicate + label logic on his
  // real Mon night and must render "N FAK" — so the pin cannot pass vacuously.
  {
    const START = "  const calData = useMemo(() => {";
    const s0 = src.indexOf(START), e0 = s0 === -1 ? -1 : src.indexOf("\n  }, [", s0);
    const depsLine = e0 === -1 ? "" : src.slice(e0, src.indexOf("]);", e0) + 3).replace(/\s+/g, " ").trim();
    check("calData memo extractable", s0 !== -1 && e0 !== -1 && src.indexOf(START, s0 + 1) === -1, s0 + ".." + e0);
    check("calData deps are exactly [schedule, appShifts] — no silvis input feeds the calendar data", depsLine === "}, [schedule, appShifts]);", depsLine);
    const P0 = "{entries.filter(e=>{", P1 = "}).map((e,j)=>{";
    const p0 = src.indexOf(P0), p1 = p0 === -1 ? -1 : src.indexOf(P1, p0);
    const LABEL = 'const label = isD?"S":isW?"W":"N";';
    check("generic S/N/W cell predicate extractable and still a DENY-list (Fierce, FierceBkp, APP, Holiday[, Silvis]) with the N-by-default label",
      p0 !== -1 && p1 !== -1 && src.indexOf(LABEL, p1) !== -1 && src.indexOf(LABEL, p1) - p1 < 400
      && /if\(e\.type==="Fierce"\|\|e\.type==="FierceBkp"\|\|e\.type==="APP"\|\|e\.type==="Holiday"(\|\|e\.type==="Silvis")?\) return false;/.test(src.slice(p0, p1)));
    if (s0 !== -1 && e0 !== -1 && p0 !== -1 && p1 !== -1) {
      let built = null, pred = null;
      try {
        built = vm.runInContext("(function (env) { const { schedule, appShifts, silvisDays, silvisFakId, silvisActive, isPublicMode } = env; return (() => {" + src.slice(s0 + START.length, e0) + "})(); })", sandbox, { filename: "caldata-extract.js" });
        pred = vm.runInContext("(function (env) { const { calFilters, sf, calDeptFilter, SURGEON_DEPTS, sMap } = env; return (e=>{" + src.slice(p0 + P0.length, p1) + "}); })", sandbox, { filename: "cell-predicate-extract.js" });
        check("calData memo + generic predicate compile standalone", true);
      } catch (ex) { check("calData memo + generic predicate compile standalone", false, String(ex)); }
      if (built && pred) {
        const FAK = "s6";
        // one week: FAK holds a REAL Mon night; Silvis PRIMARY = that week's Saturday; BACKUP = a Wednesday he does not hold.
        // silvisActive:true + isPublicMode:false = the most permissive state #56's gate allowed — nothing may leak even here.
        const fixture = { "2026-10-19": { dayCall: "s1", nights: { mon: FAK, tue: "s2", wed: "s3", thu: "s4", wknd: "s5" } } };
        const d = built({ schedule: fixture, appShifts: {}, silvisDays: { primary: new Set(["2026-10-24"]), backup: new Set(["2026-10-21"]), fetchedAt: null, from: "2026-09-17", to: "2027-01-03" }, silvisFakId: FAK, silvisActive: true, isPublicMode: false });
        const all = Object.values(d).flat();
        check("calData carries NO Silvis-type entry anywhere (Davenport call types only), even internal with the rule ON", !all.some(e => e.type === "Silvis"), JSON.stringify([...new Set(all.map(e => e.type))]));
        check("no FAK entry on his Silvis PRIMARY Saturday (10-24) nor his BACKUP Wednesday (10-21) — he holds no Davenport call there",
          !(d["2026-10-24"] || []).some(e => e.surgeon === FAK) && !(d["2026-10-21"] || []).some(e => e.surgeon === FAK), JSON.stringify({ sat: d["2026-10-24"], wed: d["2026-10-21"] }));
        check("every calData type is one the cell renderer knows (Svc/Wknd/Ngt, B- variants, Fierce, FierceBkp, Holiday, APP)",
          all.every(e => /^(B-)?(Svc|Wknd|Ngt)$|^(Fierce|FierceBkp|Holiday|APP)$/.test(e.type)), JSON.stringify([...new Set(all.map(e => e.type))]));
        // POSITIVE CONTROL — the pin must not pass vacuously
        const monNight = (d["2026-10-19"] || []).find(e => e.type === "Ngt" && e.surgeon === FAK);
        const env = { calFilters: { svc: true, wknd: true, night: true, app: true, fierce: true }, sf: "", calDeptFilter: "", SURGEON_DEPTS: {}, sMap: { s6: { name: "FAK", idx: 5 } } };
        const label = (e) => { const isD = e.type.includes("Svc"); const isW = e.type.includes("Wknd"); return isD ? "S" : isW ? "W" : "N"; };
        check("POSITIVE CONTROL: his real Mon night (10-19) IS in calData and the verbatim predicate renders it \"N FAK\"",
          !!monNight && pred(env)(monNight) === true && label(monNight) === "N" && env.sMap[monNight.surgeon].name === "FAK", JSON.stringify(monNight));
        check("MECHANISM: the deny-list predicate renders any foreign type as a NIGHT chip — why a non-Davenport row in calData is a phantom \"N\"",
          pred(env)({ type: "Foreign", surgeon: FAK }) === true && label({ type: "Foreign" }) === "N");
        check("controls behave: Night filter off hides it; a surgeon filter to someone else hides it; Holiday and a stray Silvis row are excluded",
          pred(Object.assign({}, env, { calFilters: Object.assign({}, env.calFilters, { night: false }) }))(monNight) === false
          && pred(Object.assign({}, env, { sf: "s4" }))(monNight) === false
          && pred(env)({ type: "Holiday", surgeon: FAK }) === false && pred(env)({ type: "Silvis", surgeon: FAK }) === false);
      }
    }
  }
  check("no Silvis marker in the cell renderer and no Silvis in the legend (owner decision 2026-09-24)",
    count('entries.filter(e=>e.type==="Silvis")') === 0 && count("Silvis P</span>") === 0 && count("Silvis B</span>") === 0
    && (() => { const k = src.indexOf("</span> Holiday Coverage</span>"); return k !== -1 && !/Silvis/.test(src.slice(Math.max(0, k - 2500), k + 300)); })());
  check("the Silvis feed card stays internal-only; refresh only when signed in (the card moves in the next PR)",
    count("rule silvisBusy (internal views only)") === 1 && count("sign in to refresh") === 1);
  check("the warnings memo and the marker list are gated OFF public mode",
    count("if (!silvisActive || isPublicMode) return [];") === 2);
  check("accept path: the silvisBusy check sits BEFORE the fail-closed status PATCH (a refused trade stays pending)", (() => {
    const i = src.indexOf("const acceptTradeRequest = useCallback(");
    const a = src.indexOf("if (silvisRefuse(hits)) return;", i), b = src.indexOf("Fail-closed status write", i);
    return i !== -1 && a !== -1 && b !== -1 && a < b;
  })());
  check("propose path: refused BEFORE the shift_trade_requests insert; the card previews the conflict (legs + cascades); pending rows carry the badge",
    (() => { const i = src.indexOf("const submitTradeRequest = useCallback("); const a = src.indexOf("if (silvisRefuse(hits)) return;", i); const b = src.indexOf('db.insert("shift_trade_requests"', i); return a !== -1 && b !== -1 && a < b; })()
    && count("this trade {(isScheduler || userProfile?.role === \"admin\") ? \"needs a scheduler override to be accepted\" : \"cannot be accepted\"}") === 1
    && count("🔴 Silvis conflict — {(isScheduler || userProfile?.role === \"admin\") ? \"scheduler override only\" : \"cannot be accepted\"}") === 1);
  check("member branch refuses with a MODAL (alert: every reason + what to do), never a toast; a scheduler override is audited",
    /if \(!canOverride\) \{[\s\S]{0,400}alert\(`⛔ Blocked by rule silvisBusy[\s\S]{0,500}return true;/.test(src)
    && count('logAudit("silvis.override"') === 1 && count('showToast("Blocked — "') === 0);
  check("exactly 7 refusal sites: editor, trade accept, trade propose, two-way swap, one-way swapShift, holiday swap, manual lock",
    count("silvisRefuse(") === 7, `found ${count("silvisRefuse(")}`);
  check("swap suggestions: candidates never get FAK's Silvis slot AND FAK is never offered a return leg on his Silvis day (3 legs)",
    count("candId === silvisFakId && sfConflict(silvisDays.primary, mondayStr, shift)) eligible = false;") === 1 && count("!silvisRet(") === 3);
  check("holidays: pool + Christmas + presets + swap all test the dates the role REALLY holds (holDatesFor / slot parity), incl. the Fri/Sun weekend leg",
    count("holDatesFor(hol, id, \"A\")") === 1 && count("holDatesFor(hol, id, \"B\")") === 1 && count('holDatesFor(hol, fakId, "both")') === 1
    && count('holDatesFor(hol, sA, "A")') === 1 && count('holDatesFor(hol, sB, "B")') === 1
    && count('(slot === "surgeonA" ? i % 2 === 0 : i % 2 === 1)') === 1 && count("if (dow === 5) days.add(") === 2 && count("if (dow === 0) days.add(") === 2);
  check("Christmas: a Silvis primary hit leaves Christmas UNASSIGNED with a loud warning (mirrors the missing-roster path)",
    count("was NOT auto-assigned: ${nameMap[fakId]} is Silvis PRIMARY on") === 1);
  check("Schedule Warnings: feed HEALTH lines (empty / failed / stale / beyond horizon) + one dated hard line per overlap; backup touches are NOT warnings (card only)",
    count('week: "feed"') === 3 && count("lie beyond the Silvis feed horizon") === 1
    && count("Silvis primary + Davenport ${o.label}, ${md(o.day)}") === 1
    && count("Silvis backup + Davenport") === 0 && count("Backup touches (standby — no action needed)") === 1
    && count("more Silvis line") === 1);
  check("lock UI tells the truth per slot: a Service Week / Weekend lock on a Silvis-blocked day only records intent",
    count("this lock only records intent") === 1 && count("a weeknight lock overrides the rule for this generation") === 1);
  check("feed card: refresh is signed-in only, the failure copy says the cache is kept, the empty copy says the rule is BLIND, OFF vs code-not-on-roster are distinct, coverage is shown",
    count("Sign in to refresh the Silvis feed") === 1 && count("Silvis feed refresh FAILED — the cached Silvis days are kept") === 1
    && count("Rule silvisBusy is BLIND until") === 1 && count("rule silvisBusy is OFF (silvisRule.enabled = false in the config blob)") === 1
    && count("is not on the roster — rule silvisBusy is inactive") === 1 && count("covers {silvisDays.from} → {silvisDays.to}") === 1);
  check("Refresh button forces a re-pull (force = !quiet); success is toasted only when the re-read succeeded; a skipped answer never toasts undefined counts; the code comes from the rule",
    count("sfRefreshFeed(SUPABASE_URL, h, !quiet)") === 1 && count("const ok = await loadSilvisFeed(quiet);") === 1
    && count("could not re-read the cache") === 1 && count("r && r.skipped") === 1 && count("${silvisRule.code} primary on ${r.fak_primary}") === 1);
  check("loadSilvisFeed: the empty-read tripwire and the newest-read-wins sequence are wired to refs",
    count("silvisRowsRef.current = rows;") === 1 && count("++silvisLoadSeqRef.current") === 1 && count("seq !== silvisLoadSeqRef.current") === 2);
  check("app load: cached read first, then a quiet background refresh; poll re-reads quietly",
    count("await loadSilvisFeed();") === 1 && count("refreshSilvisFeed(true);") === 1 && count("loadSilvisFeed(true),") === 1);
}

// ─── P. Hook deps are declared BEFORE the hook that lists them (TDZ) ───
// 2026-09-24: build 2026.09.24a crashed for every user at render —
// "Cannot access 'silvisActive' before initialization". acceptTradeRequest's
// useCallback deps array named three consts declared ~1200 lines LATER in
// the CallSchedule body; a deps array is evaluated at render, so a later
// const/let is a temporal-dead-zone read. Babel keeps const (checked in the
// transpiled bundle), and nothing else — not the extraction tests, not the
// deps-text pins — could see it. GENERIC pin: for every useCallback/useMemo/
// useEffect deps array in the component, every identifier that has a simple
// const/let/var/function/useState declaration in the component must be
// declared at an EARLIER offset than the deps array. Names without a simple
// declaration (props, globals, destructured) are skipped, so this cannot
// false-positive on them; it CAN miss a name shadowed by an earlier local of
// the same name — acceptable (no false alarms).
{
  const c0 = src.indexOf("function CallSchedule() {");
  const c1 = src.indexOf("\nfunction ", c0 + 1); // next top-level function = end of the component
  check("CallSchedule component bounds found for the deps-order scan", c0 !== -1 && c1 > c0, c0 + ".." + c1);
  if (c0 !== -1 && c1 > c0) {
    const comp = src.slice(c0, c1);
    const declIndex = new Map();
    const declRe = /(?:^|[\s;(])(?:const|let|var)\s+(?:\[\s*)?([A-Za-z_$][\w$]*)|(?:^|\s)function\s+([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = declRe.exec(comp)) !== null) {
      const name = m[1] || m[2];
      if (!declIndex.has(name)) declIndex.set(name, m.index);
    }
    const depsRe = /\}\s*,\s*\[([^\]]*)\]\s*\)/g; // the closing of useCallback/useMemo/useEffect(..., [deps])
    const violations = [];
    let depsCount = 0, namesChecked = 0;
    while ((m = depsRe.exec(comp)) !== null) {
      const names = m[1].split(",").map(x => x.trim()).filter(Boolean).map(x => x.split(/[.?[]/)[0].trim()).filter(x => /^[A-Za-z_$][\w$]*$/.test(x));
      if (!names.length) continue;
      depsCount++;
      for (const n of names) {
        if (!declIndex.has(n)) continue;
        namesChecked++;
        if (declIndex.get(n) > m.index) {
          const line = comp.slice(0, m.index).split(/\r?\n/).length;
          const dline = comp.slice(0, declIndex.get(n)).split(/\r?\n/).length;
          violations.push(n + ": deps at component line " + line + ", declared at line " + dline);
        }
      }
    }
    check("deps-order scan covered a meaningful surface (" + depsCount + " deps arrays, " + namesChecked + " declared names)", depsCount >= 40 && namesChecked >= 100, depsCount + "/" + namesChecked);
    check("no hook deps array names a const/let/function declared LATER in the component (TDZ at render)", violations.length === 0, violations.join("; "));
    // Two-sided: the same scan over the 2026.09.24a shape must flag it.
    const bad = "  const a = useCallback(() => {}, [zzz]);\n  const zzz = 1;";
    const d = /(?:^|[\s;(])(?:const|let|var)\s+(?:\[\s*)?zzz/.exec(bad), u = /\}\s*,\s*\[([^\]]*)\]\s*\)/.exec(bad);
    check("deps-order scan: the crash shape (dep declared after its deps array) is detectable", !!d && !!u && d.index > u.index);
    // And the concrete fix: the silvisBusy block precedes every hook that lists it.
    const sb = comp.indexOf("const silvisBlock = useCallback(");
    const firstUse = comp.search(/\[[^\]]*\bsilvisBlock\b[^\]]*\]\s*\)/);
    check("silvisBusy derived state is declared before the first hook that lists silvisBlock in its deps", sb !== -1 && firstUse !== -1 && sb < firstUse, "decl " + sb + ", first deps use " + firstUse);
  }
}

// ─── Q. Dismissable Schedule Warnings (owner request 2026-09-24) ───
// A scheduler/admin can dismiss one exact warning for EVERYONE (blob field
// dismissedWarnings [{key, text, by, at}]); every viewer's panel is filtered;
// the panel no longer renders on ?public=1 / the OR board. Keys are built
// from FACTS, never from the message: a copy edit must neither resurrect nor
// hide anything, and a changed fact must produce a new key.
//   Q1 every producer object carries a key; no key reads message/label copy
//   Q2 extraction-executed: the real conflicts / vacOverlap memos + the real
//      warnShown filter on fixtures (dismiss hides; changed fact reappears;
//      copy edits keep the key)
//   Q3 storage wired in all five places (the autosave-deps trap included)
//   Q4 the real dismiss/restore handlers: scheduler-only, confirm BEFORE the
//      write, audited both ways
//   Q5 the panel reads only the filtered lists; Q6 it is internal-only
{
  const memoOf = (START) => {
    const s0 = src.indexOf(START);
    if (s0 === -1 || src.indexOf(START, s0 + 1) !== -1) return null;
    const e0 = src.indexOf("\n  }, [", s0);
    if (e0 === -1) return null;
    return { body: src.slice(s0 + START.length, e0), deps: src.slice(e0, src.indexOf("]);", e0) + 3) };
  };
  const PRODUCERS = [
    ["silvisConflicts", "  const silvisConflicts = useMemo(() => {", 5],
    ["conflicts", "  const conflicts = useMemo(() => {", 5],
    ["vacOverlapWarnings", "  const vacOverlapWarnings = useMemo(() => {", 3],
  ];
  // Q1
  const FORBIDDEN_IN_KEY = /message|sMap|SHIFT_LABELS|\.name\b|\bwho\b|\bmd\(/;
  for (const [name, START, want] of PRODUCERS) {
    const m = memoOf(START);
    if (!m) { check(`Q1 ${name} memo extractable`, false, "anchor"); continue; }
    const lines = m.body.split(/\r?\n/).filter(l => /severity: "/.test(l));
    const keyed = lines.filter(l => /\{ key: (`[^`]*`|"[^"]*"), /.test(l));
    check(`Q1 ${name}: all ${want} warning objects carry a key (found ${lines.length} objects, ${keyed.length} keyed)`, lines.length === want && keyed.length === want, lines.filter(l => !keyed.includes(l)).map(l => l.trim().slice(0, 90)).join(" | "));
    const exprs = keyed.map(l => l.match(/\{ key: (`[^`]*`|"[^"]*"), /)[1]);
    const bad = exprs.filter(e => FORBIDDEN_IN_KEY.test(e));
    check(`Q1 ${name}: no key is built from the message or display copy (names, labels)`, bad.length === 0, bad.join(" | "));
  }

  // Q2 — executed on fixtures
  const warnMemo = memoOf("  const warnShown = useMemo(() => {");
  check("Q2 warnShown filter memo extractable; deps = the three producers + dismissedWarnings", !!warnMemo && warnMemo.deps.replace(/\s+/g, " ").trim() === "}, [silvisConflicts, conflicts, vacOverlapWarnings, dismissedWarnings]);", warnMemo && warnMemo.deps);
  const confMemo = memoOf("  const conflicts = useMemo(() => {");
  const vacMemo = memoOf("  const vacOverlapWarnings = useMemo(() => {");
  if (warnMemo && confMemo && vacMemo) {
    let runConf, runVac, runShown;
    try {
      runConf = vm.runInContext("(function (env) { const { schedule, surgeons, sMap, SHIFT_LABELS } = env; return (() => {" + confMemo.body + "})(); })", sandbox, { filename: "q-conflicts.js" });
      runVac = vm.runInContext("(function (env) { const { mondays, surgeons, apps, vacations, holidayAssignments, sMap } = env; return (() => {" + vacMemo.body + "})(); })", sandbox, { filename: "q-vac.js" });
      runShown = vm.runInContext("(function (env) { const { silvisConflicts, conflicts, vacOverlapWarnings, dismissedWarnings } = env; return (() => {" + warnMemo.body + "})(); })", sandbox, { filename: "q-shown.js" });
      check("Q2 conflicts / vacOverlap / warnShown memos compile standalone", true);
    } catch (ex) { check("Q2 conflicts / vacOverlap / warnShown memos compile standalone", false, String(ex)); }
    if (runConf && runVac && runShown) {
      const { fmt: F, addD: A, parse: P } = vm.runInContext("({ fmt, addD, parse })", sandbox);
      let mon = A(new Date(), 7); while (mon.getDay() !== 1) mon = A(mon, 1);
      const M = F(mon);
      const LABELS = vm.runInContext("SHIFT_LABELS", sandbox);
      const surgeons = [{ id: "s1", name: "DJA" }, { id: "s2", name: "MCC" }, { id: "s3", name: "RPC" }, { id: "s4", name: "KJH" }, { id: "s5", name: "REH" }, { id: "s6", name: "FAK" }, { id: "s7", name: "ARW" }];
      const sMap = Object.fromEntries(surgeons.map((s, i) => [s.id, { name: s.name, idx: i }]));
      const wk = (nights) => ({ [M]: { dayCall: "s1", nights: Object.assign({ mon: "s2", tue: "s3", wed: "s4", thu: "s5", wknd: "s7" }, nights) } });
      const monTue = runConf({ schedule: wk({ mon: "s6", tue: "s6" }), surgeons, sMap, SHIFT_LABELS: LABELS });
      const K = `consecutive|${M}|s6|mon+tue`;
      check("Q2 fixture FAK Mon+Tue nights → exactly one line, key built from facts", monTue.length === 1 && monTue[0].key === K, JSON.stringify(monTue.map(x => x.key)));
      const renamed = runConf({ schedule: wk({ mon: "s6", tue: "s6" }), surgeons, sMap: Object.assign({}, sMap, { s6: { name: "ZZZ", idx: 5 } }), SHIFT_LABELS: Object.assign({}, LABELS, { mon: "MONDAY (copy edit)", tue: "TUESDAY (copy edit)" }) });
      check("Q2 a COPY edit (label text, display name) changes the message but NOT the key", renamed.length === 1 && renamed[0].key === K && renamed[0].message !== monTue[0].message, JSON.stringify(renamed));
      const dismissed = [{ key: K, text: M + " · " + monTue[0].message, by: "FAK", at: "2026-09-24T00:00:00Z" }];
      const s1 = runShown({ silvisConflicts: [], conflicts: monTue, vacOverlapWarnings: [], dismissedWarnings: dismissed });
      check("Q2 dismissed {K} → filtered out of the shown list, listed as hidden (the 'N dismissed · show' list)", s1.conflicts.length === 0 && s1.hidden.length === 1 && s1.hidden[0].key === K, JSON.stringify(s1));
      const tueWed = runConf({ schedule: wk({ mon: "s2", tue: "s6", wed: "s6" }), surgeons, sMap, SHIFT_LABELS: LABELS });
      const s2 = runShown({ silvisConflicts: [], conflicts: tueWed, vacOverlapWarnings: [], dismissedWarnings: dismissed });
      check("Q2 the nights CHANGE to Tue+Wed → a different key → shown despite the old dismissal; the stale dismissal is not counted as hidden",
        tueWed.length === 1 && tueWed[0].key === `consecutive|${M}|s6|tue+wed` && s2.conflicts.length === 1 && s2.hidden.length === 0, JSON.stringify({ keys: tueWed.map(x => x.key), s2 }));
      const s3 = runShown({ silvisConflicts: [], conflicts: monTue, vacOverlapWarnings: [], dismissedWarnings: [] });
      check("Q2 nothing dismissed → the line is shown (the filter is not vacuous)", s3.conflicts.length === 1 && s3.hidden.length === 0);
      // vacOverlap: surgeons-off key is the SORTED id set — order of the roster never changes it
      const day = F(A(mon, 2));
      const vacs = {}; ["s5", "s1", "s4", "s2", "s3"].forEach(id => { vacs[id] = [[day, day]]; });
      const v1 = runVac({ mondays: [mon], surgeons, apps: [], vacations: vacs, holidayAssignments: {}, sMap });
      const v2 = runVac({ mondays: [mon], surgeons: [...surgeons].reverse(), apps: [], vacations: vacs, holidayAssignments: {}, sMap });
      const vk = `surgeons-off|${day}|s1+s2+s3+s4+s5`;
      check("Q2 surgeons-off key = date + SORTED ids; roster order does not change it (the message's name order does)",
        v1.length === 1 && v1[0].key === vk && v2.length === 1 && v2[0].key === vk && v1[0].message !== v2[0].message, JSON.stringify([v1, v2].map(v => v.map(x => [x.key, x.message]))));
    }
  }

  // Q3 — storage wiring (a missing site fails silently in production)
  check("Q3 state declared once, beside silvisRule (above every hook that lists it — §P)", count("const [dismissedWarnings, setDismissedWarnings] = useState([]);") === 1
    && src.indexOf("const [dismissedWarnings, setDismissedWarnings]") > src.indexOf("const [silvisRule, setSilvisRule]") && src.indexOf("const [dismissedWarnings, setDismissedWarnings]") - src.indexOf("const [silvisRule, setSilvisRule]") < 1500);
  check("Q3 buildStateBundle carries dismissedWarnings", /\n\s*silvisRule,\r?\n\s*dismissedWarnings,\r?\n\s*\.\.\.overrides,/.test(src));
  {
    const ADOPT = "if (Array.isArray(d.dismissedWarnings)) setDismissedWarnings(d.dismissedWarnings);";
    const poll = src.indexOf("const refreshScheduleRow = async () => {");
    const first = src.indexOf(ADOPT), second = src.indexOf(ADOPT, first + 1);
    check("Q3 adopted on the INITIAL blob load (before refreshScheduleRow) and in refreshScheduleRow (poll / realtime)",
      poll !== -1 && first !== -1 && first < poll && second > poll && second - poll < 3500 && src.indexOf(ADOPT, second + 1) === -1, `first=${first} poll=${poll} second=${second}`);
  }
  {
    const a = src.indexOf("// ─── Supabase: Auto-save on changes ───");
    const e0 = a === -1 ? -1 : src.indexOf("\n  }, [", a);
    const deps = e0 === -1 ? "" : src.slice(e0, src.indexOf("]);", e0) + 3);
    check("Q3 the AUTOSAVE effect's deps list dismissedWarnings (the effect only fires for listed fields — the trap)", /[\[,\s]dismissedWarnings[,\]]/.test(deps), deps.slice(0, 260));
  }
  check("Q3 the snapshot-restore adopter resets dismissals from the snapshot",
    count("setDismissedWarnings(Array.isArray(d.dismissedWarnings) ? d.dismissedWarnings : []);") === 1);

  // Q4 — the real handlers, executed
  const bodyOf = (START) => { const s0 = src.indexOf(START); if (s0 === -1 || src.indexOf(START, s0 + 1) !== -1) return null; const e0 = src.indexOf("\n  };", s0); return e0 === -1 ? null : src.slice(s0 + START.length, e0); };
  const dismissBody = bodyOf("  const dismissWarning = (x) => {");
  const restoreBody = bodyOf("  const restoreWarning = (d) => {");
  const lineTextSrc = (src.match(/  const warnLineText = \(x\) => [^\n]*;/) || [])[0];
  const actorSrc = (src.match(/  const warnActor = \(\) => [^\n]*;/) || [])[0];
  check("Q4 dismiss / restore handlers + line-text + actor helpers extractable", !!dismissBody && !!restoreBody && !!lineTextSrc && !!actorSrc);
  if (dismissBody && restoreBody && lineTextSrc && actorSrc) {
    let mk;
    try {
      mk = vm.runInContext(`(function (env) {
        const { canWriteBlob, confirm, setDismissedWarnings, logAudit, userProfile, surgeons } = env;
        ${lineTextSrc}
        ${actorSrc}
        const dismissWarning = (x) => {${dismissBody}
        };
        const restoreWarning = (d) => {${restoreBody}
        };
        return { dismissWarning, restoreWarning };
      })`, sandbox, { filename: "q-handlers.js" });
      check("Q4 handlers compile standalone", true);
    } catch (ex) { check("Q4 handlers compile standalone", false, String(ex)); }
    if (mk) {
      const LINE = { key: "consecutive|2026-09-21|s6|mon+tue", week: "2026-09-21", severity: "error", message: "FAK has consecutive nights (Mon Night + Tue Night)" };
      const TEXT = "2026-09-21 · FAK has consecutive nights (Mon Night + Tue Night)";
      const rig = (opts) => {
        const log = [];
        let state = opts.initial || [];
        const env = {
          canWriteBlob: opts.canWriteBlob !== false,
          confirm: (m) => { log.push(["confirm", m]); return !!opts.yes; },
          setDismissedWarnings: (f) => { state = typeof f === "function" ? f(state) : f; log.push(["set", state]); },
          logAudit: (action, summary, details) => log.push(["audit", action, summary, details]),
          userProfile: { display_name: "FAK", person_id: "s6" }, surgeons: [{ id: "s6", name: "FAK" }],
        };
        return { h: mk(env), log, state: () => state };
      };
      let r = rig({ canWriteBlob: false, yes: true });
      r.h.dismissWarning(LINE);
      check("Q4 a MEMBER (canWriteBlob false) cannot dismiss: no confirm, no write, no audit", r.log.length === 0, JSON.stringify(r.log));
      r = rig({ yes: false });
      r.h.dismissWarning(LINE);
      check("Q4 scheduler declines the confirm → nothing written, nothing audited; the confirm QUOTES the line",
        r.log.length === 1 && r.log[0][0] === "confirm" && r.log[0][1].includes(TEXT) && /EVERYONE/.test(r.log[0][1]), JSON.stringify(r.log));
      r = rig({ yes: true });
      r.h.dismissWarning(LINE);
      const st = r.state();
      check("Q4 scheduler confirms → confirm FIRST, then the write {key,text,by,at}, then the audit row warning_dismissed \"<name> dismissed: <line>\" {key}",
        r.log.map(x => x[0]).join(">") === "confirm>set>audit" && st.length === 1 && st[0].key === LINE.key && st[0].text === TEXT && st[0].by === "FAK" && typeof st[0].at === "string"
        && r.log[2][1] === "warning_dismissed" && r.log[2][2] === "FAK dismissed: " + TEXT && JSON.stringify(r.log[2][3]) === JSON.stringify({ key: LINE.key }), JSON.stringify(r.log));
      r = rig({ yes: true, initial: [{ key: LINE.key, text: TEXT, by: "FAK", at: "x" }, { key: "other", text: "o", by: "FAK", at: "x" }] });
      r.h.dismissWarning(LINE);
      check("Q4 dismissing an already-dismissed key replaces it (no duplicates)", r.state().filter(d => d.key === LINE.key).length === 1 && r.state().length === 2);
      r = rig({ initial: [{ key: LINE.key, text: TEXT, by: "FAK", at: "x" }, { key: "other", text: "o", by: "FAK", at: "x" }] });
      r.h.restoreWarning({ key: LINE.key, text: TEXT });
      check("Q4 restore → the key leaves the list (others kept) and the audit row warning_restored \"<name> restored: <line>\" {key} is written",
        r.state().length === 1 && r.state()[0].key === "other" && r.log.some(x => x[0] === "audit" && x[1] === "warning_restored" && x[2] === "FAK restored: " + TEXT && JSON.stringify(x[3]) === JSON.stringify({ key: LINE.key })), JSON.stringify(r.log));
      r = rig({ canWriteBlob: false, initial: [{ key: LINE.key, text: TEXT }] });
      r.h.restoreWarning({ key: LINE.key, text: TEXT });
      check("Q4 a MEMBER cannot restore either", r.log.length === 0 && r.state().length === 1);
    }
  }
  check("Q4 controls render only for canWriteBlob: the ✕ per line and the 'N dismissed · show' bar",
    // (2026-09-24: the ✕ also requires a dismissable line — section S owns that half)
    count("const dismissBtn = (x) => (canWriteBlob && x.key && x.dismissable !== false) ? (") === 1 && count("const dismissedBar = (canWriteBlob && warnShown.hidden.length > 0) ? (") === 1
    && count("{dismissBtn(c)}") === 2 && count("{dismissBtn(w)}") === 1);

  // Q5 / Q6 — the panel
  {
    const a = src.indexOf("Schedule Warnings — INTERNAL ONLY");
    const b = a === -1 ? -1 : src.indexOf("{dismissedBar}", src.indexOf("+ more…", a));
    const panel = a !== -1 && b !== -1 ? src.slice(a, b) : "";
    check("Q5 panel region found", panel.length > 0);
    check("Q5 the panel reads ONLY the filtered lists — header count, lines and both '+ more' notes (no raw producer reference)",
      panel.length > 0 && !/(^|[^.\w])(conflicts|silvisConflicts|vacOverlapWarnings)\b/.test(panel)
      && /const shownTotal = warnShown\.silvis\.length \+ warnShown\.conflicts\.length \+ warnShown\.vac\.length;/.test(panel)
      && panel.includes("⚠️ Schedule Warnings — {shownTotal}") && panel.includes("warnShown.silvis.length > 10") && panel.includes("(warnShown.conflicts.length + warnShown.vac.length) > 20"));
    check("Q5 nothing undismissed → no panel (only a scheduler's small dismissed bar)", panel.includes("if (shownTotal === 0) return dismissedBar ? <div style={{marginBottom:10}}>{dismissedBar}</div> : null;"));
    check("Q6 the panel is gated OFF ?public=1 and the OR board (owner decision 2026-09-24)",
      /\{!isPublicMode && \(\(\)=>\{\s*const shownTotal = warnShown\.silvis\.length/.test(src) && count("Schedule Warnings — {") === 1);
  }
}

// ─── R. Silvis on demand: the 🚑 calendar switch + FAK's Mine section (2026-09-24) ───
// Owner decision: FAK's Silvis days stay OFF the calendar by default for
// everyone; a "🚑 Silvis" Show-bar switch turns them on (partners, and office
// staff on ?public=1 — deliberately reversing #55's "public never shows
// Silvis": public/OR viewers see it only when THEY turn it on), ?silvis=1
// forces it on at load, the device remembers an explicit choice, and FAK's
// Mine tab lists his days. INVARIANT from #57: calData stays Davenport-only —
// the chip reads silvisDays via sfCellChip, never a calData row.
{
  const R = vm.runInContext("({ sfUpcoming, sfRowLabel, sfDayLabel, sfCellChip, sfNotice, sfResolveToggle, sfDaysFromRows })", sandbox);
  // R1 — one source of defaults, module level, silvis:false
  {
    const line = (src.match(/\nconst CAL_FILTER_DEFAULTS = Object\.freeze\(\{[^\n]*\}\);/) || [])[0];
    const decl = src.indexOf("const CAL_FILTER_DEFAULTS"), comp = src.indexOf("function CallSchedule() {");
    check("R1 CAL_FILTER_DEFAULTS is declared at MODULE level, before the component (a const read before its declaration = the 24a crash class)", !!line && decl !== -1 && comp !== -1 && decl < comp);
    let D = null;
    try { D = vm.runInContext("(() => {" + (line || "") + "\n return CAL_FILTER_DEFAULTS; })()", sandbox); } catch (ex) { /* reported below */ }
    check("R1 defaults: silvis:false, every other layer on", !!D && D.silvis === false && ["svc", "night", "wknd", "app", "fierce", "vac", "appOff"].every(k => D[k] === true) && Object.isFrozen(D), JSON.stringify(D));
    check("R1 the single source feeds useState (via the resolver), the Reset handler and the differs-check; no hard-coded filter literal remains",
      count("return { ...CAL_FILTER_DEFAULTS, silvis: sfResolveToggle(param, stored) };") === 1
      && count("setCalFilters({ ...CAL_FILTER_DEFAULTS });") === 1
      && count("const calFiltersDiffer = Object.keys(CAL_FILTER_DEFAULTS).some(k => calFilters[k] !== CAL_FILTER_DEFAULTS[k]);") === 1
      && count("(calFiltersDiffer || calSurgeonFilter ||") === 1
      && count("setCalFilters({svc:") === 0 && count("useState({ svc: true") === 0 && count("Object.values(calFilters).some(v=>!v)") === 0);
    const dl = (src.match(/  const calFiltersDiffer = [^\n]*;/) || [])[0];
    let differ = null;
    try { differ = vm.runInContext("(function (CAL_FILTER_DEFAULTS, calFilters) {" + dl + " return calFiltersDiffer; })", sandbox); } catch (ex) { /* below */ }
    check("R1 Reset hidden at defaults; shown with Silvis ON or any layer off (the default-OFF filter no longer pins Reset on forever)",
      !!differ && !!D && differ(D, Object.assign({}, D)) === false && differ(D, Object.assign({}, D, { silvis: true })) === true && differ(D, Object.assign({}, D, { night: false })) === true);
  }
  // R2 — the resolver: param → stored → off
  check("R2 resolver: nothing set → OFF", R.sfResolveToggle(null, null) === false && R.sfResolveToggle("", "") === false && R.sfResolveToggle(null, "garbage") === false);
  check("R2 resolver: ?silvis=1 wins over a stored 'false'; ?silvis=0 wins over a stored 'true'", R.sfResolveToggle("1", "false") === true && R.sfResolveToggle("0", "true") === false && R.sfResolveToggle("on", null) === true);
  check("R2 resolver: no param → the device's remembered choice", R.sfResolveToggle(null, "true") === true && R.sfResolveToggle(null, "false") === false);
  check("R2 only an EXPLICIT toggle is remembered (the ?silvis=1 load never writes the device default); Reset forgets it",
    count("localStorage.setItem(CAL_SILVIS_STORE_KEY") === 1 && count("if (key === \"silvis\") rememberSilvisToggle(v);") === 1 && count("rememberSilvisToggle(null);") === 1
    && /const rememberSilvisToggle = \(v\) => \{\s*try \{/.test(src));
  // R3 — the chip: its own block over silvisDays, never calData; P → one chip, zero "N FAK"
  {
    check("R3 the cell's Silvis block goes through sfCellChip over silvisDays, gated by calFilters.silvis; calData still carries no Silvis type",
      count("const chip = sfCellChip(silvisDays, ds, silvisFakId, {") === 1 && count("on: calFilters.silvis, sf,") === 1 && count("sfCellChip(") === 1
      // CODE only — the calData memo's comment names the retired {type:"Silvis"} row on purpose
      && src.split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join("\n").split('type:"Silvis"').length - 1 === 0);
    const START = "  const calData = useMemo(() => {";
    const s0 = src.indexOf(START), e0 = s0 === -1 ? -1 : src.indexOf("\n  }, [", s0);
    const P0 = "{entries.filter(e=>{", P1 = "}).map((e,j)=>{";
    const p0 = src.indexOf(P0), p1 = p0 === -1 ? -1 : src.indexOf(P1, p0);
    let built = null, pred = null;
    try {
      built = vm.runInContext("(function (env) { const { schedule, appShifts } = env; return (() => {" + src.slice(s0 + START.length, e0) + "})(); })", sandbox, { filename: "r-caldata.js" });
      pred = vm.runInContext("(function (env) { const { calFilters, sf, calDeptFilter, SURGEON_DEPTS, sMap } = env; return (e=>{" + src.slice(p0 + P0.length, p1) + "}); })", sandbox, { filename: "r-pred.js" });
    } catch (ex) { check("R3 calData memo + predicate extractable", false, String(ex)); }
    if (built && pred) {
      const FAK = "s6";
      // week 10/05: FAK is service week (his real Davenport Sat 10/10 → a "W" chip); week 10/19: FAK holds no call on Sat 10/24
      const sched = {
        "2026-10-05": { dayCall: FAK, nights: { mon: "s1", tue: "s2", wed: "s3", thu: "s4", wknd: "s5" } },
        "2026-10-19": { dayCall: "s7", nights: { mon: "s1", tue: "s2", wed: "s3", thu: "s4", wknd: "s5" } },
      };
      const rows = [
        { day: "2026-10-24", primary_code: "FAK", backup_code: "ABC", fetched_at: "2026-09-24T10:00:00Z" },
        { day: "2026-10-10", primary_code: "ABC", backup_code: "FAK", fetched_at: "2026-09-24T10:00:00Z" },
        { day: "2026-10-17", primary_code: "ABC", backup_code: "XYZ", fetched_at: "2026-09-24T10:00:00Z" },
      ];
      const days = R.sfDaysFromRows(rows, "FAK");
      const d = built({ schedule: sched, appShifts: {} });
      const env = { calFilters: { svc: true, wknd: true, night: true, app: true, fierce: true, silvis: true }, sf: "", calDeptFilter: "", SURGEON_DEPTS: {}, sMap: { s5: { name: "REH" }, s6: { name: "FAK" }, s7: { name: "ARW" } } };
      const lab = (e) => (e.type.includes("Svc") ? "S" : e.type.includes("Wknd") ? "W" : "N") + " " + (env.sMap[e.surgeon] ? env.sMap[e.surgeon].name : "?");
      const render = (ds, on) => {
        const generic = (d[ds] || []).filter(pred(env)).map(lab);
        const chip = R.sfCellChip(days, ds, FAK, { on, sf: "", deptOk: true, fakName: "FAK", ruleOn: true });
        return { generic, chips: chip ? [chip.label] : [] };
      };
      const onP = render("2026-10-24", true), offP = render("2026-10-24", false);
      check("R3 Silvis PRIMARY Sat 10/24, switch ON → exactly one '🚑 Silvis P · FAK' chip and ZERO 'N FAK'",
        onP.chips.length === 1 && onP.chips[0] === "🚑 Silvis P · FAK" && !onP.generic.includes("N FAK") && !onP.generic.some(x => /FAK/.test(x)), JSON.stringify(onP));
      check("R3 switch OFF → zero Silvis chips, and still no FAK entry that day", offP.chips.length === 0 && !offP.generic.some(x => /FAK/.test(x)), JSON.stringify(offP));
      const onB = render("2026-10-10", true);
      check("R3 Silvis BACKUP Sat 10/10 → his REAL Davenport chip 'W FAK' + a muted '🚑 Silvis B · FAK'; never an N chip",
        onB.generic.includes("W FAK") && onB.chips.length === 1 && onB.chips[0] === "🚑 Silvis B · FAK" && !onB.generic.includes("N FAK"), JSON.stringify(onB));
      const other = render("2026-10-17", true);
      check("R3 a day where ANOTHER Silvis code is primary/backup never renders (FAK's days only)", other.chips.length === 0, JSON.stringify(other));
      const pChip = R.sfCellChip(days, "2026-10-24", FAK, { on: true, fakName: "FAK", ruleOn: true });
      const bChip = R.sfCellChip(days, "2026-10-10", FAK, { on: true, fakName: "FAK" });
      check("R3 tooltips: P = 07:00 → 07:00 next day, no Davenport call may overlap; B = standby, no block; rule OFF says so",
        /07:00 → 07:00 next day — no Davenport call may overlap/.test(pChip.title) && /standby, no block/.test(bChip.title)
        && /rule silvisBusy is OFF/.test(R.sfCellChip(days, "2026-10-24", FAK, { on: true, ruleOn: false }).title));
      check("R3 the chip respects the surgeon filter and the department filter like every other entry",
        R.sfCellChip(days, "2026-10-24", FAK, { on: true, sf: "s4" }) === null && R.sfCellChip(days, "2026-10-24", FAK, { on: true, sf: FAK }) !== null
        && R.sfCellChip(days, "2026-10-24", FAK, { on: true, deptOk: false }) === null && R.sfCellChip(days, "2026-10-24", null, { on: true }) === null);
    }
  }
  // R4 — the switch exists in public mode (NOT appOffVisible-gated)
  {
    const sw = src.indexOf('{key:"silvis",label:"Silvis",color:"#1a4a9a",icon:"🚑"},');
    const gate = src.indexOf("...(appOffVisible ? [{key:\"appOff\"");
    const gateLine = gate === -1 ? "" : src.slice(gate, src.indexOf("\n", gate));
    check("R4 the 🚑 switch is in the Show bar for EVERY view — before, and outside, the appOffVisible-gated entry",
      sw !== -1 && gate !== -1 && sw < gate && gate - sw < 800 && !/silvis/.test(gateLine) && count('{key:"silvis",label:"Silvis"') === 1);
  }
  // R5 — the notice selector: distinct copy per untrustworthy state, silence only when healthy
  {
    const now = Date.parse("2026-09-24T12:00:00Z");
    const failed = R.sfNotice(0, "HTTP 500", null, now), empty = R.sfNotice(0, null, null, now);
    const kept = R.sfNotice(109, "HTTP 500", "2026-09-24T11:00:00Z", now);
    const stale = R.sfNotice(109, null, "2026-09-22T11:00:00Z", now), healthy = R.sfNotice(109, null, "2026-09-24T11:00:00Z", now);
    check("R5 no rows + load error → 'Silvis feed unavailable — last load failed; Silvis days may be missing.'", !!failed && failed.text === "Silvis feed unavailable — last load failed; Silvis days may be missing.");
    check("R5 no rows, no error → 'No Silvis days cached.'", !!empty && empty.text === "No Silvis days cached.");
    check("R5 stale → 'Silvis data is stale — fetched Xh ago.'", !!stale && /^Silvis data is stale — fetched 49h ago\.$/.test(stale.text), stale && stale.text);
    check("R5 rows kept after a failed read → its own warning (never silence); healthy → none; all copies distinct",
      !!kept && kept.kind === "failed-kept" && healthy === null && new Set([failed.text, empty.text, stale.text, kept.text]).size === 4);
    check("R5 the notice renders under the Show bar whenever the switch is on (and names a missing roster code)",
      count(": sfNotice(silvisRows.length, silvisLoadError, silvisDays.fetchedAt);") === 1 && count("{calFilters.silvis && (() => {") === 1 && count('kind: "noroster"') === 1);
  }
  // R6 — sfUpcoming
  {
    const rows = [
      { day: "2026-09-20", primary_code: "FAK", backup_code: null, fetched_at: "x" },
      { day: "2026-10-24", primary_code: "FAK", backup_code: null, fetched_at: "x" },
      { day: "2026-10-10", primary_code: "ABC", backup_code: "FAK", fetched_at: "x" },
      { day: "2026-09-24", primary_code: "FAK", backup_code: "FAK", fetched_at: "x" },
      { day: "2026-10-01", primary_code: "ABC", backup_code: "XYZ", fetched_at: "x" },
    ];
    const up = R.sfUpcoming(R.sfDaysFromRows(rows, "FAK"), "2026-09-24");
    check("R6 sfUpcoming: today onward (past dropped), soonest first, P and B, a P+B day listed once as P, FAK's days only",
      JSON.stringify(up) === JSON.stringify([{ day: "2026-09-24", role: "P" }, { day: "2026-10-10", role: "B" }, { day: "2026-10-24", role: "P" }]), JSON.stringify(up));
    check("R6 Mine section: FAK only, sfUpcoming + sfRowLabel, the empty/failed line points to Calendar → 🔧 Schedule Tools",
      count("{myId && silvisFakId && myId === silvisFakId && (() => {") === 1 && count("const up = sfUpcoming(silvisDays, fmt(new Date()));") === 1
      && count("{sfRowLabel(it)}") === 1 && count("Check Calendar → 🔧 Schedule Tools & Export.") === 1);
  }
  // R7 — labels under TZ=America/Chicago (a UTC run cannot see the defect)
  {
    const { execFileSync } = require("child_process");
    const code = `const sf = require(${JSON.stringify(path.join(ROOT, "silvis-feed.js"))});
      const off = new Date(2026, 9, 24).getTimezoneOffset();
      const naive = new Date("2026-10-24").getDay();
      process.stdout.write(JSON.stringify({ off, naive, p: sf.sfRowLabel({ day: "2026-10-24", role: "P" }), b: sf.sfRowLabel({ day: "2026-10-10", role: "B" }), l: sf.sfDayLabel("2026-10-24") }));`;
    let out = null;
    try { out = JSON.parse(execFileSync(process.execPath, ["-e", code], { env: Object.assign({}, process.env, { TZ: "America/Chicago" }), encoding: "utf8" })); } catch (ex) { out = { err: String(ex) }; }
    check("R7 the child really runs in America/Chicago (CDT offset 300) and there the NAIVE new Date('2026-10-24') is FRIDAY — the defect is visible",
      !!out && out.off === 300 && out.naive === 5, JSON.stringify(out));
    check("R7 under TZ=America/Chicago the labels read 'Sat Oct 24 · PRIMARY · 07:00 → Sun 07:00' and 'Sat Oct 10 · backup · standby, no block'",
      !!out && out.p === "Sat Oct 24 · PRIMARY · 07:00 → Sun 07:00" && out.b === "Sat Oct 10 · backup · standby, no block" && out.l === "Sat Oct 24", JSON.stringify(out));
  }
  // R8 — the office link is offered (the plain public link unchanged)
  check("R8 Settings → Office Notifications offers the office link ?public=1&silvis=1, labeled as opening with Silvis on",
    count("Office link (opens with 🚑 Silvis on): <span style={{fontFamily:mono}}>fkhan628.github.io/Call-Schedule-App/?public=1&silvis=1</span>") === 1
    && count("Public link: <span style={{fontFamily:mono}}>fkhan628.github.io/Call-Schedule-App/?public=1</span>") === 1);
}

// ─── S. Silvis feed-health warnings cannot be dismissed (owner decision 2026-09-24) ───
// "feed EMPTY", "last read FAILED" and "STALE" describe the DATA SOURCE and
// clear themselves once the feed is healthy; hiding one lets trades and edits
// go through against missing/old Silvis days unnoticed (an empty feed blocks
// nothing), and "silvis-feed|empty" is a STATIC key — one dismissal would hide
// every future outage. The horizon note stays dismissable (its key moves).
//   S1 the real silvisConflicts memo, executed: empty/failed/stale carry
//      dismissable:false; the horizon note does not
//   S2 the real warnShown filter: a STORED dismissal of a feed-health key is
//      inert (line still shown, not listed as hidden); a dismissable line
//      still hides (positive control)
//   S3 the ✕ and the handler both refuse a dismissable:false line
{
  const memoOf = (START) => {
    const s0 = src.indexOf(START);
    if (s0 === -1 || src.indexOf(START, s0 + 1) !== -1) return null;
    const e0 = src.indexOf("\n  }, [", s0);
    return e0 === -1 ? null : src.slice(s0 + START.length, e0);
  };
  const scBody = memoOf("  const silvisConflicts = useMemo(() => {");
  const wsBody = memoOf("  const warnShown = useMemo(() => {");
  let runSC = null, runWS = null;
  try {
    runSC = vm.runInContext("(function (env) { const { schedule, silvisActive, isPublicMode, nameOf, silvisFakId, silvisRows, silvisLoadError, silvisDays } = env; return (() => {" + scBody + "})(); })", sandbox, { filename: "s-silvisconflicts.js" });
    runWS = vm.runInContext("(function (env) { const { silvisConflicts, conflicts, vacOverlapWarnings, dismissedWarnings } = env; return (() => {" + wsBody + "})(); })", sandbox, { filename: "s-warnshown.js" });
    check("S silvisConflicts + warnShown memos extract and compile", !!scBody && !!wsBody);
  } catch (ex) { check("S silvisConflicts + warnShown memos extract and compile", false, String(ex)); }
  if (runSC && runWS) {
    const { fmt: F, addD: A } = vm.runInContext("({ fmt, addD })", sandbox);
    const base = { silvisActive: true, isPublicMode: false, nameOf: () => "FAK", silvisFakId: "s6", schedule: {} };
    const noDays = { primary: new Set(), backup: new Set(), fetchedAt: null, from: null, to: null };
    const freshTs = new Date(Date.now() - 3600e3).toISOString(), staleTs = new Date(Date.now() - 72 * 3600e3).toISOString();
    const ROWS = [{ day: "2026-10-24" }];
    const empty = runSC(Object.assign({}, base, { silvisRows: [], silvisLoadError: null, silvisDays: noDays }));
    const failed = runSC(Object.assign({}, base, { silvisRows: ROWS, silvisLoadError: "HTTP 500", silvisDays: Object.assign({}, noDays, { fetchedAt: freshTs }) }));
    const stale = runSC(Object.assign({}, base, { silvisRows: ROWS, silvisLoadError: null, silvisDays: Object.assign({}, noDays, { fetchedAt: staleTs }) }));
    let mon = A(new Date(), 7); while (mon.getDay() !== 1) mon = A(mon, 1);
    const M = F(mon);
    const horizon = runSC(Object.assign({}, base, { schedule: { [M]: { dayCall: "s1", nights: {} } }, silvisRows: ROWS, silvisLoadError: null, silvisDays: Object.assign({}, noDays, { fetchedAt: freshTs, to: F(A(mon, -7)) }) }));
    const one = (arr, re) => arr.filter(x => re.test(x.key));
    const e = one(empty, /^silvis-feed\|empty$/), f = one(failed, /^silvis-feed\|failed\|/), st = one(stale, /^silvis-feed\|stale\|/), h = one(horizon, /^silvis-horizon\|/);
    check("S1 feed EMPTY line is produced and carries dismissable:false", e.length === 1 && e[0].dismissable === false, JSON.stringify(empty));
    check("S1 last read FAILED line is produced and carries dismissable:false", f.length === 1 && f[0].dismissable === false, JSON.stringify(failed));
    check("S1 STALE line is produced and carries dismissable:false", st.length === 1 && st[0].dismissable === false, JSON.stringify(stale));
    check("S1 the horizon note is produced and stays DISMISSABLE (no dismissable:false)", h.length === 1 && h[0].dismissable !== false, JSON.stringify(horizon));
    // S2 — a stored dismissal of the static empty key is inert
    const s2 = runWS({ silvisConflicts: empty, conflicts: [], vacOverlapWarnings: [], dismissedWarnings: [{ key: "silvis-feed|empty", text: "Silvis feed is EMPTY", by: "FAK", at: "x" }] });
    check("S2 dismissedWarnings = [{key:'silvis-feed|empty'}] while the empty line is produced → the line is STILL SHOWN and NOT listed as hidden",
      s2.silvis.some(x => x.key === "silvis-feed|empty") && !s2.hidden.some(d => d.key === "silvis-feed|empty"), JSON.stringify(s2));
    const s2f = runWS({ silvisConflicts: failed.concat(stale), conflicts: [], vacOverlapWarnings: [], dismissedWarnings: [{ key: f[0].key }, { key: st[0].key }] });
    check("S2 stored dismissals of the FAILED and STALE keys are inert too", s2f.silvis.length === 2 && s2f.hidden.length === 0, JSON.stringify(s2f));
    const s2h = runWS({ silvisConflicts: horizon, conflicts: [], vacOverlapWarnings: [], dismissedWarnings: [{ key: h[0].key, text: "h", by: "FAK", at: "x" }] });
    check("S2 POSITIVE CONTROL: the dismissable horizon note still hides and is listed as hidden", s2h.silvis.length === 0 && s2h.hidden.length === 1, JSON.stringify(s2h));
  }
  // S3 — the control and the handler
  check("S3 the ✕ renders only for a dismissable line", count("const dismissBtn = (x) => (canWriteBlob && x.key && x.dismissable !== false) ? (") === 1);
  {
    const s0 = src.indexOf("  const dismissWarning = (x) => {"), e0 = s0 === -1 ? -1 : src.indexOf("\n  };", s0);
    const body = s0 === -1 || e0 === -1 ? null : src.slice(s0 + "  const dismissWarning = (x) => {".length, e0);
    const lineTextSrc = (src.match(/  const warnLineText = \(x\) => [^\n]*;/) || [])[0];
    const actorSrc = (src.match(/  const warnActor = \(\) => [^\n]*;/) || [])[0];
    let mk = null;
    try {
      mk = vm.runInContext(`(function (env) { const { canWriteBlob, confirm, setDismissedWarnings, logAudit, userProfile, surgeons } = env; ${lineTextSrc} ${actorSrc} return (x) => {${body}
        }; })`, sandbox, { filename: "s-dismiss.js" });
    } catch (ex) { check("S3 dismissWarning extractable", false, String(ex)); }
    if (mk) {
      const run = (x) => {
        const log = [];
        mk({ canWriteBlob: true, confirm: (m) => { log.push("confirm"); return true; }, setDismissedWarnings: () => log.push("set"), logAudit: () => log.push("audit"), userProfile: { display_name: "FAK" }, surgeons: [] })(x);
        return log;
      };
      const blocked = run({ key: "silvis-feed|empty", dismissable: false, week: "feed", severity: "error", message: "Silvis feed is EMPTY" });
      const allowed = run({ key: "consecutive|2026-09-21|s6|mon+tue", week: "2026-09-21", severity: "error", message: "FAK has consecutive nights (Mon Night + Tue Night)" });
      check("S3 dismissWarning refuses a dismissable:false line even for a scheduler (no confirm, no write, no audit); a normal line still goes through",
        blocked.length === 0 && allowed.join(">") === "confirm>set>audit", JSON.stringify({ blocked, allowed }));
    }
  }
}

// ─── T. The app's .ics exports are ALL-DAY (owner request 2026-09-25) ───
// Same format as the calendar-sync v15 feed. A service week is one Mon–Sat
// event, each weeknight one event, the weekend two events (Friday night and
// Sunday, so Saturday stays with the service-week holder), APP shifts and
// vacations one all-day event each. The exact hours live in the description.
//   T1 the real buildICSEvents: spans, weekdays, short vs coded titles,
//      month and year rollover
//   T2 the real generateICS: VALUE=DATE only, lines of at most 75 octets,
//      text escaping that unfolds back to the description
//   T3 the real buildAppICSEvents: weekday vs weekend hours
//   T4 the three export sites: the full exports name the surgeon and carry
//      APP shifts, personal exports do not; vacations are all-day; the timed
//      builder is gone
//   T5 call events show as FREE (owner decision 2026-09-25): an all-day event
//      defaults to busy, so without this an imported file blocks the whole
//      day on every call day. Every call and APP event carries transparent,
//      and generateICS writes TRANSP:TRANSPARENT (RFC 5545) plus Outlook's
//      X-MICROSOFT-CDO-BUSYSTATUS:FREE right after DTEND. Vacations carry no
//      flag and stay busy, since they are real unavailability.
{
  // A missing builder resolves to a stub that returns nothing, so its checks FAIL by name instead of crashing the run
  const T = vm.runInContext(`({ ${["buildICSEvents", "buildAppICSEvents", "generateICS"].map((f) => `${f}: typeof ${f} === "function" ? ${f} : () => []`).join(", ")} })`, sandbox);
  check("T0 buildICSEvents, buildAppICSEvents and generateICS are defined in helpers.js",
    vm.runInContext('typeof buildICSEvents + typeof buildAppICSEvents + typeof generateICS', sandbox) === "functionfunctionfunction");
  const sched = {
    "2026-11-30": { dayCall: "s6", nights: { mon: "s1", tue: "s6", thu: "s6", wknd: "s1" } },
    "2026-12-28": { dayCall: "s1", isBackup: true, nights: { wed: "s6", wknd: "s6" } },
  };
  const mine = JSON.parse(JSON.stringify(T.buildICSEvents(sched, "s6", "FAK")));
  const key = (e) => `${e.start}-${e.end} ${e.summary}`;
  const want = [
    "20261130-20261206 DSG Service Week",
    "20261201-20261202 DSG Night",
    "20261203-20261204 DSG Night",
    "20261230-20261231 DSG Night [BACKUP]",
    "20270101-20270102 DSG Weekend — Fri night [BACKUP]",
    "20270103-20270104 DSG Weekend — Sun [BACKUP]",
  ];
  check("T1 personal export: one Mon–Sat service week, one event per night, Fri + Sun weekend events, short titles, month and year rollover",
    mine.every((e) => e.allDay === true) && JSON.stringify(mine.map(key)) === JSON.stringify(want), JSON.stringify(mine.map(key)));
  const full = JSON.parse(JSON.stringify(T.buildICSEvents(sched, "s6", "FAK", { withCode: true })));
  check("T1 full export: the same events, each title ending with the surgeon code",
    full.length === want.length && full.every((e, i) => e.summary === mine[i].summary + " — FAK" && e.start === mine[i].start), JSON.stringify(full.map(key)));
  check("T1 descriptions carry the exact Central hours",
    /Mon–Fri 7:00 AM – 5:00 PM/.test(mine[0].desc) && /Sat 7:00 AM – Sun 7:00 AM/.test(mine[0].desc) && /Tue 5:00 PM – Wed 7:00 AM/.test(mine[1].desc) && /Central/.test(mine[5].desc), mine.map((e) => e.desc).join(" | "));

  const apps = JSON.parse(JSON.stringify(T.buildAppICSEvents({ "2026-12-02": "a1", "2026-12-05": "a2" }, { a1: { name: "MA" }, a2: { name: "SJ" } })));
  check("T3 APP shifts: one all-day event each, weekday 5 PM–7 AM, weekend 24h",
    apps.length === 2 && apps.every((e) => e.allDay) && key(apps[0]) === "20261202-20261203 DSG APP Call — MA" && /5:00 PM – 7:00 AM/.test(apps[0].desc)
    && key(apps[1]) === "20261205-20261206 DSG APP Call — SJ" && /7:00 AM – 7:00 AM next day \(24h\)/.test(apps[1].desc), JSON.stringify(apps.map(key)));

  const ics = String(T.generateICS([...full, ...apps, { allDay: true, start: "20261201", end: "20261204", summary: "DSG Vacation", desc: "a, b; c\\d" }], "Full Call Schedule"));
  const lines = ics.split("\r\n");
  const octets = (l) => Buffer.byteLength(l, "utf8");
  const unfolded = ics.replace(/\r\n /g, "");
  check("T2 generateICS: every event all-day (VALUE=DATE), no timed DTSTART/DTEND",
    (unfolded.match(/^DTSTART;VALUE=DATE:\d{8}$/gm) || []).length === 9 && (unfolded.match(/^DTEND;VALUE=DATE:\d{8}$/gm) || []).length === 9 && !/^DT(START|END):/m.test(unfolded));
  check("T2 generateICS: every line at most 75 octets, folded lines exist, CRLF throughout",
    lines.every((l) => octets(l) <= 75) && /\r\n /.test(ics) && !/[^\r]\n/.test(ics) && ics.endsWith("END:VCALENDAR\r\n"), lines.find((l) => octets(l) > 75));
  check("T2 generateICS: text escaped (newline, comma, semicolon, backslash) and unfolds back intact",
    unfolded.includes("DESCRIPTION:Mon–Fri 7:00 AM – 5:00 PM daytime call\\nSat 7:00 AM – Sun 7:00 AM (24h)\\nTimes are Central.") && unfolded.includes("DESCRIPTION:a\\, b\\; c\\\\d"));

  check("T5 every buildICSEvents event (personal and full) and every buildAppICSEvents event carries transparent: true",
    mine.length === 6 && full.length === 6 && apps.length === 2 && [...mine, ...full, ...apps].every((e) => e.transparent === true),
    JSON.stringify([...mine, ...full, ...apps].map((e) => e.transparent)));
  const nOf = (re) => (unfolded.match(re) || []).length;
  check("T5 generateICS: TRANSP:TRANSPARENT and X-MICROSOFT-CDO-BUSYSTATUS:FREE each appear exactly 8 times, once per flagged event, right after DTEND",
    nOf(/^TRANSP:TRANSPARENT$/gm) === 8 && nOf(/^X-MICROSOFT-CDO-BUSYSTATUS:FREE$/gm) === 8
    && nOf(/^DTEND;VALUE=DATE:\d{8}\r\nTRANSP:TRANSPARENT\r\nX-MICROSOFT-CDO-BUSYSTATUS:FREE\r\nSUMMARY:/gm) === 8,
    `TRANSP ${nOf(/^TRANSP:TRANSPARENT$/gm)}, BUSYSTATUS ${nOf(/^X-MICROSOFT-CDO-BUSYSTATUS:FREE$/gm)}`);
  const vacEv = unfolded.split("BEGIN:VEVENT").find((e) => e.includes("SUMMARY:DSG Vacation")) || "";
  const flaggedEvs = unfolded.split("BEGIN:VEVENT").slice(1).filter((e) => !e.includes("SUMMARY:DSG Vacation"));
  check("T5 the DSG Vacation event is the only one without the lines (it stays busy; the other 8 are free)",
    vacEv.includes("DTEND;VALUE=DATE:20261204") && !vacEv.includes("TRANSP") && !vacEv.includes("BUSYSTATUS")
    && flaggedEvs.length === 8 && flaggedEvs.every((e) => e.includes("\r\nTRANSP:TRANSPARENT\r\n") && e.includes("\r\nX-MICROSOFT-CDO-BUSYSTATUS:FREE\r\n")), vacEv.replace(/\r\n/g, " | "));

  const isrc = fs.readFileSync(path.join(ROOT, "helpers.js"), "utf8");
  // (2026-10-02: every site also passes nameOf, so a "covered by" line names the surgeon by code — section X)
  check("T4 personal exports (Download My Calendar, exported page, Settings) call the builder without the code",
    count("buildICSEvents(schedule, s.id, s.name, { nameOf });") === 3);
  check("T4 both full exports name the surgeon and add APP shifts through the shared builder",
    count("buildICSEvents(schedule, s.id, s.name, { withCode: true, nameOf })") === 2 && count("buildAppICSEvents(appShifts, aMap)") === 2);
  check("T4 Download My Calendar writes vacations as all-day events",
    count('allDay: true, start: icsDay(parse(vs)), end: icsDay(addD(parse(ve), 1)),') === 1 && count('summary: "DSG Vacation",') === 1);
  check("T5 transparency is set only inside helpers.js: index-source.html (the vacation events) never sets it",
    !/transparent\s*:\s*true/.test(src) && (isrc.match(/transparent: true/g) || []).length === 2);
  check("T4 the timed builder is gone from both files (no icsDate helper, no hand-built APP events)",
    !src.includes("icsDate(") && !isrc.includes("icsDate(") && !src.includes("APP Call - "));
}

// ─── U. Mine tab "My Shifts" lists only shifts not yet done (owner request 2026-09-25) ───
// A role is DONE once its last day is before today: a Mon–Thu night ends on
// its own date; the service week, the weekend and an OFF week run to the
// week's Sunday (the Next call card's rule). A started-but-not-done role stays
// without Find Swap. canSwap uses shiftStartDate, the exact rule every swap
// and trade path refuses on. Weeks with no roles left drop out.
//   U1 shiftLastDay for every key, plus the DST week
//   U2 mineUpcoming on FAK's live weeks at pinned todays: exact kept roles
//      and canSwap
//   U3 purity: input untouched, an all-done week disappears, OFF runs to
//      Sunday with no swap, the other role and week fields pass through
//   U4 source: My Shifts renders mineUpcoming's output, the button is gated
//      on canSwap (and the branches are in that order), both empty states
//      exist, the Next call card still reads the unfiltered list
//   U5 U1 and U2 rerun in a child pinned to TZ=America/Chicago, because a
//      UTC run (CI's) cannot see a new Date("YYYY-MM-DD") slip
// Every check carries a positive assertion, so a missing helper fails by
// name instead of passing on an empty result.
{
  const U = vm.runInContext(`({ ${["shiftLastDay", "mineUpcoming"].map((f) => `${f}: typeof ${f} === "function" ? ${f} : () => null`).join(", ")} })`, sandbox);
  const last = (m, k) => U.shiftLastDay(m, k);
  const lastWant = { dayCall: "2026-09-27", mon: "2026-09-21", tue: "2026-09-22", wed: "2026-09-23", thu: "2026-09-24", wknd: "2026-09-27" };
  const lastGot = Object.fromEntries(Object.keys(lastWant).map((k) => [k, last("2026-09-21", k)]));
  check("U1 shiftLastDay on wk 2026-09-21: nights end on their own date, service week and weekend on Sunday",
    JSON.stringify(lastGot) === JSON.stringify(lastWant), JSON.stringify(lastGot));
  check("U1 shiftLastDay: an OFF week (null key) runs to Sunday",
    last("2026-09-21", null) === "2026-09-27", last("2026-09-21", null));
  check("U1 shiftLastDay across the fall-back week 2026-10-26: weekend and service week end 2026-11-01, Thursday night 2026-10-29",
    last("2026-10-26", "wknd") === "2026-11-01" && last("2026-10-26", "dayCall") === "2026-11-01" && last("2026-10-26", "thu") === "2026-10-29",
    [last("2026-10-26", "wknd"), last("2026-10-26", "dayCall"), last("2026-10-26", "thu")].join(" "));

  // FAK's live weeks on 2026-09-25 (schedule_weeks, anon read), in the builder's role shape, plus one long-past week
  const role = (shiftKey) => shiftKey === "dayCall" ? { type: "Service Week (incl. Sat)", icon: "🏥", detail: "M–F 7a–5p + Sat 7a–Sun 7a", color: "#1a6fa8", shiftKey }
    : shiftKey === "wknd" ? { type: "Weekend", icon: "🌗", detail: "Fri 5p–Sat 7a + Sun 7a–Mon 7a", color: "#7a6030", shiftKey }
    : shiftKey ? { type: shiftKey + " Night", icon: "🌙", detail: "5p–7a", color: "#6030a0", shiftKey }
    : { type: "OFF", icon: "✅", detail: "No call this week", color: "#2a7a40", shiftKey: null };
  const wk = (mStr, keys, extra) => ({ mStr, endStr: vm.runInContext(`fmt(addD(parse("${mStr}"), 6))`, sandbox), roles: keys.map(role), isBackup: false, isFierceBackup: false, ...extra });
  const fx = [
    wk("2026-05-04", ["dayCall", "thu"]),
    wk("2026-09-14", ["wed"]),
    wk("2026-09-21", ["mon", "tue", "wknd"]),
    wk("2026-09-28", ["wed"], { isBackup: true }),
    wk("2026-10-05", ["dayCall"]),
    wk("2026-10-12", ["tue"], { isFierceBackup: true }),
    wk("2026-10-19", ["tue"]),
    wk("2026-10-26", ["mon"]),
    wk("2026-11-02", [null]),
    wk("2026-11-09", [null], { isBackup: true }),
  ];
  const fxBefore = JSON.stringify(fx);
  const view = (today) => { const r = U.mineUpcoming(fx, today); return Array.isArray(r) ? JSON.parse(JSON.stringify(r)) : null; };
  const sig = (today) => { const v = view(today); return v ? v.map((w) => `${w.mStr.slice(5)}:${w.roles.map((r) => `${r.shiftKey || "OFF"}${r.canSwap ? "+" : "-"}`).join(",")}`).join(" ") : "null"; };
  const U2 = [
    ["2026-09-25", "09-21:wknd+ 09-28:wed+ 10-05:dayCall+ 10-12:tue+ 10-19:tue+ 10-26:mon+ 11-02:OFF- 11-09:OFF-", "today 09-25: wk 9/21 keeps ONLY the weekend, still swappable (it starts today); nothing before it"],
    ["2026-09-26", "09-21:wknd- 09-28:wed+ 10-05:dayCall+ 10-12:tue+ 10-19:tue+ 10-26:mon+ 11-02:OFF- 11-09:OFF-", "today 09-26: the weekend is in progress, no swap"],
    ["2026-09-28", "09-28:wed+ 10-05:dayCall+ 10-12:tue+ 10-19:tue+ 10-26:mon+ 11-02:OFF- 11-09:OFF-", "today 09-28: wk 9/21 is gone"],
    ["2026-10-01", "10-05:dayCall+ 10-12:tue+ 10-19:tue+ 10-26:mon+ 11-02:OFF- 11-09:OFF-", "today 10-01 (Thu): wk 9/28 is gone although its Sunday is still ahead (a week drops when its ROLES are done, not when the week ends)"],
    ["2026-10-07", "10-05:dayCall- 10-12:tue+ 10-19:tue+ 10-26:mon+ 11-02:OFF- 11-09:OFF-", "today 10-07: the 10/5 service week is in progress, no swap"],
    ["2026-10-11", "10-05:dayCall- 10-12:tue+ 10-19:tue+ 10-26:mon+ 11-02:OFF- 11-09:OFF-", "today 10-11 (its Sunday): the service week is still listed"],
    ["2026-10-12", "10-12:tue+ 10-19:tue+ 10-26:mon+ 11-02:OFF- 11-09:OFF-", "today 10-12: the 10/5 service week is gone"],
  ];
  for (const [today, want, name] of U2) check(`U2 ${name}`, sig(today) === want, sig(today));

  const v25 = view("2026-09-25");
  const w0 = v25 && v25[0], src25 = fx[2];
  check("U3 input untouched (no role removed, no canSwap written) while the output does filter",
    JSON.stringify(fx) === fxBefore && !!v25 && v25.length === 8 && fx.length === 10 && fx[2].roles.length === 3 && fx[2].roles.every((r) => !("canSwap" in r)));
  check("U3 a week whose roles are all done disappears (5/4 and 9/14 at 09-25)",
    !!v25 && v25.length > 0 && !v25.some((w) => w.mStr === "2026-05-04" || w.mStr === "2026-09-14"));
  check("U3 an OFF week stays through its Sunday with canSwap false, then drops",
    sig("2026-11-08").includes("11-02:OFF-") && !sig("2026-11-09").includes("11-02") && sig("2026-11-09").includes("11-09:OFF-"), sig("2026-11-08") + " | " + sig("2026-11-09"));
  check("U3 week and role fields pass through unchanged (endStr, badges, type, icon, detail, color)",
    !!w0 && w0.endStr === src25.endStr && w0.isBackup === false && v25[1].isBackup === true && v25[3].isFierceBackup === true
    && ["type", "icon", "detail", "color", "shiftKey"].every((f) => w0.roles[0][f] === src25.roles[2][f]), JSON.stringify(w0));

  check("U4 My Shifts renders mineUpcoming's output; the unfiltered map is gone",
    count("const myShiftsView = mineUpcoming(myShifts, myToday);") === 1 && count("{myShiftsView.map(wk => (") === 1 && count("{myShifts.map(wk => (") === 0);
  check("U4 Find Swap renders only when canSwap; a started role shows the in-progress tag instead",
    count("{r.canSwap ? (") === 1 && count("findSwapSuggestions(wk.mStr, r.shiftKey, myId); setView(\"calendar\");") === 1 && count(") : r.shiftKey ? (") === 1 && count(">in progress</span>") === 1);
  {
    // Order, not just presence: swapping the two branches keeps every string above exactly once
    const mapAt = src.indexOf("{myShiftsView.map(wk => (");
    const seq = ["{r.canSwap ? (", 'findSwapSuggestions(wk.mStr, r.shiftKey, myId); setView("calendar");', "🔄 Find Swap", ") : r.shiftKey ? (", ">in progress</span>", ") : null}"];
    let pos = mapAt, ordered = mapAt >= 0;
    for (const s of seq) { const i = src.indexOf(s, pos); if (i < 0 || i - mapAt > 2500) { ordered = false; break; } pos = i + s.length; }
    check("U4 inside the My Shifts map, in order: canSwap → the Find Swap button, else a shift → the in-progress tag, else nothing", ordered);
  }
  check("U4 both empty states: nothing assigned vs nothing left",
    count("{myShifts.length === 0 && (") === 1 && count("No shifts assigned yet. Generate a schedule first.") === 1
    && count("{myShifts.length > 0 && myShiftsView.length === 0 && (") === 1 && count("No upcoming shifts in the current schedule.") === 1);
  check("U4 the Next call card still reads the unfiltered list",
    count("myShifts.forEach(s => {") === 1 && count("const myShiftsView = mineUpcoming(") === 1);

  // U5 — U1 and U2 again under TZ=America/Chicago. The named trap, new Date("YYYY-MM-DD"), parses as UTC
  // midnight, which is the PREVIOUS day in Central, so a UTC run (CI's) cannot see it. Like R7, a child
  // process pins the zone and proves the pin, then reruns the same expectations.
  {
    const { execFileSync } = require("child_process");
    const todays = U2.map(([t]) => t).concat(["2026-11-08", "2026-11-09"]);
    const code = [
      'const vm = require("vm"), fs = require("fs"), path = require("path");',
      'const sb = { console, window: {}, document: undefined, navigator: { userAgent: "node-test" }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, fetch: () => { throw new Error("no fetch"); }, setTimeout, clearTimeout };',
      "sb.globalThis = sb; vm.createContext(sb);",
      `for (const f of ["helpers.js", "config.js"]) vm.runInContext(fs.readFileSync(path.join(${JSON.stringify(ROOT)}, f), "utf8"), sb, { filename: f });`,
      'const h = vm.runInContext("({ shiftLastDay, mineUpcoming })", sb);',
      `const fx = ${JSON.stringify(fx)};`,
      'const sig = (t) => h.mineUpcoming(fx, t).map((w) => w.mStr.slice(5) + ":" + w.roles.map((r) => (r.shiftKey || "OFF") + (r.canSwap ? "+" : "-")).join(",")).join(" ");',
      'const keys = ["dayCall", "mon", "tue", "wed", "thu", "wknd"];',
      "process.stdout.write(JSON.stringify({ off: new Date(2026, 9, 24).getTimezoneOffset(), naive: new Date(\"2026-10-11\").getDay(),",
      '  last: Object.fromEntries(keys.map((k) => [k, h.shiftLastDay("2026-09-21", k)])), lastOff: h.shiftLastDay("2026-09-21", null),',
      '  dst: [h.shiftLastDay("2026-10-26", "wknd"), h.shiftLastDay("2026-10-26", "dayCall"), h.shiftLastDay("2026-10-26", "thu")].join(" "),',
      `  sigs: Object.fromEntries(${JSON.stringify(todays)}.map((t) => [t, sig(t)])) }));`,
    ].join("\n");
    let out = null;
    try { out = JSON.parse(execFileSync(process.execPath, ["-e", code], { env: Object.assign({}, process.env, { TZ: "America/Chicago" }), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); } catch (ex) { out = { err: String(ex).slice(0, 300) }; }
    check("U5 the child really runs in America/Chicago (CDT offset 300) and there the NAIVE new Date('2026-10-11') is SATURDAY — the trap is visible",
      !!out && out.off === 300 && out.naive === 6, JSON.stringify(out).slice(0, 300));
    check("U5 under TZ=America/Chicago shiftLastDay matches U1 (every key, OFF, and the fall-back week)",
      !!out && JSON.stringify(out.last) === JSON.stringify(lastWant) && out.lastOff === "2026-09-27" && out.dst === "2026-11-01 2026-11-01 2026-10-29", JSON.stringify(out).slice(0, 300));
    const tzWant = Object.fromEntries(U2.map(([t, w]) => [t, w]).concat([["2026-11-08", sig("2026-11-08")], ["2026-11-09", sig("2026-11-09")]]));
    const tzBad = out && out.sigs ? Object.keys(tzWant).filter((t) => out.sigs[t] !== tzWant[t]) : ["no output"];
    check("U5 under TZ=America/Chicago mineUpcoming gives every U2 row's exact roles and canSwap, and the OFF week still runs to Sunday",
      !!out && !!out.sigs && tzBad.length === 0 && tzWant["2026-11-08"].includes("11-02:OFF-") && !tzWant["2026-11-09"].includes("11-02"), tzBad.map((t) => `${t}: ${out && out.sigs ? out.sigs[t] : ""}`).join(" | "));
  }
}

// ─── V. Stats → Billing honors holiday coverage (owner rule + decisions 2026-10-01) ───
// A holiday 24h bills the COVERING surgeon 2 days (the day and the night) on
// the holiday's date, in a "Holiday" column, and every regular credit on that
// date drops: service day (override included), week night, weekend day. Which
// entries count: any holidayCoverage entry that names a coverer, sits inside
// its own week, and whose type is not "swap" (an unexpected type bills as a
// holiday). A backup week bills nothing, holiday included. The two imported
// "swap" Saturdays (1/24, 2/14) keep today's billing.
//   V1 the real Labor Day week          V2 an empty Monday night (non-backup)
//   V3 Friday, Saturday, Sunday holidays V4 a holiday beats an override
//   V5 backup weeks, no coverer, outside the week, swap, the live types
//   V6 regression: no-holiday weeks bill exactly as main's block (frozen copy)
//   V7 live September / May / January / February end to end, before and after
//   V8 source pins                       V9 V1/V3/V7 under TZ=America/Chicago
// Fixtures: test/fixtures/billing-live-weeks-2026-10-01.json (19 live weeks,
// anon-readable by design) and billing-block-main-591391f.txt (main's billing
// block, byte-for-byte, the "old code" reference).
{
  const FIX = path.join(ROOT, "test", "fixtures");
  const live = JSON.parse(fs.readFileSync(path.join(FIX, "billing-live-weeks-2026-10-01.json"), "utf8"));
  const oldBlock = fs.readFileSync(path.join(FIX, "billing-block-main-591391f.txt"), "utf8");
  const H = vm.runInContext('({ wbc: typeof weekBillingCredits === "function" ? weekBillingCredits : null, fmt, parse, addD })', sandbox);
  const credits = (m, wk) => (H.wbc ? JSON.parse(JSON.stringify(H.wbc(m, wk))) : null);
  const sig = (cs) => (cs ? cs.map((c) => `${c.ds.slice(5)} ${c.sid} ${c.kind}${c.n}`).sort().join(" | ") : "null");
  const want = (lines) => lines.slice().sort().join(" | ");
  const days = (m, offs) => offs.map((i) => H.fmt(H.addD(H.parse(m), i)).slice(5));
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // V1 — the real Labor Day week: FAK service, RPC Mon night + the 24h coverage
  const w97 = live["2026-09-07"];
  const want97 = want([
    ...days("2026-09-07", [1, 2, 3, 4, 5, 6]).map((d) => `${d} s6 dc1`),
    "09-08 s5 nights1", "09-09 s7 nights1", "09-10 s1 nights1",
    "09-11 s4 wknd1", "09-12 s4 wknd1", "09-13 s4 wknd1",
    "09-07 s3 hol2",
  ]);
  check("V1 Labor Day week: FAK service 9/8–9/13 only, no 9/7 night credit, RPC Holiday 2 on 9/7, REH/ARW/DJA nights 9/8–9/10, KJH weekend 9/11–9/13",
    sig(credits("2026-09-07", w97)) === want97, sig(credits("2026-09-07", w97)));

  // V2 — Memorial Day's shape (empty Monday night) as a NON-backup week
  const w525 = { ...clone(live["2026-05-25"]), isBackup: false };
  check("V2 empty Monday night, non-backup: DJA Holiday 2 on 5/25, RPC service 5/26–5/31 only, nothing else on 5/25",
    sig(credits("2026-05-25", w525)) === want([
      ...days("2026-05-25", [1, 2, 3, 4, 5, 6]).map((d) => `${d} s3 dc1`),
      "05-26 s5 nights1", "05-27 s2 nights1", "05-28 s7 nights1",
      "05-29 s4 wknd1", "05-30 s4 wknd1", "05-31 s4 wknd1", "05-25 s1 hol2",
    ]), sig(credits("2026-05-25", w525)));

  // V3 — the week of 12/21: service MCC, weekend REH, nights DJA/RPC/KJH/ARW; FAK covers one day
  const xmas = (dsCov) => ({ dayCall: "s2", isBackup: false, nights: { mon: "s1", tue: "s3", wed: "s4", thu: "s7", wknd: "s5" },
    holidayCoverage: { [dsCov]: { surgeonId: "s6", role: "holiday_24h", type: "major", hours: "7a–7a", name: "Holiday" } } });
  const xmasWant = (covOff) => want([
    ...days("2026-12-21", [0, 1, 2, 3, 4, 5, 6].filter((i) => i !== covOff)).map((d) => `${d} s2 dc1`),
    "12-21 s1 nights1", "12-22 s3 nights1", "12-23 s4 nights1", "12-24 s7 nights1",
    ...days("2026-12-21", [4, 5, 6].filter((i) => i !== covOff)).map((d) => `${d} s5 wknd1`),
    `${days("2026-12-21", [covOff])[0]} s6 hol2`,
  ]);
  check("V3 Friday holiday (Christmas 12/25): MCC loses only Fri service, REH keeps Sat + Sun, FAK Holiday 2, Christmas Eve bills normally",
    sig(credits("2026-12-21", xmas("2026-12-25"))) === xmasWant(4), sig(credits("2026-12-21", xmas("2026-12-25"))));
  check("V3 Saturday holiday: the service Saturday and the weekend Saturday both drop",
    sig(credits("2026-12-21", xmas("2026-12-26"))) === xmasWant(5), sig(credits("2026-12-21", xmas("2026-12-26"))));
  check("V3 Sunday holiday: the service Sunday and the weekend Sunday both drop",
    sig(credits("2026-12-21", xmas("2026-12-27"))) === xmasWant(6), sig(credits("2026-12-21", xmas("2026-12-27"))));
  // The generator's real shapes put SEVERAL covered dates in one week: Thanksgiving Thu (A), Fri (B), Sat (A);
  // New Year's 12/31 (A), 1/1 (B), 1/2 (A), in a week that crosses into January. Every one of them counts.
  const cov = (map) => Object.fromEntries(Object.entries(map).map(([ds, sid]) => [ds, { surgeonId: sid, role: "holiday_24h", type: "major", hours: "7a–7a", name: "Holiday" }]));
  const tgiving = { dayCall: "s1", isBackup: false, nights: { mon: "s4", tue: "s5", wed: "s6", thu: "s4", wknd: "s7" },
    holidayCoverage: cov({ "2026-11-26": "s2", "2026-11-27": "s3", "2026-11-28": "s2" }) };
  const newYear = { dayCall: "s4", isBackup: false, nights: { mon: "s1", tue: "s2", wed: "s3", thu: "s6", wknd: "s7" },
    holidayCoverage: cov({ "2026-12-31": "s5", "2027-01-01": "s1", "2027-01-02": "s5" }) };
  check("V3 three covered dates in one week (Thanksgiving): each bills its coverer Holiday 2 and drops that date's service, night and weekend credits",
    sig(credits("2026-11-23", tgiving)) === want([
      "11-23 s1 dc1", "11-24 s1 dc1", "11-25 s1 dc1", "11-29 s1 dc1",
      "11-23 s4 nights1", "11-24 s5 nights1", "11-25 s6 nights1", "11-29 s7 wknd1",
      "11-26 s2 hol2", "11-27 s3 hol2", "11-28 s2 hol2",
    ]) && sig(credits("2026-12-28", newYear)) === want([
      "12-28 s4 dc1", "12-29 s4 dc1", "12-30 s4 dc1", "01-03 s4 dc1",
      "12-28 s1 nights1", "12-29 s2 nights1", "12-30 s3 nights1", "01-03 s7 wknd1",
      "12-31 s5 hol2", "01-01 s1 hol2", "01-02 s5 hol2",
    ]), sig(credits("2026-11-23", tgiving)) + " || " + sig(credits("2026-12-28", newYear)));

  // V4 — overrides
  const w97o = { ...clone(w97), dayCallOverrides: { "2026-09-07": "s2", "2026-09-09": "s4" } };
  const w97oWant = want([
    ...days("2026-09-07", [1, 3, 4, 5, 6]).map((d) => `${d} s6 dc1`), "09-09 s4 dc1",
    "09-08 s5 nights1", "09-09 s7 nights1", "09-10 s1 nights1",
    "09-11 s4 wknd1", "09-12 s4 wknd1", "09-13 s4 wknd1", "09-07 s3 hol2",
  ]);
  check("V4 a holiday beats an override on its date (the 9/7 override bills nothing); an override on a normal date bills the covering surgeon (9/9 → KJH)",
    sig(credits("2026-09-07", w97o)) === w97oWant, sig(credits("2026-09-07", w97o)));

  // V5 — what changes nothing
  const noCov = (wk) => { const c = clone(wk); delete c.holidayCoverage; return c; };
  const base97 = sig(credits("2026-09-07", noCov(w97)));
  check("V5 the real 5/25 week (backup + Memorial Day) bills nothing at all; a backup Labor Day week bills nothing",
    !!H.wbc && credits("2026-05-25", live["2026-05-25"]).length === 0 && credits("2026-09-07", { ...clone(w97), isBackup: true }).length === 0);
  const w97noSid = { ...clone(w97), holidayCoverage: { "2026-09-07": { name: "Labor Day 24h", role: "holiday_24h", type: "minor" } } };
  const w97out = { ...clone(w97), holidayCoverage: { "2026-09-14": { surgeonId: "s3", role: "holiday_24h", type: "minor", name: "Next week" } } };
  // Before Monday too: the seed itself stores Memorial Day Eve (Sun 5/24) inside the 5/25 week
  const w525eve = { ...clone(w525), holidayCoverage: { "2026-05-24": { surgeonId: "s2", role: "holiday_24h", type: "minor", name: "Memorial Day Eve" } } };
  check("V5 an entry with no coverer, or dated outside its week (the Monday after, or the Sunday before), changes nothing (equals the week with no coverage at all)",
    !!H.wbc && base97.includes("09-07 s6 dc1") && sig(credits("2026-09-07", w97noSid)) === base97 && sig(credits("2026-09-07", w97out)) === base97
    && sig(credits("2026-05-25", w525eve)) === sig(credits("2026-05-25", noCov(w525))) && sig(credits("2026-05-25", w525eve)).includes("05-25 s3 dc1"),
    `${sig(credits("2026-09-07", w97noSid))} || ${sig(credits("2026-05-25", w525eve))}`);
  check("V5 a \"swap\" entry changes nothing: the live 1/24 (ARW) and 2/14 (FAK) Saturdays bill exactly as without the entry",
    !!H.wbc && ["2026-01-19", "2026-02-09"].every((m) => sig(credits(m, live[m])) === sig(credits(m, noCov(live[m])))) && sig(credits("2026-01-19", live["2026-01-19"])).includes("01-24 s4 dc1"),
    ["2026-01-19", "2026-02-09"].map((m) => sig(credits(m, live[m]))).join(" || "));
  const liveTypes = [...new Set(Object.values(live).flatMap((w) => Object.values((w && w.holidayCoverage) || {}).map((c) => String(c.type))))].sort();
  const w97odd = { ...clone(w97), holidayCoverage: { "2026-09-07": { surgeonId: "s3", name: "Odd" } } };
  const w97type = (type) => ({ ...clone(w97), holidayCoverage: { "2026-09-07": { surgeonId: "s3", name: "Odd", type } } });
  const oddTypes = ["Holiday", "Swap", "religious", "major", ""];
  const oddBad = oddTypes.filter((t) => sig(credits("2026-09-07", w97type(t))) !== want97);
  check(`V5 the live types are exactly ${JSON.stringify(["holiday", "minor", "swap"])}; only the exact "swap" is excluded — a missing type and ${JSON.stringify(oddTypes)} all bill as a holiday`,
    JSON.stringify(liveTypes) === JSON.stringify(["holiday", "minor", "swap"]) && sig(credits("2026-09-07", w97odd)) === want97 && oddBad.length === 0,
    `types ${JSON.stringify(liveTypes)}; missing → ${sig(credits("2026-09-07", w97odd)).slice(0, 60)}; wrong for ${JSON.stringify(oddBad)}`);

  // The real billing blocks: main's (frozen copy) and this file's
  const slice = (text) => { const a = text.indexOf("const monthly = {};"); const b = a < 0 ? -1 : text.indexOf("const sortedMonths = [...allMonths].sort();", a); return a < 0 || b < 0 ? null : text.slice(a, b); };
  const newBlock = slice(src);
  const runner = (block) => vm.runInContext(`(function (schedule, surgeons) { ${block}\n return monthly; })`, sandbox);
  const runOld = runner(oldBlock), runNew = newBlock ? runner(newBlock) : null;
  const usesHelper = !!newBlock && newBlock.includes("weekBillingCredits(");
  const SURG = ["DJA", "MCC", "RPC", "KJH", "REH", "FAK", "ARW"].map((name, i) => ({ id: "s" + (i + 1), name }));
  const sameExceptHol = (o, n) => {
    const om = Object.keys(o).sort(), nm = Object.keys(n).sort();
    if (JSON.stringify(om) !== JSON.stringify(nm)) return `months differ: ${om.length} vs ${nm.length}`;
    for (const mk of om) for (const id of Object.keys(o[mk])) {
      const a = o[mk][id], b = n[mk][id] || {};
      for (const k of ["dc", "nights", "wknd"]) if ((a[k] || 0) !== (b[k] || 0)) return `${mk} ${id} ${k}: old ${a[k]} new ${b[k]}`;
      if ((b.hol || 0) !== 0) return `${mk} ${id} hol ${b.hol} on a no-holiday schedule`;
    }
    return "";
  };

  // V6 — regression on weeks with no holiday coverage
  const septNoHol = {}; for (const [m, w] of Object.entries(live)) septNoHol[m] = noCov(w);
  const v6a = usesHelper ? sameExceptHol(clone(runOld(septNoHol, SURG)), clone(runNew(septNoHol, SURG))) : "the billing block does not use weekBillingCredits";
  let seed = 20261001;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const SIDS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const maybe = (p, v) => (rnd() < p ? v : null);
  const randWeeks = {}; let nRand = 0;
  for (let k = 0; k < 520; k++) {
    const m = H.fmt(H.addD(H.parse("2016-01-04"), 7 * k));
    const wk = { dayCall: maybe(0.9, pick(SIDS)), isBackup: rnd() < 0.12,
      nights: { mon: maybe(0.85, pick(SIDS)), tue: maybe(0.85, pick(SIDS)), wed: maybe(0.85, pick(SIDS)), thu: maybe(0.85, pick([...SIDS, "s99"])), wknd: maybe(0.9, pick(SIDS)) } };
    if (rnd() < 0.45) { wk.dayCallOverrides = {}; const n = 1 + Math.floor(rnd() * 3); for (let j = 0; j < n; j++) wk.dayCallOverrides[H.fmt(H.addD(H.parse(m), Math.floor(rnd() * 9) - 1))] = pick([...SIDS, "s99"]); }
    randWeeks[m] = wk; nRand++;
  }
  const v6b = usesHelper ? sameExceptHol(clone(runOld(randWeeks, SURG)), clone(runNew(randWeeks, SURG))) : "the billing block does not use weekBillingCredits";
  check(`V6 no-holiday weeks bill exactly as main's block: the live fixture with coverage stripped, and ${nRand} random weeks (overrides, backups, out-of-week overrides, an unknown id) — every month, surgeon and column`,
    usesHelper && nRand >= 500 && v6a === "" && v6b === "", v6a || v6b);

  // V7 — live months end to end
  const table = (monthly, mk) => SURG.map((s) => { const r = monthly[mk][s.id]; const v = (k) => (r[k] ? String(r[k]) : "–"); return `${s.name} ${v("dc")}/${v("nights")}/${v("wknd")}/${v("hol")} ${(r.dc || 0) + (r.nights || 0) + (r.wknd || 0) + (r.hol || 0)}`; }).join(" · ");
  const before = clone(runOld(live, SURG)), after = usesHelper ? clone(runNew(live, SURG)) : null;
  const SEP_BEFORE = "DJA 7/2/–/– 9 · MCC –/1/3/– 4 · RPC 6/2/–/– 8 · KJH –/2/3/– 5 · REH –/2/–/– 2 · FAK 7/4/3/– 14 · ARW 7/2/3/– 12";
  const SEP_AFTER = "DJA 7/2/–/– 9 · MCC –/1/3/– 4 · RPC 6/1/–/2 9 · KJH –/2/3/– 5 · REH –/2/–/– 2 · FAK 6/4/3/– 13 · ARW 7/2/3/– 12";
  check("V7 September: before (main's block on the live weeks) is the live table (FAK 14, RPC 8); after, FAK 6/4/3 = 13 and RPC 6/1/–/2 = 9, everyone else unchanged",
    table(before, "2026-09") === SEP_BEFORE && !!after && table(after, "2026-09") === SEP_AFTER, `before ${table(before, "2026-09")} | after ${after ? table(after, "2026-09") : "no new block"}`);
  // Several holidays in one week, through the real block: each credit lands in its OWN date's month
  const multi = usesHelper ? clone(runNew({ "2026-11-23": tgiving, "2026-12-28": newYear }, SURG)) : null;
  const MULTI_WANT = {
    "2026-11": "DJA 4/–/–/– 4 · MCC –/–/–/4 4 · RPC –/–/–/2 2 · KJH –/1/–/– 1 · REH –/1/–/– 1 · FAK –/1/–/– 1 · ARW –/–/1/– 1",
    "2026-12": "DJA –/1/–/– 1 · MCC –/1/–/– 1 · RPC –/1/–/– 1 · KJH 3/–/–/– 3 · REH –/–/–/2 2 · FAK –/–/–/– 0 · ARW –/–/–/– 0",
    "2027-01": "DJA –/–/–/2 2 · MCC –/–/–/– 0 · RPC –/–/–/– 0 · KJH 1/–/–/– 1 · REH –/–/–/2 2 · FAK –/–/–/– 0 · ARW –/–/1/– 1",
  };
  check("V7 Thanksgiving (3 holidays) and New Year's (3 holidays, Dec → Jan) through the billing block: Nov MCC Holiday 4 + RPC 2; Dec REH Holiday 2 (12/31); Jan DJA 2 (1/1) + REH 2 (1/2)",
    !!multi && Object.entries(MULTI_WANT).every(([mk, w]) => table(multi, mk) === w),
    multi ? Object.keys(MULTI_WANT).filter((mk) => table(multi, mk) !== MULTI_WANT[mk]).map((mk) => `${mk}: ${table(multi, mk)}`).join(" | ") : "no new block");
  check("V7 May (Memorial Day in a backup week), January and February (the swap Saturdays) are unchanged in every column",
    !!after && ["2026-05", "2026-01", "2026-02"].every((mk) => table(after, mk) === table(before, mk)),
    after ? ["2026-05", "2026-01", "2026-02"].filter((mk) => table(after, mk) !== table(before, mk)).map((mk) => `${mk}: ${table(before, mk)} → ${table(after, mk)}`).join(" | ") : "no new block");

  // V8 — source
  const hsrc = fs.readFileSync(path.join(ROOT, "helpers.js"), "utf8");
  check("V8 weekBillingCredits is defined once in helpers.js and the billing block aggregates its credits (the old inline loops are gone)",
    (hsrc.match(/^function weekBillingCredits\(mondayStr, wk\) \{/gm) || []).length === 1 && count("weekBillingCredits(mStr, wk).forEach(c => {") === 1
    && !src.includes("const svcSid = (wk.dayCallOverrides && wk.dayCallOverrides[ds]) || wk.dayCall;") && !/\]\.(dc|nights|wknd) \+= 1;/.test(newBlock || "x].dc += 1;"));
  check("V8 Holiday header + cell after Wknd Days; rows default hol to 0",
    // \r?\n: a Windows checkout has CRLF, CI's has LF
    (src.match(/<th style=\{thS2\}>Wknd Days<\/th>\r?\n[ \t]*<th style=\{thS2\}>Holiday<\/th>/g) || []).length === 1
    && (src.match(/<td style=\{tdS\}>\{r\.wknd\|\|"–"\}<\/td>\r?\n[ \t]*<td style=\{tdS\}>\{r\.hol\|\|"–"\}<\/td>/g) || []).length === 1
    && count("{dc:0,nights:0,wknd:0,hol:0}") === 1 && count("{ dc:0, nights:0, wknd:0, hol:0 }") === 1);
  check("V8 billingDays includes Holiday and feeds both the Total Days cell and hasAny; the formula note and explainer name it; row visibility by authenticated identity and the month loop are unchanged",
    count("const billingDays = (r) => (r.dc||0) + (r.nights||0) + (r.wknd||0) + (r.hol||0);") === 1 && count("return billingDays(monthData[s.id] || {}) > 0;") === 1
    && /const days = billingDays\(r\);[\s\S]{0,700}\{days\|\|"–"\}/.test(src) && count("const days = billingDays(r);") === 1
    && count("const billVisible = canSeeAllBilling ? surgeons : surgeons.filter(s => s.id === ownBillId);") === 1 && count("{sortedMonths.map(mk => {") === 1
    && count("Svc Days + Nights + Wknd Days + Holiday Days = Total Call Days.") === 1
    && count("A covered holiday bills 2 days (the day and the night) to the surgeon who covers it, and that date's regular credits don't count.") === 1);

  // V9 — V1, V3 and V7 again under TZ=America/Chicago (a UTC run cannot see a new Date("YYYY-MM-DD") slip)
  {
    const { execFileSync } = require("child_process");
    const code = [
      'const vm = require("vm"), fs = require("fs"), path = require("path");',
      'const sb = { console, window: {}, document: undefined, navigator: { userAgent: "node-test" }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, fetch: () => { throw new Error("no fetch"); }, setTimeout, clearTimeout };',
      "sb.globalThis = sb; vm.createContext(sb);",
      `for (const f of ["helpers.js", "config.js"]) vm.runInContext(fs.readFileSync(path.join(${JSON.stringify(ROOT)}, f), "utf8"), sb, { filename: f });`,
      'const wbc = vm.runInContext("weekBillingCredits", sb);',
      'const sig = (cs) => cs.map((c) => c.ds.slice(5) + " " + c.sid + " " + c.kind + c.n).sort().join(" | ");',
      `const live = ${JSON.stringify(live)}; const xmas = ${JSON.stringify(xmas("2026-12-25"))};`,
      `const run = vm.runInContext("(function (schedule, surgeons) { " + ${JSON.stringify(newBlock || "")} + "\\n return monthly; })", sb);`,
      `const surg = ${JSON.stringify(SURG)};`,
      "const m = run(live, surg); const r = (id) => m[\"2026-09\"][id];",
      "process.stdout.write(JSON.stringify({ off: new Date(2026, 9, 24).getTimezoneOffset(), naive: new Date(\"2026-09-07\").getDay(),",
      '  v1: sig(wbc("2026-09-07", live["2026-09-07"])), v3: sig(wbc("2026-12-21", xmas)),',
      '  sep: surg.map((s) => s.name + " " + [r(s.id).dc, r(s.id).nights, r(s.id).wknd, r(s.id).hol].map((v) => v || "–").join("/") + " " + ((r(s.id).dc||0) + (r(s.id).nights||0) + (r(s.id).wknd||0) + (r(s.id).hol||0))).join(" · ") }));',
    ].join("\n");
    const inZone = (TZ) => { try { return JSON.parse(execFileSync(process.execPath, ["-e", code], { env: Object.assign({}, process.env, { TZ }), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); } catch (ex) { return { err: String(ex).slice(0, 300) }; } };
    const out = inZone("America/Chicago"), tokyo = inZone("Asia/Tokyo");
    check("V9 the child really runs in America/Chicago (CDT offset 300) and there the NAIVE new Date('2026-09-07') is SUNDAY — the trap is visible",
      !!out && out.off === 300 && out.naive === 0, JSON.stringify(out).slice(0, 300));
    check("V9 under TZ=America/Chicago: the Labor Day week, the Christmas week and the September table match V1 / V3 / V7",
      !!out && out.v1 === want97 && out.v3 === xmasWant(4) && out.sep === SEP_AFTER, JSON.stringify(out).slice(0, 400));
    // A positive offset catches the opposite slip (a date read back through UTC lands a day EARLY east of Greenwich)
    check("V9 under TZ=Asia/Tokyo (offset −540, proven): the same Labor Day week, Christmas week and September table",
      !!tokyo && tokyo.off === -540 && tokyo.v1 === want97 && tokyo.v3 === xmasWant(4) && tokyo.sep === SEP_AFTER, JSON.stringify(tokyo).slice(0, 400));
  }
}

// ─── W. Christmas two-day cap on STORED holiday assignments (2026-10-02) ───
// The standing cap (2026-08-06, buildCoverage): when one surgeon holds both
// halves of Christmas, coverage is the Eve + the day itself and nothing more.
// The live 2026 Christmas (A = B = FAK) was SAVED before the cap and still
// carries Sat 12/26. No data is changed: every READ of stored rows goes through
// effectiveHolidayCoverage, which applies the cap; the swap remap keeps
// working on the stored rows.
//   W1 the real generator on the live 2026 assignments: 12/25 FAK, nothing on 12/26
//   W2 a Christmas with A ≠ B keeps its Saturday row
//   W3 Thanksgiving and New Year's 2026 are unchanged
//   W4 the Setup display rows for 2026 Christmas are the Eve + the day
//   W5 every read of stored rows uses the helper; the swap remap does not
//   W6 the helper alone: only a same-surgeon Christmas changes; pure
// Fixture: test/fixtures/holiday-assignments-2026-live.json (the blob's 2026
// holidayAssignments, anon-readable by design).
{
  const HA = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "holiday-assignments-2026-live.json"), "utf8"));
  const liveXmas = HA["2026"].find((h) => h.name === "Christmas Day");
  const effFn = vm.runInContext('typeof effectiveHolidayCoverage === "function" ? effectiveHolidayCoverage : null', sandbox);
  const rowsOf = (h) => (effFn ? JSON.parse(JSON.stringify(effFn(h))).map((c) => `${c.date.slice(5)}${c.isEve ? "eve" : ""}:${c.surgeon}`).join(" ") : "null");
  const storedOf = (h) => (h.coverage || []).map((c) => `${c.date.slice(5)}${c.isEve ? "eve" : ""}:${c.surgeon}`).join(" ");
  // The real generator, in its own context (sync-guards' sandbox does not load generator.js)
  const gsb = { console: { ...console, warn: () => {} }, window: {}, document: undefined, navigator: { userAgent: "node-test" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, fetch: () => { throw new Error("fetch during generation"); }, setTimeout, clearTimeout };
  gsb.globalThis = gsb; vm.createContext(gsb);
  for (const f of ["helpers.js", "config.js", "generator.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), gsb, { filename: f });
  const G = vm.runInContext("({ generate, COUNTS_1YR, parse, addD })", gsb);
  const SURG7 = ["DJA", "MCC", "RPC", "KJH", "REH", "FAK", "ARW"].map((name, i) => ({ id: "s" + (i + 1), name }));
  const MONS = Array.from({ length: 8 }, (_, k) => G.addD(G.parse("2026-11-16"), 7 * k)); // 11/16 → week of 1/4
  const generatedCover = (assignments) => {
    const sched = G.generate(SURG7, MONS, {}, new Set(), {}, {}, new Set(), assignments, [], null, {}, G.COUNTS_1YR);
    const out = {};
    for (const wk of Object.values(sched)) Object.entries((wk && wk.holidayCoverage) || {}).forEach(([ds, c]) => { out[ds] = c.surgeonId; });
    return out;
  };
  const liveCover = generatedCover({ "2026": JSON.parse(JSON.stringify(HA["2026"])) });

  check("W1 the real generator on the live 2026 assignments: Christmas 12/25 → FAK and NOTHING on Sat 12/26 (it stays with the service-week doctor); the helper gives Eve + Day",
    liveCover["2026-12-25"] === "s6" && !("2026-12-26" in liveCover) && rowsOf(liveXmas) === "12-24eve:s6 12-25:s6",
    `12/25 ${liveCover["2026-12-25"]}, 12/26 ${liveCover["2026-12-26"]}; helper rows ${rowsOf(liveXmas)}`);

  const twoXmas = { ...JSON.parse(JSON.stringify(liveXmas)), surgeonA: "s6", surgeonB: "s1",
    coverage: [{ date: "2026-12-24", surgeon: "s1", label: "Christmas Day Night Before", isEve: true }, { date: "2026-12-25", surgeon: "s6", label: "Christmas Day 24h" }, { date: "2026-12-26", surgeon: "s1", label: "Sat 24h" }] };
  const twoCover = generatedCover({ "2026": [twoXmas] });
  check("W2 a Christmas with A ≠ B keeps its Saturday row (helper returns all three rows; the generator puts Sat 12/26 on surgeon B)",
    rowsOf(twoXmas) === storedOf(twoXmas) && rowsOf(twoXmas).includes("12-26:s1") && twoCover["2026-12-26"] === "s1" && twoCover["2026-12-25"] === "s6",
    `helper ${rowsOf(twoXmas)}; generated 12/25 ${twoCover["2026-12-25"]} 12/26 ${twoCover["2026-12-26"]}`);

  const tg = HA["2026"].find((h) => h.name === "Thanksgiving"), ny = HA["2026"].find((h) => h.name === "New Year's");
  check("W3 Thanksgiving (MCC 11/26, RPC 11/27, MCC 11/28) and New Year's (REH 12/31, DJA 1/1, REH 1/2) are unchanged — by the helper and in the generated schedule",
    !!effFn && rowsOf(tg) === storedOf(tg) && rowsOf(ny) === storedOf(ny)
    && JSON.stringify(["2026-11-26", "2026-11-27", "2026-11-28", "2026-12-31", "2027-01-01", "2027-01-02"].map((d) => liveCover[d])) === JSON.stringify(["s2", "s3", "s2", "s5", "s1", "s5"]),
    `helper TG ${rowsOf(tg)} / NY ${rowsOf(ny)}; generated ${JSON.stringify(liveCover)}`);

  check("W4 Setup → Holidays shows the 2026 Christmas as the Eve + the day (the display maps the helper's rows, not the stored ones)",
    rowsOf(liveXmas) === "12-24eve:s6 12-25:s6" && count("{effectiveHolidayCoverage(hol).map((c,j)=>{") === 1 && count("{(hol.coverage||[]).map((c,j)=>{") === 0);

  const gsrc = fs.readFileSync(path.join(ROOT, "generator.js"), "utf8"), hsrc = fs.readFileSync(path.join(ROOT, "helpers.js"), "utf8");
  check("W5 every read of stored rows goes through the helper (generator, holiday-vs-vacation warnings, the swap's Silvis check, the display); the swap remap alone still works on the stored rows",
    (hsrc.match(/^function effectiveHolidayCoverage\(h\) \{/gm) || []).length === 1
    && count("effectiveHolidayCoverage(targetHol).filter(c => !c.isEve)") === 1 && count("effectiveHolidayCoverage(h).forEach(c => {") === 1
    && (src.match(/\.coverage\b/g) || []).length === 2 && count("hol.coverage = hol.coverage.map((c) => {") === 1
    && (gsrc.match(/effectiveHolidayCoverage\(h\)\.forEach\(c => \{/g) || []).length === 1 && !/\bh\.coverage\b/.test(gsrc));

  const cloneH = (h) => JSON.parse(JSON.stringify(h));
  const solo = { name: "Thanksgiving", date: "2026-11-26", surgeonA: "s2", surgeonB: "s2", coverage: [{ date: "2026-11-25", surgeon: "s2", isEve: true }, { date: "2026-11-26", surgeon: "s2" }, { date: "2026-11-27", surgeon: "s2" }] };
  const noB = { ...cloneH(liveXmas), surgeonB: null };
  const before = JSON.stringify(liveXmas);
  check("W6 the helper changes ONLY a same-surgeon Christmas: a same-surgeon Thanksgiving, a Christmas with no surgeon B, and missing coverage pass through; the input is never mutated",
    !!effFn && rowsOf(solo) === storedOf(solo) && rowsOf(noB) === storedOf(noB) && JSON.stringify(effFn({ name: "Christmas Day", date: "2026-12-25", surgeonA: "s6", surgeonB: "s6" })) === "[]"
    && JSON.stringify(effFn({ name: "Christmas Day", date: "2026-12-25", surgeonA: "s6", surgeonB: "s6", coverage: "bad" })) === "[]"
    && JSON.stringify(liveXmas) === before && liveXmas.coverage.length === 3);
}

// ─── X. Holidays + single-day coverage in the downloads and the Mine tab (2 of 3, 2026-10-02) ───
// The calendar (calData) already shows who really holds each date: a
// holidayCoverage entry (any type, backup weeks included) replaces that date's
// regular slots, and a dayCallOverrides entry replaces the service holder for
// its date. weekHolders (helpers.js) is that rule as a pure function; the
// downloads (buildICSEvents) and the Mine tab now read it.
//   X1 weekHolders == calData, per date and slot, on all 46 live weeks + synthetic shapes
//   X2 the downloads on the worked examples (Labor Day, the 7/3 override, the 1/24
//      swap, the 5/25 backup week); one event per covered date
//   X3 the Mine roles (real builder) + mineUpcoming for dated roles
//   X4 no holiday / no override → the downloads and the Mine roles equal main's (frozen copies)
//   X5 the Next call card: a dated role is its day; a role starts on its first held day
//   X6 the real generator stores the holiday's name; Thanksgiving / New Year's titles use it
//   X7 X1 + the Labor Day events again under TZ=America/Chicago and Asia/Tokyo
// Fixtures: schedule-weeks-live-2026-10-02.json (all 46 live weeks, anon-readable by
// design); buildICSEvents-main-2b8cd39.txt and mine-builder-main-2b8cd39.txt (main's
// code, byte-for-byte, the "old" reference); holiday-assignments-2026-live.json (section W).
{
  const FIXD = path.join(ROOT, "test", "fixtures");
  const LIVE = JSON.parse(fs.readFileSync(path.join(FIXD, "schedule-weeks-live-2026-10-02.json"), "utf8"));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const fnOr = (name) => vm.runInContext(`typeof ${name} === "function" ? ${name} : null`, sandbox);
  const weekHoldersFn = fnOr("weekHolders"), icsFn = fnOr("buildICSEvents"), upFn = fnOr("mineUpcoming");
  const SURG = ["DJA", "MCC", "RPC", "KJH", "REH", "FAK", "ARW"].map((name, i) => ({ id: "s" + (i + 1), name }));
  const nameOf = (id) => (SURG.find((s) => s.id === id) || {}).name || id || "?";

  // X1 — the calendar's own memo body, sliced verbatim, vs the helper
  const ci = src.indexOf("const calData = useMemo(() => {");
  const da = ci < 0 ? -1 : src.indexOf("const d={};", ci), db = da < 0 ? -1 : src.indexOf("// APP shifts", da);
  const calRun = da > 0 && db > 0 ? vm.runInContext(`(function (schedule) { ${src.slice(da, db)}\n return d; })`, sandbox) : null;
  const calMap = (sched) => {
    const out = {};
    Object.entries(calRun(sched)).forEach(([ds, list]) => list.forEach((e) => {
      const t = String(e.type).replace(/^B-/, "");
      const slot = t === "Svc" ? "svc" : t === "Ngt" ? "night" : t === "Holiday" ? "cover"
        : t === "Wknd" ? (e.note === "Sat 7a–7a" ? "sat" : e.note === "5p–7a" ? "wkndFri" : e.note === "7a–7a" ? "wkndSun" : "wknd?") : null;
      if (slot) (out[ds] = out[ds] || []).push(`${slot}:${e.surgeon || ""}`);
    }));
    Object.values(out).forEach((l) => l.sort());
    return out;
  };
  const helperMap = (sched) => {
    const out = {};
    const put = (ds, s) => (out[ds] = out[ds] || []).push(s);
    Object.entries(sched).forEach(([m, wk]) => {
      const h = weekHoldersFn(m, wk);
      h.days.forEach((d) => ["svc", "sat", "night", "wkndFri", "wkndSun"].forEach((k) => { if (d[k]) put(d.ds, `${k}:${d[k]}`); }));
      h.covers.forEach((c) => put(c.ds, `cover:${c.sid || ""}`));
    });
    Object.values(out).forEach((l) => l.sort());
    return out;
  };
  const mapDiff = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((ds) => JSON.stringify(a[ds] || []) !== JSON.stringify(b[ds] || []))
    .map((ds) => `${ds}: calendar ${JSON.stringify(a[ds] || [])} vs helper ${JSON.stringify(b[ds] || [])}`);
  const SYN = {
    "2026-11-02": { dayCall: "s1", dayCallOverrides: { "2026-11-02": "s2", "2026-11-04": "s3", "2026-11-07": "s4" }, nights: { mon: "s5", tue: "s6", wed: "s7", thu: "s2", wknd: "s3" }, holidayCoverage: { "2026-11-02": { surgeonId: "s4", type: "minor", name: "Mon 24h" } } },
    "2026-11-16": { dayCall: null, dayCallOverrides: { "2026-11-17": "s2" }, nights: { mon: "s1", tue: "s3" } },
    "2026-11-23": { dayCall: "s2", nights: { wknd: "s5" }, holidayCoverage: { "2026-11-22": { surgeonId: "s6", type: "minor", name: "Eve stored in the wrong week" } } },
    "2026-11-30": { dayCall: "s3", isBackup: true, nights: { mon: "s1", wknd: "s2" }, holidayCoverage: { "2026-12-05": { surgeonId: "s7", type: "swap", name: "Saturday swap coverage" } } },
    "2027-03-08": { dayCall: "s4", nights: { mon: "s1", tue: "s2", wed: "s3", thu: "s5", wknd: "s6" }, holidayCoverage: { "2027-03-14": { surgeonId: "s7", type: "major", name: "Sun 24h", holiday: "Test Sunday" } } },
    "2027-03-15": { dayCall: "s5", nights: { wknd: "s1" }, holidayCoverage: { "2027-03-19": { surgeonId: "s2", type: "major", name: "Fri 24h", holiday: "Test Friday" }, "2027-03-20": { surgeonId: "s3", type: "major", name: "Sat 24h", holiday: "Test Friday" } } },
  };
  const x1live = weekHoldersFn && calRun ? mapDiff(calMap(LIVE), helperMap(LIVE)) : ["helper or calendar slice missing"];
  const x1syn = weekHoldersFn && calRun ? mapDiff(calMap(SYN), helperMap(SYN)) : ["helper or calendar slice missing"];
  check(`X1 weekHolders matches the calendar (calData, sliced verbatim) on every date and slot of all ${Object.keys(LIVE).length} live weeks`,
    Object.keys(LIVE).length === 46 && x1live.length === 0, x1live.slice(0, 3).join(" | "));
  check("X1 …and on synthetic shapes: a holiday over an override, overrides with no dayCall, an entry dated outside its week, a backup-week swap, the spring-forward week, a Fri + Sat holiday pair",
    x1syn.length === 0, x1syn.slice(0, 3).join(" | "));

  // X2 — the downloads (personal unless noted), on the live weeks
  const evs = (sid, opts) => (icsFn ? clone(icsFn(LIVE, sid, nameOf(sid), { nameOf, ...(opts || {}) })) : []);
  const inRange = (list, a, b) => list.filter((e) => e.start >= a && e.start <= b);
  const sig = (e) => `${e.start}-${e.end} ${e.summary}`;
  const FAK = evs("s6"), RPC = evs("s3"), REH = evs("s5"), KJH = evs("s4"), ARW = evs("s7"), DJA = evs("s1");
  const fak97 = inRange(FAK, "20260907", "20260913").filter((e) => /Service Week/.test(e.summary));
  check("X2 Labor Day week: FAK's service event is 9/8–9/12 (DTEND 20260913) with the line \"Mon 9/7 covered by RPC (Labor Day)\"",
    fak97.length === 1 && fak97[0].start === "20260908" && fak97[0].end === "20260913" && fak97[0].desc.includes("\nMon 9/7 covered by RPC (Labor Day)\n"), JSON.stringify(fak97));
  const rpc97 = RPC.filter((e) => e.start === "20260907");
  check("X2 Labor Day: RPC has exactly one event on 9/7, \"DSG Holiday — Labor Day\" in the feed's v15 format, and no 9/7 night",
    rpc97.length === 1 && rpc97[0].summary === "DSG Holiday — Labor Day" && rpc97[0].end === "20260908"
    && rpc97[0].desc === "Labor Day 24h: 7:00 AM – 7:00 AM next day (24h)\nTimes are Central." && rpc97[0].transparent === true, JSON.stringify(rpc97));
  const reh629 = inRange(REH, "20260629", "20260705").filter((e) => /Service Week/.test(e.summary));
  const fak629 = inRange(FAK, "20260629", "20260705").map(sig);
  check("X2 the 7/3 override: REH's service runs are Mon 6/29–Thu 7/2 and Sat 7/4 (each noting \"Fri 7/3 covered by FAK\"); FAK gets \"DSG Service Day\" on 7/3 beside his Mon night, Fri night and Sun",
    JSON.stringify(reh629.map((e) => `${e.start}-${e.end}`)) === JSON.stringify(["20260629-20260703", "20260704-20260705"]) && reh629.every((e) => e.desc.includes("\nFri 7/3 covered by FAK\n"))
    && JSON.stringify(fak629.sort()) === JSON.stringify(["20260629-20260630 DSG Night", "20260703-20260704 DSG Service Day", "20260703-20260704 DSG Weekend — Fri night", "20260705-20260706 DSG Weekend — Sun"].sort())
    && inRange(FAK, "20260703", "20260703").some((e) => e.summary === "DSG Service Day" && e.desc === "7:00 AM – 5:00 PM daytime call\nTimes are Central."),
    JSON.stringify({ reh: reh629.map((e) => `${e.start}-${e.end}`), fak: fak629 }));
  const kjh119 = inRange(KJH, "20260119", "20260125").filter((e) => /Service Week/.test(e.summary));
  const arw124 = ARW.filter((e) => e.start === "20260124");
  check("X2 the 1/24 swap: KJH's service event ends Fri 1/23 (noting ARW), ARW gets \"DSG Saturday swap coverage\" on 1/24, DJA's weekend is unchanged",
    kjh119.length === 1 && `${kjh119[0].start}-${kjh119[0].end}` === "20260119-20260124" && kjh119[0].desc.includes("\nSat 1/24 covered by ARW (Saturday swap coverage)\n")
    && arw124.length === 1 && arw124[0].summary === "DSG Saturday swap coverage" && arw124[0].desc.startsWith("Saturday swap coverage: 7:00 AM – 7:00 AM next day (24h)")
    && JSON.stringify(inRange(DJA, "20260119", "20260125").map(sig)) === JSON.stringify(["20260123-20260124 DSG Weekend — Fri night", "20260125-20260126 DSG Weekend — Sun"]),
    JSON.stringify({ kjh: kjh119.map(sig), arw: arw124.map(sig), dja: inRange(DJA, "20260119", "20260125").map(sig) }));
  const rpc525 = inRange(RPC, "20260525", "20260531").filter((e) => /Service Week/.test(e.summary));
  const dja525 = DJA.filter((e) => e.start === "20260525");
  check("X2 the 5/25 backup week: RPC's service event is 5/26–5/30 [BACKUP]; DJA gets \"DSG Holiday — Memorial Day [BACKUP]\"",
    rpc525.length === 1 && `${rpc525[0].start}-${rpc525[0].end}` === "20260526-20260531" && rpc525[0].summary === "DSG Service Week [BACKUP]"
    && dja525.length === 1 && dja525[0].summary === "DSG Holiday — Memorial Day [BACKUP]", JSON.stringify({ rpc: rpc525.map(sig), dja: dja525.map(sig) }));
  const fullRPC = evs("s3", { withCode: true }).filter((e) => e.start === "20260907");
  check("X2 full export: the holiday title ends with the coverer's code; every call event is transparent (free)",
    fullRPC.length === 1 && fullRPC[0].summary === "DSG Holiday — Labor Day — RPC" && [FAK, RPC, REH, KJH, ARW, DJA].every((l) => l.length > 0 && l.every((e) => e.transparent === true && e.allDay === true)),
    JSON.stringify(fullRPC));

  // X3 — the Mine roles from the REAL builder (sliced) + mineUpcoming
  const MA = "            const myShifts = [];", MB = "            const myShiftsView = mineUpcoming(myShifts, myToday);";
  const ma = src.indexOf(MA), mb = ma < 0 ? -1 : src.indexOf(MB, ma);
  const ha = src.indexOf("const holidayEmoji = (label) => {"), hb = ha < 0 ? -1 : src.indexOf("\n  };", ha);
  const holidayEmoji = ha > 0 && hb > 0 ? vm.runInContext(`(function () { ${src.slice(ha, hb + 4)}\n return holidayEmoji; })()`, sandbox) : null;
  const mineRun = ma > 0 && mb > 0 ? vm.runInContext(`(function (schedule, myId, nameOf, holidayEmoji, myToday) { ${src.slice(ma, mb + MB.length)}\n return { myShifts, myShiftsView }; })`, sandbox) : null;
  const mine = (sid, today, sched) => (mineRun ? clone(mineRun(sched || LIVE, sid, nameOf, holidayEmoji, today)) : null);
  const wkOf = (res, m, which) => (res ? (res[which].find((w) => w.mStr === m) || { roles: [] }).roles : []);
  const rpcM = mine("s3", "2026-09-01"), fakM = mine("s6", "2026-09-01");
  const rpcLabor = wkOf(rpcM, "2026-09-07", "myShiftsView");
  check("X3 Mine (today 9/1): RPC sees \"Labor Day 24h · Mon 9/7\" (dated, no swap, 🇺🇸) and no Mon night that week",
    rpcLabor.some((r) => r.type === "Labor Day 24h" && r.detail === "Mon 9/7 · 7a–7a" && r.date === "2026-09-07" && r.canSwap === false && r.icon === "🇺🇸" && r.shiftKey === null)
    && !rpcLabor.some((r) => r.shiftKey === "mon"), JSON.stringify(rpcLabor));
  const fakSvc = wkOf(fakM, "2026-09-07", "myShiftsView").find((r) => r.shiftKey === "dayCall");
  check("X3 Mine: FAK's 9/7 service role keeps its swap and carries the note; it starts on 9/8 (the first day he holds)",
    !!fakSvc && fakSvc.detail === "M–F 7a–5p + Sat 7a–Sun 7a · Mon 9/7 covered by RPC (Labor Day)" && fakSvc.canSwap === true && (fakSvc.held || [])[0] === "2026-09-08", JSON.stringify(fakSvc));
  const fak629M = wkOf(mine("s6", "2026-06-01"), "2026-06-29", "myShiftsView");
  check("X3 Mine: FAK's 6/29 week lists the Mon night, the Weekend and a dated \"Service Day\" (Fri 7/3 · 7a–5p, no swap)",
    JSON.stringify(fak629M.map((r) => r.type).sort()) === JSON.stringify(["Mon Night", "Service Day", "Weekend"]) && fak629M.some((r) => r.type === "Service Day" && r.detail === "Fri 7/3 · 7a–5p" && r.date === "2026-07-03" && r.canSwap === false),
    JSON.stringify(fak629M));
  const arw119 = wkOf(mine("s7", "2026-01-01"), "2026-01-19", "myShiftsView"), kjh119M = wkOf(mine("s4", "2026-01-01"), "2026-01-19", "myShiftsView");
  check("X3 Mine: ARW gets \"Saturday swap coverage 24h\" on 1/24; KJH's service role notes it",
    arw119.some((r) => r.type === "Saturday swap coverage 24h" && r.date === "2026-01-24") && kjh119M.some((r) => r.shiftKey === "dayCall" && r.detail.endsWith("Sat 1/24 covered by ARW (Saturday swap coverage)")),
    JSON.stringify({ arw119, kjh: kjh119M.map((r) => r.detail) }));
  const onDay = wkOf(mine("s3", "2026-09-07"), "2026-09-07", "myShiftsView"), after = wkOf(mine("s3", "2026-09-08"), "2026-09-07", "myShiftsView");
  check("X3 mineUpcoming: a dated role is listed through its own date (no swap, no in-progress tag) and gone the day after",
    onDay.some((r) => r.date === "2026-09-07" && r.canSwap === false) && !after.some((r) => r.date === "2026-09-07")
    && !!upFn && JSON.stringify(clone(upFn([{ mStr: "2026-09-07", roles: [{ shiftKey: null, date: "2026-09-07" }, { shiftKey: "tue" }] }], "2026-09-08"))[0].roles.map((r) => r.shiftKey)) === JSON.stringify(["tue"])
    // a dated role never offers a swap, even one that also carries a shift key
    && clone(upFn([{ mStr: "2026-09-07", roles: [{ shiftKey: "wed", date: "2026-09-09" }] }], "2026-09-01"))[0].roles[0].canSwap === false,
    JSON.stringify({ onDay: onDay.map((r) => r.type), after: after.map((r) => r.type) }));

  // X4 — nothing changes without a holiday or an override (main's code, frozen)
  const oldIcs = vm.runInContext(`(function () { ${fs.readFileSync(path.join(FIXD, "buildICSEvents-main-2b8cd39.txt"), "utf8")}\n return buildICSEvents; })()`, sandbox);
  const oldMine = vm.runInContext(`(function (schedule, myId) { ${fs.readFileSync(path.join(FIXD, "mine-builder-main-2b8cd39.txt"), "utf8")}\n return myShifts; })`, sandbox);
  const plain = {}; Object.entries(LIVE).forEach(([m, w]) => { if (!w.holidayCoverage && !w.dayCallOverrides) plain[m] = w; });
  let seed = 20261002;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const IDS = SURG.map((s) => s.id);
  const maybe = (p) => (rnd() < p ? pick(IDS) : null);
  const randW = {};
  for (let k = 0; k < 520; k++) randW[vm.runInContext(`fmt(addD(parse("2016-01-04"), ${7 * k}))`, sandbox)] = { dayCall: maybe(0.9), off: maybe(0.6), isBackup: rnd() < 0.12, isFierceBackup: rnd() < 0.1, nights: { mon: maybe(0.85), tue: maybe(0.85), wed: maybe(0.85), thu: maybe(0.85), wknd: maybe(0.9) } };
  const visible = (ws) => ws.map((w) => ({ mStr: w.mStr, endStr: w.endStr, isBackup: w.isBackup, isFierceBackup: w.isFierceBackup, roles: w.roles.map((r) => ({ type: r.type, icon: r.icon, detail: r.detail, color: r.color, shiftKey: r.shiftKey, date: r.date })) }));
  const x4bad = [];
  if (!mineRun || !icsFn || !weekHoldersFn || !src.includes("const hw = weekHolders(mStr, wk);")) x4bad.push("the new builder (weekHolders) is not in place");
  else for (const [label, sched] of [["live weeks without holiday/override", plain], ["520 random weeks", randW]]) {
    for (const s of SURG) {
      for (const opts of [{}, { withCode: true }]) {
        const a = JSON.stringify(clone(oldIcs(sched, s.id, s.name, opts))), b = JSON.stringify(clone(icsFn(sched, s.id, s.name, { ...opts, nameOf })));
        if (a !== b) x4bad.push(`${label} ${s.name} ics${opts.withCode ? " full" : ""}`);
      }
      const om = JSON.stringify(visible(clone(oldMine(sched, s.id)))), nm = JSON.stringify(visible(clone(mineRun(sched, s.id, nameOf, holidayEmoji, "2016-01-01").myShifts)));
      if (om !== nm.replace(/,"date":undefined/g, "")) x4bad.push(`${label} ${s.name} mine`);
    }
  }
  check(`X4 with no holiday and no override, the downloads (personal + full) and the Mine roles equal main's, for every surgeon, on the ${Object.keys(plain).length} plain live weeks and 520 random weeks`,
    Object.keys(plain).length >= 40 && x4bad.length === 0, x4bad.slice(0, 4).join(" | "));

  // X5 — the Next call card
  check("X5 the Next call card lists dated roles as their one day and starts a role on its first held day",
    count("if (!r.shiftKey && !r.date) return; // OFF isn't a call shift") === 1
    && count("const start = r.held && r.held.length ? parse(r.held[0]) : addD(mon, _startOff[r.shiftKey] ?? 0);") === 1
    && count("_nextUp.push({ ...r, start: day, end: day, days: Math.round((day - _today0) / _DAY), span: false, isBackup: s.isBackup, isFierceBackup: s.isFierceBackup });") === 1);

  // X6 — the real generator stores the holiday's name; the titles use it
  const gsb2 = { console: { ...console, warn: () => {} }, window: {}, document: undefined, navigator: { userAgent: "node-test" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, fetch: () => { throw new Error("fetch during generation"); }, setTimeout, clearTimeout };
  gsb2.globalThis = gsb2; vm.createContext(gsb2);
  for (const f of ["helpers.js", "config.js", "generator.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), gsb2, { filename: f });
  const G2 = vm.runInContext("({ generate, COUNTS_1YR, parse, addD, buildICSEvents: typeof buildICSEvents === 'function' ? buildICSEvents : null })", gsb2);
  const HA26 = JSON.parse(fs.readFileSync(path.join(FIXD, "holiday-assignments-2026-live.json"), "utf8"));
  const genSched = clone(G2.generate(SURG, Array.from({ length: 8 }, (_, k) => G2.addD(G2.parse("2026-11-16"), 7 * k)), {}, new Set(), {}, {}, new Set(), HA26, [], null, {}, G2.COUNTS_1YR));
  const genCov = {}; Object.values(genSched).forEach((w) => Object.entries((w && w.holidayCoverage) || {}).forEach(([ds, c]) => { genCov[ds] = c; }));
  const WANT_HOL = { "2026-11-26": ["s2", "Thanksgiving"], "2026-11-27": ["s3", "Thanksgiving"], "2026-11-28": ["s2", "Thanksgiving"], "2026-12-25": ["s6", "Christmas Day"], "2026-12-31": ["s5", "New Year's"], "2027-01-01": ["s1", "New Year's"], "2027-01-02": ["s5", "New Year's"] };
  check("X6 the generator stores each coverage day's holiday name (Thanksgiving's \"Fri 24h\" / \"Sat 24h\" days carry \"Thanksgiving\"; New Year's 1/1–1/2 carry \"New Year's\")",
    JSON.stringify(Object.keys(genCov).sort()) === JSON.stringify(Object.keys(WANT_HOL).sort()) && Object.entries(WANT_HOL).every(([ds, [sid, hol]]) => genCov[ds].surgeonId === sid && genCov[ds].holiday === hol)
    && genCov["2026-11-27"].name === "Fri 24h", JSON.stringify(genCov));
  const genEvents = SURG.flatMap((s) => clone(icsFn ? icsFn(genSched, s.id, s.name, { nameOf }) : []).map((e) => ({ ...e, sid: s.id })));
  const genBad = Object.entries(WANT_HOL).filter(([ds, [sid, hol]]) => {
    const day = ds.replace(/-/g, "");
    const onDay = genEvents.filter((e) => e.start === day);
    const regular = genEvents.filter((e) => e.start <= day && day < e.end && !/^DSG Holiday/.test(e.summary));
    return !(onDay.filter((e) => /^DSG Holiday/.test(e.summary)).length === 1 && onDay.some((e) => e.sid === sid && e.summary === `DSG Holiday — ${hol}`) && regular.length === 0);
  });
  check("X6 downloads from the generated period: one \"DSG Holiday — <holiday name>\" per covered date, on the coverer, and no regular event of anyone's spans a covered date",
    !!icsFn && genBad.length === 0, genBad.map(([ds]) => `${ds}: ${genEvents.filter((e) => e.start <= ds.replace(/-/g, "") && ds.replace(/-/g, "") < e.end).map((e) => `${e.sid} ${e.summary}`).join(", ")}`).join(" | "));

  // X8 — the Next call card's own code (sliced verbatim), run on real roles
  const na = src.indexOf("            const _nextUp = [];"), nb = na < 0 ? -1 : src.indexOf("_nextUp.sort((a, b) => a.start - b.start);", na);
  const nextRun = na > 0 && nb > 0 ? vm.runInContext(`(function (myShifts, _today0, _DAY, _startOff) { ${src.slice(na, nb + "_nextUp.sort((a, b) => a.start - b.start);".length)}\n return _nextUp; })`, sandbox) : null;
  const P = (ds) => vm.runInContext(`parse("${ds}")`, sandbox);
  const nextOf = (sid, today, sched) => (nextRun && mineRun ? nextRun(mineRun(sched || LIVE, sid, nameOf, holidayEmoji, today).myShifts, P(today), 86400000, { dayCall: 0, mon: 0, tue: 1, wed: 2, thu: 3, wknd: 4 })
    .map((e) => ({ type: e.type, start: vm.runInContext(`fmt`, sandbox)(e.start), end: vm.runInContext(`fmt`, sandbox)(e.end), span: e.span, days: e.days })) : []);
  const rpcNext = nextOf("s3", "2026-09-01").filter((e) => e.start <= "2026-09-13");
  const fakNext = nextOf("s6", "2026-09-01").filter((e) => e.start <= "2026-09-13");
  const tgWk = { "2026-11-23": { dayCall: "s1", nights: { mon: "s2", wknd: "s7" }, holidayCoverage: { "2026-11-26": { surgeonId: "s1", type: "major", name: "Thanksgiving 24h", holiday: "Thanksgiving" }, "2026-11-27": { surgeonId: "s3", type: "major", name: "Fri 24h", holiday: "Thanksgiving" } } } };
  const arwNext = nextOf("s7", "2026-11-01", tgWk);
  check("X8 the Next call card (its real code): a dated role is its one day; a service week starts on its first held day (FAK 9/8); a weekend whose Friday is covered starts on Sunday",
    rpcNext.some((e) => e.type === "Labor Day 24h" && e.start === "2026-09-07" && e.end === "2026-09-07" && e.span === false && e.days === 6)
    && fakNext.some((e) => e.type === "Service Week (incl. Sat)" && e.start === "2026-09-08")
    && arwNext.some((e) => e.type === "Weekend" && e.start === "2026-11-29"),
    JSON.stringify({ rpcNext, fakNext, arwNext }));

  // X9 — the generated holiday period (X6's real generator output)
  const codeOf = Object.fromEntries(SURG.map((s) => [s.id, s.name]));
  const selfNotes = [];
  for (const s of SURG) {
    for (const e of (icsFn ? clone(icsFn(genSched, s.id, s.name, { nameOf })) : [])) if (e.desc.includes(`covered by ${s.name}`)) selfNotes.push(`ics ${s.name} ${e.start} ${e.summary}`);
    for (const w of (mineRun ? clone(mineRun(genSched, s.id, nameOf, holidayEmoji, "2026-11-01")).myShifts : [])) for (const r of w.roles) if (String(r.detail).includes(`covered by ${s.name}`)) selfNotes.push(`mine ${s.name} ${w.mStr} ${r.type}`);
  }
  check("X9 the generated holiday period: no download description and no Mine role ever says a day was \"covered by\" its own surgeon (the coverer still holds it)",
    !!weekHoldersFn && !!icsFn && !!mineRun && selfNotes.length === 0 && genEvents.some((e) => / covered by /.test(e.desc)), selfNotes.slice(0, 4).join(" | "));
  const ICON = { Thanksgiving: "🦃", "Christmas Day": "🎄", "New Year's": "🎆" };
  const genRoleBad = [], offWithDated = [];
  for (const [ds, [sid, hol]] of Object.entries(WANT_HOL)) {
    const roles = mineRun ? clone(mineRun(genSched, sid, nameOf, holidayEmoji, "2026-11-01")).myShifts.flatMap((w) => w.roles) : [];
    const r = roles.find((x) => x.date === ds);
    if (!r || r.type !== `${hol} 24h` || r.icon !== ICON[hol] || r.canSwap !== undefined) genRoleBad.push(`${ds} ${codeOf[sid]} ${JSON.stringify(r)}`);
  }
  for (const s of SURG) for (const w of (mineRun ? clone(mineRun(genSched, s.id, nameOf, holidayEmoji, "2026-11-01")).myShifts : [])) if (w.roles.some((r) => r.type === "OFF") && w.roles.some((r) => r.date)) offWithDated.push(`${s.name} ${w.mStr}`);
  const offSyn = mineRun ? clone(mineRun({ "2026-11-23": { dayCall: "s1", off: "s2", nights: {}, holidayCoverage: { "2026-11-27": { surgeonId: "s2", type: "major", name: "Fri 24h", holiday: "Thanksgiving" } } } }, "s2", nameOf, holidayEmoji, "2026-11-01")).myShifts : [];
  check("X9 Mine on the generated period: every covered date gives its coverer one dated role titled with the holiday's name and its icon (🦃 🎄 🎆); an OFF surgeon who covers a holiday is not also told \"No call this week\"",
    !!mineRun && genRoleBad.length === 0 && offWithDated.length === 0 && offSyn.length === 1 && JSON.stringify(offSyn[0].roles.map((r) => r.type)) === JSON.stringify(["Thanksgiving 24h"]),
    `${genRoleBad.slice(0, 2).join(" | ")} ${offWithDated.join(",")} ${JSON.stringify(offSyn)}`);

  // X10 — override and cover variants (synthetic)
  const VAR = {
    "2026-07-27": { dayCall: "s5", dayCallOverrides: { "2026-08-01": "s6" }, nights: {} },                                  // Saturday override
    "2026-08-03": { dayCall: "s1", isBackup: true, dayCallOverrides: { "2026-08-05": "s2" }, nights: {} },                   // backup-week override
    "2026-08-10": { dayCall: "s3", dayCallOverrides: { "2026-08-11": "s3" }, nights: {} },                                  // override equal to the dayCall
    "2026-08-17": { dayCall: "s2", nights: { wknd: "s4" }, holidayCoverage: { "2026-08-23": { surgeonId: "s6", type: "major", name: "Sun 24h", holiday: "Test Sunday" } } }, // covered Sunday
    "2026-08-24": { dayCall: "s5", isBackup: true, nights: {}, holidayCoverage: { "2026-08-26": { surgeonId: "s2", type: "major", name: "Test Wed 24h" } } },            // backup-week holiday
    "2026-08-31": { dayCall: "s1", nights: {}, holidayCoverage: { "2026-08-30": { surgeonId: "s7", type: "minor", name: "Prior Sunday 24h" } } },                      // cover dated outside its week
  };
  const vEv = (sid, opts) => (icsFn ? clone(icsFn(VAR, sid, nameOf(sid), { nameOf, ...(opts || {}) })) : []);
  const vMine = (sid) => (mineRun ? clone(mineRun(VAR, sid, nameOf, holidayEmoji, "2026-07-01")).myShifts.flatMap((w) => w.roles.map((r) => ({ ...r, mStr: w.mStr }))) : []);
  const sv = (l) => l.map((e) => `${e.start}-${e.end} ${e.summary}`).sort();
  const reh = vEv("s5"), fakV = vEv("s6"), mcc = vEv("s2"), mccFull = vEv("s2", { withCode: true }), djaV = vEv("s1"), rpcV = vEv("s3"), kjhV = vEv("s4"), arwV = vEv("s7");
  const x10 = {
    satOverride: sv(reh.filter((e) => e.start < "20260803")).join() === "20260727-20260801 DSG Service Week" && reh[0].desc.includes("\nSat 8/1 covered by FAK\n")
      && fakV.some((e) => e.start === "20260801" && e.summary === "DSG Service Day" && e.desc === "Sat 7:00 AM – Sun 7:00 AM (24h)\nTimes are Central.")
      && vMine("s6").some((r) => r.type === "Service Day" && r.detail === "Sat 8/1 · 7a–7a" && r.date === "2026-08-01")
      && vMine("s5").some((r) => r.mStr === "2026-07-27" && r.detail === "M–F 7a–5p + Sat 7a–Sun 7a · Sat 8/1 covered by FAK"),
    backupOverride: sv(djaV.filter((e) => e.start >= "20260803" && e.start < "20260810")).join() === "20260803-20260805 DSG Service Week [BACKUP],20260806-20260809 DSG Service Week [BACKUP]"
      && mcc.some((e) => e.start === "20260805" && e.summary === "DSG Service Day [BACKUP]") && mccFull.some((e) => e.start === "20260805" && e.summary === "DSG Service Day [BACKUP] — MCC"),
    overrideIsDayCall: sv(rpcV).join() === "20260810-20260816 DSG Service Week" && !rpcV[0].desc.includes("covered by") && !rpcV.some((e) => /Service Day/.test(e.summary))
      && vMine("s3").filter((r) => r.mStr === "2026-08-10").map((r) => r.type).join() === "Service Week (incl. Sat)",
    coveredSunday: sv(kjhV).join() === "20260821-20260822 DSG Weekend — Fri night" && fakV.some((e) => e.start === "20260823" && e.summary === "DSG Holiday — Test Sunday")
      && vMine("s4").some((r) => r.type === "Weekend" && JSON.stringify(r.held) === JSON.stringify(["2026-08-21"]) && r.detail.endsWith("· Sun 8/23 covered by FAK (Test Sunday)")),
    backupHolidayFull: mccFull.some((e) => e.start === "20260826" && e.summary === "DSG Holiday — Test Wed [BACKUP] — MCC"),
    outOfWeekCover: arwV.some((e) => e.start === "20260830" && e.end === "20260831" && e.summary === "DSG Holiday — Prior Sunday")
      && vMine("s7").some((r) => r.date === "2026-08-30" && r.type === "Prior Sunday 24h" && r.mStr === "2026-08-31")
      && sv(djaV.filter((e) => e.start >= "20260831")).join() === "20260831-20260906 DSG Service Week",
  };
  check("X10 variants: a Saturday override (24h hours, the note, Mine \"Sat 8/1 · 7a–7a\"); a backup-week override ([BACKUP], full title order); an override equal to the dayCall (no change); a covered Sunday (the leg drops, Mine keeps Fri with a note); a backup-week holiday in the full export; a cover dated outside its week (downloads + Mine)",
    Object.values(x10).every(Boolean), JSON.stringify(x10));

  // X7 — X1 and the Labor Day events again in two time zones
  {
    const { execFileSync } = require("child_process");
    const code = [
      'const vm = require("vm"), fs = require("fs"), path = require("path");',
      'const sb = { console, window: {}, document: undefined, navigator: { userAgent: "node-test" }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, fetch: () => { throw new Error("no fetch"); }, setTimeout, clearTimeout };',
      "sb.globalThis = sb; vm.createContext(sb);",
      `for (const f of ["helpers.js", "config.js"]) vm.runInContext(fs.readFileSync(path.join(${JSON.stringify(ROOT)}, f), "utf8"), sb, { filename: f });`,
      `const LIVE = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(FIXD, "schedule-weeks-live-2026-10-02.json"))}, "utf8"));`,
      `const cal = vm.runInContext("(function (schedule) { " + ${JSON.stringify(da > 0 && db > 0 ? src.slice(da, db) : "")} + "\\n return d; })", sb);`,
      'const wh = vm.runInContext("weekHolders", sb), ics = vm.runInContext("buildICSEvents", sb);',
      "let mism = 0; const cm = {}, hm = {};",
      'Object.entries(cal(LIVE)).forEach(([ds, l]) => l.forEach((e) => { if (/Svc|Ngt|Wknd|Holiday/.test(e.type)) (cm[ds] = cm[ds] || []).push(String(e.surgeon || "")); }));',
      'Object.entries(LIVE).forEach(([m, w]) => { const h = wh(m, w); h.days.forEach((d) => ["svc", "sat", "night", "wkndFri", "wkndSun"].forEach((k) => { if (d[k]) (hm[d.ds] = hm[d.ds] || []).push(d[k]); })); h.covers.forEach((c) => (hm[c.ds] = hm[c.ds] || []).push(c.sid || "")); });',
      "for (const ds of new Set([...Object.keys(cm), ...Object.keys(hm)])) if (JSON.stringify((cm[ds] || []).sort()) !== JSON.stringify((hm[ds] || []).sort())) mism++;",
      'const fak = ics(LIVE, "s6", "FAK", {}).filter((e) => e.start >= "20260907" && e.start <= "20260913").map((e) => e.start + "-" + e.end + " " + e.summary);',
      'const rpc = ics(LIVE, "s3", "RPC", {}).filter((e) => e.start === "20260907").map((e) => e.summary);',
      'process.stdout.write(JSON.stringify({ off: new Date(2026, 9, 24).getTimezoneOffset(), mism, fak, rpc }));',
    ].join("\n");
    const inZone = (TZ) => { try { return JSON.parse(execFileSync(process.execPath, ["-e", code], { env: Object.assign({}, process.env, { TZ }), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); } catch (ex) { return { err: String(ex).slice(0, 300) }; } };
    const FAK97 = JSON.stringify(["20260908-20260913 DSG Service Week", "20260911-20260912 DSG Weekend — Fri night"].sort());
    for (const [TZ, off] of [["America/Chicago", 300], ["Asia/Tokyo", -540]]) {
      const o = inZone(TZ);
      const fakNoNight = o && o.fak ? JSON.stringify(o.fak.filter((s) => /Service Week/.test(s))) : "";
      check(`X7 under TZ=${TZ} (offset ${off}, proven): the helper still matches the calendar on all live weeks, FAK's service event is 9/8–9/12, RPC's 9/7 is only the holiday`,
        !!o && o.off === off && o.mism === 0 && fakNoNight === JSON.stringify(["20260908-20260913 DSG Service Week"]) && JSON.stringify(o.rpc) === JSON.stringify(["DSG Holiday — Labor Day"]),
        JSON.stringify(o).slice(0, 300) + " " + FAK97.slice(0, 0));
    }
  }
}

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
