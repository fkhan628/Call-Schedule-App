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
// An await that never settles empties the event loop and Node exits 0 —
// a hung test would read as a PASS. No verdict printed = failure.
let verdictReached = false;
process.on("exit", (code) => {
  if (!verdictReached && code === 0) { console.error("\nFAIL — sync-guards ended without a verdict (a hung await)"); process.exitCode = 1; }
});
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
  check("A15 schedule_weeks fetch fails, blob real → ok:false, nothing inserted (no schedule-less snapshot, any reason)", r.ok === false && writesIn(f).length === 0, JSON.stringify(r));
  // 6b. …but NOT for a capture that precedes a destructive operation (sync
  //     v2, I6): the schedule fold is required there, or the snapshot can't
  //     put the schedule back. Every strict reason, and nothing inserted.
  for (const reason of ["clear_schedule", "regenerate", "reset_all_data", "before_restore"]) {
    f = stubFetch([
      { m: "GET", url: "call_schedule_data", json: BLOB_ROW },
      { m: "GET", url: "schedule_weeks", status: 503, text: "boom" },
      { m: "GET", url: "time_off", json: TIME_OFF_ROWS },
      { m: "POST", url: "call_schedule_snapshots", status: 201, json: [] },
    ]);
    r = await snapshots.capture(reason);
    check(`strict capture (${reason}): schedule_weeks fold fails → ok:false, nothing inserted`, r.ok === false && writesIn(f).length === 0, JSON.stringify(r));
  }
  // 6c. A strict capture whose schedule read is EMPTY while the caller knows
  //     weeks exist (the anon/RLS shape) fails too; a genuinely empty table
  //     (minWeeks 0) is recorded as schedule: {}.
  f = stubFetch([
    { m: "GET", url: "call_schedule_data", json: BLOB_ROW },
    { m: "GET", url: "schedule_weeks", json: [] },
    { m: "GET", url: "time_off", json: TIME_OFF_ROWS },
    { m: "POST", url: "call_schedule_snapshots", status: 201, json: [] },
  ]);
  r = await snapshots.capture("clear_schedule", { minWeeks: 3 });
  check("strict capture: 200 + [] while 3 weeks are known → ok:false (RLS-empty shape), nothing inserted", r.ok === false && writesIn(f).length === 0, JSON.stringify(r));
  f = stubFetch([
    { m: "GET", url: "call_schedule_data", json: BLOB_ROW },
    { m: "GET", url: "schedule_weeks", json: [] },
    { m: "GET", url: "time_off", json: TIME_OFF_ROWS },
    { m: "POST", url: "call_schedule_snapshots", status: 201, json: [] },
  ]);
  r = await snapshots.capture("clear_schedule");
  const emptyIns = writesIn(f)[0];
  check("strict capture of a genuinely empty table records schedule: {} (restorable, not 'missing')",
    r.ok === true && !!emptyIns && JSON.parse(emptyIns.body).data.schedule && Object.keys(JSON.parse(emptyIns.body).data.schedule).length === 0, JSON.stringify(r));

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

  // A snapshot whose schedule fold had failed but whose time_off fold
  // worked: vacations make it NOT look empty, so payloadLooksWiped let it
  // through — and the applier ran with schedule {} and the grant: every
  // week deleted (critic, live on main). Refused on the missing key now.
  f = stubFetch([{ m: "GET", url: snapUrl, json: [{ id: 7, reason: "periodic_session", created_at: "c",
    data: { surgeons: INIT_SURGEONS, vacations: { s5: [["2026-09-12", "2026-09-21"]] } } }] }]);
  applied = 0;
  r = await snapshots.restore(7, async () => { applied++; return { ok: true }; });
  check("snapshot with vacations but NO schedule key → REFUSED (would delete every week), zero writes, applier never called",
    r.ok === false && /no schedule/.test(r.error || "") && applied === 0 && writesIn(f).length === 0, JSON.stringify(r));

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
  // A15: a periodic capture whose schedule fold fails inserts NOTHING and is
  // ok:false, so the 6-hour clock does not reset on a schedule-less snapshot.
  let f2 = stubFetch([
    { m: "GET", url: "call_schedule_snapshots?select=", json: [{ created_at: "2026-01-01T00:00:00Z" }] },
    { m: "GET", url: "call_schedule_data", json: BLOB_ROW },
    { m: "GET", url: "schedule_weeks", status: 503, text: "boom" },
    { m: "GET", url: "time_off", json: [] },
    { m: "POST", url: "call_schedule_snapshots", status: 201, json: [] },
  ]);
  r = await snapshots.captureIfStale("periodic_session", 6);
  check("A15 periodic capture, schedule fold 503 → ok:false, nothing inserted", r.ok === false && writesIn(f2).length === 0, JSON.stringify(r));
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
check("empty-save gate present at exactly 1 save path (the autosave; the blob keepalive is removed — A10)", count(GATE) === 1, `found ${count(GATE)}`);

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

// The schedule_weeks full-delete authorization (sync v2). It used to be a
// shared one-shot ref (intentionalScheduleWipeRef) granted at 3 sites and
// consumed at 2 — and a path that skipped the consume left it ARMED (the
// 2026-08-08 empty-reset dangle). Now the grant travels WITH the engine's
// authoritative request (clear, factory reset, restore), so there is nothing
// to leave armed. Behaviour is executed in section SE against the emulated
// table: SE19 (a wipe-shaped push without the grant deletes nothing), SE19b
// (a push queued before a clear defers to it — no false block), SE19c (the
// grant never lingers: after clear + regenerate a wipe is blocked again —
// the dangle's equivalent), SE19e, SE20, SE22. These pins keep the call
// sites honest: one place starts authoritative jobs, three call it.
check("the shared armed wipe grant is gone (no intentionalScheduleWipeRef anywhere)",
  count("intentionalScheduleWipeRef") === 0, `found ${count("intentionalScheduleWipeRef")}`);
check("the engine's wipe guard: a wipe-shaped push WITHOUT the request's grant is blocked (one guard)",
  count("if ((wipingAll || wipingMost) && !job.grant) {") === 1);
check("authoritative jobs start at exactly 2 sites — runAuthoritativeSchedule (the grant holders: clear, factory reset, restore) and runPublish (the period's weeks, no grant, no delete: Generate & Publish, Accept & Publish — A14) — a new caller needs this census updated",
  count(".authoritative(") === 2 && count("runAuthoritativeSchedule(") === 3
    && count('const runPublish = (weeks) => schedSyncRef.current.authoritative(weeks, false, "publish", Object.keys(weeks));') === 1 && count("runPublish(") === 2 && count("const job = runPublish(") === 2
    && count('runAuthoritativeSchedule({}, "clear")') === 1 && count('runAuthoritativeSchedule({}, "reset")') === 1 && count('runAuthoritativeSchedule(sched, "restore")') === 1,
  `.authoritative( ×${count(".authoritative(")}, runAuthoritativeSchedule( ×${count("runAuthoritativeSchedule(")}`);

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

  // 1. MEMBER: blob leg must not be attempted at all. The weeks are no longer
  //    in this body at all (sync v2): their own effect is executed below.
  const member = await run(false, denial);
  check("member: the blob autosave body carries NO schedule_weeks write (the weeks have their own effect, executed below)",
    member.weeks === 0 && !/schedSyncRef|syncSchedWeeks\(/.test(bodySrc), `weeks writes = ${member.weeks}`);
  check("member: ZERO blob write attempts", member.blob === 0);
  check("member: no save-failure toast, no red status churn",
    member.toasts.length === 0 && member.status.length === 0,
    `toasts=${JSON.stringify(member.toasts)} status=${JSON.stringify(member.status)}`);

  // 2. SCHEDULER whose blob write FAILS: weeks leg must STILL fire (the
  //    coupling also bit schedulers on any transient 5xx).
  const schedFail = await run(true, { error: "500 upstream boom" });
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
  check("scheduler + blob OK: the blob leg fires, status 'Saved'",
    schedOk.blob === 1 && schedOk.status.includes("Saved"));
})();

// ── The weeks push (sync v2): its OWN effect — the 2026-08-17 regression
// test's successor, executed: a loaded member or scheduler session pushes
// whatever the blob does (it isn't consulted), public / OR board never do. ──
await (async () => {
  const nsrc = src.replace(/\r\n/g, "\n");
  const START = "  useEffect(() => {\n    if (!loaded || isPublicMode) return;\n    const t = setTimeout(() => { schedSyncRef.current.push(); }, 800);";
  const i = nsrc.indexOf(START), e = i < 0 ? -1 : nsrc.indexOf("  }, [loaded, schedule]);", i);
  if (i < 0 || e < 0 || nsrc.indexOf(START, i + 1) !== -1) { check("weeks push effect extractable (exactly one)", false, "anchors not found"); return; }
  const body = nsrc.slice(i + "  useEffect(() => {".length, e);
  const mk = vm.runInContext(`(function (env) { const { loaded, isPublicMode, schedSyncRef, setTimeout, clearTimeout } = env; return (() => {${body}}); })`, sandbox);
  const go = (loaded, pub) => { let pushes = 0; const timers = []; const fx = mk({ loaded, isPublicMode: pub, schedSyncRef: { current: { push: () => { pushes++; } } }, setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout: () => {} }); fx(); timers.forEach(f => f()); return pushes; };
  check("weeks push effect: a loaded member / scheduler session pushes (member AND failed-blob cases: the blob isn't consulted)", go(true, false) === 1);
  check("weeks push effect: public / OR board never pushes; nothing before the load", go(true, true) === 0 && go(false, false) === 0);
  check("weeks push effect has none of the blob leg's gates (canWriteBlob, isScheduler, loadFailedRef, payloadLooksWiped, the 3-s skip)",
    !/canWriteBlob|isScheduler|loadFailedRef|payloadLooksWiped|loadedAtRef/.test(body), body.slice(0, 200));
})();

// ── Adopted foreign weeks produce ZERO echo writes (the old baseline-ref
// invariant). Since sync v2 the engine is the ONE adopter (the pull), and
// what it adopts becomes what it knows in the same step — executed in SE13
// ("the adopted W1 caused ZERO echo writes") and SE36 (two writers converge).
// This pin keeps it the only adopter: no realtime schedule_weeks handler.
check("schedule_weeks has no second adopter (no realtime handler; the engine's pull is the one)",
  count('table: "schedule_weeks" }') === 0 && count("schedSyncRef.current.pull()") === 3,
  `realtime: ${count('table: "schedule_weeks" }')}, pull triggers: ${count("schedSyncRef.current.pull()")}`);

// Source pins: the gate exists, mirrors the DB predicate, and is applied at
// all three write sites (autosave blob leg, keepalive blob leg, edge-URL).
check("canWriteBlob defined once, mirroring is_scheduler_or_admin()",
  count("const canWriteBlob = isScheduler;") === 1);
check("blob gate applied at exactly 2 sites (autosave, edge-URL; the blob keepalive is removed — A10)",
  count("if (!canWriteBlob) return;") === 2, `found ${count("if (!canWriteBlob) return;")}`);
check("the weeks are pushed from exactly one effect, never from inside the blob autosave (decoupling is structural, not incidental)",
  count("schedSyncRef.current.push(); }, 800);") === 1 && count("const syncSchedWeeks") === 0);

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
check("all 4 public-mode write guards remain `if (isPublicMode) return;` (autosave, day-off flush, schedule_weeks flush, config; the blob keepalive is removed — A10)",
  count("if (isPublicMode) return;") === 4, `found ${count("if (isPublicMode) return;")}`);
check("the sync engine's write gate keys on isPublicMode ALONE (never the OR flag); its push effect too",
  count("canWrite: !isPublicMode,") === 1 && count("if (!loaded || isPublicMode) return;") === 1);
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
  // its closure: DAYNAMES, the year being generated and FAK (the Christmas surgeon — his design-week eve, 2026-10-13)
  let buildCoverage, mkCov, gctxEH = null;
  try {
    // generator.js joins this sandbox later (as the page loads it after the app's helpers): its christmasDesignWeek comes from its own context
    const gctx = vm.createContext({ console, Math, Date, JSON, Set, Map, Object, Array, Number, String, Boolean, Int8Array, Int16Array, Uint8Array, Float64Array, Infinity, NaN, isFinite, parseInt, parseFloat, localStorage: { getItem() { return null; }, setItem() {} } });
    for (const f of ["config.js", "helpers.js", "generator.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), gctx, { filename: f });
    const cdw = vm.runInContext("christmasDesignWeek", gctx); gctxEH = gctx;
    const mk0 = vm.runInContext(
      `(function(year, christmasDesignWeek){ const DAYNAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]; const fakId = "s6"; ${fnSrc} return buildCoverage; })`,
      sandbox
    );
    mkCov = (y) => mk0(y, cdw);
    buildCoverage = mkCov(2029);
  } catch (ex) { check("buildCoverage compiles standalone", false, String(ex)); return; }
  // decision 3 (owner 2026-10-13): a New Year's eve that is a weekend night of FAK's Christmas design week is HIS (a
  // Tuesday Christmas: Mon 12/31 New Year's, Sun 12/30 eve) — the card, the swap and the time-off check follow the row;
  // any other year's eve stays surgeon B's
  const ny = (y) => mkCov(y)({ name: "New Year's", date: `${y}-12-31`, endDate: `${y + 1}-01-01` }, "s5", "s1").find(c => c.isEve);
  check("buildCoverage: a card's Night Before row is its surgeon B in every year (the stored data) — who really works a weekend eve of FAK's Christmas week is resolved live",
    [2026, 2027, 2028, 2029, 2030, 2031, 2033, 2035].every(y => ny(y).surgeon === "s1" && !ny(y).christmasWeek), JSON.stringify([2026, 2029, 2035].map(y => [y, ny(y).date, ny(y).surgeon])));
  // holidayEveHolder (generator.js), executed: FAK's only when the real Christmas card is his A = B, the eve is a weekend night of
  // that design week, and the cards give him the weekend (takesWknd — the generator's own pins); else surgeon B
  const EH = vm.runInContext("holidayEveHolder", gctxEH);
  const nyH = (y) => ({ name: "New Year's", date: `${y}-12-31`, surgeonA: "s5", surgeonB: "s1" }), xc = (y, a) => ({ [y]: [{ name: "Christmas Day", date: `${y}-12-25`, surgeonA: a, surgeonB: a }] });
  const yes = () => true, no = () => false;
  check("holidayEveHolder: the 2029 / 2035 New Year's eve (Sun 12/30) is FAK's when the cards give him his Christmas weekend, surgeon B's when they don't (time off, a Silvis day) or when the Christmas card isn't his; a weekday eve (2026 Wed 12/30) is always B's",
    EH(nyH(2029), "2029-12-30", xc(2029, "s6"), "s6", yes) === "s6" && EH(nyH(2035), "2035-12-30", xc(2035, "s6"), "s6", yes) === "s6" && EH(nyH(2029), "2029-12-30", xc(2029, "s6"), "s6", no) === "s1"
      && EH(nyH(2029), "2029-12-30", xc(2029, "s7"), "s6", yes) === "s1" && EH(nyH(2029), "2029-12-30", {}, "s6", yes) === "s1" && EH(nyH(2026), "2026-12-30", xc(2026, "s6"), "s6", yes) === "s1",
    JSON.stringify([EH(nyH(2029), "2029-12-30", xc(2029, "s6"), "s6", yes), EH(nyH(2029), "2029-12-30", xc(2029, "s6"), "s6", no), EH(nyH(2026), "2026-12-30", xc(2026, "s6"), "s6", yes)]));
  // Dec 25 weekday walk: 2026 Fri, 2027 Sat, 2028 Mon, 2029 Tue (the six-day
  // trap), 2030 Wed, 2031 Thu — every shape must cap at 2.
  for (let y = 2026; y <= 2031; y++) {
    const cov = mkCov(y)({ name: "Christmas Day", date: `${y}-12-25` }, "s6", "s6");
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
check("the holiday planner ranks by tenure-normalized RATES (holidayRate over both operands, handed to planHolidayPairs as rate)",
  count("const rateOf = (id, type) => holidayRate(lifetimeCt[id]?.[type] || 0, eligibleCt[id]?.[type] || 0);") === 1 && count("unavailable, rate: rateOf,") === 1,
  `found ${count("holidayRate(lifetimeCt")}`);
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
                pushUndo, updateSchedule, scheduleRef, schedEditable, addNotification, sendEmailNotif, schedulerAdminIds, confirm,
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
          updateSchedule: () => { log.schedWrites++; }, scheduleRef: { current: {} }, schedEditable: () => true,
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
      t.env.scheduleRef = { current: t.env.schedule };
      fetchStub = stubFetch([{ m: "PATCH", url: "shift_trade_requests", json: [{ id: 9 }] }]);
      await acceptFn(t.env)(baseReq(futureMon));
      check("valid future trade → status PATCH attempted and swap applied",
        writesIn(fetchStub).length === 1 && t.log.schedWrites === 1 && t.log.undo === 1
        && !t.log.toasts.some(x => /already passed/.test(x.msg)),
        `writes=${writesIn(fetchStub).length} sched=${t.log.schedWrites} toasts=${JSON.stringify(t.log.toasts)}`);
      // RED (sync v2, stale intents): the proposer no longer holds the shift —
      // someone changed the week since the trade was proposed (v2's pull now
      // shows that here). Refused BEFORE the status PATCH: the trade stays
      // pending, zero writes, zero notifications.
      t = mkEnv();
      t.env.schedule = { [futureMon]: { dayCall: "s9", nights: { tue: "s7", wed: "s2" }, off: null } };
      t.env.scheduleRef = { current: t.env.schedule };
      fetchStub = stubFetch([]);
      await acceptFn(t.env)(baseReq(futureMon));
      check("out-of-date trade (the proposer no longer holds the shift) → refused with ZERO writes, before the status PATCH",
        fetchStub.calls.length === 0 && t.log.schedWrites === 0 && t.log.undo === 0 && t.log.toasts.length === 1 && /out of date/.test(t.log.toasts[0].msg), JSON.stringify(t.log.toasts));
      // RED: the sign-in / load gate refuses before anything (nothing pending can be lost).
      t = mkEnv();
      t.env.schedule = { [futureMon]: { dayCall: "s9", nights: { tue: "s1", wed: "s2" }, off: null } };
      t.env.scheduleRef = { current: t.env.schedule }; t.env.schedEditable = () => false;
      fetchStub = stubFetch([]);
      await acceptFn(t.env)(baseReq(futureMon));
      check("the edit gate (not loaded / sign-in expired) refuses the accept before the status PATCH", fetchStub.calls.length === 0 && t.log.schedWrites === 0);
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
    /executeTwoWaySwap = useCallback\(\(targetMon[\s\S]{0,900}shiftStartDate\(targetMon, targetShift\)[\s\S]{0,2600}pushUndo\(\);/.test(src) && /executeTwoWaySwap = useCallback\(\(targetMon[\s\S]{0,2600}if \(!schedEditable\(\)\) return;[\s\S]{0,900}out of date[\s\S]{0,1200}pushUndo\(\);/.test(src)); // window 400→900→2600 (sync v2: the edit gate + the holder precondition sit between); order unchanged for the silvisBusy block (2026-09-24); order unchanged
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
  check("…and the generator's search still receives the untouched `vacations` map as its trailing-edge (vacationsOnly) argument",
    count("createScheduleSearch(surgeons, mondays, availability, backupMondaySet, priorCounts, prefs, fierceBackupSet, holidayAssignments, pendingLocks, prevWeekSeed, vacations, year1Counts, { silvisPrimary: buildSilvisPrimary() })") === 1
    && count("vacations[silvisFakId]") === 0);
  check("doGenerate: feed-health + coverage gate confirms BEFORE generating; dropped locks are toasted AFTER",
    count("Rule silvisBusy is BLIND for part or all of this period") === 1 && count("NOT honored by the generator") === 1
    && src.indexOf("Rule silvisBusy is BLIND") < src.indexOf("const search = createScheduleSearch(surgeons, mondays, availability") && src.indexOf("const search = createScheduleSearch(surgeons, mondays, availability") < src.indexOf("NOT honored by the generator"));
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
    && count("silvisBlock(candId, targetMon, targetShift, cur[targetMon])") === 1
    && count("silvisBlock(targetOldId, returnMon, returnShift, cur[returnMon])") === 1
    && count("silvisBlock(newId, mStr, shift, schedule[mStr])") === 1
    && count("silvisBlock(newLockSurgeon, newLockWeek, newLockSlot, schedule[newLockWeek])") === 1
    && count("silvisBlock(tradeTo, tradeWeek, tradeShift, schedule[tradeWeek])") === 2
    && count("silvisBlock(tradeFrom, tradeReturnWeek, tradeReturnShift, schedule[tradeReturnWeek])") === 2
    && count("silvisBlock(r.to_surgeon_id, r.week_monday, r.shift_key, schedule[r.week_monday])") === 1
    && (src.match(/silvisBlock\([^)]*\)/g) || []).every(c => /schedule\[|cur\[|, oldWk\)/.test(c) || /silvisBlock\(id, mondayStr, slotKey, wk\)/.test(c)),
    (src.match(/silvisBlock\([^)]*\)/g) || []).filter(c => !/schedule\[|cur\[|, oldWk\)|slotKey, wk\)/.test(c)).join(" | "));
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
    count("holDatesFor(hol, id, role)") === 2 && count('holDatesFor(hol, fakId, "both")') === 1
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
    // the closing of useCallback/useMemo/useEffect(..., [deps]) — after a block body "}" OR an
    // expression body ")" (2026-10-11: useMemo(() => f(x), [x]) shapes were invisible before)
    const depsRe = /[})]\s*,\s*\[([^\]]*)\]\s*\)/g;
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
    const d = /(?:^|[\s;(])(?:const|let|var)\s+(?:\[\s*)?zzz/.exec(bad), u = /[})]\s*,\s*\[([^\]]*)\]\s*\)/.exec(bad);
    check("deps-order scan: the crash shape (dep declared after its deps array) is detectable", !!d && !!u && d.index > u.index);
    // The expression-bodied shape too (useMemo(() => f(zzz), [zzz]) before `const zzz`), which the old "}"-only scan missed
    const bad2 = "  const a = useMemo(() => f(zzz), [zzz]);\n  const zzz = 1;";
    const d2 = /(?:^|[\s;(])(?:const|let|var)\s+(?:\[\s*)?zzz/.exec(bad2), u2 = /[})]\s*,\s*\[([^\]]*)\]\s*\)/.exec(bad2), uOld = /\}\s*,\s*\[([^\]]*)\]\s*\)/.exec(bad2);
    check("deps-order scan: the expression-bodied crash shape is detectable now (the old \"}\"-only pattern missed it)", !!d2 && !!u2 && d2.index > u2.index && !uOld);
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
    ["silvisConflicts", "  const silvisConflicts = useMemo(() => {", 7], // +1 Silvis on the service week's Sunday (2026-10-12); +1 a Davenport overnight next to a Silvis 24h (2026-10-13)
    ["conflicts", "  const conflicts = useMemo(() => {", 9], // +2 time-off lines (2026-10-11); +2 rule 1 Sunday / rule 2 Thu → weekend (2026-10-12)
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
      runConf = vm.runInContext("(function (env) { const { schedule, surgeons, sMap, SHIFT_LABELS, holidayAssignments, vacations, noCallDays } = env; const buildGenAvailability = env.buildGenAvailability || (() => { const m = {}; [vacations || {}, noCallDays || {}].forEach(src => Object.keys(src).forEach(k => { m[k] = (m[k] || []).concat(src[k]); })); return m; }); const buildSilvisPrimary = env.buildSilvisPrimary || (() => null); return (() => {" + confMemo.body + "})(); })", sandbox, { filename: "q-conflicts.js" });
      runVac = vm.runInContext("(function (env) { const { mondays, surgeons, apps, vacations, holidayAssignments, sMap } = env; const takesChristWknd = env.takesChristWknd || (() => false); return (() => {" + vacMemo.body + "})(); })", sandbox, { filename: "q-vac.js" });
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
    const b = a === -1 ? -1 : src.indexOf("{dismissedBar}", src.indexOf("more vacation-overlap line", a));
    const panel = a !== -1 && b !== -1 ? src.slice(a, b) : "";
    check("Q5 panel region found", panel.length > 0);
    check("Q5 the panel reads ONLY the filtered lists — header count, lines and both '+ more' notes (no raw producer reference)",
      panel.length > 0 && !/(^|[^.\w])(conflicts|silvisConflicts|vacOverlapWarnings)\b/.test(panel)
      && /const shownTotal = warnShown\.silvis\.length \+ warnShown\.conflicts\.length \+ warnShown\.vac\.length;/.test(panel)
      && panel.includes("⚠️ Schedule Warnings — {shownTotal}") && panel.includes("warnShown.silvis.length > 10") && panel.includes("warnShown.conflicts.length > 10") && panel.includes("warnShown.vac.length > 10"));
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

// ─── Y. DSG + Silvis personal totals card: the ONE counting function (Faraz 10/9; decisions 2026-10-11) ───
// callTotalsFor({ weeks, roster, silvisRows, code, today }) in helpers.js — pure, no clock — is the only
// counter behind FAK's totals card here AND the Silvis app's copy of the card (Silvis Prompt 31 copies
// weekBillingCredits + callTotalPeriods + callTotalsFor verbatim and NIGHT_KEYS' value into a new module,
// reusing its own identical fmt/parse/addD — see the PARITY CONTRACT in helpers.js — then runs the
// fixture below). DSG lines are Stats → Billing's own weekBillingCredits credits — no second definition;
// a backup week is counted by the SAME function as backup roles (dcB/nightsB/wkndB/holB). Silvis:
// primary_code / backup_code = code, one 07:00–07:00 day = 1. Weighted total: every backup role 0.5.
// A day on or before `today` is worked, after it scheduled. Everything is keyed by the roster CODE.
//   Y1 the synthetic fixture end to end (test/fixtures/call-totals-card-synthetic-2026-10-14.json — the
//      file the Silvis session copies; its numbers are hand-tallied, see its _hand_tally_FAK)
//   Y2 invariants on every period and month (sums, weights, months add up to the year and to YTD)
//   Y3 no second definition: on the 19 live weeks, every surgeon's DSG month (worked + scheduled,
//      dc/nights/wknd/hol) equals the real Stats → Billing block's month
//   Y4 a backup week = weekBillingCredits of the same week counted as 1st call (the live 5/25 Memorial
//      Day backup week: DJA holB 2, RPC dcB 6), which Billing itself skips
//   Y5 the periods (rolling-12, YTD, month, leap day, year turn); a bad date → null
//   Y6 fail loud: unknown/empty code and impossible dates refuse; codes compare case-insensitively;
//      empty data is ok with null ranges; malformed rows and non-date week keys are ignored
//   Y7 source: each function defined once; pure (no clock, React, DOM, storage, fetch); the DSG rules
//      are only weekBillingCredits' (no overrides / holidays / nights logic of its own)
//   Y8 Y1 again under TZ=America/Chicago and TZ=Asia/Tokyo (offsets proven)
{
  const FIX = path.join(ROOT, "test", "fixtures");
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, "call-totals-card-synthetic-2026-10-14.json"), "utf8"));
  const live = JSON.parse(fs.readFileSync(path.join(FIX, "billing-live-weeks-2026-10-01.json"), "utf8"));
  const Y = vm.runInContext('({ ctf: typeof callTotalsFor === "function" ? callTotalsFor : null, ctp: typeof callTotalPeriods === "function" ? callTotalPeriods : null, wbc: weekBillingCredits })', sandbox);
  const sortKeys = (x) => (x && typeof x === "object" && !Array.isArray(x)) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x;
  const canon = (v) => JSON.stringify(v, (k, x) => sortKeys(x));
  const firstDiff = (a, b, p = "$") => {
    if (canon(a) === canon(b)) return "";
    if (a && b && typeof a === "object" && typeof b === "object") {
      for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) { const d = firstDiff(a[k], b[k], `${p}.${k}`); if (d) return d; }
    }
    return `${p}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`.slice(0, 300);
  };
  const copy = (o) => JSON.parse(JSON.stringify(o));
  const ct = (input) => { if (!Y.ctf) return null; try { return copy(Y.ctf(copy(input))); } catch (ex) { return { threw: String(ex).slice(0, 200) }; } };
  const NONE = "callTotalsFor is not defined in helpers.js";
  const KINDS = ["dc", "nights", "wknd", "hol", "dcB", "nightsB", "wkndB", "holB", "silvisP", "silvisB", "dsg", "dsgB", "total", "weighted"];
  const SURG = ["DJA", "MCC", "RPC", "KJH", "REH", "FAK", "ARW"].map((name, i) => ({ id: "s" + (i + 1), name }));

  // Y1 — the fixture, end to end
  const out = ct(fx.input);
  check("Y1 the synthetic fixture: callTotalsFor gives exactly the hand-tallied card (5 periods × worked/scheduled, 12 months, data range)",
    !!out && canon(out) === canon(fx.expected), out ? firstDiff(out, fx.expected) : NONE);
  const oct = out && out.periods && out.periods.month;
  check("Y1 headline: October worked 3 dc + 1 night + 3 backup weekend days + Silvis 1 P / 2 B = 10 (weighted 7.5); scheduled 4 dc + 1 P = 5; today's 10/14 counts as worked",
    !!oct && oct.worked && oct.worked.total === 10 && oct.worked.weighted === 7.5 && oct.scheduled.total === 5 && oct.worked.dc === 3 && oct.scheduled.dc === 4 && oct.worked.silvisB === 2,
    oct ? JSON.stringify(oct).slice(0, 300) : NONE);

  // Y2 — invariants (also run on Y3's live outputs below)
  const invariantErrors = (o, label) => {
    if (!o || !o.ok || !o.periods || !Array.isArray(o.months)) return [`${label}: no output`];
    const errs = [];
    const cOk = (c, w) => {
      if (!c || KINDS.some((k) => typeof c[k] !== "number")) { errs.push(`${w}: missing fields`); return; }
      const dsg = c.dc + c.nights + c.wknd + c.hol, dsgB = c.dcB + c.nightsB + c.wkndB + c.holB;
      if (c.dsg !== dsg || c.dsgB !== dsgB || c.total !== dsg + dsgB + c.silvisP + c.silvisB || c.weighted !== dsg + c.silvisP + 0.5 * (dsgB + c.silvisB)) errs.push(`${w}: sums`);
    };
    ["month", "ytd", "year", "rolling12"].forEach((p) => { cOk(o.periods[p] && o.periods[p].worked, `${label} ${p}.worked`); cOk(o.periods[p] && o.periods[p].scheduled, `${label} ${p}.scheduled`); });
    o.months.forEach((m) => { cOk(m.worked, `${label} ${m.month}.worked`); cOk(m.scheduled, `${label} ${m.month}.scheduled`); });
    if (o.months.length !== 12) errs.push(`${label}: ${o.months.length} months`);
    const sum = (ms, part) => Object.fromEntries(KINDS.map((k) => [k, ms.reduce((a, m) => a + ((m[part] || {})[k] || 0), 0)]));
    if (errs.length) return errs;
    if (canon(sum(o.months, "worked")) !== canon(sortKeys(o.periods.year.worked)) || canon(sum(o.months, "scheduled")) !== canon(sortKeys(o.periods.year.scheduled))) errs.push(`${label}: months ≠ year`);
    const mi = Number(o.today.slice(5, 7));
    if (canon(sum(o.months.slice(0, mi), "worked")) !== canon(sortKeys(o.periods.ytd.worked))) errs.push(`${label}: Jan..this month worked ≠ YTD`);
    if (KINDS.some((k) => o.periods.ytd.scheduled[k] !== 0 || o.periods.rolling12.scheduled[k] !== 0)) errs.push(`${label}: YTD / rolling-12 must have nothing scheduled`);
    if (canon(o.periods.month) !== canon({ from: o.months[mi - 1].from, to: o.months[mi - 1].to, worked: o.months[mi - 1].worked, scheduled: o.months[mi - 1].scheduled })) errs.push(`${label}: this month ≠ its row in the month list`);
    return errs;
  };
  const y2 = invariantErrors(out, "fixture");
  check("Y2 invariants on the fixture: dsg/dsgB/total/weighted are their sums on every period and month; the months add up to the year; Jan..October worked = YTD; YTD and rolling-12 hold nothing scheduled",
    y2.length === 0, y2.join(" | "));

  // Y3 — no second definition: the live weeks through the real Stats → Billing block
  const billSlice = (() => { const a = src.indexOf("const monthly = {};"); const b = a < 0 ? -1 : src.indexOf("const sortedMonths = [...allMonths].sort();", a); return a < 0 || b < 0 ? null : src.slice(a, b); })();
  const billing = billSlice ? copy(vm.runInContext(`(function (schedule, surgeons) { ${billSlice}\n return monthly; })`, sandbox)(copy(live), SURG)) : null;
  let y3n = 0, y3bad = [], y3inv = [];
  const y3 = {};
  SURG.forEach((s) => {
    const o = ct({ weeks: live, roster: SURG, silvisRows: [], code: s.name, today: "2026-10-14" });
    y3[s.name] = o;
    y3inv.push(...invariantErrors(o, s.name));
    if (!o || !o.ok || !billing) return;
    o.months.forEach((m) => {
      const b = (billing[m.month] && billing[m.month][s.id]) || { dc: 0, nights: 0, wknd: 0, hol: 0 };
      ["dc", "nights", "wknd", "hol"].forEach((k) => { y3n++; if (m.worked[k] + m.scheduled[k] !== (b[k] || 0)) y3bad.push(`${s.name} ${m.month} ${k}: card ${m.worked[k] + m.scheduled[k]} billing ${b[k] || 0}`); });
    });
  });
  const sepOf = (code) => { const m = y3[code] && y3[code].months && y3[code].months[8]; return m ? ["dc", "nights", "wknd", "hol"].map((k) => m.worked[k] + m.scheduled[k]).join("/") : "?"; };
  check(`Y3 no second definition: on the 19 live weeks every surgeon's DSG month (dc/nights/wknd/hol, worked + scheduled) equals the real Stats → Billing block (${y3n} cells; September FAK 6/4/3/0, RPC 6/1/0/2)`,
    !!billing && y3n === 7 * 12 * 4 && y3bad.length === 0 && sepOf("FAK") === "6/4/3/0" && sepOf("RPC") === "6/1/0/2",
    !billing ? "billing block not found" : (y3bad.slice(0, 4).join(" | ") || `cells ${y3n}; Sep FAK ${sepOf("FAK")} RPC ${sepOf("RPC")}`));
  check("Y3 invariants hold on all seven live outputs", y3inv.length === 0, y3inv.slice(0, 4).join(" | "));

  // Y4 — backup weeks: the same function, counted as backup roles
  const w525 = live["2026-05-25"];
  const asFirst = (w) => Object.assign(copy(w), { isBackup: false });
  const byKind = (cs, sid) => cs.filter((c) => c.sid === sid).reduce((a, c) => { a[c.kind] = (a[c.kind] || 0) + c.n; return a; }, {});
  let y4bad = [];
  const y4 = {};
  SURG.forEach((s) => {
    const o = ct({ weeks: { "2026-05-25": w525 }, roster: SURG, silvisRows: [], code: s.name, today: "2026-10-14" });
    y4[s.name] = o;
    const may = o && o.months && o.months[4], w = byKind(copy(Y.wbc("2026-05-25", asFirst(w525))), s.id);
    if (!may) { y4bad.push(`${s.name}: no output`); return; }
    ["dc", "nights", "wknd", "hol"].forEach((k) => {
      if (may.worked[k + "B"] + may.scheduled[k + "B"] !== (w[k] || 0)) y4bad.push(`${s.name} ${k}B ${may.worked[k + "B"]} vs ${w[k] || 0}`);
      if (may.worked[k] + may.scheduled[k] !== 0) y4bad.push(`${s.name} ${k} ${may.worked[k]} (a backup week must not count as 1st call)`);
    });
  });
  const dja = y4.DJA && y4.DJA.months && y4.DJA.months[4], rpc = y4.RPC && y4.RPC.months && y4.RPC.months[4];
  check("Y4 a backup week counts as backup roles, exactly weekBillingCredits of the same week as 1st call: the live 5/25 week (Memorial Day, a real backup week Billing skips) gives DJA holB 2 and RPC dcB 6, and no 1st-call credit to anyone",
    !!w525 && w525.isBackup === true && Y.wbc("2026-05-25", w525).length === 0 && y4bad.length === 0
      && !!dja && dja.worked.holB === 2 && dja.worked.dc === 0 && !!rpc && rpc.worked.dcB === 6,
    y4bad.slice(0, 4).join(" | ") || JSON.stringify({ dja: dja && dja.worked, rpc: rpc && rpc.worked }).slice(0, 300));

  // Y5 — the periods
  const P = (t) => (Y.ctp ? copy(Y.ctp(t)) : null);
  const span = (p) => (p ? `${p.from}..${p.to}` : "null");
  const p1 = P("2026-10-14"), pLeap = P("2028-02-29"), pJan1 = P("2027-01-01"), pMar31 = P("2026-03-31"), pDec31 = P("2026-12-31");
  check("Y5 today 2026-10-14: month 10-01..10-31, YTD 01-01..10-14, year 01-01..12-31, rolling-12 2025-10-15..2026-10-14, 12 months Jan..Dec (Feb 2026 ends the 28th)",
    !!p1 && span(p1.month) === "2026-10-01..2026-10-31" && span(p1.ytd) === "2026-01-01..2026-10-14" && span(p1.year) === "2026-01-01..2026-12-31"
      && span(p1.rolling12) === "2025-10-15..2026-10-14" && p1.months.length === 12 && p1.months[0].month === "2026-01" && span(p1.months[1]) === "2026-02-01..2026-02-28" && p1.months[11].month === "2026-12",
    p1 ? JSON.stringify(p1).slice(0, 300) : "callTotalPeriods is not defined in helpers.js");
  check("Y5 edges: leap day 2028-02-29 → rolling-12 from 2027-03-01 (Feb 29 → Feb 28, + 1 day) and February ends the 29th; 2027-01-01 → YTD is that one day, rolling-12 from 2026-01-02; 2026-03-31 → from 2025-04-01; 2026-12-31 → rolling-12 = the calendar year",
    !!pLeap && span(pLeap.rolling12) === "2027-03-01..2028-02-29" && span(pLeap.month) === "2028-02-01..2028-02-29" && span(pLeap.months[1]) === "2028-02-01..2028-02-29"
      && !!pJan1 && span(pJan1.ytd) === "2027-01-01..2027-01-01" && span(pJan1.rolling12) === "2026-01-02..2027-01-01"
      && !!pMar31 && pMar31.rolling12.from === "2025-04-01" && !!pDec31 && span(pDec31.rolling12) === "2026-01-01..2026-12-31",
    [pLeap, pJan1, pMar31, pDec31].map((p) => (p ? span(p.rolling12) : "null")).join(" | "));
  check("Y5 a bad date gives null (never a guessed period): '2026-13-01', '2026-02-30', '', 'today', null",
    !!Y.ctp && ["2026-13-01", "2026-02-30", "", "today", null].every((t) => Y.ctp(t) === null));

  // Y6 — fail loud
  const base = copy(fx.input);
  const oUnknown = ct({ ...base, code: "ZZZ" }), oEmpty = ct({ ...base, code: "  " }), oBadDay = ct({ ...base, today: "2026-02-30" });
  check("Y6 an unknown code, an empty code and an impossible today all refuse (ok:false, the reason names the problem) — never zeros that look like 'no call'",
    !!oUnknown && oUnknown.ok === false && /ZZZ/.test(String(oUnknown.error)) && !!oEmpty && oEmpty.ok === false && !!oBadDay && oBadDay.ok === false && /2026-02-30/.test(String(oBadDay.error)),
    JSON.stringify([oUnknown, oEmpty, oBadDay]).slice(0, 300));
  const oLower = ct({ ...base, code: "fak", silvisRows: base.silvisRows.map((r) => ({ ...r, primary_code: r.primary_code && r.primary_code.toLowerCase(), backup_code: r.backup_code && r.backup_code.toLowerCase() })) });
  check("Y6 codes compare case-insensitively on both sides (the app's resolver and sfDaysFromRows do): 'fak' + lower-case Silvis codes give the fixture's numbers",
    !!oLower && oLower.ok === true && oLower.sid === "s6" && canon(oLower.periods) === canon(fx.expected.periods), oLower ? firstDiff(oLower.periods, fx.expected.periods) : NONE);
  const oNone = ct({ weeks: {}, roster: SURG, silvisRows: [], code: "FAK", today: "2026-10-14" });
  check("Y6 no data at all is ok with null ranges and zeros (the card, not the counter, says the data is missing)",
    !!oNone && oNone.ok === true && oNone.range && oNone.range.dsgFrom === null && oNone.range.dsgTo === null && oNone.range.silvisFrom === null && oNone.range.silvisTo === null
      && oNone.periods && oNone.periods.year.worked.total === 0, JSON.stringify(oNone).slice(0, 300));
  const noisy = copy(base);
  noisy.weeks.notes = { dayCall: "s6" }; noisy.weeks["2026-13-02"] = { dayCall: "s6" }; noisy.weeks["2026-07-06"] = null;
  noisy.silvisRows.push(null, { day: "2026-10-1", primary_code: "FAK" }, { primary_code: "FAK" }, { day: "garbage", backup_code: "FAK" });
  const oNoisy = ct(noisy);
  check("Y6 malformed Silvis rows, non-date week keys and empty weeks are ignored (same card as the clean fixture)",
    !!oNoisy && canon(oNoisy) === canon(fx.expected), oNoisy ? firstDiff(oNoisy, fx.expected) : NONE);

  // Y7 — source
  const hsrcY = fs.readFileSync(path.join(ROOT, "helpers.js"), "utf8");
  const bodyOf = (name) => { const a = hsrcY.search(new RegExp(`^function ${name}\\(`, "m")); if (a < 0) return null; const b = hsrcY.slice(a + 1).search(/^function |^const |^var |^let /m); return b < 0 ? hsrcY.slice(a) : hsrcY.slice(a, a + 1 + b); };
  const bCT = bodyOf("callTotalsFor"), bCP = bodyOf("callTotalPeriods");
  const banned = ["new Date()", "Date.now", "useState", "useMemo", "useEffect", "window.", "document.", "localStorage", "fetch(", "previewSchedule", "Math.random"];
  check("Y7 helpers.js defines callTotalsFor(input) and callTotalPeriods(today) exactly once each",
    (hsrcY.match(/^function callTotalsFor\(input\) \{/gm) || []).length === 1 && (hsrcY.match(/^function callTotalPeriods\(today\) \{/gm) || []).length === 1);
  check(`Y7 both are pure — no clock, React, DOM, storage, fetch or draft state: none of ${JSON.stringify(banned)}`,
    !!bCT && !!bCP && banned.every((t) => !bCT.includes(t) && !bCP.includes(t)),
    !bCT || !bCP ? "function not found" : banned.filter((t) => bCT.includes(t) || bCP.includes(t)).join(", "));
  // A week row's slots are read as <row>.nights.<slot> / .nights?.<slot> / .nights[...] and <row>.dayCall;
  // the function's own bucket sums (o.nights) are not slot reads.
  const SECOND_DEF = /dayCallOverrides|holidayCoverage|NIGHT_KEYS|\.nights\??\.|\.nights\??\[|\.dayCall\b/;
  check("Y7 no second definition in the source: callTotalsFor delegates every DSG rule to weekBillingCredits (it never reads dayCallOverrides, holidayCoverage, the nights slots or NIGHT_KEYS itself)",
    !!bCT && bCT.includes("weekBillingCredits(") && !SECOND_DEF.test(bCT),
    bCT ? (bCT.match(SECOND_DEF) || ["delegation missing"])[0] : "function not found");

  // Y8 — Y1 under America/Chicago and Asia/Tokyo
  {
    const { execFileSync } = require("child_process");
    const code = [
      'const vm = require("vm"), fs = require("fs"), path = require("path");',
      'const sb = { console, window: {}, document: undefined, navigator: { userAgent: "node-test" }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, fetch: () => { throw new Error("no fetch"); }, setTimeout, clearTimeout };',
      "sb.globalThis = sb; vm.createContext(sb);",
      `for (const f of ["helpers.js", "config.js"]) vm.runInContext(fs.readFileSync(path.join(${JSON.stringify(ROOT)}, f), "utf8"), sb, { filename: f });`,
      'const ctf = vm.runInContext("typeof callTotalsFor === \\"function\\" ? callTotalsFor : null", sb);',
      `const input = ${JSON.stringify(fx.input)};`,
      'process.stdout.write(JSON.stringify({ off: new Date(2026, 9, 24).getTimezoneOffset(), naive: new Date("2026-10-14").getDate(), out: ctf ? ctf(input) : null }));',
    ].join("\n");
    const inZone = (TZ) => { try { return JSON.parse(execFileSync(process.execPath, ["-e", code], { env: Object.assign({}, process.env, { TZ }), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); } catch (ex) { return { err: String(ex).slice(0, 300) }; } };
    const chi = inZone("America/Chicago"), tok = inZone("Asia/Tokyo");
    check("Y8 the children really run in America/Chicago (offset 300; the naive new Date('2026-10-14') is the 13th there) and Asia/Tokyo (offset −540)",
      !!chi && chi.off === 300 && chi.naive === 13 && !!tok && tok.off === -540, JSON.stringify({ chi: chi && { off: chi.off, naive: chi.naive, err: chi.err }, tok: tok && { off: tok.off, err: tok.err } }));
    check("Y8 under TZ=America/Chicago and TZ=Asia/Tokyo the fixture gives exactly the same card",
      !!chi && !!chi.out && canon(chi.out) === canon(fx.expected) && !!tok && !!tok.out && canon(tok.out) === canon(fx.expected),
      chi && chi.out ? firstDiff(chi.out, fx.expected) || (tok && tok.out ? firstDiff(tok.out, fx.expected) : "tokyo: no output") : NONE);
  }

  // Y9 — the card's wiring in index-source.html
  const GATE = "{!isPublicMode && !!userProfile?.person_id && !!silvisFakId && userProfile.person_id === silvisFakId && myId === silvisFakId && (";
  let gateFn = null;
  try { gateFn = count(GATE) === 1 ? vm.runInContext(`(function (env) { const { isPublicMode, userProfile, silvisFakId, myId } = env; return !!(${GATE.slice(1, -4)}); })`, sandbox) : null; } catch (ex) { gateFn = null; }
  const G = (isPublicMode, person, fakId, myId) => gateFn({ isPublicMode, userProfile: person === null ? null : { person_id: person }, silvisFakId: fakId, myId });
  const gateCases = gateFn ? [
    ["FAK signed in, on his own Mine page", G(false, "s6", "s6", "s6"), true],
    ["FAK signed in, viewing another surgeon's Mine (scheduler)", G(false, "s6", "s6", "s2"), false],
    ["another surgeon signed in, Mine selector set to FAK", G(false, "s2", "s6", "s6"), false],
    ["the office account (person_id 'admin'), selector on FAK", G(false, "admin", "s6", "s6"), false],
    ["signed out, selector on FAK", G(false, null, "s6", "s6"), false],
    ["public mode", G(true, "s6", "s6", "s6"), false],
    ["the code resolves to nobody", G(false, "s6", null, "s6"), false],
  ] : [];
  check("Y9 the card shows ONLY for the signed-in account whose code is silvisRule.code, on its own Mine page — the gate, run as written, refuses the scheduler viewing someone else, another surgeon with the selector on FAK, the office account, signed-out, public mode and an unresolved code",
    gateCases.length === 7 && gateCases.every(([, got, want]) => got === want), gateFn ? gateCases.filter(([, got, want]) => got !== want).map(([w]) => w).join(" | ") : "gate literal not found exactly once");
  const iSilvis = src.indexOf("{myId && silvisFakId && myId === silvisFakId && (() => {"), iCard = src.indexOf(GATE), iVac = src.indexOf("{/* My Vacations — completed (past) ones hidden; shown in date order */}");
  const callAt = iCard < 0 ? "" : src.slice(iCard, src.indexOf("/>", iCard));
  // The card must BE the gate's last && operand (a card placed after the gate's closing parenthesis
  // would still leave the literal and the call text in place — a privacy leak the checks above miss).
  const GATED_CARD = /\{!isPublicMode && !!userProfile\?\.person_id && !!silvisFakId && userProfile\.person_id === silvisFakId && myId === silvisFakId && \(\s*<CallTotalsCard\b[^]*?\/>\s*\)\}/g;
  check("Y9 the card is the gate's own operand: {GATE && ( <CallTotalsCard …/> )} is the only card in the file",
    (src.match(GATED_CARD) || []).length === 1 && count("<CallTotalsCard") === 1, `gated ${(src.match(GATED_CARD) || []).length}, cards ${count("<CallTotalsCard")}`);
  check("Y9 placed in Mine after the 🚑 Silvis section and before My Vacations; it counts the PUBLISHED weeks (schedule) — never the generator preview — and the full Silvis cache, guarded against an old cached helpers.js",
    iSilvis > 0 && iCard > iSilvis && iVac > iCard && count("<CallTotalsCard") === 1
      && callAt.includes('typeof callTotalsFor === "function" ? callTotalsFor({ weeks: schedule, roster: surgeons, silvisRows, code: silvisRule.code, today: fmt(new Date()) }) : null')
      && !callAt.includes("previewSchedule") && !callAt.includes("mySurgeon"), `${iSilvis} < ${iCard} < ${iVac}; ${callAt.slice(0, 160)}`);
  const cardSrc = (() => { const a = src.indexOf("function CallTotalsCard({ totals, silvisNote, css, dk }) {"); const b = a < 0 ? -1 : src.indexOf("// Reusable collapsible section.", a); return a < 0 || b < 0 ? "" : src.slice(a, b); })();
  check("Y9 CallTotalsCard is defined once at module scope and only renders: no fetch, Supabase client, storage or app write path; a refused or missing count shows as text, not zeros",
    count("function CallTotalsCard({ totals, silvisNote, css, dk }) {") === 1 && !!cardSrc
      && !/fetch\(|supabase|localStorage|dbAuthHeaders|dbHeaders|setSchedule|syncSchedWeeks/.test(cardSrc)
      && cardSrc.includes('if (!totals || totals.ok !== true) {') && cardSrc.includes("Totals unavailable — "),
    cardSrc ? (cardSrc.match(/fetch\(|supabase|localStorage|dbAuthHeaders|dbHeaders|setSchedule|syncSchedWeeks/) || ["fail-loud branch missing"])[0] : "component not found");
  // An EMPTY Silvis feed (sfNotice failed / empty) shows "?" in the Silvis cells and both two-site totals —
  // never "–" and DSG-only totals that read as "no Silvis call". Every number cell goes through show().
  check("Y9 an empty Silvis feed shows \"?\" in the Silvis and total cells (show()), never zeros or DSG-only totals",
    cardSrc.includes('const silvisOut = !!silvisNote && (silvisNote.kind === "failed" || silvisNote.kind === "empty");')
      && cardSrc.includes("const SILVIS_KEYS = { silvisP: 1, silvisB: 1, total: 1, weighted: 1 };")
      && (cardSrc.match(/\{show\(r\.k, /g) || []).length === 3 && cardSrc.includes("{show(k, v(k))}") && !/\{cell\(/.test(cardSrc),
    cardSrc ? `show(r.k ×${(cardSrc.match(/\{show\(r\.k, /g) || []).length}; raw cell( in JSX: ${/\{cell\(/.test(cardSrc)}` : "component not found");
}

// ─── Z. silvisBusy keeps reading v6's rows (spec item 1; decisions 2026-10-11) ───
// silvis-feed v7 keeps up to 12 months of Silvis history in silvis_feed and pulls up to today + 400, for
// the totals card only. Every EXISTING Silvis consumer — the rule (editor, swaps, trades, holidays,
// suggestions, generator fold), the 🚑 chips (the office link too), the feed card, the generate gate and
// the horizon note — must keep seeing exactly the rows v6 cached. sfRuleRows(rows) keeps the rows inside
// [Central date of the newest fetched_at − 7, + 120]: v6's WINDOW_BACK_DAYS / WINDOW_FWD_DAYS around
// the pull that wrote them (every row of one pull carries that pull's fetched_at).
//   Z1 a v6-shaped cache passes through unchanged
//   Z2 a v7-shaped cache (history from 9/14 + days past +120) gives exactly v6's rows and silvisDays
//   Z3 the Central date decides, not UTC: 23:30 vs 00:30 CDT, and CST after DST ends
//   Z4 no or unreadable fetched_at → rows unchanged (over-block, never go blind); empty → []
//   Z5 Z3 again with the DEVICE in Asia/Tokyo and America/Chicago: the same window
//   Z6 exported for Node
{
  const Z = vm.runInContext('({ rr: typeof sfRuleRows === "function" ? sfRuleRows : null, dfr: sfDaysFromRows })', sandbox);
  const NONE = "sfRuleRows is not defined in silvis-feed.js";
  const zAdd = (ds, n) => { const d = new Date(ds + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const daysFrom = (a, b) => { const out = []; for (let d = a; d <= b; d = zAdd(d, 1)) out.push(d); return out; };
  const FETCHED = "2026-10-10T20:06:11.589+00:00"; // the live cache's newest fetched_at on 2026-10-11 (Central 10/10)
  const rowFor = (day, i, fetched) => ({ day, primary_code: i % 7 === 0 ? "FAK" : "MAB", backup_code: i % 7 === 3 ? "FAK" : "BDA", fetched_at: fetched });
  const silvisAll = daysFrom("2026-09-14", "2027-03-10").map((d, i) => rowFor(d, i, FETCHED));
  const v6rows = silvisAll.filter((r) => r.day >= "2026-10-03" && r.day <= "2027-02-07");
  const rr = (rows) => (Z.rr ? Z.rr(rows) : null);
  const daysSig = (d) => JSON.stringify({ p: [...d.primary].sort(), b: [...d.backup].sort(), from: d.from, to: d.to, f: d.fetchedAt });

  const z1 = rr(v6rows);
  check("Z1 a v6-shaped cache (10/03..02/07, fetched 10/10 Central) passes through unchanged — same rows, same order",
    !!z1 && z1.length === v6rows.length && z1.every((r, i) => r === v6rows[i]), z1 ? `${z1.length} of ${v6rows.length}` : NONE);
  const z2 = rr(silvisAll);
  check(`Z2 a v7-shaped cache (${silvisAll.length} rows, 9/14..3/10) keeps exactly v6's ${v6rows.length} rows (10/03..02/07) and gives the same silvisDays (FAK primary/backup sets, from, to, fetchedAt)`,
    !!z2 && JSON.stringify(z2) === JSON.stringify(v6rows) && daysSig(Z.dfr(z2, "FAK")) === daysSig(Z.dfr(v6rows, "FAK")) && Z.dfr(z2, "FAK").from === "2026-10-03" && Z.dfr(z2, "FAK").to === "2027-02-07",
    z2 ? `${z2.length} rows ${z2[0] && z2[0].day}..${z2[z2.length - 1] && z2[z2.length - 1].day}` : NONE);

  const wide = daysFrom("2026-08-01", "2027-06-30");
  const windowAt = (fetched) => { const k = rr(wide.map((d, i) => rowFor(d, i, fetched))); return k && k.length ? `${k[0].day}..${k[k.length - 1].day}` : "none"; };
  const Z3 = [
    ["2026-10-11T04:30:00Z", "2026-10-03..2027-02-07"], // 23:30 CDT Sat 10/10
    ["2026-10-11T05:30:00Z", "2026-10-04..2027-02-08"], // 00:30 CDT Sun 10/11
    ["2026-12-01T05:30:00Z", "2026-11-23..2027-03-30"], // 23:30 CST Mon 11/30 (DST ended 11/1)
    ["2026-12-01T06:30:00Z", "2026-11-24..2027-03-31"], // 00:30 CST Tue 12/1
  ];
  const z3got = Z3.map(([f]) => windowAt(f));
  check("Z3 the window follows the CENTRAL date of the pull: 04:30Z on 10/11 is still 10/10 (CDT), 05:30Z is 10/11; after DST ends 05:30Z on 12/1 is still 11/30 (CST), 06:30Z is 12/1",
    Z3.every(([, want], i) => z3got[i] === want), z3got.join(" | "));

  const noStamp = silvisAll.map(({ fetched_at, ...r }) => r), badStamp = silvisAll.map((r) => ({ ...r, fetched_at: "garbage" }));
  const z4a = rr(noStamp), z4b = rr(badStamp);
  check("Z4 rows with no fetched_at, or an unreadable one, come back unchanged (the rule over-blocks rather than going blind); [] and null give []",
    !!z4a && z4a.length === noStamp.length && !!z4b && z4b.length === badStamp.length && Array.isArray(rr([])) && rr([]).length === 0 && Array.isArray(rr(null)) && rr(null).length === 0,
    z4a ? `${z4a.length}/${noStamp.length} ${z4b && z4b.length}/${badStamp.length}` : NONE);

  {
    const { execFileSync } = require("child_process");
    const code = `const sf = require(${JSON.stringify(path.join(ROOT, "silvis-feed.js"))});
      const add = ${zAdd.toString()};
      const wide = []; for (let d = "2026-08-01"; d <= "2027-06-30"; d = add(d, 1)) wide.push(d);
      const at = (f) => { if (typeof sf.sfRuleRows !== "function") return "missing"; const k = sf.sfRuleRows(wide.map((d) => ({ day: d, primary_code: "FAK", backup_code: null, fetched_at: f }))); return k.length ? k[0].day + ".." + k[k.length - 1].day : "none"; };
      process.stdout.write(JSON.stringify({ off: new Date(2026, 9, 24).getTimezoneOffset(), w: ${JSON.stringify(Z3.map(([f]) => f))}.map(at) }));`;
    const inZone = (TZ) => { try { return JSON.parse(execFileSync(process.execPath, ["-e", code], { env: Object.assign({}, process.env, { TZ }), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); } catch (ex) { return { err: String(ex).slice(0, 300) }; } };
    const tok = inZone("Asia/Tokyo"), chi = inZone("America/Chicago");
    check("Z5 with the DEVICE in Asia/Tokyo (offset −540) and America/Chicago (300) the window is the same Central one as Z3",
      !!tok && tok.off === -540 && JSON.stringify(tok.w) === JSON.stringify(Z3.map(([, w]) => w)) && !!chi && chi.off === 300 && JSON.stringify(chi.w) === JSON.stringify(Z3.map(([, w]) => w)),
      JSON.stringify({ tok, chi }).slice(0, 300));
  }
  let zExp = null; try { zExp = require(path.join(ROOT, "silvis-feed.js")); } catch (ex) { zExp = null; }
  check("Z6 sfRuleRows is exported from silvis-feed.js for Node (the sf-prefixed classic-script convention)",
    !!zExp && typeof zExp.sfRuleRows === "function");

  // Z7 — the app wires every existing reader through the window
  check("Z7 the app derives silvisDays from sfRuleRows(silvisRows), and nothing derives day sets from the full cache",
    count("const silvisRuleRows = useMemo(() => sfRuleRows(silvisRows), [silvisRows]);") === 1
      && count("const silvisDays = useMemo(() => sfDaysFromRows(silvisRuleRows, silvisRule.code), [silvisRuleRows, silvisRule.code]);") === 1
      && count("sfDaysFromRows(silvisRows") === 0 && count("sfDaysFromRows(") === 1
      && src.indexOf("const silvisRuleRows = useMemo(") < src.indexOf("const silvisDays = useMemo("));
  check("Z7 the feed card's 'days cached' counts the rule's window (same number as before v7), next to the unchanged covers line",
    count("<b>{silvisRuleRows.length}</b> days cached") === 1 && count("<b>{silvisRows.length}</b> days cached") === 0 && count("covers {silvisDays.from} → {silvisDays.to}") === 1);
}

// ─── AA. Request submits fail loud (2026-10-11, audit QW7) ───
// db.insert returns { data:null, error } on an HTTP failure — it does not throw.
// submitVacRequest / submitTradeRequest read only `data`, so a 401 / 403 / RLS
// refusal cleared the form and said NOTHING (IN-FILE CONVENTION 3). Now each
// says why (writeFailReason), keeps the form, confirms success, refuses an end
// date before the start and a double tap. Executed on the REAL handler bodies.
//   AA1 vacation: RLS refusal / expired sign-in / success / double tap / bad dates / empty form
//   AA2 trade:    RLS refusal / success / double tap / empty form; the Silvis refusal still precedes the insert
//   AA3 success toasts before notifying (a notification failure is the last word); thrown insert; tap while busy says so
{
  const nsrcAA = src.replace(/\r\n/g, "\n");   // a Windows checkout is CRLF, CI's is LF
  const bodyOf = (decl, depsHead) => {
    const i = nsrcAA.indexOf(decl); if (i < 0) return null;
    const a = nsrcAA.indexOf("async () => {", i), b = nsrcAA.indexOf("\n  }, [" + depsHead, i);
    return a < 0 || b < 0 ? null : nsrcAA.slice(a, b) + "\n  }";
  };
  const wfrSrc = (() => { const a = nsrcAA.indexOf("function writeFailReason(err) {"); const b = a < 0 ? -1 : nsrcAA.indexOf("\n}\n", a); return a < 0 || b < 0 ? null : nsrcAA.slice(a, b + 2); })();
  const vacSrc = bodyOf("const submitVacRequest = useCallback(", "vacReqSurgeon, vacReqStart");
  const tradeSrc = bodyOf("const submitTradeRequest = useCallback(", "tradeFrom, tradeTo");
  const ENV_V = "vacReqSurgeon, vacReqStart, vacReqEnd, vacReqReason, vacReqType, surgeons, apps, showToast, db, setVacRequests, addNotification, schedulerAdminIds, sendEmailNotif, setVacReqStart, setVacReqEnd, setVacReqReason, setVacReqType, vacSubmitBusyRef";
  const ENV_T = "tradeFrom, tradeTo, tradeWeek, tradeShift, tradeReturnWeek, tradeReturnShift, isScheduler, silvisActive, silvisBlock, silvisRefuse, surgeons, schedule, logAudit, addNotification, sendEmailNotif, setTradeRequests, setTradeWeek, setTradeShift, setTradeReturnWeek, setTradeReturnShift, tradeSubmitBusyRef, showToast, db, alert, confirm";
  let mkV = null, mkT = null;
  try {
    if (wfrSrc && vacSrc) mkV = vm.runInContext(`(function () { ${wfrSrc}\n return function (env) { const { ${ENV_V} } = env; return (${vacSrc}); }; })()`, sandbox);
    if (wfrSrc && tradeSrc) mkT = vm.runInContext(`(function () { ${wfrSrc}\n return function (env) { const { ${ENV_T} } = env; return (${tradeSrc}); }; })()`, sandbox);
  } catch (ex) { console.log("  (AA compile error) " + String(ex).slice(0, 200)); }
  const NONE = "handler body or writeFailReason not extractable";
  const SURG = [{ id: "s1", name: "DJA" }, { id: "s6", name: "FAK" }];
  const vEnv = (insertResult, over = {}) => {
    const rec = { inserts: 0, toasts: [], cleared: 0, added: 0, notifs: 0 };
    let release; const gate = new Promise(r => (release = r));
    const env = Object.assign({
      vacReqSurgeon: "s6", vacReqStart: "2099-01-05", vacReqEnd: "2099-01-09", vacReqReason: "", vacReqType: "vacation",
      surgeons: SURG, apps: [], schedulerAdminIds: ["s6"],
      showToast: (m, t) => rec.toasts.push((t || "info") + ": " + m),
      db: { insert: async () => { rec.inserts++; if (over.slowInsert) await gate; return insertResult; } },
      setVacRequests: () => { rec.added++; }, addNotification: async () => { rec.notifs++; }, sendEmailNotif: () => {},
      setVacReqStart: () => { rec.cleared++; }, setVacReqEnd: () => {}, setVacReqReason: () => {}, setVacReqType: () => {},
      vacSubmitBusyRef: { current: false },
    }, over.env || {});
    return { run: mkV ? mkV(env) : null, rec, env, release };
  };
  const RLS = { data: null, error: { code: "42501", message: "new row violates row-level security policy for table \"vacation_requests\"" } };
  const EXPIRED = { data: null, error: { code: "PGRST303", message: "JWT expired" } };
  const OK_V = { data: { id: 7, surgeon_id: "s6" }, error: null };
  {
    const a = vEnv(RLS); if (a.run) await a.run();
    const b = vEnv(EXPIRED); if (b.run) await b.run();
    const c = vEnv(OK_V); if (c.run) await c.run();
    check("AA1 vacation: an RLS refusal says it is a permission problem, keeps the form, adds nothing — never a silent clear",
      !!a.run && a.rec.inserts === 1 && a.rec.cleared === 0 && a.rec.added === 0 && a.rec.toasts.length === 1 && /^error: Couldn't send your vacation request — you don't have permission/.test(a.rec.toasts[0]) && a.env.vacSubmitBusyRef.current === false,
      a.run ? JSON.stringify(a.rec) : NONE);
    check("AA1 vacation: an expired sign-in says so",
      !!b.run && b.rec.cleared === 0 && /sign-in has expired/.test(b.rec.toasts.join(" ")), b.run ? JSON.stringify(b.rec.toasts) : NONE);
    check("AA1 vacation: success adds the request, notifies, clears the form and confirms",
      !!c.run && c.rec.added === 1 && c.rec.notifs === 1 && c.rec.cleared === 1 && c.rec.toasts.length === 1 && /^success: Vacation request sent/.test(c.rec.toasts[0]),
      c.run ? JSON.stringify(c.rec) : NONE);
    const d = vEnv(OK_V, { slowInsert: true });
    if (d.run) { const p1 = d.run(), p2 = d.run(); d.release(); await Promise.all([p1, p2]); }
    check("AA1 vacation: a double tap files ONE request", !!d.run && d.rec.inserts === 1 && d.rec.added === 1, d.run ? JSON.stringify(d.rec) : NONE);
    const e = vEnv(OK_V, { env: { vacReqStart: "2099-01-09", vacReqEnd: "2099-01-05" } }); if (e.run) await e.run();
    const f = vEnv(OK_V, { env: { vacReqEnd: "" } }); if (f.run) await f.run();
    check("AA1 vacation: an end date before the start, or an empty field, is explained and nothing is inserted",
      !!e.run && e.rec.inserts === 0 && /end date is before the start/.test(e.rec.toasts.join(" ")) && f.rec.inserts === 0 && /both dates first/.test(f.rec.toasts.join(" ")),
      e.run ? JSON.stringify([e.rec.toasts, f.rec.toasts]) : NONE);
  }
  const tEnv = (insertResult, over = {}) => {
    const rec = { inserts: 0, toasts: [], cleared: 0, added: 0, notifs: 0 };
    let release; const gate = new Promise(r => (release = r));
    const env = Object.assign({
      tradeFrom: "s6", tradeTo: "s1", tradeWeek: "2099-01-05", tradeShift: "mon", tradeReturnWeek: "2099-01-12", tradeReturnShift: "tue",
      isScheduler: false, silvisActive: false, silvisBlock: () => null, silvisRefuse: () => false,
      surgeons: SURG, schedule: {}, logAudit: () => {}, addNotification: async () => { rec.notifs++; }, sendEmailNotif: () => {},
      setTradeRequests: () => { rec.added++; }, setTradeWeek: () => { rec.cleared++; }, setTradeShift: () => {}, setTradeReturnWeek: () => {}, setTradeReturnShift: () => {},
      tradeSubmitBusyRef: { current: false },
      showToast: (m, t) => rec.toasts.push((t || "info") + ": " + m),
      db: { insert: async () => { rec.inserts++; if (over.slowInsert) await gate; return insertResult; } },
      alert: () => {}, confirm: () => true,
    }, over.env || {});
    return { run: mkT ? mkT(env) : null, rec, env, release };
  };
  {
    const a = tEnv({ data: null, error: { message: "permission denied", code: "42501" } }); if (a.run) await a.run();
    const b = tEnv({ data: { id: 9 }, error: null }); if (b.run) await b.run();
    const c = tEnv({ data: { id: 9 }, error: null }, { slowInsert: true });
    if (c.run) { const p1 = c.run(), p2 = c.run(); c.release(); await Promise.all([p1, p2]); }
    const e = tEnv({ data: { id: 9 }, error: null }, { env: { tradeShift: "" } }); if (e.run) await e.run();
    check("AA2 trade: an RLS refusal is explained and the choices are kept (nothing added, no notification)",
      !!a.run && a.rec.inserts === 1 && a.rec.cleared === 0 && a.rec.added === 0 && a.rec.notifs === 0 && /^error: Couldn't propose the trade — you don't have permission/.test(a.rec.toasts.join(" ")) && a.env.tradeSubmitBusyRef.current === false,
      a.run ? JSON.stringify(a.rec) : NONE);
    check("AA2 trade: success adds, notifies, clears and confirms who will be asked",
      !!b.run && b.rec.added === 1 && b.rec.notifs === 1 && b.rec.cleared === 1 && /^success: Trade proposed — DJA will be asked/.test(b.rec.toasts.join(" ")), b.run ? JSON.stringify(b.rec) : NONE);
    check("AA2 trade: a double tap proposes ONCE; an empty field is explained",
      !!c.run && c.rec.inserts === 1 && c.rec.added === 1 && e.rec.inserts === 0 && /Pick both people/.test(e.rec.toasts.join(" ")), c.run ? JSON.stringify([c.rec, e.rec.toasts]) : NONE);
  }
  // AA3 (review of 7cd289c): the success toast goes up BEFORE notifying — addNotification
  // toasts its own failure, and that must be the message left on screen (the old order
  // overwrote it with "the scheduler has been notified"). A thrown insert releases the
  // guard and keeps the form; a tap while a submit is in flight shows nothing at all.
  {
    // the handler destructures env when it is built, so the failing stub goes in up front
    const notifFails = (box) => ({ env: { addNotification: async () => { box.it.rec.notifs++; box.it.env.showToast("Couldn't save that notification.", "error"); } } });
    const vBox = {}, tBox = {};
    const v = (vBox.it = vEnv(OK_V, notifFails(vBox))); if (v.run) await v.run();
    const t = (tBox.it = tEnv({ data: { id: 9 }, error: null }, notifFails(tBox))); if (t.run) await t.run();
    check("AA3 a notification failure is the LAST toast after a successful submit (vacation + trade); nothing claims the scheduler was notified",
      !!v.run && !!t.run && v.rec.toasts.length === 2 && /^success: Vacation request sent\.$/.test(v.rec.toasts[0]) && /^error: Couldn't save that notification/.test(v.rec.toasts[1])
        && t.rec.toasts.length === 2 && /^success: Trade proposed/.test(t.rec.toasts[0]) && /^error: Couldn't save that notification/.test(t.rec.toasts[1])
        && v.rec.cleared === 1 && t.rec.cleared === 1 && count("has been notified") === 0,
      JSON.stringify([v.rec.toasts, t.rec.toasts]));
    const throwIns = { insert: async () => { throw new TypeError("Failed to fetch"); } };
    const vt = vEnv(OK_V, { env: { db: throwIns } }); if (vt.run) await vt.run();
    const tt = tEnv({ data: { id: 9 }, error: null }, { env: { db: throwIns } }); if (tt.run) await tt.run();
    check("AA3 a THROWN insert (network) says so, keeps the form and releases the double-tap guard (vacation + trade)",
      !!vt.run && !!tt.run && vt.rec.cleared === 0 && tt.rec.cleared === 0 && vt.env.vacSubmitBusyRef.current === false && tt.env.tradeSubmitBusyRef.current === false
        && /^error: Couldn't submit your request/.test(vt.rec.toasts.join(" ")) && /^error: Couldn't submit the trade/.test(tt.rec.toasts.join(" ")),
      JSON.stringify([vt.rec.toasts, tt.rec.toasts]));
    let alerts = 0, confirms = 0;
    const vb = vEnv(OK_V, { env: { vacReqEnd: "", vacSubmitBusyRef: { current: true } } }); if (vb.run) await vb.run();
    const tb = tEnv({ data: { id: 9 }, error: null }, { env: { tradeReturnWeek: "", tradeSubmitBusyRef: { current: true }, alert: () => { alerts++; }, confirm: () => { confirms++; return true; } } }); if (tb.run) await tb.run();
    check("AA3 a tap while a submit is in flight only says it is still sending — no validation toast, no one-way-trade prompt, no insert",
      !!vb.run && !!tb.run && vb.rec.inserts === 0 && tb.rec.inserts === 0 && alerts === 0 && confirms === 0
        && JSON.stringify(vb.rec.toasts) === JSON.stringify(["info: Still sending your last request — one moment."])
        && JSON.stringify(tb.rec.toasts) === JSON.stringify(["info: Still sending your last trade proposal — one moment."]),
      JSON.stringify({ v: vb.rec, t: tb.rec, alerts, confirms }));
  }
  check("AA writeFailReason is defined once at module scope and both submits use it",
    count("function writeFailReason(err) {") === 1 && count("writeFailReason(insertErr)") === 2);
}

// ─── AB. APP call-shift edits wait for the APP-shift row (2026-10-11, audit QW4 + its review) ───
// Every APP write upserts the WHOLE app_shifts_data 'main' map (no CAS, no
// snapshot, no restore path). If the read failed, appShifts stayed at its
// initial {} and the next tap — or ANY week-editor save, which wrote its 7-day
// APP draft back unconditionally — replaced every APP's assignments. The
// day-off row already had this guard; now the call-shift row does too, and the
// week editor writes only the APP days edited against what it showed on open.
//   AB1 add / remove / paint refuse before a successful read, write the right map after it
//   AB2 the REAL saveWeekEdits: an editor opened before the row loaded never clears assignments;
//       only edited days are written, onto the latest map; refused APP edits stay out of the
//       audit and the notifications; surgeon edits always save; an APP-only refusal keeps the editor open
//   AB3 both reads arm the guard; the card disables its buttons and says why; a failed APP save toasts
{
  const nsrcAB = src.replace(/\r\n/g, "\n");
  const arrowBody = (decl, head) => { const i = nsrcAB.indexOf(decl); if (i < 0) return null; const e = nsrcAB.indexOf("\n  };\n", i); return e < 0 ? null : head + nsrcAB.slice(i + decl.length, e) + "\n  }"; };
  const addSrc = arrowBody("const addAppShift = () => {", "() => {");
  const rmBody = arrowBody("const rmAppShift = (ds) => {", "(ds) => {");
  const paintBody = arrowBody("const commitAppPaint = async (draft) => {", "async (draft) => {");
  const saveBody = arrowBody("const saveAppShifts = async (next) => {", "async (next) => {");
  const ENV = "appShiftsLoaded, appShifts, appDate, appPerson, showToast, setAppShifts, saveAppShifts, logAudit, nameOf, setAppDate, supabase, APP_SHIFTS_NOT_LOADED, setSaveError, setSaveStatus";
  const mk = (body) => { try { return body ? vm.runInContext(`(function (env) { const { ${ENV} } = env; return (${body}); })`, sandbox) : null; } catch (ex) { return null; } };
  const mkAdd = mk(addSrc), mkRm = mk(rmBody), mkPaint = mk(paintBody), mkSave = mk(saveBody);
  const envAB = (loaded, over = {}) => {
    const rec = { toasts: [], sets: [], saves: [], upserts: 0, rows: [] };
    return { rec, env: Object.assign({
      appShiftsLoaded: loaded, appShifts: { "2026-10-12": "a1", "2026-10-13": "a2" }, appDate: "2026-10-14", appPerson: "a3",
      showToast: (m) => rec.toasts.push(String(m)), setAppShifts: (x) => rec.sets.push(x), saveAppShifts: (x) => rec.saves.push(x),
      logAudit: () => {}, nameOf: (x) => x, setAppDate: () => {}, setSaveError: () => {}, setSaveStatus: () => {},
      supabase: { from: () => ({ upsert: async (row) => { rec.upserts++; rec.rows.push(row); return { error: null }; } }) },
      APP_SHIFTS_NOT_LOADED: "APP shifts haven't loaded yet",
    }, over) };
  };
  {
    const a0 = envAB(false), a1 = envAB(true), r0 = envAB(false), r1 = envAB(true), p0 = envAB(false), p1 = envAB(true);
    if (mkAdd) { mkAdd(a0.env)(); mkAdd(a1.env)(); }
    if (mkRm) { mkRm(r0.env)("2026-10-12"); mkRm(r1.env)("2026-10-12"); }
    const pr0 = mkPaint ? await mkPaint(p0.env)({ "2026-10-20": "a1" }) : null, pr1 = mkPaint ? await mkPaint(p1.env)({ "2026-10-20": "a1" }) : null;
    check("AB1 before a successful read, add / remove refuse with the reason and write nothing; the paint sheet gets {ok:false} and keeps its draft",
      !!mkAdd && !!mkRm && !!mkPaint && a0.rec.sets.length === 0 && a0.rec.saves.length === 0 && /haven't loaded/.test(a0.rec.toasts.join(" "))
        && r0.rec.sets.length === 0 && r0.rec.saves.length === 0 && /haven't loaded/.test(r0.rec.toasts.join(" "))
        && pr0 && pr0.ok === false && /haven't loaded/.test(pr0.error) && p0.rec.upserts === 0,
      JSON.stringify({ a0: a0.rec, r0: r0.rec, pr0, mk: [!!mkAdd, !!mkRm, !!mkPaint] }).slice(0, 300));
    check("AB1 after a successful read the same three write the right map (add merges, remove drops, paint upserts main once with the old days kept)",
      a1.rec.saves.length === 1 && a1.rec.saves[0]["2026-10-14"] === "a3" && a1.rec.saves[0]["2026-10-12"] === "a1"
        && r1.rec.saves.length === 1 && !("2026-10-12" in r1.rec.saves[0]) && r1.rec.saves[0]["2026-10-13"] === "a2"
        && pr1 && pr1.ok === true && p1.rec.upserts === 1 && p1.rec.rows[0].id === "main" && p1.rec.rows[0].data["2026-10-20"] === "a1" && p1.rec.rows[0].data["2026-10-12"] === "a1" && p1.rec.rows[0].data["2026-10-13"] === "a2",
      JSON.stringify({ a1: a1.rec.saves, r1: r1.rec.saves, pr1, rows: p1.rec.rows }).slice(0, 300));
  }
  // AB2 — the REAL saveWeekEdits
  {
    const i = nsrcAB.indexOf("const saveWeekEdits = useCallback((openAfter) => {"), e = i < 0 ? -1 : nsrcAB.indexOf("\n  }, [editWeekModal,", i);
    const weBody = i < 0 || e < 0 ? null : "(openAfter) => {" + nsrcAB.slice(i + "const saveWeekEdits = useCallback((openAfter) => {".length, e) + "\n  }";
    const WE_ENV = "editWeekModal, schedule, appShifts, appShiftsLoaded, openWeekEditor, setEditWeekModal, silvisActive, silvisFakId, silvisDays, silvisBlock, silvisRefuse, sfSlotDays, confirm, pushUndo, updateSchedule, scheduleRef, schedEditable, schedSyncRef, backupMondaySet, fierceBackupSet, surgeons, showToast, APP_SHIFTS_NOT_LOADED, setAppShifts, saveAppShifts, logAudit, nameOf, aMap, sMap, schedulerAdminIds, addNotification, sendEmailNotif, setTimeout";
    let mkWE = null; try { mkWE = weBody ? vm.runInContext(`(function (env) { const { ${WE_ENV} } = env; return (${weBody}); })`, sandbox) : null; } catch (ex) { mkWE = null; }
    const MON = "2026-10-12", DAYS = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];
    const blanks = Object.fromEntries(DAYS.map(d => [d, ""]));
    const real = { "2026-10-12": "a1", "2026-10-13": "a2", "2026-10-20": "a4" };   // the stored map (incl. a day outside this week)
    const realWk = Object.fromEntries(DAYS.map(d => [d, real[d] || ""]));
    const runWE = ({ loaded, appsBase, draftApps, surgeonChange, movedUnderneath }) => {
      const rec = { toasts: [], appSets: [], saves: [], schedSets: 0, closed: 0, audits: [], notifs: [] };
      const wk = { dayCall: "s1", nights: { mon: "s2", tue: "s3", wed: "s4", thu: "s5", wknd: "s6" } };
      const env = {
        editWeekModal: { mondayStr: MON, appsBase, draft: { dayCall: surgeonChange ? "s7" : "s1", nights: { ...wk.nights }, dayCallOverrides: {}, apps: draftApps, reason: "" } },
        schedule: { [MON]: wk }, appShifts: real, appShiftsLoaded: loaded, openWeekEditor: () => {}, setEditWeekModal: (x) => { if (x === null) rec.closed++; },
        silvisActive: false, silvisFakId: null, silvisDays: { primary: new Set() }, silvisBlock: () => null, silvisRefuse: () => false, sfSlotDays: () => [],
        confirm: () => true, pushUndo: () => {}, updateSchedule: () => { rec.schedSets++; }, scheduleRef: { current: { [MON]: wk } }, schedEditable: () => true,
        schedSyncRef: { current: { changedSince: (keys) => movedUnderneath ? keys.slice() : [] } }, backupMondaySet: new Set(), fierceBackupSet: new Set(),
        surgeons: ["s1", "s2", "s3", "s4", "s5", "s6", "s7"].map(id => ({ id, name: id.toUpperCase() })),
        showToast: (m) => rec.toasts.push(String(m)), APP_SHIFTS_NOT_LOADED: "APP shifts haven't loaded yet",
        setAppShifts: (u) => rec.appSets.push(u), saveAppShifts: (x) => rec.saves.push(x),
        logAudit: (a, msg, meta) => rec.audits.push(meta), nameOf: (x) => x, aMap: {}, sMap: {}, schedulerAdminIds: ["s6"],
        addNotification: (t, title, msg) => rec.notifs.push(msg), sendEmailNotif: () => {}, setTimeout: () => {},
      };
      mkWE(env)(null);
      const merged = rec.appSets.length ? rec.appSets[0]({ ...real, "2026-10-15": "a6", "2026-10-21": "a5" }) : null;   // the updater runs on the LATEST map (two days assigned elsewhere meanwhile)
      return { rec, merged };
    };
    const sortedJSON = (o) => JSON.stringify(o && Object.keys(o).sort().map(k => [k, o[k]]));
    if (mkWE) {
      const opened = runWE({ loaded: true, appsBase: blanks, draftApps: { ...blanks }, surgeonChange: true });
      check("AB2 an editor OPENED before the APP row loaded (all blanks), saved after it loaded, writes NO APP change — the week's real assignments stay (the review's data-loss case)",
        opened.rec.appSets.length === 0 && opened.rec.saves.length === 0 && opened.rec.schedSets === 1, JSON.stringify(opened.rec).slice(0, 300));
      const edited = runWE({ loaded: true, appsBase: realWk, draftApps: { ...realWk, "2026-10-14": "a3", "2026-10-13": "" }, surgeonChange: false });
      check("AB2 only the days edited in the editor are written, onto the LATEST map (days assigned elsewhere meanwhile survive — inside this week too), and saved once",
        edited.rec.appSets.length === 1 && sortedJSON(edited.merged) === sortedJSON({ "2026-10-12": "a1", "2026-10-14": "a3", "2026-10-15": "a6", "2026-10-20": "a4", "2026-10-21": "a5" })
          && edited.rec.saves.length === 1 && JSON.stringify(edited.rec.saves[0]) === JSON.stringify(edited.merged), JSON.stringify(edited.merged));
      const refusedMix = runWE({ loaded: false, appsBase: blanks, draftApps: { ...blanks, "2026-10-14": "a3" }, surgeonChange: true });
      const auditSlots = refusedMix.rec.audits.length ? refusedMix.rec.audits[0].changes.map(c => c.slot) : [];
      check("AB2 unloaded: the surgeon change saves, the APP change is refused with the reason — and it stays OUT of the audit and the notification",
        refusedMix.rec.schedSets === 1 && refusedMix.rec.appSets.length === 0 && /APP changes were NOT saved/.test(refusedMix.rec.toasts.join(" "))
          && auditSlots.length === 1 && !auditSlots.some(s => /^APP /.test(s)) && !refusedMix.rec.notifs.some(m => /APP /.test(m)), JSON.stringify({ auditSlots, notifs: refusedMix.rec.notifs, toasts: refusedMix.rec.toasts }));
      const appOnly = runWE({ loaded: false, appsBase: blanks, draftApps: { ...blanks, "2026-10-14": "a3" }, surgeonChange: false });
      check("AB2 unloaded with ONLY an APP change: refused with the reason, nothing written or audited, and the editor stays open",
        appOnly.rec.schedSets === 0 && appOnly.rec.appSets.length === 0 && appOnly.rec.audits.length === 0 && appOnly.rec.closed === 0 && /APP changes were NOT saved/.test(appOnly.rec.toasts.join(" ")), JSON.stringify(appOnly.rec));
      const moved = runWE({ loaded: true, appsBase: realWk, draftApps: { ...realWk, "2026-10-14": "a3" }, surgeonChange: true, movedUnderneath: true });
      check("AB2 sync v2 (R15): the week was changed by someone else while the editor was open → NOTHING is saved (surgeon slots or APP days), the editor stays open, and it says why",
        moved.rec.schedSets === 0 && moved.rec.appSets.length === 0 && moved.rec.saves.length === 0 && moved.rec.closed === 0 && /changed by someone else while the editor was open/.test(moved.rec.toasts.join(" ")), JSON.stringify(moved.rec));
      const none = runWE({ loaded: false, appsBase: realWk, draftApps: { ...realWk }, surgeonChange: false });
      check("AB2 no edits at all closes the editor quietly — even unloaded (no toast, no write)",
        none.rec.closed === 1 && none.rec.toasts.length === 0 && none.rec.appSets.length === 0 && none.rec.schedSets === 0, JSON.stringify(none.rec));
    } else check("AB2 saveWeekEdits extractable for execution", false, "anchors not found");
    check("AB2 the editor keeps a COPY of what its APP rows showed on open (the base the save diffs against), and it is the only place a week editor is created",
      count('appsDraft[ds] = appShifts[ds] || "";') === 1 && count("appsBase: { ...appsDraft },") === 1 && count("setEditWeekModal({") === 1);
    check("AB2 an editor opened before the row loaded LOCKS its APP selects and says why (records appsLoaded, in the deps); '• unsaved' diffs the APP days against appsBase, not the live map",
      count("appsLoaded: appShiftsLoaded,") === 1 && count("}, [appShifts, appShiftsLoaded]);") === 1 && count("openEpoch: schedSyncRef.current.epochNow(),") === 1
        && count("const appsLocked = !editWeekModal.appsLoaded;") === 1 && count("disabled={appsLocked}") === 1 && count("{appsLocked && <div") === 1
        && count('Object.entries(draft.apps).some(([ds, aid]) => (appsBase[ds] || "") !== (aid || ""))') === 1
        && count('Object.entries(draft.apps).some(([ds, aid]) => (appShifts[ds] || "") !== (aid || ""))') === 0);
    check("AB2 the mixed-refusal toast never claims the surgeon changes were SAVED (the autosave may still refuse after a failed load)",
      count("Saved the surgeon changes") === 0 && count("The surgeon changes went through, but the APP changes were NOT saved") === 1);
  }
  check("AB3 both reads of the main row arm the guard right after .single() (mount + poll); nothing else arms it",
    (src.match(/\.eq\("id", "main"\)\.single\(\);\r?\n\s*setAppShiftsLoaded\(true\);/g) || []).length === 2 && count("setAppShiftsLoaded(true)") === 2);
  check("AB3 the APP card disables + Assign and Paint Month until the row loads, and says why",
    count("disabled={!appShiftsLoaded}") === 2 && count("⚠ {APP_SHIFTS_NOT_LOADED}") === 1);
  {
    const s1 = envAB(true, { supabase: { from: () => ({ upsert: async () => ({ error: { code: "42501", message: "denied" } }) }) } });
    const s2 = envAB(true, { supabase: { from: () => ({ upsert: async () => { throw new TypeError("Failed to fetch"); } }) } });
    if (mkSave) { await mkSave(s1.env)({}); await mkSave(s2.env)({}); }
    check("AB3 a failed APP save toasts (it only set a status line before) — for an error result and for a thrown request",
      !!mkSave && /Couldn't save APP shifts/.test(s1.rec.toasts.join(" ")) && /Couldn't save APP shifts/.test(s2.rec.toasts.join(" ")), JSON.stringify([s1.rec.toasts, s2.rec.toasts]));
  }
}

// ─── AD. Month grids fit a phone (2026-10-11, Generate preview overflow) ───
// A bare `repeat(7,1fr)` column can't shrink below its content: in the Generate
// preview a long vacation list ("🏖DJA,FAK,JH", no spaces) widened its column and
// pushed the week past a 390-px screen (page 506 px wide; observed in a local
// scheduler harness). Every 7-day grid uses minmax(0,1fr) like the Calendar tab,
// and the preview's cells clip / wrap instead of widening (checked at 320–1280 px).
{
  check("AD every 7-day month grid uses repeat(7,minmax(0,1fr)) — no bare repeat(7,1fr) column can widen past the screen",
    (src.match(/gridTemplateColumns:\s*"repeat\(7,\s*1fr\)"/g) || []).length === 0 && count('gridTemplateColumns:"repeat(7,minmax(0,1fr))"') >= 4);
  check("AD the Generate preview's day cells can shrink (minWidth 0, overflow hidden) and its vacation list wraps (', ' + overflowWrap)",
    count('minHeight:70,padding:"2px 2px",borderRadius:2,minWidth:0,overflow:"hidden"}}>') === 1
      && count('{vacList.length>0&&<div style={{fontSize:8,color:"#a07070",marginTop:1,overflowWrap:"anywhere"}}>🏖{vacList.map(v=>v.name).join(", ")}</div>}') === 1);
}

// ─── AE. Generator: "Needs your OK" before publish + Setup holiday text (2026-10-11) ───
// Owner decisions 2026-10-11: time off is a hard stop, card eves are night
// shifts, Christmas week is FAK's, and a squeezed week takes the mildest bend.
// generator.js listScheduleBends lists every bend / empty slot / time-off
// placement / crowded day; the preview shows them in a "Needs your OK" box and
// publishing waits for "I've reviewed these N items". (The generator itself
// is pinned by test/generator-regression.js — live scenario + oracle.)
//   AE1 the REAL acceptPreview: box non-empty + unticked → nothing published;
//       ticked → publishes, the audit records N; empty box → publishes as before
//   AE2 the button is disabled until ticked; the checkbox, its reset on a new
//       preview, and the box sit where the scheduler sees them
//   AE3 Generate & Publish never publishes a result with items: it opens the
//       preview instead, and only a real publish sends the notice
//   AE4 the box judges with the generator's own availability (one builder)
//   AE5 Setup → Holidays says eves are night shifts and Christmas week is FAK's
{
  const nsrcAE = src.replace(/\r\n/g, "\n");
  const A0 = "  const acceptPreview = async () => {";
  const i = nsrcAE.indexOf(A0), e = i < 0 ? -1 : nsrcAE.indexOf("\n  };\n", i);
  const body = i < 0 || e < 0 ? null : "async () => {" + nsrcAE.slice(i + A0.length, e) + "\n  }";
  const ENV = "previewSchedule, previewSchedRef, previewNeedsOk, previewAck, previewOrigin, publishWeeks, runPublish, publishNotLanded, publishingRef, setPublishing, snapshots, showToast, schedEditable, schedSyncRef, previewEpochRef, setPreviewSchedule, setShowPreview, setCalMonth, setCalYear, setView, setSaveStatus, setTimeout, numWeeks, MO, startMonth, startYear, cancelSearch, publishSearchRunning";
  let mk = null; try { mk = body ? vm.runInContext(`(function (env) { const { ${ENV} } = env; return (${body}); })`, sandbox) : null; } catch (ex) { mk = null; }
  // o: busy (a publish in progress) · pubSearch (a Generate & Publish search running) · moved (a week of the preview adopted
  // since it was made) · movedAfter (…adopted during the snapshot's await) · gated (the edit gate refuses) · snapFail · landed:false
  const run = async (items, ack, o = {}) => {
    const rec = { published: 0, toasts: [], audits: [], cancelled: 0, jobs: 0, snaps: 0, status: [], order: [] };
    const PS = { "2026-11-16": { dayCall: "s1", nights: {} }, "2026-11-23": { dayCall: "s2", nights: {} } };
    let snapped = false;
    await mk({
      schedEditable: () => !o.gated, previewEpochRef: { current: 3 },
      // bites only if acceptPreview asks with previewEpochRef.current
      schedSyncRef: { current: { changedSince: (keys, since) => (since === 3 && (o.moved || (o.movedAfter && snapped))) ? keys.slice(0, 1) : [], knownSchedule: () => ({ "2026-11-09": {} }) } },
      previewSchedule: PS, previewSchedRef: { current: PS }, previewNeedsOk: { cost: items.length * 6, items }, previewAck: ack,
      previewOrigin: "generated", publishingRef: { current: !!o.busy }, setPublishing: () => {},
      snapshots: { capture: async () => { rec.snaps++; rec.order.push("snapshot"); snapped = true; return { ok: !o.snapFail }; } },
      // publishWeeks (the one publish step) is executed for real in AG5; here it records what acceptPreview hands it
      publishWeeks: (weeks, how) => { rec.published++; rec.order.push("publishWeeks"); rec.audits.push({ msg: `Published schedule (${how.label})${how.extra || ""}`, meta: how.meta, weeks }); return {}; },
      runPublish: (w) => { rec.jobs++; rec.order.push("job"); rec.jobWeeks = Object.keys(w).join(); return Promise.resolve(o.landed === false ? { ok: false, results: [{ k: "2026-11-23", outcome: "pending" }] } : { ok: true, results: [] }); },
      publishNotLanded: (pr, what) => rec.toasts.push("NOT LANDED: " + what),
      showToast: (m) => rec.toasts.push(String(m)), setPreviewSchedule: () => {}, setShowPreview: () => {}, setCalMonth: () => {}, setCalYear: () => {},
      setView: () => {}, setSaveStatus: (x) => rec.status.push(x), setTimeout: () => {},
      numWeeks: 14, MO: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"], startMonth: 10, startYear: 2026,
      cancelSearch: () => { rec.cancelled++; }, publishSearchRunning: () => !!o.pubSearch,
    })();
    return rec;
  };
  if (mk) {
    const two = [{ kind: "bend", text: "a" }, { kind: "crowded", text: "b" }];
    const blocked = await run(two, false), ticked = await run(two, true), clean = await run([], false);
    check("AE1 the REAL acceptPreview: with items and the box unticked nothing is published (and it says why)",
      blocked.published === 0 && blocked.audits.length === 0 && /reviewed/.test(blocked.toasts.join(" ")), JSON.stringify(blocked));
    check("AE1 ticked: it publishes, and the publish audit entry records N (and the bend cost)",
      ticked.published === 1 && ticked.audits.length === 1 && ticked.audits[0].meta.needsOk === 2 && ticked.audits[0].meta.bendCost === 12 && /2 items reviewed/.test(ticked.audits[0].msg), JSON.stringify(ticked.audits));
    const stale = await run([], false, { moved: true });
    check("AE1 sync v2: a preview whose week someone else changed since it was generated is NOT published (it would overwrite that change) — and it says so",
      stale.published === 0 && stale.audits.length === 0 && stale.snaps === 0 && /changed since this preview was generated/.test(stale.toasts.join(" ")), JSON.stringify(stale));
    const gatedRun = await run([], false, { gated: true });
    check("AE1 sync v2: the edit gate (not loaded / sign-in expired) refuses before the publish step — nothing published", gatedRun.published === 0 && gatedRun.audits.length === 0 && gatedRun.snaps === 0, JSON.stringify(gatedRun));
    check("AE1 an empty box publishes exactly as before — no checkbox needed, needsOk 0, no extra wording",
      clean.published === 1 && clean.toasts.length === 0 && clean.audits[0].meta.needsOk === 0 && !/reviewed/.test(clean.audits[0].msg), JSON.stringify(clean.audits));
    check("AE1 Accept & Publish hands the WHOLE preview to publishWeeks (the one publish step — net counts, undo, audit: AG5) and to the engine's publish job",
      ticked.audits[0] && Object.keys(ticked.audits[0].weeks).join() === "2026-11-16,2026-11-23" && ticked.audits[0].meta.origin === "generated" && ticked.jobWeeks === "2026-11-16,2026-11-23");
    check("AE1 Accept & Publish first cancels a running search (\"Search more\"), so its late result can't reopen the published preview (2026-10-12)",
      ticked.cancelled === 1 && clean.cancelled === 1, JSON.stringify([ticked.cancelled, clean.cancelled]));
    const during = await run([], false, { pubSearch: true });
    check("AE1 while a Generate & Publish SEARCH runs (it publishes its own schedule when it ends), Accept & Publish publishes NOTHING and says why — never two publishes racing",
      during.published === 0 && during.cancelled === 0 && /still searching/.test(during.toasts.join(" ")), JSON.stringify(during));
    const busy = await run([], false, { busy: true });
    check("AE1 while a publish is in progress (Generate & Publish waiting for its snapshot), Accept & Publish publishes NOTHING and says why",
      busy.published === 0 && /already in progress/.test(busy.toasts.join(" ")), JSON.stringify(busy));
    // A14 — a backup snapshot first (fail closed), the checks again after its await, the period as ONE engine job, the outcome said
    check("AE1 A14: the order is snapshot → publishWeeks → the engine's publish job, and \"Published — totals updated\" only after the job landed every week",
      clean.order.join() === "snapshot,publishWeeks,job" && clean.status.includes("Publishing…") && clean.status.includes("Published — totals updated")
        && clean.status.indexOf("Publishing…") < clean.status.indexOf("Published — totals updated"), JSON.stringify({ order: clean.order, status: clean.status }));
    const noSnap = await run([], false, { snapFail: true }), movedAfter = await run([], false, { movedAfter: true }), notLanded = await run([], false, { landed: false });
    check("AE1 A14: no backup snapshot → nothing published (and it says so); a week changed by someone else DURING the snapshot's await → nothing published either",
      noSnap.snaps === 1 && noSnap.published === 0 && noSnap.jobs === 0 && /backup snapshot/.test(noSnap.toasts.join(" "))
        && movedAfter.snaps === 1 && movedAfter.published === 0 && movedAfter.jobs === 0 && /changed since this preview was generated/.test(movedAfter.toasts.join(" ")),
      JSON.stringify([noSnap, movedAfter]));
    check("AE1 A14: a publish job that didn't land every week → no \"Published\", the scheduler is told (retrying, nobody notified)",
      notLanded.published === 1 && notLanded.jobs === 1 && !notLanded.status.includes("Published — totals updated") && /NOT LANDED: Published on this screen/.test(notLanded.toasts.join(" ")),
      JSON.stringify(notLanded));
  } else check("AE1 acceptPreview extractable for execution", false, "anchors not found");
  check("AE2 ✓ Accept & Publish is disabled while the box has items and is unticked; the checkbox drives previewAck; a new preview resets it",
    count('<button onClick={acceptPreview} disabled={publishing || searching === "publish" || (previewNeedsOk.items.length > 0 && !previewAck)}') === 1
      && count("checked={previewAck} onChange={e=>setPreviewAck(e.target.checked)}") === 1
      && count("useEffect(() => { setPreviewAck(false); }, [previewSchedule]);") === 1
      && count("{previewNeedsOk.items.length > 0 && (") === 1
      && /I've reviewed these \{previewNeedsOk\.items\.length\} item/.test(src));
  check("AE2 the box sits above the preview calendar and the spacing box, and wraps at phone width (#72)",
    nsrcAE.indexOf("⚠ Needs your OK —") > 0 && nsrcAE.indexOf("⚠ Needs your OK —") < nsrcAE.indexOf("{/* Spacing-exception disclosure")
      && nsrcAE.indexOf("{/* Spacing-exception disclosure") < nsrcAE.indexOf("{/* Preview Calendar Grid */}")
      && count('color:dk?"#f0c890":"#7a4010",overflowWrap:"anywhere"}}>') === 1);
  check("AE3 Generate & Publish: a result with items opens the preview (\"review\") instead of saving; only \"published\" sends the notice; a cancelled Silvis confirm sends nothing",
    count('    if (needsOkN > 0) {\n      setPreviewSchedule(result); setPreviewOrigin("generated"); previewEpochRef.current = genEpoch;\n      setShowPreview(true);'.replace(/\n/g, src.includes("\r\n") ? "\r\n" : "\n")) === 1
      && count('previewEpochRef.current = genEpoch;') === 3 // preview · inputs changed · Needs your OK (sync v2)
      && count('return "review";') === 2 && count('return out && out.ok ? "published" : "not-published";') === 1 && count('return "published";') === 0 && count('return "cancelled";') === 2 // review: + inputs changed during the search (2026-10-12) — // the Silvis confirm; a cancelled / empty search (2026-10-12)
      && count('if ((await doGenerate(false)) !== "published") return;') === 1);
  check("AE4 the box and the generator share ONE availability builder (vacations ∪ no-call ∪ Silvis), and the box reads the bends from generator.js",
    count("const availability = buildGenAvailability();") === 1 && count("vac: buildGenAvailability(), vacationsOnly: vacations,") === 2 // the box + Generate & Publish's gate (today's inputs, 2026-10-12)
      && count("return listScheduleBends(previewSchedule, {") === 1 && count("const availability = {};") === 1);
  check("AE5 Setup → Holidays: eves are night shifts for the card's Night Before surgeon; Christmas week is FAK's; the stale sentences are gone",
    count("The eve is a regular night shift worked by the card's \"Night Before\" surgeon") === 1
      && count("FAK covers Christmas Eve night and Christmas Day (standing rule), and the generator also gives FAK that week's service week and weekend") === 1
      && count("Eves stay on the regular schedule") === 0 && count("two days exactly, then the regular service-week doctor resumes") === 0);
}

// ─── AF. Schedule Warnings: on call while off (2026-10-11, owner decision G) ───
// Time off entered AFTER publishing lands under existing shifts. The real
// `conflicts` memo now adds, per DATE by weekHolders (a holiday-covered date
// credits its coverer):
//   "<CODE> is on call <shift> <date> but is off (vacation | no-call)"
//   "<CODE>'s <shift> <date> runs into their vacation starting <date>"
// (a weeknight before a vacation day, the weekend before a vacation Monday,
// a holiday 24h before a vacation day; a no-call next day is fine). Silvis
// primary days keep their own lines. And a card eve held by its card surgeon
// is not a "service week + night" conflict (Christmas: FAK's week + Eve).
//   AF1 own-day vacation / no-call → one line each, keyed from facts
//   AF2 overnights into a vacation (night, weekend); not into a no-call day
//   AF3 a holiday-covered date credits the coverer, not the dropped night holder
//   AF4 card eve + service week by the card surgeon → no svc-night line (control: a non-eve night is flagged)
//   AF5 the lines read vacations ∪ no-call only (Silvis has its own), skip past dates, and stay dismissable
{
  const nsrcAF = src.replace(/\r\n/g, "\n");
  if (!vm.runInContext("typeof holidayDesign === 'function'", sandbox)) vm.runInContext(fs.readFileSync(path.join(ROOT, "generator.js"), "utf8"), sandbox, { filename: "generator.js" }); // the page loads it before the app
  const START = "  const conflicts = useMemo(() => {";
  const s0 = nsrcAF.indexOf(START), e0 = s0 < 0 ? -1 : nsrcAF.indexOf("\n  }, [", s0);
  const body = s0 < 0 || e0 < 0 ? null : nsrcAF.slice(s0 + START.length, e0);
  let runC = null;
  try { runC = body ? vm.runInContext("(function (env) { const { schedule, surgeons, sMap, SHIFT_LABELS, holidayAssignments, vacations, noCallDays } = env; const buildGenAvailability = env.buildGenAvailability || (() => { const m = {}; [vacations || {}, noCallDays || {}].forEach(src => Object.keys(src).forEach(k => { m[k] = (m[k] || []).concat(src[k]); })); return m; }); const buildSilvisPrimary = env.buildSilvisPrimary || (() => null); return (() => {" + body + "})(); })", sandbox, { filename: "af-conflicts.js" }) : null; } catch (ex) { runC = null; }
  if (!runC) check("AF conflicts memo extractable for execution", false, "anchor / compile");
  else {
    const { fmt: F, addD: A, parse: P } = vm.runInContext("({ fmt, addD, parse })", sandbox);
    let mon = P("2099-03-01"); while (mon.getDay() !== 1) mon = A(mon, 1);
    const M = F(mon), d = (o) => F(A(mon, o)), md = (o) => { const x = A(mon, o); return `${x.getMonth() + 1}/${x.getDate()}`; };
    const surgeons = [{ id: "s1", name: "DJA" }, { id: "s2", name: "MCC" }, { id: "s3", name: "RPC" }, { id: "s4", name: "KJH" }, { id: "s5", name: "REH" }, { id: "s6", name: "FAK" }, { id: "s7", name: "ARW" }];
    const sMap = Object.fromEntries(surgeons.map((s, i) => [s.id, { name: s.name, idx: i }]));
    const LABELS = vm.runInContext("SHIFT_LABELS", sandbox);
    const base = (over) => ({ [M]: Object.assign({ dayCall: "s1", nights: { mon: "s2", tue: "s3", wed: "s4", thu: "s5", wknd: "s7" } }, over || {}) });
    const run = (env) => runC(Object.assign({ schedule: base(), surgeons, sMap, SHIFT_LABELS: LABELS, holidayAssignments: {}, vacations: {}, noCallDays: {} }, env));
    const off = (lines) => lines.filter(l => l.type === "timeoff");

    const a = off(run({ vacations: { s3: [[d(1), d(1)]] }, noCallDays: { s4: [[d(2), d(2)]] } }));
    check("AF1 a vacation on a night's own day and a no-call on another → exactly those two lines, keyed from facts (who, slot, date, kind)",
      a.length === 2
        && a.some(l => l.key === `on-off|${M}|s3|tue|${d(1)}|${d(1)}|vacation` && l.message === `RPC is on call Tue night ${md(1)} but is off (vacation)`)
        && a.some(l => l.key === `on-off|${M}|s4|wed|${d(2)}|${d(2)}|no-call` && l.message === `KJH is on call Wed night ${md(2)} but is off (no-call)`),
      JSON.stringify(a));
    const sw = off(run({ vacations: { s1: [[d(5), d(5)]] } }));
    check("AF1 the service week's Saturday on vacation → a service-week line for that day",
      sw.length === 1 && sw[0].key === `on-off|${M}|s1|svc|${d(5)}|${d(5)}|vacation` && sw[0].message === `DJA is on call service week Sat ${md(5)} but is off (vacation)`, JSON.stringify(sw));
    const run6 = off(run({ vacations: { s1: [[d(0), d(5)]] } }));
    check("AF1 a 6-day vacation under the service week is ONE line (Mon–Sat), keyed by its first and last day",
      run6.length === 1 && run6[0].key === `on-off|${M}|s1|svc|${d(0)}|${d(5)}|vacation` && run6[0].message === `DJA is on call service week Mon ${md(0)}–Sat ${md(5)} but is off (vacation)`, JSON.stringify(run6));
    const ovr = off(run({ schedule: base({ dayCallOverrides: { [d(1)]: "s5" } }), vacations: { s5: [[d(1), d(1)]] } }));
    check("AF1 a single-day override holder on time off is a 'service day' line, not 'service week'",
      ovr.length === 1 && ovr[0].key === `on-off|${M}|s5|svcday|${d(1)}|${d(1)}|vacation` && /^REH is on call service day Tue /.test(ovr[0].message), JSON.stringify(ovr));

    const b = off(run({ vacations: { s2: [[d(1), d(3)]], s7: [[d(7), d(9)]] }, noCallDays: { s5: [[d(4), d(4)]] } }));
    check("AF2 a Mon night before a vacation Tuesday and a weekend before a vacation Monday → 'runs into their vacation'; a Thu night before a NO-CALL Friday → nothing",
      b.length === 2
        && b.some(l => l.key === `into-vac|${M}|s2|mon|${d(0)}` && l.message === `MCC's Mon night ${md(0)} runs into their vacation starting Tue ${md(1)}`)
        && b.some(l => l.key === `into-vac|${M}|s7|wknd|${d(6)}` && l.message === `ARW's weekend ${md(4)}–${md(6)} runs into their vacation starting Mon ${md(7)}`)
        && !b.some(l => /REH/.test(l.message)),
      JSON.stringify(b));

    const covered = base({ holidayCoverage: { [d(2)]: { surgeonId: "s6", name: "Test Day 24h", holiday: "Test Day" } } });
    const c1 = off(run({ schedule: covered, vacations: { s4: [[d(2), d(2)]] } }));
    const c2 = off(run({ schedule: covered, vacations: { s6: [[d(2), d(2)]] } }));
    check("AF3 a holiday-covered date credits the COVERER: the dropped Wed-night holder on vacation → no line; the coverer on vacation → '… on call Test Day 24h …'",
      c1.length === 0 && c2.length === 1 && c2[0].key === `on-off|${M}|s6|cover|${d(2)}|${d(2)}|${d(2)}|vacation` && c2[0].message === `FAK is on call Test Day 24h Wed ${md(2)} but is off (vacation)`,
      JSON.stringify([c1, c2]));

    const fakWeek = base({ dayCall: "s6", nights: { mon: "s2", tue: "s3", wed: "s4", thu: "s6", wknd: "s7" } });
    const card = { "2099": [{ name: "Test Holiday", date: d(4), type: "major", surgeonA: "s6", surgeonB: "s6", coverage: [{ date: d(3), surgeon: "s6", label: "Test Holiday Night Before", isEve: true }] }] };
    const withEve = run({ schedule: fakWeek, holidayAssignments: card }).filter(l => l.type === "double");
    const noEve = run({ schedule: fakWeek, holidayAssignments: {} }).filter(l => l.type === "double");
    check("AF4 a card eve held by its card surgeon who also holds the service week is NOT flagged; the same week without the card IS (control)",
      withEve.length === 0 && noEve.length === 1 && noEve[0].key === `svc-night|${M}|s6|thu`, JSON.stringify([withEve, noEve]));
    const cardAB = { "2099": [{ name: "Test Holiday", date: d(4), type: "major", surgeonA: "s2", surgeonB: "s6", coverage: [{ date: d(3), surgeon: "s6", label: "Test Holiday Night Before", isEve: true }, { date: d(4), surgeon: "s2", label: "Test Holiday 24h" }] }] };
    const notDesigned = run({ schedule: fakWeek, holidayAssignments: cardAB }).filter(l => l.type === "double");
    check("AF4 the card's eve surgeon (B) on the service week + the eve is NOT designed (A holds the designed service week) — still flagged, like listScheduleBends",
      notDesigned.length === 1 && notDesigned[0].key === `svc-night|${M}|s6|thu`, JSON.stringify(notDesigned));
    const rowVac = off(run({ schedule: covered, holidayAssignments: { "2099": [{ name: "Test Day", date: d(2), type: "minor", surgeonA: "s6", surgeonB: null, coverage: [{ date: d(2), surgeon: "s6", label: "Test Day 24h" }] }] }, vacations: { s6: [[d(2), d(2)]] } }));
    const rowNoCall = off(run({ schedule: covered, holidayAssignments: { "2099": [{ name: "Test Day", date: d(2), type: "minor", surgeonA: "s6", surgeonB: null, coverage: [{ date: d(2), surgeon: "s6", label: "Test Day 24h" }] }] }, noCallDays: { s6: [[d(2), d(2)]] } }));
    check("AF4 one fact, one line: a VACATION on a holiday card's own row is the existing holiday-vac line (none here); a NO-CALL there (holiday-vac doesn't see it) is shown",
      rowVac.length === 0 && rowNoCall.length === 1 && /but is off \(no-call\)$/.test(rowNoCall[0].message), JSON.stringify([rowVac, rowNoCall]));

    {
    // AF6 — a dismissal must hold while a run is in progress (only the clock moves)
    const { fmt: F2, addD: A2, parse: P2 } = vm.runInContext("({ fmt, addD, parse })", sandbox);
    let mon2 = P2("2099-03-01"); while (mon2.getDay() !== 1) mon2 = A2(mon2, 1);
    const M2 = F2(mon2), dd = (o) => F2(A2(mon2, o));
    const clockAt = (o) => { const fixed = A2(mon2, o).getTime(); const RealDate = vm.runInContext("Date", sandbox); return class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fixed); } }; };
    let runAt = null;
    try { runAt = body ? vm.runInContext("(function (env) { const { schedule, surgeons, sMap, SHIFT_LABELS, holidayAssignments, vacations, noCallDays, Date } = env; const buildGenAvailability = env.buildGenAvailability || (() => { const m = {}; [vacations || {}, noCallDays || {}].forEach(src => Object.keys(src).forEach(k => { m[k] = (m[k] || []).concat(src[k]); })); return m; }); const buildSilvisPrimary = env.buildSilvisPrimary || (() => null); return (() => {" + body + "})(); })", sandbox, { filename: "af6-conflicts.js" }) : null; } catch (ex) { runAt = null; }
    const sur = [{ id: "s1", name: "DJA" }, { id: "s2", name: "MCC" }, { id: "s3", name: "RPC" }, { id: "s4", name: "KJH" }, { id: "s5", name: "REH" }, { id: "s6", name: "FAK" }, { id: "s7", name: "ARW" }];
    const sm = Object.fromEntries(sur.map((s, i) => [s.id, { name: s.name, idx: i }]));
    const sch = { [M2]: { dayCall: "s1", nights: { mon: "s2", tue: "s3", wed: "s4", thu: "s5", wknd: "s7" } } };
    const env = (o, extra) => Object.assign({ schedule: sch, surgeons: sur, sMap: sm, SHIFT_LABELS: vm.runInContext("SHIFT_LABELS", sandbox), holidayAssignments: {}, vacations: { s1: [[dd(0), dd(5)]], s7: [[dd(4), dd(6)]] }, noCallDays: {}, Date: clockAt(o) }, extra || {});
    const k1 = runAt ? runAt(env(0)).filter(l => l.type === "timeoff").map(l => l.key).sort() : [];
    const k3 = runAt ? runAt(env(2)).filter(l => l.type === "timeoff").map(l => l.key).sort() : [];
    const past = runAt ? runAt(env(6)).filter(l => l.type === "timeoff" && l.key.includes("|s1|")) : [];
    check("AF6 a multi-day line keeps ONE key while the run is in progress (day 1 = day 3), so a dismissal holds; a weekend vacation Fri–Sun is ONE line; a run wholly past is dropped",
      !!runAt && k1.length === 2 && JSON.stringify(k1) === JSON.stringify(k3)
        && k1.includes(`on-off|${M2}|s1|svc|${dd(0)}|${dd(5)}|vacation`) && k1.includes(`on-off|${M2}|s7|wknd|${dd(4)}|${dd(6)}|vacation`) && past.length === 0,
      JSON.stringify({ k1, k3, past: past.map(l => l.key) }));
  }
  check("AF5 the time-off lines read vacations ∪ no-call only (Silvis keeps its own lines), drop only runs wholly past (overnights skip past dates), and carry factual keys (dismissable)",
      /onVac\(id, ds, vacations \|\| \{\}\) \? "vacation" : onVac\(id, ds, noCallDays \|\| \{\}\) \? "no-call"/.test(body)
        && !/silvisDays|sfBusyRanges|silvisFakId/.test(body.slice(body.indexOf("ON CALL WHILE OFF")))
        && body.includes("runs.filter(r => r.to >= todayStr)") && body.includes("if (l.ds < todayStr || !l.overnight")
        && body.includes("key: `on-off|${mStr}|${r.sid}|${r.fam}|${r.from}|${r.to}|${r.kind}`") && body.includes("key: `into-vac|${mStr}|${l.sid}|${l.fam}|${l.ds}`")
        && !/dismissable:\s*false/.test(body));
  }
}

// ══════════════════════════════════════════════════════════════
// AG. Benchmark loader + safe re-publish (owner 2026-10-12, PR 1)
// ══════════════════════════════════════════════════════════════
//   AG1 the REAL rollForwardCounts: publishing a period twice counts it once;
//       re-publishing a corrected version moves the counts by the difference
//   AG2 validateScheduleJson / shapeScheduleWeeks (generator.js): a real
//       generate() result written out in the loader's format loads back
//       IDENTICAL to what the generator stored; every refusal names its reason
//   AG3 the REAL loadScheduleJson: a good file fills the preview (origin
//       "json"); a bad one changes nothing and says why
//   AG4 wiring pins: the button (scheduler only), the header label, both
//       publish paths net, no 100 ms timer
console.log("\nAG. benchmark loader + safe re-publish");
await (async () => {
  const nsrc = src.replace(/\r\n/g, "\n");
  // ── AG1 ──
  {
    const i = nsrc.indexOf("  const countsOfWeeks = (weeks, pick) => {");
    const k = i < 0 ? -1 : nsrc.indexOf("  const rollForwardCounts = useCallback((sched, replaced) => {", i);
    const j = k < 0 ? -1 : nsrc.indexOf("\n  }, [", k);
    let mk = null;
    if (i >= 0 && k > i && j > k) { try { mk = vm.runInContext(`(function (env) { const { surgeons, parse, useCallback, setPriorCounts, setYear1Counts } = env; ${nsrc.slice(i, j) + "\n  });"}; return rollForwardCounts; })`, sandbox); } catch (ex) { mk = null; } }
    if (!mk) check("AG1 rollForwardCounts extractable and compiles", false, "anchors not found or compile error");
    else {
      const sur = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"].map(id => ({ id, name: id.toUpperCase() }));
      const state = { prior: { s1: { dc: 10, nights: 40, wknd: 12, off: 5, dcB: 1, nightsB: 2, wkndB: 1, offB: 0, totalDays: 150, totalDaysB: 12 } }, y1: {} };
      const roll = mk({ surgeons: sur, parse: vm.runInContext("parse", sandbox), useCallback: (f) => f,
        setPriorCounts: (fn) => { state.prior = fn(state.prior); }, setYear1Counts: (fn) => { state.y1 = fn(state.y1); } });
      const wk = (dc, n, bk) => ({ dayCall: dc, nights: { wknd: n[4], mon: n[0], tue: n[1], wed: n[2], thu: n[3] }, off: "s7", isBackup: !!bk, isFierceBackup: false, holidayCoverage: null });
      // Two Mondays in December of THIS year (the 1-year tally counts the
      // current year only — fixed 2026 dates would make that half vacuous
      // from 2027-01-01). Always above the 2026-05-04 floor.
      const Y = Math.max(2026, new Date().getFullYear());
      const dec1 = new Date(Y, 11, 1), m1 = new Date(Y, 11, 1 + ((8 - dec1.getDay()) % 7)), m2 = new Date(m1.getFullYear(), 11, m1.getDate() + 7);
      const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const W1 = iso(m1), W2 = iso(m2), W0 = iso(new Date(m1.getFullYear(), 11, m1.getDate() - 7));
      const P = { [W1]: wk("s1", ["s2", "s3", "s4", "s5", "s6"]), [W2]: wk("s2", ["s1", "s4", "s3", "s6", "s5"], true) };
      const P2 = { [W1]: wk("s3", ["s2", "s1", "s4", "s5", "s6"]), [W2]: wk("s2", ["s1", "s4", "s3", "s6", "s5"], true) };
      const snap = () => JSON.stringify({ p: state.prior, y: state.y1 });
      const base = snap();
      roll(P, {}); const once = snap();
      roll(P, P); const twice = snap();
      check("AG1 publish a period, publish it AGAIN (replacing itself) → counts equal ONE publish (multi-year AND 1-year — both moved on the first publish — totalDays too)",
        once !== base && twice === once && JSON.stringify(JSON.parse(once).y) !== JSON.stringify(JSON.parse(base).y) && JSON.stringify(JSON.parse(once).p) !== JSON.stringify(JSON.parse(base).p),
        twice === once ? "the 1-year or multi-year tally did not move on the first publish" : `once=${once}\ntwice=${twice}`);
      roll(P2, P); const corrected = snap();
      state.prior = JSON.parse(base).p; state.y1 = JSON.parse(base).y; roll(P2, {}); const p2once = snap();
      check("AG1 re-publishing a CORRECTED version replaces the old one: counts = one publish of the corrected period", corrected === p2once, `corrected=${corrected}\nfresh=${p2once}`);
      state.prior = JSON.parse(base).p; state.y1 = JSON.parse(base).y;
      const rr = roll(P, { [W1]: P[W1], [W0]: wk("s5", ["s1", "s2", "s3", "s4", "s6"]) });
      const net = rr && rr.delta;
      check("AG1 only a replaced week that is itself being published comes off (the week before isn't in this publish): net = the new second week alone, 1 replaced week counted",
        net && net.s2.dc === 0 && net.s2.dcB === 1 && net.s1.dc === 0 && net.s1.nightsB === 1 && net.s5.dc === 0 && rr.replacedCounted === 1 && rr.delta1yr.s2.dcB === 1,
        JSON.stringify(rr && { s1: net.s1, s2: net.s2, s5: net.s5, replaced: rr.replacedCounted }));
      const floorNet = roll({ "2026-04-27": wk("s1", ["s2", "s3", "s4", "s5", "s6"]) }, {});
      check("AG1 the counts floor still holds (a week before 2026-05-04 never rolls forward)", floorNet === null);
    }
  }
  // ── AG2 ──
  const gsb2 = { console: { ...console, warn: () => {} }, window: {}, document: undefined, navigator: { userAgent: "node-test" }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, fetch: () => { throw new Error("fetch during generation"); }, setTimeout, clearTimeout };
  gsb2.globalThis = gsb2; vm.createContext(gsb2);
  for (const f of ["helpers.js", "config.js", "generator.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), gsb2, { filename: f });
  const G = vm.runInContext("({ generate, validateScheduleJson, shapeScheduleWeeks, fmt, addD, parse })", gsb2);
  const SUR = vm.runInContext("INIT_SURGEONS", gsb2).map(x => ({ id: x.id, name: x.name }));
  const ids = SUR.map(x => x.id);
  const MON = Array.from({ length: 6 }, (_, k) => G.addD(G.parse("2026-11-16"), 7 * k));
  const mStrs = MON.map(G.fmt);
  const HOL = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "holiday-assignments-2026-live.json"), "utf8"));
  const BK = new Set([mStrs[2]]), FB = new Set([mStrs[4]]);
  const gen = G.generate(SUR, MON, {}, BK, {}, {}, FB, HOL, [], null, {}, {});
  const asFile = { startMonday: mStrs[0], numWeeks: mStrs.length, weeks: Object.fromEntries(mStrs.map(m => [m, { dayCall: gen[m].dayCall, nights: { mon: gen[m].nights.mon, tue: gen[m].nights.tue, wed: gen[m].nights.wed, thu: gen[m].nights.thu, wknd: gen[m].nights.wknd } }])) };
  const v = G.validateScheduleJson(JSON.parse(JSON.stringify(asFile)), mStrs, ids);
  const shaped = v.ok ? G.shapeScheduleWeeks(v.weeks, SUR, BK, FB, HOL) : null;
  const hasHol = mStrs.some(m => gen[m].holidayCoverage);
  check("AG2 a real generate() result, written out in the loader's format and loaded back, is IDENTICAL to what the generator stored (off, backup flags, holiday coverage, key order)",
    v.ok && hasHol && JSON.stringify(shaped) === JSON.stringify(Object.fromEntries(mStrs.map(m => [m, gen[m]]))),
    v.ok ? (hasHol ? "differs: " + JSON.stringify(shaped).slice(0, 200) : "fixture has no holiday week") : v.error);
  const wkOk = asFile.weeks[mStrs[0]];
  const refusals = [
    ["a JSON array", [], /one JSON object/],
    ["a different start Monday", Object.assign({}, asFile, { startMonday: mStrs[1] }), /starts on "2026-11-23", but Generate is set to start on 2026-11-16/],
    ["a different week count", Object.assign({}, asFile, { numWeeks: 5 }), /numWeeks 5, but Generate is set to 6 weeks/],
    ["numWeeks as text", Object.assign({}, asFile, { numWeeks: "6" }), /numWeeks must be the number 6 \(the file has "6", which is text\)/],
    ["no numWeeks", (() => { const x = Object.assign({}, asFile); delete x.numWeeks; return x; })(), /the file has no numWeeks/],
    ["a missing week", Object.assign({}, asFile, { weeks: Object.fromEntries(mStrs.slice(0, 5).map(m => [m, asFile.weeks[m]])) }), /missing "2026-12-21"/],
    ["an extra week", Object.assign({}, asFile, { weeks: Object.assign({}, asFile.weeks, { "2026-12-28": wkOk }) }), /not in the settings: "2026-12-28"/],
    ["an id not on the roster", Object.assign({}, asFile, { weeks: Object.assign({}, asFile.weeks, { [mStrs[1]]: { dayCall: "s9", nights: wkOk.nights } }) }), /dayCall "s9" is not a roster id/],
    ["a night id not on the roster", Object.assign({}, asFile, { weeks: Object.assign({}, asFile.weeks, { [mStrs[1]]: { dayCall: "s1", nights: Object.assign({}, wkOk.nights, { thu: "DJA" }) } }) }), /thu "DJA" is not a roster id/],
    ["an unknown night", Object.assign({}, asFile, { weeks: Object.assign({}, asFile.weeks, { [mStrs[1]]: { dayCall: "s1", nights: Object.assign({}, wkOk.nights, { fri: "s2" }) } }) }), /unknown night "fri"/],
    ["an unknown field (typo)", Object.assign({}, asFile, { weeks: Object.assign({}, asFile.weeks, { [mStrs[1]]: { daycall: "s1", nights: wkOk.nights } }) }), /unknown field "daycall"/],
  ];
  const wrong = refusals.filter(([, o, re]) => { const r = G.validateScheduleJson(o, mStrs, ids); return r.ok || !re.test(r.error); }).map(([n]) => n);
  check("AG2 the whole load is refused, with the reason, for: " + refusals.map(r => r[0]).join(", "), wrong.length === 0, "not refused / wrong reason: " + wrong.join(", "));
  const exported = Object.assign({}, asFile, { weeks: Object.fromEntries(mStrs.map(m => [m, gen[m]])) });
  const ve = G.validateScheduleJson(JSON.parse(JSON.stringify(exported)), mStrs, ids);
  check("AG2 an exported week (with off / isBackup / holidayCoverage) loads: those fields are ignored and recomputed", ve.ok && JSON.stringify(G.shapeScheduleWeeks(ve.weeks, SUR, BK, FB, HOL)) === JSON.stringify(shaped));
  const blank = G.validateScheduleJson({ startMonday: mStrs[0], numWeeks: 6, weeks: Object.fromEntries(mStrs.map(m => [m, { dayCall: "s1", nights: { mon: null, tue: "" } }])) }, mStrs, ids);
  check("AG2 an empty slot (null / \"\" / missing) loads as empty — it shows in Needs your OK as an EMPTY slot, like a generated one", blank.ok && blank.weeks[mStrs[0]].nights.mon === null && blank.weeks[mStrs[0]].nights.wknd === null);
  // ── AG3 ──
  {
    const i = nsrc.indexOf("  const loadScheduleJson = (text, fileName) => {"), e = i < 0 ? -1 : nsrc.indexOf("\n  };\n", i);
    if (i < 0 || e < 0) check("AG3 loadScheduleJson extractable", false, "anchors not found");
    else {
      const body = nsrc.slice(i, e) + "\n  };";
      const mk = vm.runInContext(`(function (env) { const { showToast, validateScheduleJson, shapeScheduleWeeks, mondays, fmt, surgeons, backupMondaySet, fierceBackupSet, holidayAssignments, setPreviewSchedule, setPreviewOrigin, setPreviewCalMonth, setShowPreview, cancelSearch, setSearchStats, publishSearchRunning, previewEpochRef, schedSyncRef } = env; ${body}; return loadScheduleJson; })`, sandbox);
      const go = (text) => {
        const rec = { toasts: [], preview: null, origin: null, shown: false, cancelled: 0 }, pe = { current: -1 };
        const load = mk({ showToast: (m, t) => rec.toasts.push([String(m), t]), validateScheduleJson: G.validateScheduleJson, shapeScheduleWeeks: G.shapeScheduleWeeks, mondays: MON, fmt: G.fmt, surgeons: SUR,
          backupMondaySet: BK, fierceBackupSet: FB, holidayAssignments: HOL, setPreviewSchedule: (x) => { rec.preview = x; }, setPreviewOrigin: (x) => { rec.origin = x; }, setPreviewCalMonth: () => {}, setShowPreview: (x) => { rec.shown = x; }, cancelSearch: () => { rec.cancelled++; }, setSearchStats: (x) => { rec.stats = x; }, publishSearchRunning: () => false, previewEpochRef: pe, schedSyncRef: { current: { epochNow: () => 7 } } });
        rec.ret = load(text, "bench.json"); rec.epoch = pe.current;
        return rec;
      };
      const good = go(JSON.stringify(asFile)), bad = go(JSON.stringify(Object.assign({}, asFile, { numWeeks: 9 }))), junk = go("{not json");
      const bom = go("﻿" + JSON.stringify(asFile, null, 2));
      check("AG3 sync v2: a loaded preview is judged from the engine epoch at the load; a refused file leaves the epoch alone", good.epoch === 7 && bad.epoch === -1 && junk.epoch === -1, JSON.stringify([good.epoch, bad.epoch, junk.epoch]));
      check("AG3 a file saved with a byte-order mark (Windows editors) loads like any other", bom.ret === true && JSON.stringify(bom.preview) === JSON.stringify(shaped), JSON.stringify(bom.toasts));
      check("AG3 the REAL loader: a good file fills the preview with the shaped weeks, origin \"json\", shown, and says nothing is published yet",
        good.ret === true && JSON.stringify(good.preview) === JSON.stringify(shaped) && good.origin === "json" && good.shown === true && /nothing is published until/.test(good.toasts[0][0]), JSON.stringify(good.toasts));
      const shifted = { startMonday: mStrs[1], numWeeks: 6, weeks: Object.fromEntries([...mStrs.slice(1), G.fmt(G.addD(MON[5], 7))].map(m => [m, wkOk])) };
      const sh = go(JSON.stringify(shifted));
      check("AG3 a self-consistent file for a DIFFERENT start (11/23 × 6) is refused against the Generate settings (11/16 × 6)",
        sh.ret === false && sh.preview === null && sh.origin === null && /Generate is set to start on 2026-11-16/.test(sh.toasts[0][0]), JSON.stringify(sh.toasts));
      check("AG3 a refused file (wrong week count) or a non-JSON file changes NOTHING and says why",
        bad.ret === false && bad.preview === null && bad.origin === null && /Not loaded — the file has numWeeks 9/.test(bad.toasts[0][0]) && bad.toasts[0][1] === "error"
          && junk.ret === false && junk.preview === null && /isn't valid JSON/.test(junk.toasts[0][0]), JSON.stringify([bad.toasts, junk.toasts]));
    }
  }
  // ── AG4 ──
  check("AG4 the button sits next to 👁 Preview Schedule, scheduler/admin only, with a hidden .json file input; the header says where the preview came from",
    /👁 Preview Schedule"\}\n\s*<\/button>\n\s*\{\(isScheduler \|\| userProfile\?\.role === "admin"\) && <>[\s\S]{0,600}📋 Load schedule \(JSON\)[\s\S]{0,200}<input ref=\{loadJsonInputRef\} type="file" accept="\.json,application\/json" onChange=\{onLoadJsonFile\}/.test(nsrc)
      && count('{previewOrigin === "json" && <span') === 1 && count("Loaded from JSON — not generated") === 1
      && count('setPreviewSchedule(result); setPreviewOrigin("generated");') === 3 && count('setPreviewOrigin("json")') === 1); // preview · inputs changed · Needs your OK
  check("AG4 both publish paths go through the ONE publish step (Accept & Publish; Generate & Publish at commit), the only roll-forward — no 100 ms timer, no 'skip if any schedule exists'",
    count("publishWeeks(weeks, {") === 1 && count("publishWeeks(result, {") === 1 && count("publishWeeks(") === 2
      && count("const r = rollForwardCounts(newWeeks, replacedWeeks);") === 1 && count("rollForwardCounts(") === 1
      && count("hadExistingSchedule") === 0 && !/rollForwardCounts\(latest\)/.test(nsrc));
  {
    // since 2026-10-12 the publish runs after the search, in finishGenerate → commitGenerated (with the latest state)
    const g = nsrc.indexOf("  const finishGenerate = (result, preview, clickSig, clickLocks, genEpoch) => {"), ge = nsrc.indexOf("\n  genFinishRef.current = finishGenerate; genCommitRef.current = commitGenerated;", g), body = g < 0 || ge < 0 ? "" : nsrc.slice(g, ge);
    const busy = body.indexOf("if (publishingRef.current) {"), arm = body.indexOf("publishingRef.current = true; setPublishing(true);"), iife = body.indexOf("(async () => {", arm);
    const snapOk = body.indexOf("if (!snap.ok) {"), commit = body.indexOf("await genCommitRef.current(result);"), fin = body.indexOf("} finally { publishingRef.current = false; setPublishing(false); }"), pub = body.indexOf("publishWeeks(result, {");
    check("AG4 Generate & Publish: refused while a publish is in progress, armed BEFORE the snapshot's await, released in finally; the counts move only AFTER a good snapshot (a refused publish moves nothing), in commitGenerated — with the state as it is after the await",
      busy > 0 && arm > busy && iife > arm && snapOk > iife && commit > snapOk && fin > commit && pub > fin && body.indexOf("const commitGenerated = async (result) => {") > fin && body.indexOf("const commitGenerated = async (result) => {") < pub && count('return "busy";') === 2 // + a search already running (2026-10-12)
        && count("disabled={publishing || !!searching}") === 1 && count("disabled={publishing || searching === \"publish\" || (previewNeedsOk.items.length > 0 && !previewAck)}") === 1,
      JSON.stringify({ busy, arm, iife, snapOk, commit, fin, pub }));
  }
  check("AG4 the immediate save after Generate & Publish writes the counts AFTER the publish (not the render's)",
    count("buildStateBundle({ schedule: merged, priorCounts: prior, year1Counts: y1 })") === 1);
  check("AG4 a loaded preview's texts say the weeks came from the file (Needs-your-OK footnote, spacing notes), and the generator's seed panel is hidden for it",
    (nsrc.split('previewOrigin === "json"\n                      ? "These are in the loaded file').length - 1) === 1 && count("(as in the loaded file)") === 1
      && count('{previewOrigin === "json" ? "These are in the loaded file. Accepting publishes them as shown') === 1 && count('seedDebug && previewOrigin !== "json" && (') === 1);
  // ── AG5: the REAL publish step, undo and audit text, on a simulated component state ──
  {
    const iU = nsrc.indexOf("  const pushUndo = useCallback((counts) => {"), eU = iU < 0 ? -1 : nsrc.indexOf("\n  // ─── What-If Preview ───", iU);
    const iC = nsrc.indexOf("  const countsOfWeeks = (weeks, pick) => {"), kC = iC < 0 ? -1 : nsrc.indexOf("  const rollForwardCounts = useCallback((sched, replaced) => {", iC), eC = kC < 0 ? -1 : nsrc.indexOf("\n  }, [", kC);
    const iP = nsrc.indexOf("  const publishWeeks = (newWeeks, how) => {"), eP = iP < 0 ? -1 : nsrc.indexOf("\n\n  // ─── Load a schedule from JSON", iP);
    let factory = null;
    if ([iU, eU, iC, kC, eC, iP, eP].every(x => x >= 0)) {
      try {
        factory = vm.runInContext(`(function (env) {
          const { surgeons, parse, useCallback, scheduleRef, commitSchedule, schedSyncRef, schedEditable, showToast, priorCounts, year1Counts, setPriorCounts, setYear1Counts, scheduleHistory, setScheduleHistory, logAudit } = env;
          ${nsrc.slice(iU, eU)}
          ${nsrc.slice(iC, eC) + "\n  });"}
          ${nsrc.slice(iP, eP)}
          return { pushUndo, undoLastChange, rollForwardCounts, publishWeeks, netCountsText, applyCountsDelta };
        })`, sandbox);
      } catch (ex) { factory = null; }
    }
    if (!factory) check("AG5 the publish step, undo and counts are extractable and compile", false, "anchors not found or compile error");
    else {
      const sur = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"].map(id => ({ id, name: id.toUpperCase() }));
      const st = { schedule: {}, prior: { s1: { dc: 9, nights: 30, wknd: 10, off: 4, dcB: 0, nightsB: 0, wkndB: 0, offB: 0, totalDays: 120, totalDaysB: 0 } }, y1: {}, history: [], audits: [], toasts: [] };
      const eng = { epoch: 4, blocked: [] }; // the engine stub: its epoch, and the weeks its undoPlan reports as adopted since a step
      const ref = { current: st.schedule };
      const upd = (k) => (f) => { st[k] = typeof f === "function" ? f(st[k]) : f; };
      const render = () => factory({ surgeons: sur, parse: vm.runInContext("parse", sandbox), useCallback: (f) => f, scheduleRef: ref,
        commitSchedule: (v) => { st.schedule = v; ref.current = v; }, schedEditable: () => true, showToast: (m) => st.toasts.push(String(m)),
        schedSyncRef: { current: { epochNow: () => eng.epoch, undoPlan: (snap) => ({ next: JSON.parse(JSON.stringify(snap)), touched: [], blocked: eng.blocked.slice() }) } }, priorCounts: st.prior, year1Counts: st.y1,
        setPriorCounts: upd("prior"), setYear1Counts: upd("y1"), scheduleHistory: st.history, setScheduleHistory: upd("history"),
        logAudit: (a, msg, meta) => st.audits.push({ a, msg, meta }) });
      const wk = (dc, n) => ({ dayCall: dc, nights: { wknd: n[4], mon: n[0], tue: n[1], wed: n[2], thu: n[3] }, off: "s7", isBackup: false, isFierceBackup: false, holidayCoverage: null });
      const OLD = { "2026-11-09": wk("s5", ["s1", "s2", "s3", "s4", "s6"]) };
      const P = { "2026-11-16": wk("s1", ["s2", "s3", "s4", "s5", "s6"]), "2026-11-23": wk("s2", ["s1", "s4", "s3", "s6", "s5"]) };
      st.schedule = JSON.parse(JSON.stringify(OLD)); ref.current = st.schedule;
      const counts = () => JSON.stringify({ p: st.prior, y: st.y1 });
      const c0 = counts();
      const r1 = render().publishWeeks(P, { label: "test", meta: {} });
      const c1 = counts();
      check("AG5 the REAL publish step: publishes, merges into the existing weeks, moves the counts, and returns exactly the counts it set (for the immediate save)",
        c1 !== c0 && Object.keys(st.schedule).length === 3 && JSON.stringify({ p: r1.prior, y: r1.y1 }) === c1 && st.audits[0].meta.replaced === 0 && st.history.length === 1 && st.history[0].counts,
        JSON.stringify({ c0, c1, ret: { p: r1.prior, y: r1.y1 } }).slice(0, 400));
      render().publishWeeks(JSON.parse(JSON.stringify(P)), { label: "test", meta: {} });
      check("AG5 publish → publish again: counts equal ONE publish; the audit says 2 weeks replaced, counts net: no change",
        counts() === c1 && st.audits[1].meta.replaced === 2 && /2 weeks replaced a published version — counts net: no change/.test(st.audits[1].msg), st.audits[1].msg);
      render().undoLastChange();
      render().undoLastChange();
      check("AG5 ↩ Undo twice takes BOTH publishes back off: the schedule AND the counts are as before the first publish", counts() === c0 && JSON.stringify(st.schedule) === JSON.stringify(OLD), counts());
      render().publishWeeks(JSON.parse(JSON.stringify(P)), { label: "test", meta: {} });
      check("AG5 publish → ↩ Undo → publish counts the period ONCE (Undo used to put the schedule back but not the counts)", counts() === c1, counts());
      check("AG5 sync v2: the publish step carries the engine epoch with its counts", st.history.length >= 1 && st.history[st.history.length - 1].epoch === 4 && !!st.history[st.history.length - 1].counts, JSON.stringify(st.history.map(h => h.epoch)));
      { const s0 = JSON.stringify(st.schedule), k0 = counts(), h0 = st.history.length; eng.blocked = ["2026-11-16"]; render().undoLastChange(); eng.blocked = [];
        check("AG5 sync v2: an Undo the engine refuses (a week adopted since) changes NOTHING — schedule, counts and history — and says why",
          JSON.stringify(st.schedule) === s0 && counts() === k0 && st.history.length === h0 && /Can't undo/.test(st.toasts.join(" ")), JSON.stringify({ toasts: st.toasts, h: [h0, st.history.length] })); }
      const P2 = { "2026-11-16": wk("s3", ["s2", "s1", "s4", "s5", "s6"]) };
      render().publishWeeks(P2, { label: "test", meta: {} });
      const last = st.audits[st.audits.length - 1].msg;
      check("AG5 the audit names the net in plain words: a corrected week → 'S1 service −1, nights +1; S3 service +1, nights −1'",
        /counts net: S1 service −1, nights \+1; S3 service \+1, nights −1$/.test(last) || /counts net: S1 service −1, nights \+1; S3 service \+1, nights −1 \(this year/.test(last), last);
      const fns = render();
      check("AG5 netCountsText: null → 'no change'; a backup week reads as 'backup service'; off counts are included",
        fns.netCountsText(null) === "no change" && /S4 backup service \+1/.test(fns.netCountsText({ s4: { dc: 0, nights: 0, wknd: 0, off: 0, dcB: 1, nightsB: 0, wkndB: 0, offB: 0 } }))
          && /S7 off \+2/.test(fns.netCountsText({ s7: { dc: 0, nights: 0, wknd: 0, off: 2, dcB: 0, nightsB: 0, wkndB: 0, offB: 0 } })));
    }
  }
})();

// ─── AH. The search, strain and the floor in the app (owner brief 2026-10-12, PR 2) ───
// The generator's side is pinned by test/generator-regression.js (live
// scenario + benchmark + oracle). Here, the app's side:
//   AH1 Schedule Warnings (the REAL conflicts memo): rule 1 — a service-week
//       surgeon off (vacation / no-call) on that Sunday is one line; rule 2 —
//       Thu night + that weekend is one line (not when the cards design it or
//       a holiday 24h holds the Friday)
//   AH2 Schedule Warnings (the REAL silvisConflicts memo): a Silvis primary on
//       the Sunday after FAK's Davenport service week is one line
//   AH3 Needs your OK: every item kind listScheduleBends emits sits in exactly
//       one group; the box renders the groups; the footnote no longer claims
//       the bends are "the minimum the calendar allows"
//   AH4 ONE seed builder (the REAL buildPrevWeekSeed): that week's service
//       week, weekend AND weeknights, and the service-week history — used by
//       Generate, Search more and the preview's box
//   AH5 the REAL runSearch: time slices until perfect or the budget is spent;
//       cancelled → null; a throwing slice still ends the search
//   AH6 the wiring: Generate / Re-roll / Regenerate / Search more go through
//       the search; Accept, Discard and a JSON load cancel it; Search more
//       starts from the preview and drops a late result; the progress line
//       re-renders itself, not the app
//   AH7 generator.js: one FLEX list, the 10-second budget, and a generate()
//       result is the weeks and nothing else
await (async () => {
  const nsrcAH = src.replace(/\r\n/g, "\n");
  const G = vm.runInContext("({ fmt, addD, parse, listScheduleBends, generate, createScheduleSearch })", sandbox);
  // ── AH1 ──
  {
    const START = "  const conflicts = useMemo(() => {";
    const s0 = nsrcAH.indexOf(START), e0 = s0 < 0 ? -1 : nsrcAH.indexOf("\n  }, [", s0);
    const body = s0 < 0 || e0 < 0 ? null : nsrcAH.slice(s0 + START.length, e0);
    let runC = null;
    try { runC = body ? vm.runInContext("(function (env) { const { schedule, surgeons, sMap, SHIFT_LABELS, holidayAssignments, vacations, noCallDays } = env; const buildGenAvailability = env.buildGenAvailability || (() => { const m = {}; [vacations || {}, noCallDays || {}].forEach(src => Object.keys(src).forEach(k => { m[k] = (m[k] || []).concat(src[k]); })); return m; }); const buildSilvisPrimary = env.buildSilvisPrimary || (() => null); return (() => {" + body + "})(); })", sandbox, { filename: "ah-conflicts.js" }) : null; } catch (ex) { runC = null; }
    if (!runC) check("AH1 conflicts memo extractable for execution", false, "anchor / compile");
    else {
      let mon = G.parse("2099-03-01"); while (mon.getDay() !== 1) mon = G.addD(mon, 1);
      const M = G.fmt(mon), d = (o) => G.fmt(G.addD(mon, o));
      const surgeons = [{ id: "s1", name: "DJA" }, { id: "s2", name: "MCC" }, { id: "s3", name: "RPC" }, { id: "s4", name: "KJH" }, { id: "s5", name: "REH" }, { id: "s6", name: "FAK" }, { id: "s7", name: "ARW" }];
      const sMap = Object.fromEntries(surgeons.map((s, i) => [s.id, { name: s.name, idx: i }]));
      const LABELS = vm.runInContext("SHIFT_LABELS", sandbox);
      const base = (over) => ({ [M]: Object.assign({ dayCall: "s1", nights: { mon: "s2", tue: "s3", wed: "s4", thu: "s5", wknd: "s7" } }, over || {}) });
      const run = (env) => runC(Object.assign({ schedule: base(), surgeons, sMap, SHIFT_LABELS: LABELS, holidayAssignments: {}, vacations: {}, noCallDays: {} }, env));
      const keysOf = (r, p) => r.filter(x => x.key.startsWith(p)).map(x => x.key);
      const vacSun = run({ vacations: { s1: [[d(6), d(6)]] } }), ncSun = run({ noCallDays: { s1: [[d(6), d(6)]] } }), clean = run({});
      check("AH1 rule 1: the service-week surgeon on vacation that SUNDAY → one 'svc-sun' line keyed from facts, saying the surgeon must be free that Sunday",
        JSON.stringify(keysOf(vacSun, "svc-sun|")) === JSON.stringify([`svc-sun|${M}|s1|${d(6)}|vacation`]) && /DJA is on Service Week .* but is off Sun .* \(vacation\) — the service-week surgeon must be free that Sunday/.test(vacSun.find(x => x.key.startsWith("svc-sun|")).message),
        JSON.stringify(vacSun.map(x => x.key)));
      check("AH1 rule 1: a NO-CALL Sunday is the same line (kind no-call); a free Sunday → none",
        JSON.stringify(keysOf(ncSun, "svc-sun|")) === JSON.stringify([`svc-sun|${M}|s1|${d(6)}|no-call`]) && keysOf(clean, "svc-sun|").length === 0, JSON.stringify([ncSun.map(x => x.key), clean.map(x => x.key)]));
      const thu = run({ schedule: base({ nights: { mon: "s2", tue: "s3", wed: "s4", thu: "s7", wknd: "s7" } }) });
      check("AH1 rule 2: Thu night + that weekend by one surgeon → one 'thu-wknd' line (two nights in a row)",
        JSON.stringify(keysOf(thu, "thu-wknd|")) === JSON.stringify([`thu-wknd|${M}|s7`]) && /ARW has Thu night then the Weekend \(Fri night\) — two nights in a row/.test(thu.find(x => x.key.startsWith("thu-wknd|")).message), JSON.stringify(thu.map(x => x.key)));
      const holFri = run({ schedule: base({ nights: { mon: "s2", tue: "s3", wed: "s4", thu: "s7", wknd: "s7" }, holidayCoverage: { [d(4)]: { surgeonId: "s3", name: "Fri 24h" } } }) });
      check("AH1 rule 2: a holiday 24h holding that Friday breaks the run — no 'thu-wknd' line", keysOf(holFri, "thu-wknd|").length === 0, JSON.stringify(holFri.map(x => x.key)));
    }
  }
  // ── AH2 ──
  {
    const START = "  const silvisConflicts = useMemo(() => {";
    const s0 = nsrcAH.indexOf(START), e0 = s0 < 0 ? -1 : nsrcAH.indexOf("\n  }, [", s0);
    const body = s0 < 0 || e0 < 0 ? null : nsrcAH.slice(s0 + START.length, e0);
    let runS = null;
    try { runS = body ? vm.runInContext("(function (env) { const { silvisActive, isPublicMode, schedule, silvisDays, silvisFakId, nameOf, silvisRows, silvisLoadError } = env; return (() => {" + body + "})(); })", sandbox, { filename: "ah-silvis.js" }) : null; } catch (ex) { runS = null; }
    if (!runS) check("AH2 silvisConflicts memo extractable for execution", false, "anchor / compile");
    else {
      let mon = G.parse("2099-03-01"); while (mon.getDay() !== 1) mon = G.addD(mon, 1);
      const M = G.fmt(mon), d = (o) => G.fmt(G.addD(mon, o));
      const env = (primary, dc) => ({ silvisActive: true, isPublicMode: false, schedule: { [M]: { dayCall: dc, nights: { mon: "s2", tue: "s3", wed: "s4", thu: "s5", wknd: "s7" } } },
        silvisDays: { primary: new Set(primary), backup: new Set(), fetchedAt: new Date().toISOString(), from: d(-30), to: d(60) }, silvisFakId: "s6", nameOf: (id) => ({ s6: "FAK" })[id] || id, silvisRows: [{}], silvisLoadError: null });
      let onSun = null, other = null, notHis = null;
      try { onSun = runS(env([d(6)], "s6")); other = runS(env([d(13)], "s6")); notHis = runS(env([d(6)], "s1")); } catch (ex) { onSun = null; }
      const sunKeys = (r) => (r || []).filter(x => x.key.startsWith("silvis-sun|")).map(x => x.key);
      check("AH2 rule 1: a Silvis primary on the SUNDAY of FAK's Davenport service week → one 'silvis-sun' line; a Silvis day elsewhere, or another surgeon's service week → none",
        !!onSun && JSON.stringify(sunKeys(onSun)) === JSON.stringify([`silvis-sun|s6|${M}|${d(6)}`]) && sunKeys(other).length === 0 && sunKeys(notHis).length === 0,
        JSON.stringify([sunKeys(onSun), sunKeys(other), sunKeys(notHis)]));
      // rule 2 across the two jobs (2026-10-13): a published Davenport overnight of FAK's next to a Silvis 24h — both sides, by
      // weekHolders' rule (a holiday row counts, a Saturday override hands the night away), and never a past week
      const adjEnv = (primary, wk, mStr) => ({ silvisActive: true, isPublicMode: false, schedule: { [mStr || M]: wk },
        silvisDays: { primary: new Set(primary), backup: new Set(), fetchedAt: new Date().toISOString(), from: d(-30), to: d(60) }, silvisFakId: "s6", nameOf: (id) => ({ s6: "FAK" })[id] || id, silvisRows: [{}], silvisLoadError: null });
      const adjKeys = (r) => (r || []).filter(x => x.key.startsWith("silvis-adj|")).map(x => x.key).sort();
      const base = { dayCall: "s1", nights: { mon: "s2", tue: "s3", wed: "s4", thu: "s6", wknd: "s7" } };
      let thuFri = null, satBoth = null, ovr = null, row = null, past = null;
      try {
        thuFri = runS(adjEnv([d(4)], base));                                                                   // FAK Thu night → Silvis Fri
        satBoth = runS(adjEnv([d(5)], { ...base, nights: { ...base.nights, thu: "s5", wknd: "s6" } }));         // FAK weekend Fri + Sun around a Silvis Sat
        ovr = runS(adjEnv([d(4)], { ...base, dayCall: "s6", nights: { ...base.nights, thu: "s5" }, dayCallOverrides: { [d(5)]: "s2" } })); // FAK's service Sat handed to MCC
        row = runS(adjEnv([d(3)], { ...base, nights: { ...base.nights, thu: "s5" }, holidayCoverage: { [d(2)]: { surgeonId: "s6" } } })); // FAK's holiday 24h Wed → Silvis Thu
        let pm = G.parse("2020-03-02"); const PM = G.fmt(pm);
        past = runS(adjEnv([G.fmt(G.addD(pm, 4))], base, PM));
      } catch (ex) { thuFri = null; }
      check("AH2 rule 2 across the two jobs: a published Davenport overnight of FAK's next to a Silvis 24h is listed — Thu night → Silvis Fri, both sides of a Silvis Saturday, a holiday 24h row of his; not a Saturday handed to someone else by an override, not a past week",
        !!thuFri && JSON.stringify(adjKeys(thuFri)) === JSON.stringify([`silvis-adj|s6|${d(4)}|${d(3)}`])
          && JSON.stringify(adjKeys(satBoth)) === JSON.stringify([`silvis-adj|s6|${d(5)}|${d(4)}`, `silvis-adj|s6|${d(5)}|${d(6)}`].sort())
          && adjKeys(ovr).length === 0 && JSON.stringify(adjKeys(row)) === JSON.stringify([`silvis-adj|s6|${d(3)}|${d(2)}`]) && adjKeys(past).length === 0
          && (thuFri.find(x => x.key.startsWith("silvis-adj|")) || {}).severity === "warning",
        JSON.stringify([adjKeys(thuFri), adjKeys(satBoth), adjKeys(ovr), adjKeys(row), adjKeys(past)]));
    }
  }
  // ── AH3 ──
  {
    const gs = nsrcAH.indexOf("const NEEDS_OK_GROUPS = ["), ge = gs < 0 ? -1 : nsrcAH.indexOf("];\n", gs);
    let groups = null; try { groups = gs < 0 ? null : vm.runInContext("(" + nsrcAH.slice(gs + "const NEEDS_OK_GROUPS = ".length, ge + 1) + ")", sandbox); } catch (ex) { groups = null; }
    const KINDS = ["error", "lock", "empty", "timeoff", "hard", "lastResort", "strain", "bend", "flexStrain", "crowded"];
    const all = groups ? groups.flatMap(g => g.kinds) : [];
    check("AH3 every item kind (incl. the check's own 'error') sits in exactly ONE Needs-your-OK group, rule breaks first",
      !!groups && KINDS.every(k => all.filter(x => x === k).length === 1) && all.length === KINDS.length && groups[0].kinds.includes("hard") && groups[0].kinds.includes("timeoff"), JSON.stringify(groups));
    // generator.js emits only kinds the groups know (a crafted schedule with a hard pair, a Sunday off, strain, a bend, an empty slot, a lock, crowding)
    const S7 = ["DJA", "MCC", "RPC", "KJH", "REH", "FAK", "ARW"].map((n, i) => ({ id: "s" + (i + 1), name: n }));
    const ms = ["2099-03-02", "2099-03-09"].map(G.parse);
    const sched = { "2099-03-02": { dayCall: "s1", nights: { mon: "s2", tue: "s2", wed: "s3", thu: "s4", wknd: "s5" } }, "2099-03-09": { dayCall: "s5", nights: { mon: null, tue: "s7", wed: "s2", thu: "s6", wknd: "s6" } } };
    const off = Object.fromEntries(["s2", "s3", "s4", "s7", "s6"].map(id => [id, [["2099-03-12", "2099-03-12"]]]));
    off.s1 = [["2099-03-08", "2099-03-08"]];
    const lst = G.listScheduleBends(sched, { surgeons: S7, mondays: ms, vac: off, vacationsOnly: {}, holAssignments: {}, prevWeekSeed: null, locks: [{ mondayStr: "2099-03-09", slot: "dc", surgeonId: "s3" }] });
    const got = [...new Set(lst.items.map(i => i.kind))].sort();
    check("AH3 the crafted schedule exercises the new kinds, and every kind listScheduleBends emits is in a group",
      ["hard", "timeoff", "empty", "lock", "bend", "crowded"].every(k => got.includes(k)) && got.every(k => all.includes(k)) && lst.items.some(i => i.key === "sunday" && /must be free that Sunday/.test(i.text)), JSON.stringify(got) + " " + JSON.stringify(lst.items.map(i => i.text)));
    check("AH3 the box renders the groups (subheads), and the footnote no longer claims the bends are the calendar's minimum",
      count("{NEEDS_OK_GROUPS.map(g => { const its = previewNeedsOk.items.filter(it => g.kinds.includes(it.kind));") === 1 && count("the bends themselves are the minimum the calendar allows") === 0
        && count("no time off and no two nights in a row (designed holiday runs aside — anything left breaking them is under Must fix), FAK's last resort, service weeks even, weekends even, the least strain, the mildest bends, totals even") === 1);
  }
  // ── AH4 ──
  {
    const i = nsrcAH.indexOf("  const buildPrevWeekSeed = (first) => {"), e = i < 0 ? -1 : nsrcAH.indexOf("\n  };\n", i);
    let mk = null; try { mk = i < 0 ? null : vm.runInContext("(function (env) { const { mondays, schedule, fmt, addD } = env; return (" + nsrcAH.slice(i + "  const buildPrevWeekSeed = ".length, e) + "\n  }); })", sandbox); } catch (ex) { mk = null; }
    if (!mk) check("AH4 buildPrevWeekSeed extractable", false, "anchor / compile");
    else {
      const schedule = { "2026-11-09": { dayCall: "s2", nights: { mon: "s1", tue: "s3", wed: "s4", thu: "s7", wknd: "s5" }, holidayCoverage: { "2026-11-15": { surgeonId: "s6" } }, dayCallOverrides: { "2026-11-14": "s3" } }, "2026-11-02": { dayCall: "s4", nights: {} }, "2026-10-26": { dayCall: "s2", nights: {} } };
      const seedOf = mk({ mondays: [G.parse("2026-11-16")], schedule, fmt: G.fmt, addD: G.addD });
      const s1 = seedOf(), s2 = seedOf(G.parse("2026-11-23"));
      check("AH4 the ONE seed: the week before's service week, weekend AND weeknights, and each surgeon's latest service week (nearest wins); `first` overrides the Generate settings",
        JSON.stringify(s1) === JSON.stringify({ dayCall: "s2", wknd: "s5", nights: { mon: "s1", tue: "s3", wed: "s4", thu: "s7" }, holidayCoverage: { "2026-11-15": { surgeonId: "s6" } }, dayCallOverrides: { "2026-11-14": "s3" }, recentDc: { s2: -1, s4: -2 } }) && s2.dayCall === null && s2.recentDc.s2 === -2,
        JSON.stringify([s1, s2]));
    }
    {
      // the engine reads the seed's dates by weekHolders' rule: the row's surgeon held that Sunday, not the weekend slot's
      const S7 = ["DJA", "MCC", "RPC", "KJH", "REH", "FAK", "ARW"].map((n, i) => ({ id: "s" + (i + 1), name: n }));
      const wk = { "2026-11-16": { dayCall: "s1", nights: { mon: "s5", tue: "s2", wed: "s3", thu: "s4", wknd: "s7" } } };
      const ctx = (seed) => ({ surgeons: S7, mondays: ["2026-11-16"], vac: {}, vacationsOnly: {}, holAssignments: {}, prevWeekSeed: seed });
      const plain = { dayCall: "s2", wknd: "s5", nights: {}, recentDc: {} };
      const hard = (seed) => G.listScheduleBends(wk, ctx(seed)).items.filter(i => i.kind === "hard").map(i => i.who);
      check("AH4 the engine reads the seed by weekHolders' rule: a holiday/swap row on the seam Sunday (or an override on its Saturday) is who worked it — REH's weekend Sun → Mon night is a rule-2 item; with FAK's row on that Sunday it is not",
        JSON.stringify(hard(plain)) === JSON.stringify(["s5"]) && hard({ ...plain, holidayCoverage: { "2026-11-15": { surgeonId: "s6" } } }).length === 0,
        JSON.stringify([hard(plain), hard({ ...plain, holidayCoverage: { "2026-11-15": { surgeonId: "s6" } } })]));
    }
    check("AH4 Generate, Search more and the preview's box all build the seed with it (the box used to drop the history and the weeknights)",
      count("const prevWeekSeed = buildPrevWeekSeed();") === 1 && count("buildPrevWeekSeed(ms[0])") === 1 && count("prevWeekSeed: keys.length ? buildPrevWeekSeed(parse(keys[0])) : null,") === 1
        && count("prevWeekSeed: buildPrevWeekSeed(), locks: pendingLocks, silvisPrimary: buildSilvisPrimary() }).items.length;") === 1 // Generate & Publish's gate: today's seed AND the locks, like the box
        && count("locks: pendingLocks, // a lock the schedule doesn't honor is listed too") === 1);
  }
  // ── AH5 ──
  {
    const i = nsrcAH.indexOf("  const runSearch = (session, purpose, budgetMs) => new Promise(resolve => {"), e = i < 0 ? -1 : nsrcAH.indexOf("\n  });\n", i);
    let mk = null; try { mk = i < 0 ? null : vm.runInContext("(function (env) { const { searchRef, setSearching, setTimeout } = env; return (" + nsrcAH.slice(i + "  const runSearch = ".length, e) + "\n  })); })", sandbox); } catch (ex) { mk = null; }
    // the REAL cancelSearch + publishSearchRunning, on the same ref as the real runSearch
    const ci = nsrcAH.indexOf("  const cancelSearch = () => {"), ce = ci < 0 ? -1 : nsrcAH.indexOf("\n", nsrcAH.indexOf("  const publishSearchRunning = () =>", ci));
    let mkAll = null; try { mkAll = ci < 0 || i < 0 ? null : vm.runInContext("(function (env) { const { searchRef, setSearching, setTimeout } = env; const runSearch = (" + nsrcAH.slice(i + "  const runSearch = ".length, e) + "\n  }));\n" + nsrcAH.slice(ci, ce) + "\n return { runSearch, cancelSearch, publishSearchRunning }; })", sandbox); } catch (ex) { mkAll = null; }
    if (!mk) check("AH5 runSearch extractable", false, "anchor / compile");
    else {
      const mkEnv = () => { const flags = []; return { flags, env: { searchRef: { current: null }, setSearching: (v) => flags.push(v), setTimeout } }; };
      const fake = (perfectAt, throwAt) => ({ n: 0, step() { this.n++; if (throwAt && this.n === throwAt) throw new Error("boom"); }, status() { return { perfect: this.n >= perfectAt }; } });
      const A = mkEnv(), sA = fake(3); const rA = await mk(A.env)(sA, "generate", 60000);
      check("AH5 the REAL runSearch: slices until perfect, then resolves { session, ms } and clears the flag (generate → null)",
        !!rA && rA.session === sA && sA.n === 3 && A.env.searchRef.current === null && JSON.stringify(A.flags) === JSON.stringify(["generate", null]), JSON.stringify([sA.n, A.flags]));
      const B = mkEnv(), sB = fake(1e9); const pB = mk(B.env)(sB, "more", 60000);
      await new Promise(r => setTimeout(r, 5)); B.env.searchRef.current = null; // cancelSearch
      const rB = await pB;
      check("AH5 cancelled (Accept / Discard / a JSON load clears the ref) → resolves null; the search stops", rB === null && sB.n >= 1 && sB.n < 1e9, JSON.stringify([rB, sB.n]));
      const C = mkEnv(), sC = fake(1e9); const rC = await mk(C.env)(sC, "generate", 0);
      check("AH5 the budget counts ACTIVE search time: 0 ms → one slice, then done", !!rC && sC.n === 1 && C.env.searchRef.current === null, JSON.stringify(sC.n));
      const D = mkEnv(), sD = fake(1e9, 2), errs = []; const oldErr = console.error; console.error = (...a) => errs.push(a.join(" "));
      const rD = await mk(D.env)(sD, "generate", 60000); console.error = oldErr;
      check("AH5 a slice that throws ends the search with what it has (no endless 'Searching…'), and says so in the console", !!rD && sD.n === 2 && D.env.searchRef.current === null && /Schedule search failed/.test(errs.join(" ")), JSON.stringify([sD.n, errs]));
      if (!mkAll) check("AH5 the real cancelSearch / publishSearchRunning extractable with runSearch", false, "anchor / compile");
      else {
        const E1 = mkEnv(), f1 = mkAll(E1.env), s1 = fake(1e9); const p1 = f1.runSearch(s1, "generate", 60000);
        await new Promise(r => setTimeout(r, 5)); f1.cancelSearch();
        const r1 = await Promise.race([p1, new Promise(r => setTimeout(() => r("TIMEOUT"), 3000))]); // a cancel that doesn't cancel fails here, it doesn't hang the suite
        if (r1 === "TIMEOUT") E1.env.searchRef.current = null;
        const n1 = s1.n; await new Promise(r => setTimeout(r, 20));
        check("AH5 the REAL cancelSearch stops a preview-bound search: it resolves null, the ref is cleared, and the session gets no more slices", r1 === null && E1.env.searchRef.current === null && s1.n === n1 && JSON.stringify(E1.flags) === JSON.stringify(["generate", null]), JSON.stringify([r1, n1, s1.n, E1.flags]));
        const E2 = mkEnv(), f2 = mkAll(E2.env), s2 = { n: 0, step() { this.n++; const t = Date.now(); while (Date.now() - t < 1) {} }, status() { return { perfect: false }; } }; const p2 = f2.runSearch(s2, "publish", 30);
        await new Promise(r => setTimeout(r, 5)); f2.cancelSearch(); const running = f2.publishSearchRunning(); const r2 = await p2;
        check("AH5 …but never a Generate & Publish search (its result doesn't go to the preview): it keeps running to its end and publishSearchRunning() says so meanwhile", running === true && !!r2 && r2.session === s2 && E2.env.searchRef.current === null, JSON.stringify([running, !!r2]));
        // ACTIVE time: each slice works ~2 ms, the gap between slices is ~25 ms (a throttled tab) — wall-clock accounting would stop after ~2 slices
        const E3 = mkEnv(); E3.env.setTimeout = (fn) => setTimeout(fn, 25);
        const s3 = { n: 0, step() { this.n++; const t = Date.now(); while (Date.now() - t < 2) {} }, status() { return { perfect: false }; } };
        const r3 = await mkAll(E3.env).runSearch(s3, "generate", 30);
        check("AH5 the budget is ACTIVE search time: slow gaps between slices (a hidden, throttled tab) don't use it up", !!r3 && s3.n >= 10 && r3.ms >= 30, JSON.stringify([s3.n, r3 && r3.ms]));
        const S7r = ["DJA", "MCC", "RPC", "KJH", "REH", "FAK", "ARW"].map((n, k) => ({ id: "s" + (k + 1), name: n }));
        const msr = [0, 7, 14, 21, 28, 35, 42].map(o => G.addD(G.parse("2099-03-02"), o));
        const real = G.createScheduleSearch(S7r, msr, {}, new Set(), {}, {}, new Set(), null, [], null, {}, null);
        const E4 = mkEnv(), r4 = await mkAll(E4.env).runSearch(real, "generate", 2000);
        check("AH5 a REAL search session through the REAL runSearch: it ends (perfect, or the budget) with a schedule and schedules checked", !!r4 && r4.session === real && !!real.best() && real.status().checked > 0, JSON.stringify(real.status()));
      }
    }
  }
  // ── AH6 ──
  {
    const dg = nsrcAH.indexOf("  const doGenerate = async (preview) => {"), dge = nsrcAH.indexOf("\n  };\n", dg), dgb = dg < 0 ? "" : nsrcAH.slice(dg, dge);
    check("AH6 Generate goes through the search for SEARCH_MS and refuses a second search while one runs",
      dgb.indexOf('if (searchRef.current) { showToast("A schedule search is already running') > 0 && dgb.indexOf('const done = await runSearch(search, preview ? "generate" : "publish", SEARCH_MS);') > dgb.indexOf("const search = createScheduleSearch(") && dgb.indexOf("return genFinishRef.current(result, preview, clickSig, pendingLocks, genEpoch);") > 0 && dgb.indexOf("const result = done && done.session.best();") > 0);
    check("AH6 Accept, Discard and a JSON load cancel a running search first (Discard and a load also clear the last search's count, which no longer applies)",
      /const acceptPreview = async \(\) => \{\n[^]*?if \(publishSearchRunning\(\)\) \{[^\n]*return; \}\n    cancelSearch\(\);/.test(nsrcAH) && /const discardPreview = \(\) => \{\n    cancelSearch\(\); setSearchStats\(null\);/.test(nsrcAH)
        && /const loadScheduleJson = \(text, fileName\) => \{\n    if \(publishSearchRunning\(\)\) \{[^\n]*return false; \}\n    cancelSearch\(\); setSearchStats\(null\);/.test(nsrcAH)
        && count('const cancelSearch = () => { const sr = searchRef.current; if (sr && sr.purpose !== "publish") { searchRef.current = null; setSearching(null); } };') === 1);
    const sm = nsrcAH.indexOf("  const searchMore = async () => {"), sme = nsrcAH.indexOf("\n  };\n", sm), smb = sm < 0 ? "" : nsrcAH.slice(sm, sme);
    check("AH6 🔍 Search more starts FROM the preview (seed), replaces it only when strictly better, and drops a late result if the preview changed meanwhile",
      smb.indexOf("search.seed(base);") > 0 && smb.indexOf('const done = await runSearch(search, "more", SEARCH_MS);') > smb.indexOf("search.seed(base);")
        && smb.indexOf("if (!done || previewSchedRef.current !== base) return;") > 0 && smb.indexOf("if (st.improved) {") > smb.indexOf("previewSchedRef.current !== base")
        && count("previewSchedRef.current = previewSchedule;") === 1 && count('<button onClick={searchMore} disabled={!!searching || publishing}') === 1
        // the same floor and seam as Generate: vacations ∪ no-call ∪ Silvis as vac, the untouched vacations as vacationsOnly, the locks, the seed
        && count("createScheduleSearch(surgeons, ms, buildGenAvailability(), backupMondaySet, priorCounts, buildPrefs(), fierceBackupSet, holidayAssignments, pendingLocks, buildPrevWeekSeed(ms[0]), vacations, year1Counts, { silvisPrimary: buildSilvisPrimary() })") === 1
        && count("createScheduleSearch(") === 2);
    check("AH6 the buttons that start a search are disabled while one runs; the progress line polls the ref itself (setInterval in SearchProgress), not app state",
      count('<button onClick={()=>doGenerate(true)} disabled={!!searching}') === 1 && count("disabled={publishing || !!searching}") === 1 && count("<button onClick={()=>doGenerate(false)} disabled={!!searching}") === 1
        && /function SearchProgress\(\{ searchRef, dk \}\) \{\n  const \[, setTick\] = React\.useState\(0\);\n  React\.useEffect\(\(\) => \{ const t = setInterval\(\(\) => setTick\(n => n \+ 1\), 250\); return \(\) => clearInterval\(t\); \}, \[\]\);/.test(nsrcAH)
        && count("<SearchProgress searchRef={searchRef} dk={dk} />") === 3);
  }
  // ── AH7 ──
  {
    const gsrc = fs.readFileSync(path.join(ROOT, "generator.js"), "utf8");
    check("AH7 generator.js: ONE FLEX list (by code), the app's 10-second search budget, the preferences polish's size, and the brief's tier order (floor > last resort > service weeks > weekends > strain > bends > totals > soft > preferences), compared in that order",
      (gsrc.match(/const FLEX = \["FAK"\];/g) || []).length === 1 && (gsrc.match(/const SEARCH_MS = 10000;/g) || []).length === 1 && (gsrc.match(/const SEARCH_PREFS_POLISH = 3000;/g) || []).length === 1
        && gsrc.includes('const RULE_TIERS = ["floor", "lastResort", "svc", "wknd", "strain", "bend", "total", "soft", "prefs"];')
        && gsrc.includes("  for (let i = 0; i < RULE_TIERS.length; i++) { if (A[i] < B[i]) return -1; if (A[i] > B[i]) return 1; }"));
    const S7 = ["DJA", "MCC", "RPC", "KJH", "REH", "FAK", "ARW"].map((n, i) => ({ id: "s" + (i + 1), name: n }));
    const ms = [0, 7, 14, 21, 28, 35, 42].map(o => G.addD(G.parse("2099-03-02"), o));
    const r = G.generate(S7, ms, {}, new Set(), {}, {}, new Set(), null, [], null, {}, null);
    const se = G.createScheduleSearch(S7, ms, {}, new Set(), {}, {}, new Set(), null, [], null, {}, null).seed(r);
    check("AH7 a generate() result is the weeks and NOTHING else enumerable (the app spreads it into the schedule); a search seeded with it starts 'not improved'",
      JSON.stringify(Object.keys(r)) === JSON.stringify(ms.map(G.fmt)) && se.status().improved === false && !!se.best(), JSON.stringify(Object.keys(r)));
    // seed(): a perfect schedule stays as it is (nothing checked, nothing replaced); a broken one is ranked as listed, then improved
    se.run({ proposals: 20000 });
    const POLISH = vm.runInContext("SEARCH_PREFS_POLISH", sandbox);
    check("AH7 Search more from a schedule that is already perfect: only the short preferences polish (SEARCH_PREFS_POLISH schedules), then the same schedule back, 'not improved'",
      se.status().checked >= POLISH && se.status().checked <= POLISH + 1000 && se.status().improved === false && se.status().perfect === true && JSON.stringify(se.best()) === JSON.stringify(r), JSON.stringify(se.status()));
    // step() — the app's ONLY way into the search — does work every slice, and a fresh start (a whole
    // generateOnce, up to ~0.2 s on a squeezed period) only ever OPENS a slice: on the live period (never
    // perfect, its improvers are used up in well under a second) one long step() opens exactly one start
    { const LF = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "generator-live-2026-11-16.json"), "utf8"));
      const sl = G.createScheduleSearch(LF.surgeons, LF.mondays.map(G.parse), LF.avail, new Set(LF.backupMondays), LF.priorCounts, LF.prefs, new Set(LF.fierceBackupMondays), LF.holAssignments, [], LF.prevWeekSeed, LF.vacationsOnly, LF.yearCounts);
      const a0 = sl.status(); sl.step(1500); const a1 = sl.status(); sl.step(1500); const a2 = sl.status();
      check("AH7 step() does work (schedules checked, a best found) and opens exactly ONE fresh start per slice, however long the slice",
        a1.starts - a0.starts === 1 && a2.starts - a1.starts <= 1 && a1.checked > 1000 && a2.checked > a1.checked && !!sl.best(), JSON.stringify([a0, a1, a2].map(x => [x.starts, x.checked]))); }
    const broken = JSON.parse(JSON.stringify(r)); const m0 = ms.map(G.fmt)[2];
    broken[m0].nights.tue = broken[m0].nights.mon; // two nights in a row (rule 2) for that surgeon
    const ctx7 = { surgeons: S7, mondays: ms, vac: {}, vacationsOnly: {}, holAssignments: null, prevWeekSeed: null };
    const listed = G.listScheduleBends(broken, ctx7).tiers;
    const sb7 = G.createScheduleSearch(S7, ms, {}, new Set(), {}, {}, new Set(), null, [], null, {}, null).seed(broken);
    const before = sb7.status().tiers;
    sb7.run({ proposals: 20000 });
    const after = sb7.status();
    const T7 = ["floor", "lastResort", "svc", "wknd", "strain", "bend", "total"];
    check("AH7 Search more from a broken schedule: it starts from exactly what Needs your OK ranks (two nights in a row on the floor), checks schedules, and replaces it only with a strictly better one",
      T7.every(k => before[k] === listed[k]) && before.floor > 0 && after.checked > 0 && after.improved === true && after.tiers.floor < before.floor,
      JSON.stringify({ before, listed, after }));
  }
  // ── AH8: the brief's designed runs and its strain texts, on crafted schedules (generator.js listScheduleBends) ──
  {
    const S7 = ["DJA", "MCC", "RPC", "KJH", "REH", "FAK", "ARW"].map((n, i) => ({ id: "s" + (i + 1), name: n }));
    const md = (d) => (d.getMonth() + 1) + "/" + d.getDate();
    const monOf = (y, mo, dd) => { let d = G.parse(`${y}-${mo}-${dd}`); while (d.getDay() !== 1) d = G.addD(d, -1); return d; };
    const W = (dc, mon, tue, wed, thu, wknd) => ({ dayCall: dc, nights: { wknd, mon, tue, wed, thu } });
    const run8 = (weeks, mons, hol, seed) => G.listScheduleBends(weeks, { surgeons: S7, mondays: mons, vac: {}, vacationsOnly: {}, holAssignments: hol, prevWeekSeed: seed || null });
    // (a) a card's Night Before + its own 24h → designed; (b) a card fixing one partner on two other consecutive dates → still two nights in a row
    {
      const m = monOf(2099, "11", "26"), M = G.fmt(m), d = (o) => G.fmt(G.addD(m, o));
      const card = (a, b, cov) => ({ 2099: [{ name: "Thanksgiving", date: d(3), surgeonA: a, surgeonB: b, type: "major", coverage: cov }] });
      const eveRun = run8({ [M]: W("s2", "s4", "s5", "s2", "s2", "s3") }, [M], card("s2", "s3", [{ date: d(2), surgeon: "s2", isEve: true }, { date: d(3), surgeon: "s2" }, { date: d(4), surgeon: "s3" }]));
      const collapsed = run8({ [M]: W("s2", "s4", "s5", "s1", "s2", "s2") }, [M], card("s2", "s2", [{ date: d(3), surgeon: "s2" }, { date: d(4), surgeon: "s2" }]));
      check("AH8 rule 2's designed runs are exactly the brief's: a card's Night Before → its own 24h is not listed; a card that fixes a partner on two other dates in a row (Thu 24h → Fri 24h → …) IS (only FAK's Christmas is the other exemption)",
        eveRun.counts.hard === 0 && collapsed.counts.hard === 3 && collapsed.items.some(it => it.kind === "hard" && it.who === "s2"), JSON.stringify([eveRun.counts, collapsed.counts, collapsed.items.filter(i => i.kind === "hard").map(i => i.text)]));
    }
    // (c) two weekends in a row that the cards fix entirely → no strain; one of them a free choice → strain
    {
      const m = monOf(2099, "03", "04"), M0 = G.fmt(m), M1 = G.fmt(G.addD(m, 7)), d = (o) => G.fmt(G.addD(m, o));
      const sunCard = (date) => ({ name: "July 4th", date, surgeonA: "s3", surgeonB: null, type: "minor", coverage: [{ date, surgeon: "s3" }] });
      const weeks = { [M0]: W("s1", "s2", "s4", "s5", "s7", "s3"), [M1]: W("s6", "s4", "s2", "s1", "s5", "s3") };
      const both = run8(weeks, [M0, M1], { 2099: [sunCard(d(6)), sunCard(d(13))] }), one = run8(weeks, [M0, M1], { 2099: [sunCard(d(6))] });
      check("AH8 strain a: two weekends in a row that the holiday cards fix entirely are not strain (both exempt); with one of them a free choice, it is one unit",
        both.tiers.strain === 0 && one.tiers.strain === 1 && one.items.some(it => it.kind === "strain" && it.key === "wkndRun" && it.who === "s3"), JSON.stringify([both.tiers.strain, one.tiers.strain, one.items.filter(i => i.kind === "strain").map(i => i.text)]));
    }
    // (d) the brief's plain words: "3 weekends in a row, <first>–<last>" and "every other night ×3, …"
    {
      const m = monOf(2099, "03", "04"), ms4 = [0, 7, 14, 21].map(o => G.addD(m, o)), K = ms4.map(G.fmt), d = (o) => G.addD(m, o);
      const weeks = { [K[0]]: W("s1", "s2", "s3", "s5", "s7", "s4"), [K[1]]: W("s2", "s1", "s5", "s3", "s6", "s4"), [K[2]]: W("s3", "s6", "s1", "s2", "s7", "s4"), [K[3]]: W("s5", "s1", "s5", "s3", "s5", "s7") };
      const r8 = run8(weeks, ms4, null);
      const want1 = `KJH: 3 weekends in a row, ${md(d(4))}–${md(d(20))}`, want2 = `REH: every other night ×3, Tue ${md(d(22))} → Thu ${md(d(24))} → Sat ${md(d(26))}`;
      const it1 = r8.items.find(i => i.text === want1), it2 = r8.items.find(i => i.text === want2);
      check("AH8 strain in plain words (brief item 6): '" + want1 + "' (2 units) and '" + want2 + "' (1 unit)",
        !!it1 && it1.kind === "strain" && it1.units === 2 && !!it2 && it2.kind === "strain" && it2.units === 1, JSON.stringify(r8.items.filter(i => /strain/i.test(i.kind)).map(i => [i.text, i.units])));
    }
    // (d2) service week + that weekend when someone else's holiday 24h holds the Saturday: no two nights in a row, but a bend (60) — FAK: his last resort
    {
      const m = monOf(2099, "07", "01"), M = G.fmt(m), d = (o) => G.fmt(G.addD(m, o));
      const hol = { 2099: [{ name: "July 4th", date: d(5), surgeonA: "s3", surgeonB: null, type: "minor", coverage: [{ date: d(5), surgeon: "s3" }] }] };
      const part = run8({ [M]: W("s2", "s4", "s5", "s1", "s7", "s2") }, [M], hol), fak = run8({ [M]: W("s6", "s4", "s5", "s1", "s7", "s6") }, [M], hol);
      check("AH8 service week + that weekend split by someone else's Saturday holiday 24h: not two nights in a row (no Fri → Sat → Sun), but listed and priced as a bend (60) — for a partner and for FAK alike (no last resort: nothing runs in a row)",
        part.counts.hard === 0 && part.items.some(i => i.kind === "bend" && i.key === "svcWkndSplit" && i.cost === 60 && i.who === "s2")
          && fak.counts.hard === 0 && fak.counts.lastRes === 0 && fak.items.some(i => i.kind === "bend" && i.key === "svcWkndSplit" && i.who === "s6"),
        JSON.stringify([part.counts, part.items.map(i => i.kind + ":" + i.key), fak.counts, fak.items.map(i => i.kind + ":" + i.key)]));
      // FAK as surgeon A of a Friday holiday: the cards pin him the service week AND the weekend (B holds the Saturday 24h) — designed, nothing listed
      const holA = { 2099: [{ name: "July 4th", date: d(4), surgeonA: "s6", surgeonB: "s3", type: "minor", coverage: [{ date: d(4), surgeon: "s6" }, { date: d(5), surgeon: "s3" }] }] };
      const des = run8({ [M]: W("s6", "s4", "s5", "s1", "s7", "s6") }, [M], holA);
      check("AH8 FAK as surgeon A of a Friday holiday — the cards give him that week's service week and weekend: designed, so not his last resort and not a bend (nothing listed for it)",
        des.counts.lastRes === 0 && des.counts.hard === 0 && !des.items.some(i => i.key === "svcWkndSplit" || i.kind === "lastResort"), JSON.stringify([des.counts, des.items.map(i => i.kind + ":" + i.key)]));
      // a real Fri → Sat → Sun for FAK (no rows) — the last resort, and its text names the nights he holds
      const realLR = run8({ [M]: W("s6", "s4", "s5", "s1", "s7", "s6") }, [M], null);
      check("AH8 FAK on a service week + that weekend with no holiday in it: Fri → Sat → Sun, his listed LAST RESORT (with those three nights named), not two-in-a-row",
        realLR.counts.lastRes === 1 && realLR.counts.hard === 0 && realLR.items.some(i => i.kind === "lastResort" && new RegExp("Fri " + md(G.addD(m, 4)) + " → Sat " + md(G.addD(m, 5)) + " → Sun " + md(G.addD(m, 6)) + " in a row").test(i.text)),
        JSON.stringify([realLR.counts, realLR.items.filter(i => i.kind === "lastResort").map(i => i.text)]));
    }
    // FAK's Christmas service week is pinned for a Saturday / Sunday Christmas too (decision 3), like Tue–Fri
    {
      const pinDc = (y) => { const x = G.parse(`${y}-12-25`), dow = x.getDay(), des = G.fmt(G.addD(x, dow === 0 ? -6 : 1 - dow));
        const hol = { [y]: [{ name: "Christmas Day", date: `${y}-12-25`, surgeonA: "s6", surgeonB: "s6", type: "major", coverage: [{ date: G.fmt(G.addD(x, -1)), surgeon: "s6", isEve: true }, { date: `${y}-12-25`, surgeon: "s6" }] }] };
        const des2 = vm.runInContext("holidayDesign", sandbox)(hol, [des], "s6");
        return des2.pins[des] && (des2.pins[des].dayCall + "/" + des2.pins[des].wknd); };
      check("AH8 decision 3 — FAK's Christmas design week is his whole week: the cards pin him its service week AND its weekend for every Christmas weekday (2026 Fri, 2027 Sat, 2029 Tue, 2030 Wed, 2031 Thu, 2033 Sun)",
        ["2026", "2027", "2029", "2030", "2031", "2033"].every(y => pinDc(y) === "s6/s6"), JSON.stringify(["2026", "2027", "2029", "2030", "2031", "2033"].map(y => [y, pinDc(y)])));
      // …and the generator deals it (he is that week's service doctor too): 2029 (Tue) and 2027 (Sat), a few rolls each — and Needs your OK lists nothing for it
      const gen = (y) => { const x = G.parse(`${y}-12-25`), dow = x.getDay(), des = G.addD(x, dow === 0 ? -6 : dow === 1 ? -7 : 1 - dow), ms4 = [-7, 0, 7, 14].map(o => G.addD(des, o));
        const hol = { [y]: [{ name: "Christmas Day", date: `${y}-12-25`, surgeonA: "s6", surgeonB: "s6", type: "major", coverage: [{ date: G.fmt(G.addD(x, -1)), surgeon: "s6", isEve: true }, { date: `${y}-12-25`, surgeon: "s6" }] }] };
        const S7g = ["DJA", "MCC", "RPC", "KJH", "REH", "FAK", "ARW"].map((n, k) => ({ id: "s" + (k + 1), name: n }));
        const out = [];
        for (let r = 0; r < 4; r++) {
          const g = G.generate(S7g, ms4, {}, new Set(), {}, {}, new Set(), hol, [], null, {}, null, { proposals: 20000 });
          const wk = g[G.fmt(des)], lst = G.listScheduleBends(g, { surgeons: S7g, mondays: ms4, vac: {}, vacationsOnly: {}, holAssignments: hol, prevWeekSeed: null });
          out.push({ svc: wk.dayCall, wknd: wk.nights.wknd, fakItems: lst.items.filter(i => i.who === "s6" && i.kind !== "crowded").map(i => i.kind + ":" + i.key) });
        }
        return out; };
      const g29 = gen(2029), g27 = gen(2027), g28 = gen(2028);
      check("AH8 …the generator gives FAK that service week AND that weekend (2029 Tue, 2027 Sat, 2028 Mon Christmas — the week before it — every roll), and Needs your OK lists nothing for his Christmas week",
        g29.concat(g27, g28).every(o => o.svc === "s6" && o.wknd === "s6" && o.fakItems.length === 0), JSON.stringify({ g29, g27, g28 }));
    }
    // (e0) a Tuesday Christmas WITH the New Year's card (Mon 12/31, A = REH s5, B = DJA s1): the owner chose decision 3
    // (2026-10-13) — FAK's Christmas design week is whole over New Year's Monday convention, in either card order and
    // for every reader; New Year's keeps its own 24h rows (12/31 REH, 1/1 DJA). Other years are unchanged by the card.
    {
      const H = vm.runInContext("holidayDesign", sandbox);
      const xmas = (y) => { const x = G.parse(`${y}-12-25`); return { name: "Christmas Day", date: `${y}-12-25`, surgeonA: "s6", surgeonB: "s6", type: "major", coverage: [{ date: G.fmt(G.addD(x, -1)), surgeon: "s6", isEve: true }, { date: `${y}-12-25`, surgeon: "s6" }] }; };
      const ny = (y) => { const x = G.parse(`${y}-12-31`); return { name: "New Year's", date: `${y}-12-31`, surgeonA: "s5", surgeonB: "s1", type: "major", coverage: [{ date: `${y}-12-31`, surgeon: "s5" }, { date: G.fmt(G.addD(x, 1)), surgeon: "s1" }] }; };
      const desOf = (y) => { const x = G.parse(`${y}-12-25`), dow = x.getDay(); return G.fmt(G.addD(x, dow === 0 ? -6 : dow === 1 ? -7 : 1 - dow)); };
      const pinsY = (y, cards) => { const p = H({ [y]: cards }, [desOf(y)], "s6").pins[desOf(y)] || {}; return p.dayCall + "/" + p.wknd; };
      const all = ["2026", "2027", "2028", "2029", "2030", "2031", "2033", "2035"].map(y => [y, pinsY(y, [xmas(y), ny(y)]), pinsY(y, [ny(y), xmas(y)])]);
      check("AH8 decision 3 vs New Year's (a Tuesday Christmas, 2029 / 2035 — owner 2026-10-13): FAK's design week stays whole — the cards pin him its service week AND weekend over New Year's Monday convention, in EITHER card order; every other year likewise with the New Year's card present",
        all.every(r => r[1] === "s6/s6" && r[2] === "s6/s6"), JSON.stringify(all));
      const x = G.parse("2029-12-25"), des = G.addD(x, -1), ms4 = [-7, 0, 7, 14].map(o => G.addD(des, o)), K = ms4.map(G.fmt);
      const S7g = ["DJA", "MCC", "RPC", "KJH", "REH", "FAK", "ARW"].map((n, k) => ({ id: "s" + (k + 1), name: n }));
      const out = [];
      for (const order of [0, 1]) for (let r = 0; r < 3; r++) {
        const hol = { 2029: order ? [ny(2029), xmas(2029)] : [xmas(2029), ny(2029)] };
        const g = G.generate(S7g, ms4, {}, new Set(), {}, {}, new Set(), hol, [], null, {}, null, { proposals: 20000 });
        const wk = g[K[1]], nyw = g[K[2]] || {}, hc = nyw.holidayCoverage || {}, lst = G.listScheduleBends(g, { surgeons: S7g, mondays: ms4, vac: {}, vacationsOnly: {}, holAssignments: hol, prevWeekSeed: null });
        out.push({ svc: wk.dayCall, wknd: wk.nights.wknd, eve: wk.nights.mon, nyEve: hc["2029-12-31"] && hc["2029-12-31"].surgeonId, nyDay: hc["2030-01-01"] && hc["2030-01-01"].surgeonId, hard: lst.counts.hard, lastRes: lst.counts.lastRes, fakItems: lst.items.filter(i => i.who === "s6" && i.kind !== "crowded").map(i => i.kind + ":" + i.key) });
      }
      check("AH8 …and the generator deals it so (2029 + the New Year's card, both card orders, every roll): FAK service week, weekend and eve; New Year's 24h rows REH 12/31, DJA 1/1; nothing breaks a rule and nothing is listed for FAK",
        out.every(o => o.svc === "s6" && o.wknd === "s6" && o.eve === "s6" && o.nyEve === "s5" && o.nyDay === "s1" && o.hard === 0 && o.lastRes === 0 && o.fakItems.length === 0), JSON.stringify(out));
      // the rules engine agrees: FAK's whole week there is his designed Christmas — never his last resort, never two in a row
      const hol = { 2029: [ny(2029), xmas(2029)] };
      const whole = { [K[0]]: W("s1", "s2", "s3", "s4", "s7", "s2"), [K[1]]: W("s6", "s6", "s6", "s2", "s3", "s6"), [K[2]]: W("s7", "s5", "s1", "s3", "s4", "s3"), [K[3]]: W("s2", "s5", "s4", "s7", "s1", "s4") };
      const rw = run8(whole, ms4, hol);
      check("AH8 …the rules engine reads the same week the same way: FAK's whole 2029 Christmas week (eve, 24h, Fri → service Sat → Sun) with the New Year's card is his design — not two in a row, not his last resort, nothing listed for him",
        rw.counts.hard === 0 && rw.counts.lastRes === 0 && !rw.items.some(i => i.who === "s6" && i.kind !== "crowded"),
        JSON.stringify([rw.counts, rw.items.filter(i => i.who === "s6").map(i => i.text)]));
    }
    // (e1) decision 3 is FAK's (christmasDcId), not whoever holds an A = B Christmas card: ARW (s7) on both slots of a Wednesday
    // Christmas (2030) gets the eve + Christmas Day, FAK the service week, and no weekend pin, no designated Fri / Sun for ARW
    {
      const H = vm.runInContext("holidayDesign", sandbox);
      const x = G.parse("2030-12-25"), des = G.addD(x, -2), K = [-7, 0, 7].map(o => G.fmt(G.addD(des, o)));
      const hol = { 2030: [{ name: "Christmas Day", date: "2030-12-25", surgeonA: "s7", surgeonB: "s7", type: "major", coverage: [{ date: "2030-12-24", surgeon: "s7", isEve: true }, { date: "2030-12-25", surgeon: "s7" }] }] };
      const p = H(hol, [K[1]], "s6").pins[K[1]] || {};
      // ARW: eve Tue, Christmas Wed (row), then the design week's weekend Fri + Sun → Wed → Fri → Sun is every other night ×3, a free choice: strain
      const weeks = { [K[0]]: W("s1", "s2", "s3", "s4", "s5", "s2"), [K[1]]: W("s6", "s1", "s7", "s7", "s2", "s7"), [K[2]]: W("s3", "s4", "s5", "s1", "s2", "s4") };
      const r = run8(weeks, K.map(G.parse), hol);
      check("AH8 decision 3 is FAK's alone: an A = B Christmas card held by ARW pins FAK the service week and NO weekend for ARW; ARW's Wed 24h → Fri → Sun is strain (every other night ×3), not exempted as a designed Christmas week",
        p.dayCall === "s6" && !p.wknd && r.items.some(i => i.kind === "strain" && i.who === "s7"), JSON.stringify([p, r.tiers, r.items.filter(i => i.who === "s7").map(i => i.kind + ":" + i.text)]));
    }
    // (e) FAK's Christmas week in EVERY year — the card's own pattern is never "two nights in a row" nor a last resort (2026 Fri, 2027 Sat, 2028 Mon, 2029 Tue, 2031 Thu, 2033 Sun)
    {
      const res = [], adj = []; let adjN = 0;
      for (const y of [2026, 2027, 2028, 2029, 2031, 2033]) {
        const x = G.parse(`${y}-12-25`), dow = x.getDay();
        const des = G.addD(x, dow === 0 ? -6 : dow === 1 ? -7 : 1 - dow), prev = G.addD(des, -7), next = G.addD(des, 7), after = G.addD(des, 14);
        const mons = [prev, des, next, after], K = mons.map(G.fmt);
        const eve = G.fmt(G.addD(x, -1)), xs = G.fmt(x);
        const hol = { [y]: [{ name: "Christmas Day", date: xs, surgeonA: "s6", surgeonB: "s6", type: "major", coverage: [{ date: eve, surgeon: "s6", isEve: true }, { date: xs, surgeon: "s6" }] }] };
        // FAK holds the design week's service week + weekend, the eve night (a weeknight eve) and the Christmas 24h night (a Mon–Thu Christmas)
        const nightKey = (date) => ["mon", "tue", "wed", "thu"][G.parse(date).getDay() - 1];
        const weeks = {};
        weeks[K[0]] = W("s1", "s2", "s3", "s4", "s5", "s7");
        weeks[K[1]] = W("s6", "s1", "s2", "s3", "s4", "s6");
        weeks[K[2]] = W("s7", "s5", "s1", "s2", "s3", "s4");
        weeks[K[3]] = W("s2", "s3", "s4", "s5", "s7", "s1");
        [eve, xs].forEach(dt => { const k = nightKey(dt), wi = K.findIndex(m => m <= dt && dt < G.fmt(G.addD(G.parse(m), 7))); if (k && wi >= 0) weeks[K[wi]].nights[k] = "s6"; });
        const r = run8(weeks, mons, hol);
        res.push({ y, hard: r.counts.hard, lastRes: r.counts.lastRes, items: r.items.filter(i => i.kind === "hard" || i.kind === "lastResort").map(i => i.text) });
        // each Mon–Thu night of the design week (and the Monday after) that is NOT in decision 3's set but touches it: FAK there → two in a row
        const D = new Set([eve, xs, G.fmt(G.addD(des, 4)), G.fmt(G.addD(des, 5)), G.fmt(G.addD(des, 6))]);
        [0, 1, 2, 3, 7].map(o => G.fmt(G.addD(des, o))).forEach(n => {
          if (D.has(n) || !(D.has(G.fmt(G.addD(G.parse(n), -1))) || D.has(G.fmt(G.addD(G.parse(n), 1))))) return;
          const k = ["mon", "tue", "wed", "thu"][G.parse(n).getDay() - 1], wi = K.findIndex(mm => mm <= n && n < G.fmt(G.addD(G.parse(mm), 7)));
          if (!k || wi < 0) return;
          const w2 = JSON.parse(JSON.stringify(weeks)); w2[K[wi]].nights[k] = "s6";
          const r2 = run8(w2, mons, hol);
          if (r2.counts.hard < 1) adj.push(`${y}: FAK on ${n} (next to his designed Christmas nights) is not listed as two in a row`);
          adjN++;
        });
      }
      check("AH8 FAK's Christmas week is the card's design in EVERY year (Fri 2026, Sat 2027, Mon 2028, Tue 2029, Thu 2031, Sun 2033): never two nights in a row, never his last resort",
        res.every(x => x.hard === 0 && x.lastRes === 0), JSON.stringify(res));
      check(`AH8 …and exactly that set: every free night touching it (${adjN} cases across the six years — e.g. Thu before a Friday-night weekend, the Monday after the Christmas Sunday) is still two nights in a row`,
        adj.length === 0 && adjN >= 6, JSON.stringify(adj));
      // control: the same 2029 week with FAK also on the Wednesday after his Tuesday Christmas 24h — not designed
      const x = G.parse("2029-12-25"), des = G.addD(x, -1), K = [G.addD(des, -7), des, G.addD(des, 7)].map(G.fmt);
      const hol = { 2029: [{ name: "Christmas Day", date: "2029-12-25", surgeonA: "s6", surgeonB: "s6", type: "major", coverage: [{ date: "2029-12-24", surgeon: "s6", isEve: true }, { date: "2029-12-25", surgeon: "s6" }] }] };
      const weeks = { [K[0]]: W("s1", "s2", "s3", "s4", "s5", "s7"), [K[1]]: W("s6", "s6", "s6", "s6", "s4", "s6"), [K[2]]: W("s7", "s5", "s1", "s2", "s3", "s4") };
      const r = run8(weeks, K.map(G.parse), hol);
      const plainWeeks = { [K[0]]: W("s6", "s2", "s3", "s4", "s5", "s6"), [K[1]]: W("s1", "s5", "s2", "s3", "s4", "s7"), [K[2]]: W("s7", "s5", "s1", "s2", "s3", "s4") };
      const plain = run8(plainWeeks, K.map(G.parse), hol);
      check("AH8 …but not more than the design: FAK's free Wednesday after his Tuesday Christmas 24h is two nights in a row; his service week + weekend in another week is his last resort",
        r.counts.hard === 1 && plain.counts.lastRes === 1 && plain.counts.hard === 0, JSON.stringify([r.counts, plain.counts]));
    }
  }
})();

// ─── AH9. The REAL finishGenerate: Generate's end, with the LATEST state (2026-10-13) ───
await (async () => {
  const nsrcF = src.replace(/\r\n/g, "\n");
  const i = nsrcF.indexOf("  const finishGenerate = (result, preview, clickSig, clickLocks, genEpoch) => {"), e = i < 0 ? -1 : nsrcF.indexOf("\n  };\n", i);
  const ENV = "pendingLocks, nameOf, slotLabel, showToast, setPreviewSchedule, setPreviewOrigin, setShowPreview, genInputsSig, listScheduleBends, surgeons, mondays, buildGenAvailability, buildSilvisPrimary, vacations, holidayAssignments, buildPrevWeekSeed, publishingRef, setPublishing, setSaveStatus, snapshots, genCommitRef, previewEpochRef, schedEditable, schedSyncRef";
  let mk = null; try { mk = i < 0 ? null : vm.runInContext("(function (env) { const { " + ENV + " } = env; return (" + nsrcF.slice(i + "  const finishGenerate = ".length, e) + "\n  }); })", sandbox); } catch (ex) { mk = null; }
  if (!mk) { check("AH9 finishGenerate extractable for execution", false, "anchor / compile"); return; }
  const RES = { "2099-03-02": { dayCall: "s1", nights: {} } };
  const go = async (o) => {
    const rec = { toasts: [], preview: null, shown: false, captured: 0, committed: 0 }, pub = { current: false }, pe = { current: -1 };
    const fn = mk({ pendingLocks: o.locksNow || [], nameOf: (x) => x, slotLabel: () => "slot", showToast: (m) => rec.toasts.push(String(m)), setPreviewSchedule: (x) => { rec.preview = x; }, setPreviewOrigin: () => {}, setShowPreview: (x) => { rec.shown = x; },
      genInputsSig: () => o.sigNow, listScheduleBends: () => ({ items: o.items || [] }), surgeons: [], mondays: [], buildGenAvailability: () => ({}), buildSilvisPrimary: () => null, vacations: {}, holidayAssignments: {}, buildPrevWeekSeed: () => null,
      publishingRef: pub, setPublishing: () => {}, setSaveStatus: () => {}, snapshots: { capture: async () => { rec.captured++; if (o.gateAfter) o.gated = true; return { ok: !o.snapFail }; } }, genCommitRef: { current: async () => { rec.committed++; return { ok: !o.notLanded }; } },
      previewEpochRef: pe, schedEditable: () => !o.gated, schedSyncRef: { current: { knownSchedule: () => ({}), changedSince: (keys, since) => (o.moved && since === 5) ? keys.slice() : [] } } });
    rec.ret = await fn(RES, !!o.preview, "SIG0", o.locksAtClick || [], 5); rec.epoch = pe.current; // a publish resolves to its OUTCOME (A14)
    await new Promise(r => setTimeout(r, 30)); // let a publish run through its snapshot
    rec.armed = pub.current;
    return rec;
  };
  const changed = await go({ sigNow: "SIG1" });
  check("AH9 the REAL finishGenerate: when what the schedule depends on changed during the search, Generate & Publish sends the result to the preview, says why, and publishes NOTHING (no snapshot, no commit)",
    changed.ret === "review" && changed.preview === RES && changed.shown === true && /changed during the search/.test(changed.toasts.join(" ")) && changed.captured === 0 && changed.committed === 0, JSON.stringify(changed));
  const items = await go({ sigNow: "SIG0", items: [{ kind: "bend" }] });
  check("AH9 …unchanged inputs but Needs-your-OK items (judged on today's inputs) → the preview, nothing published", items.ret === "review" && items.preview === RES && items.captured === 0 && items.committed === 0, JSON.stringify(items));
  const clean = await go({ sigNow: "SIG0" });
  check("AH9 …unchanged and clean → published: the snapshot first, then the commit through genCommitRef (the state after the snapshot's await), and the publish flag released",
    clean.ret === "published" && clean.captured === 1 && clean.committed === 1 && clean.armed === false, JSON.stringify(clean));
  check("AH9 sync v2: every preview it opens is judged from the click's engine epoch", changed.epoch === 5 && items.epoch === 5, JSON.stringify([changed.epoch, items.epoch]));
  const moved = await go({ sigNow: "SIG0", moved: true }), gatedNow = await go({ sigNow: "SIG0", gated: true }), gatedLater = await go({ sigNow: "SIG0", gateAfter: true });
  check("AH9 sync v2: a week of the period adopted since the CLICK → after the snapshot NOTHING is committed, it says why, and the publish flag is released",
    moved.captured === 1 && moved.committed === 0 && /changed while generating/.test(moved.toasts.join(" ")) && moved.armed === false, JSON.stringify(moved));
  check("AH9 sync v2: the edit gate before the snapshot (\"refused\", no snapshot) and again after it (signed out during the await: nothing committed, flag released)",
    gatedNow.ret === "refused" && gatedNow.captured === 0 && gatedNow.committed === 0 && gatedLater.captured === 1 && gatedLater.committed === 0 && gatedLater.armed === false, JSON.stringify([gatedNow, gatedLater]));
  const notLanded = await go({ sigNow: "SIG0", notLanded: true }), noSnap = await go({ sigNow: "SIG0", snapFail: true });
  check("AH9 A14: Generate & Publish resolves to its OUTCOME — \"published\" only when the commit's publish job landed every week (\"not-published\" otherwise), \"no-snapshot\" / \"moved\" / \"refused\" when it stopped; so only a real publish notifies",
    notLanded.ret === "not-published" && notLanded.committed === 1 && notLanded.armed === false && noSnap.ret === "no-snapshot" && noSnap.committed === 0 && moved.ret === "moved" && gatedLater.ret === "refused",
    JSON.stringify([notLanded.ret, noSnap.ret, moved.ret, gatedLater.ret]));
  const lk = [{ mondayStr: "2099-03-02", slot: "dc", surgeonId: "s1" }];
  const prev = await go({ preview: true, sigNow: "SIGx", locksAtClick: lk, locksNow: lk.concat([{ mondayStr: "2099-03-02", slot: "mon", surgeonId: "s2" }]) });
  check("AH9 …a Preview: it opens; a lock ADDED during the search is not blamed on time off ('NOT honored') — the scheduler is told the preview used the earlier locks",
    prev.ret === "preview" && prev.preview === RES && !/NOT honored/.test(prev.toasts.join(" ")) && /locks changed during the search/.test(prev.toasts.join(" ")), JSON.stringify(prev.toasts));
  check("AH9 the finish and commit refs are set on EVERY render, at the component's top level (not once, not conditionally)",
    /\n  \};\n  genFinishRef\.current = finishGenerate; genCommitRef\.current = commitGenerated;\n/.test(nsrcF) && (nsrcF.match(/genFinishRef\.current = /g) || []).length === 1);
})();

// ─── AI. NEVER RE-APPLY (owner rule, 2026-10-12/13) ───
// A previewed schedule — generated, or loaded from a JSON file such as the
// CP-SAT benchmark that is now the published period — reaches the schedule
// ONLY through ✓ Accept & Publish. Nothing may keep it around to re-apply
// later: it is never in the state bundle (the blob, the snapshots, the
// unload flush, the export all build from it), never an autosave trigger,
// never in browser storage, never restored from anywhere; and no app file
// names the test fixture. Each guard below is TWO-SIDED: it passes on the
// real source and FAILS on a copy with that violation planted (a guard that
// can't fail proves nothing).
//   AI1 buildStateBundle — the REAL function, executed: no preview key, and
//       the preview object appears in no value
//   AI2 the autosave effect: previewSchedule / previewOrigin are not in its
//       deps and not read in its body
//   AI3 browser storage: no localStorage / sessionStorage / IndexedDB write in
//       any app file mentions the preview; the preview is only ever set from
//       the search's result, the loader's checked weeks, or null — and the
//       loader runs only from the file input
//   AI4 no app file (index-source.html, helpers.js, config.js, generator.js,
//       silvis-feed.js, app-styles.js) references the benchmark fixture — by
//       name, or by any fetch / import / script source into test/
{
  const APP_FILES = ["index-source.html", "helpers.js", "config.js", "generator.js", "silvis-feed.js", "app-styles.js"];
  const files = Object.fromEntries(APP_FILES.map(f => [f, fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n")]));
  const PREVIEW = /\bpreview(Schedule|Origin|SchedRef)\b/;
  const plant = (text, anchor, insert, label) => {
    const n = text.split(anchor).length - 1;
    if (n !== 1) throw new Error(`AI plant anchor x${n} (${label}): ${anchor.slice(0, 80)}`);
    return text.replace(anchor, () => insert);
  };
  const twoSided = (name, guard, real, planted) => {
    const r = guard(real), p = guard(planted);
    check(`${name} — holds on the real source`, r.ok, r.why || "");
    check(`${name} — and FAILS on a copy with the violation planted (the guard bites — it ran, and caught it)`, !p.ok && !p.broken, (p.broken ? "the guard could not run on the planted copy: " : "the planted copy passed: ") + (p.why || ""));
  };
  const src0 = files["index-source.html"];
  // ── AI1 ──
  {
    const guard = (text) => {
      const START = "  const buildStateBundle = (overrides = {}) => ({";
      const i = text.indexOf(START), e = i < 0 ? -1 : text.indexOf("\n  });\n", i);
      if (i < 0 || e < 0) return { ok: false, broken: true, why: "buildStateBundle not found" };
      const body = text.slice(i + START.length, e);
      const names = [...new Set((body.match(/\b[A-Za-z_$][\w$]*\b/g) || []))].filter(w => !["overrides", "true", "false", "null"].includes(w));
      const PREV = { "2026-11-16": { dayCall: "s4", nights: {} } }, ORIGIN = "json";
      const env = {};
      names.forEach(n => { env[n] = n === "previewSchedule" ? PREV : n === "previewOrigin" ? ORIGIN : n === "previewSchedRef" ? { current: PREV } : /Set$/.test(n) ? new Set() : { tag: n }; });
      let out;
      try { out = vm.runInContext(`(function (env) { const { ${names.join(", ")} } = env; return (overrides = {}) => ({${body}\n  }); })`, sandbox)(env)(); }
      catch (ex) { return { ok: false, broken: true, why: "not executable: " + ex.message }; }
      const keys = Object.keys(out).filter(k => /preview/i.test(k));
      const holds = Object.values(out).some(v => v === PREV || v === ORIGIN || (v && typeof v === "object" && JSON.stringify(v) === JSON.stringify(PREV)));
      // an ALLOWLIST: the bundle holds exactly these keys — any new one (an alias of the preview, the search's session…) must be reviewed here first
      const BUNDLE_KEYS = ["apps", "backupMondays", "dismissedWarnings", "fierceBackup", "holidayAssignments", "noCallDays", "numWeeks", "pendingLocks", "priorCounts", "schedule", "silvisRule", "startMondayOverride", "startMonth", "startYear", "surgeons", "vacations", "year1Counts"];
      const exact = JSON.stringify(Object.keys(out).sort()) === JSON.stringify(BUNDLE_KEYS);
      return { ok: keys.length === 0 && !holds && !PREVIEW.test(body) && exact, why: JSON.stringify({ keys, holds, extra: Object.keys(out).filter(k => !BUNDLE_KEYS.includes(k)) }) };
    };
    twoSided("AI1 the REAL buildStateBundle (blob, snapshots, unload flush, export) never carries the preview",
      guard, src0, plant(src0, "    startMonth, startYear, numWeeks, holidayAssignments, startMondayOverride,\n    pendingLocks,\n    silvisRule,\n", "    startMonth, startYear, numWeeks, holidayAssignments, startMondayOverride,\n    pendingLocks,\n    previewSchedule, previewOrigin,\n    silvisRule,\n", "AI1"));
    twoSided("AI1 …nor the preview under another name (previewSchedRef, the ref that mirrors it every render)",
      guard, src0, plant(src0, "    startMonth, startYear, numWeeks, holidayAssignments, startMondayOverride,\n    pendingLocks,\n    silvisRule,\n", "    startMonth, startYear, numWeeks, holidayAssignments, startMondayOverride,\n    pendingLocks,\n    draft: previewSchedRef.current,\n    silvisRule,\n", "AI1b"));
    twoSided("AI1 …nor anything else new, under any name (the bundle's keys are an allowlist — e.g. the search's best schedule)",
      guard, src0, plant(src0, "    startMonth, startYear, numWeeks, holidayAssignments, startMondayOverride,\n    pendingLocks,\n    silvisRule,\n", "    startMonth, startYear, numWeeks, holidayAssignments, startMondayOverride,\n    pendingLocks,\n    lastSearch: searchRef.current && searchRef.current.session.best(),\n    silvisRule,\n", "AI1c"));
  }
  // ── AI2 ──
  {
    const guard = (text) => {
      const START = "  // ─── Supabase: Auto-save on changes ───\n  useEffect(() => {";
      const i = text.indexOf(START), e = i < 0 ? -1 : text.indexOf("\n  }, [", i);
      if (i < 0 || e < 0) return { ok: false, broken: true, why: "autosave effect not found" };
      const deps = text.slice(e, text.indexOf("]);", e) + 3), body = text.slice(i, e);
      return { ok: !PREVIEW.test(deps) && !PREVIEW.test(body), why: deps };
    };
    twoSided("AI2 the autosave effect neither depends on nor reads previewSchedule / previewOrigin",
      guard, src0, plant(src0, "startMondayOverride, pendingLocks, dismissedWarnings]);", "startMondayOverride, pendingLocks, dismissedWarnings, previewSchedule]);", "AI2"));
  }
  // ── AI3 ──
  {
    // every argument list of a storage write (balanced parens), per file
    const writes = (text) => {
      const out = [], re = /\b(localStorage\.setItem|sessionStorage\.setItem|\.put|\.add)\s*\(/g;
      let m;
      while ((m = re.exec(text))) {
        if (m[1] !== "localStorage.setItem" && m[1] !== "sessionStorage.setItem" && !/indexedDB|objectStore|\bstore\b|\bidb\b/i.test(text.slice(Math.max(0, m.index - 200), m.index))) continue;
        let d = 1, j = m.index + m[0].length;
        while (j < text.length && d > 0) { if (text[j] === "(") d++; else if (text[j] === ")") d--; j++; }
        out.push(text.slice(m.index, j));
      }
      return out;
    };
    // …and ANY storage write inside the paths that hold the preview or the search's result under another name
    const PREVIEW_PATHS = ["  const runSearch = (session, purpose, budgetMs) => new Promise(resolve => {", "  const doGenerate = async (preview) => {", "  const finishGenerate = (result, preview, clickSig, clickLocks, genEpoch) => {", "  const commitGenerated = async (result) => {", "  const searchMore = async () => {", "  const acceptPreview = async () => {", "  const discardPreview = () => {", "  const loadScheduleJson = (text, fileName) => {", "  const onLoadJsonFile = (e) => {"];
    const pathBodies = (text) => PREVIEW_PATHS.map(a => { const i = text.indexOf(a); if (i < 0) return ""; const e = text.indexOf("\n  };\n", i); return text.slice(i, e < 0 ? i : e); });
    const guardStore = (fs_) => {
      const bad = [];
      for (const f in fs_) writes(fs_[f]).forEach(w => { if (/preview|\b(result|better|shaped|base)\b/i.test(w)) bad.push(f + ": " + w.slice(0, 120)); });
      pathBodies(fs_["index-source.html"]).forEach(b => writes(b).forEach(w => bad.push("in a preview path: " + w.slice(0, 120))));
      if (pathBodies(fs_["index-source.html"]).some(b => !b)) bad.push("a preview path was not found");
      // an ALLOWLIST of the keys the app may write (anything else — a helper that stashes "a value", a new key — must be reviewed here first)
      const STORE_KEYS = ["AUTH_TOKEN_KEY", "AUTH_REFRESH_KEY", "BIOMETRIC_CRED_KEY", "BIOMETRIC_USER_KEY", '"dsg_collapse_" + ck', '"dsg-notif-seen"', '"dsg-notif-cleared"', "CAL_SILVIS_STORE_KEY", '"dsg-dark-mode"', '"dsg-my-surgeon"', '"dsg_app_version"'];
      for (const f in fs_) writes(fs_[f]).filter(w => /Storage\.setItem/.test(w)).forEach(w => { const k = w.slice(w.indexOf("(") + 1).split(",")[0].trim(); if (!STORE_KEYS.includes(k)) bad.push(`${f}: a storage key not on the allowlist — ${k}`); });
      const n = Object.values(fs_).reduce((t, x) => t + writes(x).length, 0);
      return { ok: bad.length === 0 && n > 0, why: bad.join(" | ") || `${n} storage writes scanned` };
    };
    twoSided("AI3 no localStorage / sessionStorage / IndexedDB write in any app file mentions the preview",
      guardStore, files, Object.assign({}, files, { "index-source.html": plant(src0, "  const discardPreview = () => {\n", "  const discardPreview = () => {\n    try { localStorage.setItem(\"dsg-last-preview\", JSON.stringify(previewSchedule)); } catch (e) {}\n", "AI3a") }));
    twoSided("AI3 …nor one that keeps the search's result under its own name (result / better / shaped) in a preview path",
      guardStore, files, Object.assign({}, files, { "index-source.html": plant(src0, "  const finishGenerate = (result, preview, clickSig, clickLocks, genEpoch) => {\n", "  const finishGenerate = (result, preview, clickSig, clickLocks, genEpoch) => {\n    try { localStorage.setItem(\"dsg-gen\", JSON.stringify(result)); } catch (e) {}\n", "AI3d") }));
    twoSided("AI3 …nor a helper that stores something under its own key (the storage keys are an allowlist)",
      guardStore, files, Object.assign({}, files, { "index-source.html": plant(src0, "  const discardPreview = () => {\n", "  const stash = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };\n  const discardPreview = () => {\n", "AI3e") }));
    twoSided("AI3 …nor one inside the search runner",
      guardStore, files, Object.assign({}, files, { "index-source.html": plant(src0, "      sr.activeMs += Date.now() - t0;\n", "      sr.activeMs += Date.now() - t0;\n      try { sessionStorage.setItem(\"dsg-run\", \"x\"); } catch (e) {}\n", "AI3f") }));
    const guardSet = (text) => {
      const args = [];
      const re = /\bsetPreviewSchedule\(/g; let m;
      while ((m = re.exec(text))) { let d = 1, j = m.index + m[0].length; while (j < text.length && d > 0) { if (text[j] === "(") d++; else if (text[j] === ")") d--; j++; } args.push(text.slice(m.index + m[0].length, j - 1).trim()); }
      const ALLOWED = ["result", "better", "shaped", "null"];
      const odd = args.filter(a => !ALLOWED.includes(a));
      const calls = (text.match(/\bloadScheduleJson\(/g) || []).length, fromInput = /r\.onload = \(\) => loadScheduleJson\(String\(r\.result \|\| ""\), f\.name\);/.test(text);
      return { ok: args.length > 0 && odd.length === 0 && calls === 1 && fromInput, why: JSON.stringify({ odd, calls, fromInput }) };
    };
    twoSided("AI3 the preview is only ever set from the search's result, the loader's checked weeks, or null — and the loader runs only from the file input (nothing restores a preview)",
      guardSet, src0, plant(src0, "  const discardPreview = () => {\n", "  const restorePreview = () => { try { setPreviewSchedule(JSON.parse(localStorage.getItem(\"dsg-last-preview\"))); } catch (e) {} };\n  const discardPreview = () => {\n", "AI3b"));
    twoSided("AI3 …and the loader can't be called from anywhere but the file input",
      guardSet, src0, plant(src0, "  const discardPreview = () => {\n", "  const reloadBenchmark = (t) => loadScheduleJson(t, \"again.json\");\n  const discardPreview = () => {\n", "AI3c"));
  }
  // ── AI4 ──
  {
    const guard = (fs_) => {
      // the benchmark by name anywhere (code or comment), and any fetch / import /
      // script source into test/ (a doc comment naming another fixture is fine)
      const bad = Object.keys(fs_).filter(f => /benchmark-2026-11-16-v3/.test(fs_[f]) || /(fetch|import|require)\s*\(\s*["'`][^"'`]*\btest\/|src=["'][^"']*\btest\//.test(fs_[f]));
      const sizes = Object.values(fs_).every(x => x.length > 100);
      return { ok: bad.length === 0 && sizes && Object.keys(fs_).length === APP_FILES.length, why: bad.join(", ") || "clean" };
    };
    twoSided("AI4 no app file references the benchmark fixture (test/fixtures/benchmark-2026-11-16-v3.json) — by name, or by a fetch / import into test/",
      guard, files, Object.assign({}, files, { "generator.js": files["generator.js"] + "\n// see benchmark-2026-11-16-v3.json\n" }));
    twoSided("AI4 …and a fetch into test/fixtures under any other name is caught too",
      guard, files, Object.assign({}, files, { "helpers.js": files["helpers.js"] + "\nconst _b = () => fetch(\"test/fixtures/period.json\");\n" }));
  }
}

// ─── AJ. Owner decisions 2026-10-13: Silvis next to a Davenport night, the spacing box, holiday pairs ───
console.log("\nAJ. owner decisions 2026-10-13");
{
  const G = vm.runInContext("({ fmt, addD, parse, listScheduleBends, createScheduleSearch, planHolidayPairs, overnightHolderOn, getHolidays, generate })", sandbox);
  const S7 = ["DJA", "MCC", "RPC", "KJH", "REH", "FAK", "ARW"].map((n, i) => ({ id: "s" + (i + 1), name: n }));
  const W = (dc, mon, tue, wed, thu, wknd) => ({ dayCall: dc, nights: { wknd, mon, tue, wed, thu } });
  // ── AJ1: FAK's Davenport overnight next to his Silvis primary 24h — his LAST RESORT (rule 2 across the two jobs) ──
  {
    const K = ["2099-03-09", "2099-03-16"], ms = K.map(G.parse);
    const ctx = (sil, extra) => Object.assign({ surgeons: S7, mondays: ms, vac: {}, vacationsOnly: {}, holAssignments: null, prevWeekSeed: null }, sil ? { silvisPrimary: { id: "s6", dates: sil } } : {}, extra || {});
    // FAK the Thu night 3/12; Silvis primary Fri 3/13
    const thu = { [K[0]]: W("s1", "s2", "s3", "s4", "s6", "s5"), [K[1]]: W("s2", "s3", "s4", "s5", "s7", "s1") };
    const a = G.listScheduleBends(thu, ctx(["2099-03-13"])), b = G.listScheduleBends(thu, ctx(null));
    const it = a.items.find(i => i.kind === "lastResort" && i.key === "silvisAdj");
    check("AJ1 FAK's Davenport Thu night 3/12 before his Silvis primary Fri 3/13: his LAST RESORT (one unit, listed in plain words with the date and the slot); without the Silvis days it is nothing",
      a.counts.lastRes === 1 && a.counts.silvisAdj === 1 && !!it && it.who === "s6" && it.date === "2099-03-12" && /Davenport Thu 3\/12 \(Thu night 3\/12\) → Silvis 24h Fri 3\/13 — two overnights in a row across the two jobs, the last resort/.test(it.text)
        && b.counts.lastRes === 0 && !b.items.some(i => i.key === "silvisAdj"), JSON.stringify([a.counts, it && it.text, b.counts]));
    // FAK the weekend 3/13 + 3/15 around a Silvis Saturday 3/14: two units (Fri → Sat, Sat → Sun); the daytime service week after a Silvis Sunday: nothing
    const wk = { [K[0]]: W("s1", "s2", "s3", "s4", "s7", "s6"), [K[1]]: W("s2", "s3", "s4", "s5", "s7", "s1") };
    const c2 = G.listScheduleBends(wk, ctx(["2099-03-14"]));
    const svc = { [K[0]]: W("s1", "s2", "s3", "s4", "s7", "s5"), [K[1]]: W("s6", "s3", "s4", "s5", "s7", "s1") };
    const c3 = G.listScheduleBends(svc, ctx(["2099-03-15"]));
    check("AJ1 …the weekend around a Silvis Saturday is two units (Fri → Sat, Sat → Sun); FAK's service week starting the Monday a Silvis Sunday ends (07:00) is not (its overnight is Saturday) — only overnights count",
      c2.counts.silvisAdj === 2 && c2.counts.lastRes === 2 && c3.counts.silvisAdj === 0 && c3.counts.lastRes === 0, JSON.stringify([c2.counts, c3.counts]));
    // the seam: a Silvis primary on the Sunday before the period → FAK's Mon night of week 0; and on the Monday after → FAK's last Sunday
    const seam = { [K[0]]: W("s1", "s6", "s3", "s4", "s7", "s5"), [K[1]]: W("s2", "s3", "s4", "s5", "s7", "s6") };
    const c4 = G.listScheduleBends(seam, ctx(["2099-03-08", "2099-03-23"]));
    check("AJ1 …across the seam both ways: a Silvis Sunday before the period next to FAK's Mon night of week 0, a Silvis Monday after it next to FAK's last Sunday",
      c4.counts.silvisAdj === 2 && c4.items.filter(i => i.key === "silvisAdj").map(i => i.date).join(",") === "2099-03-09,2099-03-22", JSON.stringify(c4.items.filter(i => i.key === "silvisAdj").map(i => i.text)));
    // the search reads it (opts.silvisPrimary → its rules): a seeded schedule's tiers say so
    const sr = (o) => { const S = G.createScheduleSearch(S7, ms, {}, new Set(), {}, {}, new Set(), null, [], null, {}, null, o); S.seed(thu); return S.status().tiers; };
    check("AJ1 …and the search ranks by it: createScheduleSearch's opts.silvisPrimary reaches its rules (a seeded schedule's last-resort tier is 1 with it, 0 without)",
      sr({ silvisPrimary: { id: "s6", dates: ["2099-03-13"] } }).lastResort === 1 && sr({}).lastResort === 0, JSON.stringify([sr({ silvisPrimary: { id: "s6", dates: ["2099-03-13"] } }), sr({})]));
    // FAK's own holiday 24h next to a Silvis day is not a free choice: the item names the card's row, no slot, no "also free"
    const hol25 = { 2099: [{ name: "July 4th", date: "2099-03-11", surgeonA: "s6", surgeonB: "s3", type: "minor", coverage: [{ date: "2099-03-11", surgeon: "s6" }] }] };
    const r25 = G.listScheduleBends({ [K[0]]: W("s1", "s2", "s3", "s4", "s5", "s7"), [K[1]]: W("s2", "s3", "s4", "s5", "s7", "s1") }, ctx(["2099-03-12"], { holAssignments: hol25 }));
    const i25 = r25.items.find(i => i.key === "silvisAdj");
    check("AJ1 …on FAK's own holiday 24h row (fixed by the card) the item says so — no slot, no 'also free' list (nothing to choose)",
      !!i25 && i25.slots.length === 0 && /holiday 24h Wed 3\/11, the card's/.test(i25.text) && !/also free/.test(i25.text), JSON.stringify(i25));
    // overnightHolderOn (Warnings): weekHolders' rule, executed
    const pub = { "2099-03-09": { dayCall: "s1", nights: { mon: "s2", tue: "s3", wed: "s4", thu: "s5", wknd: "s7" }, holidayCoverage: { "2099-03-11": { surgeonId: "s6" } }, dayCallOverrides: { "2099-03-14": "s4" } } };
    const hs = ["09", "10", "11", "12", "13", "14", "15"].map(d => G.overnightHolderOn(pub, "2099-03-" + d)), none = G.overnightHolderOn(pub, "2099-03-16");
    check("AJ1 overnightHolderOn reads a published week by weekHolders' rule: Mon–Thu nights, a holiday 24h row on its date, Fri / Sun the weekend, Sat the service week's single-day override; nothing for an unpublished week",
      hs.join(",") === "s2,s3,s6,s5,s7,s4,s7" && none === null, JSON.stringify([hs, none]));
    // the app wires it everywhere a schedule is read, and Warnings says it for published weeks
    check("AJ1 the app hands FAK's Silvis primaries to BOTH searches, the G&P gate and the preview's Needs your OK (one builder), and Warnings lists a published Davenport overnight next to one",
      count("const buildSilvisPrimary = () => (silvisActive && silvisFakId) ? { id: silvisFakId, dates: [...(silvisDays.primary || [])] } : null;") === 1
        && count(", { silvisPrimary: buildSilvisPrimary() });") === 2 && count("silvisPrimary: buildSilvisPrimary() }).items.length;") === 1 && count("silvisPrimary: buildSilvisPrimary(), // FAK's Davenport night next to his Silvis 24h") === 1
        && count("if (overnightHolderOn(schedule, N) !== silvisFakId) return;") === 1 && count("return health.concat(hard, sunday, adj);") === 1);
  }
  // ── AJ1b: decision 3 only where FAK can work it — else New Year's Monday convention stands, for every reader ──
  {
    const H = vm.runInContext("holidayDesign", sandbox), SOK = vm.runInContext("christmasSlotOk", sandbox);
    const xmas = { name: "Christmas Day", date: "2029-12-25", surgeonA: "s6", surgeonB: "s6", type: "major", coverage: [{ date: "2029-12-24", surgeon: "s6", isEve: true }, { date: "2029-12-25", surgeon: "s6" }] };
    const ny = (a, b) => ({ name: "New Year's", date: "2029-12-31", surgeonA: a, surgeonB: b, type: "major", coverage: [{ date: "2029-12-31", surgeon: a }, { date: "2030-01-01", surgeon: b }] });
    const D = "2029-12-24", pinsOf = (hol, vac, sil) => { const p = H({ 2029: hol }, [D], "s6", SOK(vac || {}, vac || {}, sil || null)).pins[D] || {}; return p.dayCall + "/" + p.wknd; };
    const free = pinsOf([xmas, ny("s5", "s1")]), offWed = pinsOf([xmas, ny("s5", "s1")], { s6: [["2029-12-26", "2029-12-26"]] }), offSun = pinsOf([xmas, ny("s5", "s1")], { s6: [["2029-12-30", "2029-12-30"]] }), offMon = pinsOf([xmas, ny("s5", "s1")], { s6: [["2029-12-31", "2029-12-31"]] });
    const silMon = pinsOf([xmas, ny("s5", "s1")], {}, { id: "s6", dates: ["2029-12-31"] }), nyFak = pinsOf([xmas, ny("s6", "s1")]);
    check("AJ1b decision 3 slot by slot (2029 + New Year's REH / DJA): free → FAK / FAK; FAK off Wed 12/26 → REH's service week (the convention), his weekend stays; off Sun 12/30 (his service week's Sunday too) → REH / DJA; off Mon 12/31 (the weekend's Monday) → his service week, DJA's weekend; a Silvis Mon 12/31 → not his weekend; FAK as New Year's surgeon A (his 24h Mon 12/31) → not his weekend either",
      free === "s6/s6" && offWed === "s5/s6" && offSun === "s5/s1" && offMon === "s6/s1" && silMon === "s6/s1" && nyFak === "s6/s1", JSON.stringify({ free, offWed, offSun, offMon, silMon, nyFak }));
    // the generator and the rules engine agree: FAK off Wed 12/26 → REH service week, nothing listed for REH's convention week
    const S7g = ["DJA", "MCC", "RPC", "KJH", "REH", "FAK", "ARW"].map((n, k) => ({ id: "s" + (k + 1), name: n }));
    const ms4 = [-7, 0, 7, 14].map(o => G.addD(G.parse(D), o)), vac = { s6: [["2029-12-26", "2029-12-26"]] }, hol = { 2029: [xmas, ny("s5", "s1")] };
    const out = [];
    for (let r = 0; r < 3; r++) {
      const g = G.generate(S7g, ms4, vac, new Set(), {}, {}, new Set(), hol, [], null, vac, null, { proposals: 20000 });
      const lst = G.listScheduleBends(g, { surgeons: S7g, mondays: ms4, vac, vacationsOnly: vac, holAssignments: hol, prevWeekSeed: null });
      out.push({ svc: g[D].dayCall, wknd: g[D].nights.wknd, hard: lst.counts.hard, reh: lst.items.filter(i => i.who === "s5" && i.kind === "bend").map(i => i.key) });
    }
    check("AJ1b …and the generator deals the fallback the rules engine reads as designed: FAK off Wed 12/26 → REH's service week every roll, FAK's weekend, no bend listed for REH's convention week, nothing in a row",
      out.every(o => o.svc === "s5" && o.wknd === "s6" && o.hard === 0 && o.reh.length === 0), JSON.stringify(out));
  }
  // ── AJ1c: FAK's design-week pins he cannot work are dropped whatever rule set them; designation follows the pins ──
  {
    const H = vm.runInContext("holidayDesign", sandbox), SOK = vm.runInContext("christmasSlotOk", sandbox);
    const card = (y, dow) => { const x = `${y}-12-25`, ev = G.fmt(G.addD(G.parse(x), -1)); return { name: "Christmas Day", date: x, surgeonA: "s6", surgeonB: "s6", type: "major", coverage: [{ date: ev, surgeon: "s6", isEve: true }, { date: x, surgeon: "s6" }] }; };
    const p26 = (sil) => H({ 2026: [card(2026)] }, ["2026-12-21"], "s6", SOK({}, {}, sil ? { id: "s6", dates: sil } : null)).pins["2026-12-21"] || {};
    const p28 = (sil) => H({ 2028: [card(2028)] }, ["2028-12-18"], "s6", SOK({}, {}, sil ? { id: "s6", dates: sil } : null)).pins["2028-12-18"] || {};
    const a = p26(null), b = p26(["2026-12-28"]), c = p28(["2028-12-23"]);
    check("AJ1c a Friday Christmas (2026): his own 24h's weekend pin is dropped when a Silvis Mon 12/28 sits next to its Sunday (the service Saturday stays his); a Monday Christmas (2028) keeps the weekend holding his Christmas Eve even next to a Silvis Saturday",
      a.wknd === "s6" && a.dayCall === "s6" && !b.wknd && b.dayCall === "s6" && c.wknd === "s6", JSON.stringify({ a, b, c }));
    // the search follows: 2026 with Silvis Mon 12/28 — the weekend goes to a partner, nothing is his last resort
    const S7g = ["DJA", "MCC", "RPC", "KJH", "REH", "FAK", "ARW"].map((n, k) => ({ id: "s" + (k + 1), name: n }));
    const ms4 = ["2026-12-14", "2026-12-21", "2026-12-28", "2027-01-04"].map(G.parse), hol = { 2026: [card(2026)] }, vac = { s6: [["2026-12-28", "2026-12-28"]] }, sil = { id: "s6", dates: ["2026-12-28"] };
    const out = [];
    for (let r = 0; r < 3; r++) {
      const g = G.generate(S7g, ms4, vac, new Set(), {}, {}, new Set(), hol, [], null, {}, null, { proposals: 20000, silvisPrimary: sil });
      const l = G.listScheduleBends(g, { surgeons: S7g, mondays: ms4, vac, vacationsOnly: {}, holAssignments: hol, prevWeekSeed: null, silvisPrimary: sil });
      out.push({ wknd: g["2026-12-21"].nights.wknd, svc: g["2026-12-21"].dayCall, lastRes: l.counts.lastRes, hard: l.counts.hard });
    }
    check("AJ1c …and the generator follows it (2026, Silvis Mon 12/28): FAK keeps the service week, a partner takes the weekend, no last resort and nothing in a row — every roll",
      out.every(o => o.svc === "s6" && o.wknd !== "s6" && o.lastRes === 0 && o.hard === 0), JSON.stringify(out));
    // a slot the cards fix next to a Silvis day: the item says so (no slot, no "also free") — 2030 Christmas Eve Tue 12/24 (the card's eve pin) by a Silvis Mon 12/23
    const K30 = ["2030-12-16", "2030-12-23", "2030-12-30"], ms30 = K30.map(G.parse), hol30 = { 2030: [card(2030)] };
    const w30 = { [K30[0]]: W("s1", "s2", "s3", "s4", "s5", "s7"), [K30[1]]: W("s6", "s2", "s6", "s6", "s3", "s6"), [K30[2]]: W("s2", "s3", "s4", "s5", "s7", "s1") };
    const l30 = G.listScheduleBends(w30, { surgeons: S7, mondays: ms30, vac: {}, vacationsOnly: {}, holAssignments: hol30, prevWeekSeed: null, silvisPrimary: { id: "s6", dates: ["2030-12-23"] } });
    const i30 = l30.items.find(i => i.key === "silvisAdj" && i.date === "2030-12-24");
    check("AJ1c …a slot the cards fix (the 2030 Christmas Eve, Tue 12/24) next to a Silvis Mon 12/23: listed as his last resort with 'fixed by the holiday cards' — no slot, no 'also free'",
      !!i30 && i30.slots.length === 0 && /Tue night 12\/24, fixed by the holiday cards/.test(i30.text) && !/also free/.test(i30.text), JSON.stringify(i30));
    // designation follows the pins: 2029 + New Year's, FAK off Wed 12/26 (the service week is REH's by the convention) — FAK on that service week + weekend anyway is his LAST RESORT, not his design
    const xm = card(2029), nyc = { name: "New Year's", date: "2029-12-31", surgeonA: "s5", surgeonB: "s1", type: "major", coverage: [{ date: "2029-12-31", surgeon: "s5" }, { date: "2030-01-01", surgeon: "s1" }] };
    const K29 = ["2029-12-17", "2029-12-24", "2029-12-31", "2030-01-07"], v29 = { s6: [["2029-12-26", "2029-12-26"]] };
    const w29 = { [K29[0]]: W("s1", "s2", "s3", "s4", "s7", "s2"), [K29[1]]: W("s6", "s6", "s6", "s2", "s3", "s6"), [K29[2]]: W("s7", "s5", "s1", "s3", "s4", "s3"), [K29[3]]: W("s2", "s5", "s4", "s7", "s1", "s4") };
    const l29 = G.listScheduleBends(w29, { surgeons: S7, mondays: K29.map(G.parse), vac: v29, vacationsOnly: v29, holAssignments: { 2029: [xm, nyc] }, prevWeekSeed: null });
    check("AJ1c …designation follows the pins: 2029, FAK off Wed 12/26 (the convention gives REH the service week) — FAK on that service week + weekend anyway is his LAST RESORT, not his Christmas design",
      l29.counts.lastRes === 1 && l29.items.some(i => i.kind === "lastResort" && i.key === "svcWknd" && i.mondayStr === K29[1]), JSON.stringify(l29.counts));
    check("AJ1c the app's Warnings judge 'designed' with the generator's own slot test",
      count("holidayDesign(holidayAssignments, mondayStrs, fakW, christmasSlotOk(buildGenAvailability(), vacations, buildSilvisPrimary()))") === 1);
  }
  // ── AJ2: the spacing box no longer repeats what Needs your OK lists ──
  {
    const K = ["2099-03-02", "2099-03-09", "2099-03-16"], ms = K.map(G.parse);
    const sch = { [K[0]]: W("s2", "s1", "s3", "s4", "s5", "s7"), [K[1]]: W("s1", "s3", "s4", "s5", "s7", "s6"), [K[2]]: W("s2", "s4", "s5", "s7", "s3", "s1") };
    const it = G.listScheduleBends(sch, { surgeons: S7, mondays: ms, vac: {}, vacationsOnly: {}, holAssignments: null, prevWeekSeed: null }).items.find(i => i.key === "svcGap");
    check("AJ2 a svcGap strain item carries BOTH its weeks (prevMondayStr + mondayStr), so the spacing box can tell it is listed",
      !!it && it.who === "s2" && it.prevMondayStr === K[0] && it.mondayStr === K[2], JSON.stringify(it));
    // across the seam (the case the box was built for): MCC's service week 2 weeks before the period (recentDc) and its week 1
    const seamS = { [K[0]]: W("s1", "s3", "s4", "s5", "s7", "s6"), [K[1]]: W("s2", "s1", "s3", "s4", "s5", "s7"), [K[2]]: W("s3", "s4", "s5", "s7", "s1", "s2") };
    const seamIt = G.listScheduleBends(seamS, { surgeons: S7, mondays: ms, vac: {}, vacationsOnly: {}, holAssignments: null, prevWeekSeed: { dayCall: "s4", wknd: "s1", nights: {}, recentDc: { s2: -1 } } }).items.find(i => i.key === "svcGap" && i.who === "s2");
    check("AJ2 …across the seam too: MCC's service week the week before the period (recentDc) and the period's week 1 → the item's prevMondayStr is that Monday, exactly the Monday the box walks back to",
      !!seamIt && seamIt.prevMondayStr === G.fmt(G.addD(ms[0], -7)) && seamIt.mondayStr === K[1], JSON.stringify(seamIt));
    check("AJ2 the spacing box skips every pair Needs your OK lists as svcGap strain (keeping only the card-forced ones), and says so",
      count('const listedGap = new Set((previewNeedsOk.items || []).filter(it => it.key === "svcGap").map(it => it.who + "|" + it.prevMondayStr + "|" + it.mondayStr));') === 1
        && count('w - last[id].w <= MIN_DC_GAP && !listedGap.has(id + "|" + last[id].mStr + "|" + mStr)') === 1 && count("so Needs your OK doesn't count them as strain") === 1);
  }
  // ── AJ3: holiday pairs — one minor + at most one major each, FAK's Christmas Eve + Day, the rest rotating ──
  {
    const live = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "holiday-assignments-2026-live.json"), "utf8"));
    const PART = ["s1", "s2", "s3", "s4", "s5", "s7"];
    const holsOf = (y) => { const H = G.getHolidays(y); return [...H.major.map(h => Object.assign({}, h, { type: "major" })), ...H.minor.map(h => Object.assign({}, h, { type: "minor" }))].filter(h => h.name !== "Christmas Day"); };
    const run = (from, to, extra) => {
      const hist = JSON.parse(JSON.stringify(live.holidayAssignments || live)), bad = [];
      for (let y = from; y <= to; y++) {
        const plan = G.planHolidayPairs(Object.assign({ year: y, holidays: holsOf(y), partners: PART, history: hist }, extra ? extra(y) : {}));
        const arr = holsOf(y).map(h => ({ name: h.name, type: h.type, date: h.date, surgeonA: plan.picks[h.name].surgeonA, surgeonB: plan.picks[h.name].surgeonB }));
        arr.push({ name: "Christmas Day", type: "major", date: y + "-12-25", surgeonA: "s6", surgeonB: "s6" });
        const prev = hist[String(y - 1)] || [];
        PART.forEach(id => {
          const mine = arr.filter(h => h.name !== "Christmas Day" && (h.surgeonA === id || h.surgeonB === id));
          if (mine.filter(h => h.type === "minor").length !== 1) bad.push(`${y} ${id}: ${mine.filter(h => h.type === "minor").length} minors`);
          if (mine.filter(h => h.type === "major").length > 1) bad.push(`${y} ${id}: two majors`);
          mine.forEach(h => { if (prev.some(p => p.name === h.name && (p.surgeonA === id || p.surgeonB === id))) bad.push(`${y} ${id}: ${h.name} again`); });
          if (!mine.some(h => h.type === "major") && !prev.some(p => p.type === "major" && (p.surgeonA === id || p.surgeonB === id))) bad.push(`${y} ${id}: no major two years running`);
          if (arr.some(h => h.surgeonA === h.surgeonB && h.name !== "Christmas Day")) bad.push(`${y}: a collapsed pair`);
        });
        if (arr.some(h => h.name !== "Christmas Day" && (h.surgeonA === "s6" || h.surgeonB === "s6"))) bad.push(`${y}: FAK on a holiday other than Christmas`);
        hist[String(y)] = arr;
      }
      return { hist, bad };
    };
    const r = run(2027, 2044);
    const tally = {}; PART.forEach(id => { tally[id] = {}; });
    for (let y = 2027; y <= 2044; y++) r.hist[String(y)].forEach(h => [h.surgeonA, h.surgeonB].filter((v, i, a) => a.indexOf(v) === i).forEach(id => { if (tally[id]) tally[id][h.name] = (tally[id][h.name] || 0) + 1; }));
    const spread = PART.every(id => ["New Year's", "Thanksgiving", "Memorial Day", "July 4th", "Labor Day"].every(n => (tally[id][n] || 0) >= 5 && (tally[id][n] || 0) <= 7));
    const cycle = PART.every(id => { for (let y = 2027; y + 2 <= 2044; y++) { const n = [y, y + 1, y + 2].filter(z => r.hist[String(z)].some(h => h.type === "major" && h.name !== "Christmas Day" && (h.surgeonA === id || h.surgeonB === id))).length; if (n !== 2) return false; } return true; });
    check("AJ3 holiday pairs 2027–2044 from the live 2026 cards: every year each partner has exactly ONE minor and at most ONE major, FAK only Christmas, no partner on the same holiday as last year, nobody without a major two years running",
      r.bad.length === 0, r.bad.slice(0, 6).join("; "));
    check("AJ3 …and it rotates: over 18 years each partner has each of the five holidays 5–7 times, and exactly 2 majors in every 3 consecutive years",
      spread && cycle, JSON.stringify(tally));
    // time off: DJA off on July 4th 2027 → never there; presets count (Memorial Day 2027 fixed to DJA/MCC → neither is planned onto another minor)
    const off = G.planHolidayPairs({ year: 2027, holidays: holsOf(2027), partners: PART, history: live.holidayAssignments || live, unavailable: (id, h) => id === "s1" && h.name === "July 4th" });
    const fixedM = { name: "Memorial Day", type: "minor", surgeonA: "s1", surgeonB: "s2" };
    const pre = G.planHolidayPairs({ year: 2027, holidays: holsOf(2027).filter(h => h.name !== "Memorial Day"), partners: PART, history: live.holidayAssignments || live, fixed: [fixedM] });
    const preMinor = ["July 4th", "Labor Day"].flatMap(n => [pre.picks[n].surgeonA, pre.picks[n].surgeonB]);
    check("AJ3 …time off on a role's dates keeps a partner off that holiday; a preset card counts toward one-per-group (its two partners are not planned onto another minor)",
      ![off.picks["July 4th"].surgeonA, off.picks["July 4th"].surgeonB].includes("s1") && !preMinor.includes("s1") && !preMinor.includes("s2") && new Set(preMinor).size === 4,
      JSON.stringify([off.picks["July 4th"], pre.picks]));
    // too few / too many partners: said in plain words, never silently
    const five = G.planHolidayPairs({ year: 2027, holidays: holsOf(2027), partners: PART.slice(0, 5), history: live.holidayAssignments || live, nameOf: (id) => id });
    const seven = G.planHolidayPairs({ year: 2027, holidays: holsOf(2027), partners: PART.concat(["s8"]), history: live.holidayAssignments || live });
    const sevenMinor = ["Memorial Day", "July 4th", "Labor Day"].flatMap(n => [seven.picks[n].surgeonA, seven.picks[n].surgeonB]);
    const sevenMajor = ["New Year's", "Thanksgiving"].flatMap(n => [seven.picks[n].surgeonA, seven.picks[n].surgeonB]);
    check("AJ3 …five partners for six minor slots: someone takes two and the notes SAY so; a seventh partner (a new hire): still at most one each, and the new hire — no holiday last year — gets a major first",
      five.notes.some(n => /has two minor holidays in 2027/.test(n)) && new Set(sevenMinor).size === 6 && new Set(sevenMajor).size === 4 && sevenMajor.includes("s8"),
      JSON.stringify([five.notes, seven.picks]));
    // sitting out twice running beats the counts: KJH (s4) and ARW (s7) held New Year's / Thanksgiving every year
    // 2016–2025 and sat out 2026 — the holiday counts alone would leave them out again; the rule puts both in 2027
    const heavy = {};
    for (let y = 2016; y <= 2025; y++) heavy[String(y)] = [{ name: y % 2 ? "Thanksgiving" : "New Year's", type: "major", date: y + "-12-31", surgeonA: "s4", surgeonB: "s7" }];
    heavy["2026"] = [{ name: "New Year's", type: "major", date: "2026-12-31", surgeonA: "s1", surgeonB: "s2" }, { name: "Thanksgiving", type: "major", date: "2026-11-26", surgeonA: "s3", surgeonB: "s5" }];
    const hv = G.planHolidayPairs({ year: 2027, holidays: holsOf(2027), partners: PART, history: heavy });
    const hvMajor = ["New Year's", "Thanksgiving"].flatMap(n => [hv.picks[n].surgeonA, hv.picks[n].surgeonB]);
    check("AJ3 …nobody sits out a major two years running even when the holiday counts favour others (KJH and ARW held the majors for ten years, then sat out 2026: both get one in 2027)",
      hvMajor.includes("s4") && hvMajor.includes("s7"), JSON.stringify(hv.picks));
    const L26 = live.holidayAssignments || live;
    // rule order: time off ranks above "not the same holiday as last year" — DJA off July 4th + Labor Day → Memorial Day again (said)
    const ord = G.planHolidayPairs({ year: 2027, holidays: holsOf(2027), partners: PART, history: L26, unavailable: (id, h) => id === "s1" && (h.name === "July 4th" || h.name === "Labor Day"), nameOf: (id) => id });
    check("AJ3 rule order: time off outranks 'not last year's holiday' — DJA off July 4th and Labor Day gets Memorial Day again (2026 too), and the notes say so; never a holiday he is off for",
      [ord.picks["Memorial Day"].surgeonA, ord.picks["Memorial Day"].surgeonB].includes("s1") && !["July 4th", "Labor Day"].some(n => [ord.picks[n].surgeonA, ord.picks[n].surgeonB].includes("s1"))
        && ord.notes.some(n => /s1 has Memorial Day again \(2026 too\)/.test(n)), JSON.stringify(ord));
    // the rate tier: with the sit-outs (KJH, ARW) placed, the other two majors go to the LOWER lifetime rates
    const rates = { s1: 0.9, s2: 0.8, s3: 0.1, s5: 0.2, s4: 0.5, s7: 0.5 };
    const rt = G.planHolidayPairs({ year: 2027, holidays: holsOf(2027), partners: PART, history: L26, rate: (id) => rates[id] });
    const rtMajor = ["New Year's", "Thanksgiving"].flatMap(n => [rt.picks[n].surgeonA, rt.picks[n].surgeonB]);
    check("AJ3 the rate tier decides who else gets a major: RPC and REH (rates 0.1, 0.2) over DJA and MCC (0.9, 0.8), beside the sit-outs KJH and ARW",
      ["s3", "s5", "s4", "s7"].every(id => rtMajor.includes(id)), JSON.stringify(rt.picks));
    // a preset pair is never paired again on another card that year (10 random tie-breaks: KJH + ARW fixed on Memorial Day, both need a major)
    let apart = 0;
    for (let t = 0; t < 10; t++) { const pp = G.planHolidayPairs({ year: 2027, holidays: holsOf(2027).filter(h => h.name !== "Memorial Day"), partners: PART, history: L26, fixed: [{ name: "Memorial Day", type: "minor", surgeonA: "s4", surgeonB: "s7" }] });
      if (!["New Year's", "Thanksgiving"].some(n => { const p = pp.picks[n]; return [p.surgeonA, p.surgeonB].includes("s4") && [p.surgeonA, p.surgeonB].includes("s7"); })) apart++; }
    check("AJ3 no two partners on two cards the same year: KJH + ARW, fixed together on Memorial Day and both owed a major, are never put on one major card (10 of 10 tie-breaks)", apart === 10, `${apart}/10`);
    // …where nothing else tells them apart (no history, four partners, every one gets a major): only that rule keeps the pair off one card
    let apart2 = 0;
    const nyThx = holsOf(2030).filter(h => h.type === "major");
    for (let t = 0; t < 20; t++) { const pp = G.planHolidayPairs({ year: 2030, holidays: nyThx, partners: ["s1", "s2", "s3", "s4"], history: {}, fixed: [{ name: "Memorial Day", type: "minor", surgeonA: "s1", surgeonB: "s2" }] });
      if (!nyThx.some(h => { const p = pp.picks[h.name]; return [p.surgeonA, p.surgeonB].includes("s1") && [p.surgeonA, p.surgeonB].includes("s2"); })) apart2++; }
    check("AJ3 …even with nothing else to go on (no history, four partners for four major slots): DJA + MCC, paired on Memorial Day, never share a major card (20 of 20)", apart2 === 20, `${apart2}/20`);
    // the notes give the real reason
    const offK = G.planHolidayPairs({ year: 2027, holidays: holsOf(2027), partners: PART, history: L26, unavailable: (id, h) => id === "s4" && h.type === "minor", nameOf: (id) => id });
    check("AJ3 the notes give the real reason: KJH off for every minor → 'KJH has no minor holiday in 2027 — off on every minor holiday date' and the partner with two says KJH is off, not 'not enough partners'",
      offK.notes.some(n => /^s4 has no minor holiday in 2027 — off on every minor holiday date/.test(n)) && offK.notes.some(n => /has two minor holidays in 2027 — s4 off on every minor holiday/.test(n)) && !offK.notes.some(n => /not enough partners/.test(n)),
      JSON.stringify(offK.notes));
    // a year already stored after this one: the notes say what the new picks break against it
    const h27 = run(2027, 2028).hist; const re27 = G.planHolidayPairs({ year: 2027, holidays: holsOf(2027), partners: PART, history: Object.assign({}, h27, { "2027": undefined }), nameOf: (id) => id });
    const clash = PART.some(id => Object.keys(re27.picks).some(n => [re27.picks[n].surgeonA, re27.picks[n].surgeonB].includes(id) && h27["2028"].some(h => h.name === n && (h.surgeonA === id || h.surgeonB === id))));
    let clashes = 0;
    for (let t = 0; t < 30; t++) { const rp = G.planHolidayPairs({ year: 2027, holidays: holsOf(2027), partners: PART, history: Object.assign({}, h27, { "2027": undefined }) });
      if (PART.some(id => Object.keys(rp.picks).some(n => [rp.picks[n].surgeonA, rp.picks[n].surgeonB].includes(id) && h27["2028"].some(h => h.name === n && (h.surgeonA === id || h.surgeonB === id))))) clashes++; }
    check("AJ3 re-generating a year with the NEXT year stored ranks against it: the same holiday as someone's stored 2028 is avoided (0 of 30 re-plans clash — the year it replaced fit)", clashes === 0, `${clashes}/30`);
    check("AJ3 re-generating a year with the NEXT year stored: every clash with it is in the notes ('re-generate 2028 too'), none when there is none",
      clash ? re27.notes.some(n => /\(already stored\) — re-generate 2028 too/.test(n)) : !re27.notes.some(n => /already stored/.test(n)), JSON.stringify({ clash, notes: re27.notes }));
    // the holiday card's checks, executed (helpers.js holidayRotationCheck)
    const RC = vm.runInContext("holidayRotationCheck", sandbox);
    const prior = [{ name: "New Year's", type: "major", surgeonA: "s1", surgeonB: "s2" }, { name: "Thanksgiving", type: "major", surgeonA: "s3", surgeonB: "s5" }, { name: "July 4th", type: "minor", surgeonA: "s4", surgeonB: "s7" }];
    const cards = [{ name: "New Year's", type: "major", surgeonA: "s1", surgeonB: "s3" }, { name: "Thanksgiving", type: "major", surgeonA: "s2", surgeonB: "s5" }, { name: "Christmas Day", type: "major", surgeonA: "s6", surgeonB: "s6" },
      { name: "Memorial Day", type: "minor", surgeonA: "s1", surgeonB: "s2" }, { name: "July 4th", type: "minor", surgeonA: "s4", surgeonB: "s6" }, { name: "Labor Day", type: "minor", surgeonA: "s3", surgeonB: "s5" }];
    const rc = RC({ assignments: cards, prior, surgeons: S7, fakId: "s6", year: 2027 }), rcP = RC({ assignments: cards, prior, surgeons: S7, fakId: "s6", year: 2027, preset: true });
    const want = ["ARW has no minor holiday", "FAK is on July 4th (his holidays are Christmas Eve + Day)", "KJH has no major in 2026 or 2027", "ARW has no major in 2026 or 2027", "DJA has New Year's again (2026 too)", "REH has Thanksgiving again (2026 too)", "KJH has July 4th again (2026 too)"];
    check("AJ3 the holiday card's checks (holidayRotationCheck, executed): FAK's Christmas A = B is ONE holiday (no duplicate); it names a partner with no minor, FAK on another holiday, no major two years running, a holiday again from last year — and nothing in a hand-written preset year",
      rc.major.ok && rc.major.uniqueCount === 5 && JSON.stringify(rc.major.none.slice().sort()) === JSON.stringify(["s4", "s7"]) && want.every(w => rc.issues.includes(w)) && rc.issues.length === want.length
        && rcP.preset === true && rcP.issues.length === 0, JSON.stringify(rc.issues));
    // the app, executed: the REAL generateHolidayAssignments (with a spy on the planner) — FAK only on Christmas, the
    // role's dates as the floor sees them (vacation ∪ no-call, the next morning, B's eve unless FAK's Christmas week), worked holidays kept
    {
      const nsrcG = src.replace(/\r\n/g, "\n");
      const START = "  const generateHolidayAssignments = useCallback((year) => {", i0 = nsrcG.indexOf(START), e0 = i0 < 0 ? -1 : nsrcG.indexOf("\n  }, [surgeons, vacations, noCallDays, holidayAssignments, silvisActive, silvisFakId, silvisDays]);", i0);
      const ENVK = "surgeons, vacations, noCallDays, holidayAssignments, silvisActive, silvisFakId, silvisDays, setHolidayLockWarning, setHolidayAssignments, logAudit, planHolidayPairs, sfConflictDay, buildGenAvailability, buildSilvisPrimary, Date";
      let mkG = null; try { mkG = i0 < 0 || e0 < 0 ? null : vm.runInContext("(function (env) { const { " + ENVK + " } = env; return (year) => {" + nsrcG.slice(i0 + START.length, e0) + "\n  }; })", sandbox, { filename: "ah-holgen.js" }); } catch (ex) { mkG = null; }
      if (!mkG) check("AJ3 generateHolidayAssignments extractable for execution", false, "anchor / compile");
      else {
        const realPlan = vm.runInContext("planHolidayPairs", sandbox);
        const go = (year, o) => { const rec = { warn: "", saved: null, plan: null };
          const fn = mkG({ surgeons: S7, vacations: o.vac || {}, noCallDays: o.noCall || {}, holidayAssignments: o.hist || L26, silvisActive: false, silvisFakId: "s6", silvisDays: { primary: new Set() },
            setHolidayLockWarning: (v) => { rec.warn = typeof v === "function" ? v(rec.warn) : v; }, setHolidayAssignments: (u) => { rec.saved = u({})[String(year)]; }, logAudit: () => {},
            planHolidayPairs: (p) => { rec.plan = p; return realPlan(p); }, sfConflictDay: () => null,
            buildGenAvailability: () => { const m = {}; [o.vac || {}, o.noCall || {}].forEach(src => Object.keys(src).forEach(k => { m[k] = (m[k] || []).concat(src[k]); })); return m; }, buildSilvisPrimary: () => null,
            Date: o.today ? class extends Date { constructor(...a) { if (a.length) super(...a); else super(o.today + "T12:00:00"); } } : Date });
          fn(year); return rec; };
        const g27 = go(2027, {});
        const fakCards = (g27.saved || []).filter(h => h.surgeonA === "s6" || h.surgeonB === "s6").map(h => h.name);
        const u = g27.plan && g27.plan.unavailable, mem = { name: "Memorial Day", date: "2027-05-31", type: "minor" };
        const nyH = (y) => ({ name: "New Year's", date: `${y}-12-31`, endDate: `${y + 1}-01-01`, type: "major" });
        const vacOn = (ds) => go(2027, { vac: { s1: [[ds, ds]] } }).plan.unavailable, ncOn = (ds) => go(2027, { noCall: { s1: [[ds, ds]] } }).plan.unavailable;
        const uSun = vacOn("2027-05-30"), uTue = vacOn("2027-06-01"), uNc = ncOn("2027-05-31"), u29 = go(2029, { vac: { s1: [["2029-12-30", "2029-12-30"]] } }).plan.unavailable, u26 = go(2026, { hist: {}, vac: { s1: [["2026-12-30", "2026-12-30"]] } }).plan;
        check("AJ3 the app, executed: FAK only on Christmas (A = B) though he is on the roster; the planner gets the roster minus FAK and the lifetime rate",
          JSON.stringify(fakCards) === JSON.stringify(["Christmas Day"]) && !!g27.plan && !g27.plan.partners.includes("s6") && g27.plan.partners.length === 6 && typeof g27.plan.rate === "function",
          JSON.stringify({ fakCards, partners: g27.plan && g27.plan.partners }));
        check("AJ3 …time off by the role's dates as the floor sees it: Memorial Day (Mon) — a vacation on the Sun eve keeps DJA off B, not A; one starting Tue (the morning after A's 24h) keeps him off A; a no-call on the Monday keeps him off A; with nothing, both open",
          uSun("s1", mem, "B") === true && uSun("s1", mem, "A") === false && uTue("s1", mem, "A") === true && uTue("s1", mem, "B") === false && uNc("s1", mem, "A") === true && u("s1", mem, "A") === false && u("s1", mem, "B") === false,
          JSON.stringify([uSun("s1", mem, "B"), uSun("s1", mem, "A"), uTue("s1", mem, "A"), uTue("s1", mem, "B"), uNc("s1", mem, "A")]));
        check("AJ3 …and B's eve only when it is his: the 2029 New Year's eve (Sun 12/30) is FAK's Christmas-week night — a B vacation that day does not count; the 2026 eve (Wed 12/30) does",
          u29("s1", nyH(2029), "B") === false && (u26 ? u26.unavailable("s1", nyH(2026), "B") === true : false), JSON.stringify([u29("s1", nyH(2029), "B"), u26 && u26.unavailable("s1", nyH(2026), "B")]));
        // a hand-written preset (a partly preset year): kept as written AND counted — its two partners are not planned onto another minor
        vm.runInContext('HOLIDAY_PRESETS["2027"] = { "Memorial Day": ["s4", "s7"] };', sandbox);
        let gp = null; try { gp = go(2027, {}); } finally { vm.runInContext('delete HOLIDAY_PRESETS["2027"];', sandbox); }
        const pm = gp && gp.saved && gp.saved.find(h => h.name === "Memorial Day"), otherMinor = gp && gp.saved ? gp.saved.filter(h => h.type === "minor" && h.name !== "Memorial Day").flatMap(h => [h.surgeonA, h.surgeonB]) : [];
        check("AJ3 …a partly preset year: the preset card is kept as written and handed to the planner as fixed — KJH + ARW (Memorial Day) are on no other minor",
          !!pm && pm.surgeonA === "s4" && pm.surgeonB === "s7" && gp.plan.fixed.some(h => h.name === "Memorial Day") && !otherMinor.includes("s4") && !otherMinor.includes("s7") && otherMinor.length === 4,
          JSON.stringify(gp && gp.saved && gp.saved.map(h => [h.name, h.surgeonA, h.surgeonB])));
        // a partly past year (the clock at 8/1/2027): Memorial Day (KJH / ARW) and July 4th (DJA / MCC) were worked — kept, and
        // counted, so Labor Day goes to the two partners with no minor yet (RPC, REH)
        const part27 = [{ name: "Memorial Day", date: "2027-05-31", type: "minor", emoji: "x", surgeonA: "s4", surgeonB: "s7", coverage: [] }, { name: "July 4th", date: "2027-07-04", type: "minor", emoji: "x", surgeonA: "s1", surgeonB: "s2", coverage: [] }];
        const gpp = go(2027, { hist: Object.assign({}, L26, { "2027": part27 }), today: "2027-08-01" });
        const lab = gpp.saved && gpp.saved.find(h => h.name === "Labor Day"), keptOk = part27.every(k => gpp.saved && gpp.saved.some(x => x.name === k.name && x.surgeonA === k.surgeonA && x.surgeonB === k.surgeonB));
        check("AJ3 …a partly past year (clock 8/1/2027): the worked Memorial Day and July 4th are kept as stored and count — Labor Day goes to RPC + REH, the two with no minor yet",
          keptOk && !!lab && [lab.surgeonA, lab.surgeonB].sort().join() === "s3,s5" && gpp.plan.fixed.length >= 2, JSON.stringify(gpp.saved && gpp.saved.map(h => [h.name, h.surgeonA, h.surgeonB])));
        // worked holidays are kept: re-generating 2025 (all past) re-plans nothing and keeps every card as stored
        const st25 = holsOf(2025).map((h, k) => ({ name: h.name, date: h.date, type: h.type, emoji: "x", surgeonA: PART[k % 6], surgeonB: PART[(k + 1) % 6], coverage: [] }));
        st25.push({ name: "Christmas Day", date: "2025-12-25", type: "major", emoji: "x", surgeonA: "s6", surgeonB: "s6", coverage: [] });
        const g25 = go(2025, { hist: { "2025": st25 } });
        check("AJ3 …a holiday already worked (dated before today) is kept as stored on a re-generate — re-generating 2025 re-plans nothing",
          !!g25.saved && g25.saved.length === 6 && st25.every(h => g25.saved.some(x => x.name === h.name && x.surgeonA === h.surgeonA && x.surgeonB === h.surgeonB)) && g25.plan.holidays.length === 0,
          JSON.stringify(g25.saved && g25.saved.map(h => [h.name, h.surgeonA, h.surgeonB])));
        check("AJ3 swapping FAK onto a holiday other than Christmas asks ONCE (his own question, not the one-per-group one too); the card, the holiday-vac Warnings and the planner resolve a weekend eve with holidayEveHolder",
          count("'s holidays are Christmas Eve + Christmas Day (his major and his minor). Put him on") === 1 && count("if (usedInGroup.has(newSurgeonId) && newSurgeonId !== fakSwap) {") === 1
            && count("holidayEveHolder(hol, c.date, holidayAssignments, fakIdUI, takesChristWknd)") === 1 && count("holidayEveHolder(h, c.date, holidayAssignments, fakV, takesChristWknd)") === 1
            && count("if (holidayEveHolder({ ...hol, surgeonB: id }, eve, { [year]: xc ? [xc] : [] }, fakId, takes) === id) days.push(eve);") === 1 && count("christmasWeek") === 0);
        // the REAL vacOverlapWarnings memo: the 2029 New Year's eve (Sun 12/30) is checked against whoever works it — FAK when
        // the cards give him his Christmas weekend (DJA's vacation then is no conflict), DJA (surgeon B) when they don't
        const VS = "  const vacOverlapWarnings = useMemo(() => {", vs0 = nsrcG.indexOf(VS), ve0 = vs0 < 0 ? -1 : nsrcG.indexOf("\n  }, [", vs0);
        let runV = null; try { runV = vs0 < 0 ? null : vm.runInContext("(function (env) { const { mondays, surgeons, apps, vacations, holidayAssignments, sMap, takesChristWknd } = env; return (() => {" + nsrcG.slice(vs0 + VS.length, ve0) + "})(); })", sandbox, { filename: "aj-vac.js" }); } catch (ex) { runV = null; }
        if (!runV) check("AJ3 vacOverlapWarnings extractable for execution", false, "anchor / compile");
        else {
          const hv = { 2029: [{ name: "Christmas Day", date: "2029-12-25", type: "major", surgeonA: "s6", surgeonB: "s6", coverage: [{ date: "2029-12-24", surgeon: "s6", isEve: true }, { date: "2029-12-25", surgeon: "s6" }] },
            { name: "New Year's", date: "2029-12-31", type: "major", surgeonA: "s5", surgeonB: "s1", coverage: [{ date: "2029-12-30", surgeon: "s1", isEve: true }, { date: "2029-12-31", surgeon: "s5" }, { date: "2030-01-01", surgeon: "s1" }] }] };
          const sMapV = Object.fromEntries(S7.map(x => [x.id, x]));
          const hvKeys = (vacs, takes) => (runV({ mondays: [G.parse("2029-12-24")], surgeons: S7, apps: [], vacations: vacs, holidayAssignments: hv, sMap: sMapV, takesChristWknd: () => takes }) || []).filter(w => w.key.startsWith("holiday-vac|")).map(w => w.key);
          const djaOffT = hvKeys({ s1: [["2029-12-30", "2029-12-30"]] }, true), djaOffF = hvKeys({ s1: [["2029-12-30", "2029-12-30"]] }, false), fakOffT = hvKeys({ s6: [["2029-12-30", "2029-12-30"]] }, true);
          check("AJ3 the holiday-vac Warnings (executed) check a weekend eve of FAK's Christmas week against who works it: DJA off Sun 12/30 is no conflict when FAK takes that weekend, a conflict when he doesn't; FAK off that day is one when he does",
            djaOffT.length === 0 && djaOffF.includes("holiday-vac|2029-12-31|2029-12-30|s1") && fakOffT.includes("holiday-vac|2029-12-31|2029-12-30|s6"), JSON.stringify({ djaOffT, djaOffF, fakOffT }));
        }
      }
    }
  }
}

// ─── AK. The calendar's Today button (owner 2026-10-14) ───
console.log("\nAK. calendar Today button");
check("AK1 the calendar has a Today button beside the month arrows: it sets the month AND the year from a fresh Date (not a stale render), then scrolls today's cell into view",
  count('aria-label="Go to today"') === 1 && count("const n = new Date(); setCalMonth(n.getMonth()); setCalYear(n.getFullYear());") === 1
    && count('document.querySelector("[data-cal-today=\\"1\\"]")') === 1 && count('data-cal-today={isToday ? "1" : undefined}') === 1
    && src.indexOf('aria-label="Go to today"') > src.indexOf('aria-label="Next month"'));

// ══════════════════════════════════════════════════════════════
// SE. Sync engine v2 — test/sync-engine-se.js (the real createSchedSync on an
// emulated schedule_weeks table, plus its mutant battery), and the emulated
// table's own contract tests, so a drift in the fake can't hide a bug.
// ══════════════════════════════════════════════════════════════
await require("./sync-engine-se.js")({ src, check });

// SE-W. The engine's wiring in the component. The behaviour is executed in SE
// (the engine) and E2 (the push effect); these pins keep the integration the
// design depends on from drifting quietly.
{
  const nsrcW = src.replace(/\r\n/g, "\n");
  const bodyOf = (decl, endMark) => { const i = nsrcW.indexOf(decl); if (i < 0) return ""; const e = nsrcW.indexOf(endMark, i); return e < 0 ? "" : nsrcW.slice(i, e); };
  check("SE-W the schedule mirror has ONE writer: setSchedule( appears only inside commitSchedule, and scheduleRef.current is assigned only there (no passive-effect writer)",
    count("setSchedule(") === 1 && count("scheduleRef.current =") === 1 && count("const commitSchedule = useCallback((next) => { scheduleRef.current = next; setSchedule(next); }, []);") === 1,
    `setSchedule( ×${count("setSchedule(")}, scheduleRef.current = ×${count("scheduleRef.current =")}`);
  check("SE-W one engine per session (created once, in a ref), with reads that fall back to anon and writes that never do",
    count("createSchedSync({") === 1 && count("if (!schedSyncRef.current) schedSyncRef.current = createSchedSync({") === 1
      && count("writeHeaders: () => dbAuthHeaders(),") === 1 && count("readHeaders: () => dbReadHeaders(),") === 1);
  // The edit gate sits at the START of every user-initiated schedule action,
  // before its first side effect (status PATCH, undo step, schedule write).
  const gateBefore = (decl, endMark, firstEffect) => { const b = bodyOf(decl, endMark); const g = b.indexOf("schedEditable()"), f = b.indexOf(firstEffect); return g !== -1 && f !== -1 && g < f; };
  check("SE-W the edit gate (load + sign-in) runs before the first side effect in: undo, trade accept, one-way swap, two-way swap, week editor, accept-preview, generate",
    gateBefore("  const undoLastChange = () => {", "\n  };\n", "commitSchedule(")
      && gateBefore("  const acceptTradeRequest = useCallback(", "\n  }, [", "Fail-closed status write")
      && gateBefore("  const swapShift = (mStr, shift, newId, expectOldId) => {", "\n  };\n", "pushUndo();")
      && gateBefore("  const executeTwoWaySwap = useCallback(", "\n  }, [", "pushUndo();")
      && gateBefore("  const saveWeekEdits = useCallback(", "\n  }, [", "pushUndo();")
      && gateBefore("  const acceptPreview = async () => {", "\n  };\n", "snapshots.capture(")
      && gateBefore("  const doGenerate = async (preview) => {", "\n  };\n", "buildPrefs()")
      && gateBefore("  const finishGenerate = (result, preview, clickSig, clickLocks, genEpoch) => {", "\n  };\n", "publishingRef.current = true;"));
  {
    const fb = bodyOf("  const finishGenerate = (result, preview, clickSig, clickLocks, genEpoch) => {", "\n  };\n");
    const snapOk = fb.indexOf("if (!snap.ok) {"), gate = fb.indexOf('if (!schedEditable()) { setSaveStatus(""); return "refused"; }'), stale = fb.indexOf("changedSince(Object.keys(result), genEpoch)"), commit = fb.indexOf("await genCommitRef.current(result);");
    check("SE-W Generate & Publish re-checks AFTER the snapshot's await and before the commit: the edit gate, then the click's engine epoch",
      snapOk > 0 && gate > snapOk && stale > gate && commit > stale, JSON.stringify({ snapOk, gate, stale, commit }));
  }
  check("SE-W stale intents carry preconditions: trade accept + both swaps check the slot holder; preview / publish / editor check the engine epoch",
    count("This trade is out of date") === 1 && count("This swap is out of date") === 2
      && count("changedSince(Object.keys(previewSchedule), previewEpochRef.current)") === 1 && count("changedSince(Object.keys(weeks), previewEpochRef.current)") === 1 && count("changedSince(Object.keys(result), genEpoch)") === 1
      && count("changedSince([mondayStr], editWeekModal.openEpoch || 0)") === 1 && count("swapShift(swapTarget.mondayStr, swapTarget.shift, s.candidateId, swapTarget.surgeonId)") === 1
      && count("previewEpochRef.current = genEpoch;") === 3 && count("previewEpochRef.current = schedSyncRef.current.epochNow();") === 1 && count("return genFinishRef.current(result, preview, clickSig, pendingLocks, genEpoch);") === 1);
  check("SE-W unload: the weeks keepalive comes ONLY from the engine (CAS, no insert, no delete) and only on pagehide/beforeunload; hide pushes through the chain",
    count("keepaliveRequests()") === 1 && count('if (source === "visibilitychange") { schedSyncRef.current.push(); return; }') === 1 && count("on_conflict=week_monday") === 0);
  check("SE-W reload / sign-out guards: every reload button (update banner, Settings → Refresh, the stale-removal Reload — A14) asks while weeks are unsaved; sign-out asks, then resets the engine (mirror too), undo and editor BEFORE signing out",
    count("confirmReloadWithPending(") === 3 && count("const reloadToResync = () => { if (confirmReloadWithPending()) window.location.reload(); };") === 1 // reloadToResync is executed in SE-A
      && /searchRef\.current = null; setSearching\(null\); setSearchStats\(null\); setPreviewSchedule\(null\); setShowPreview\(false\);[^\n]*\n\s*schedSyncRef\.current\.reset\(\);/.test(nsrcW)
      && /const handleSignOut = async \(\) => \{[\s\S]{0,1100}schedSyncRef\.current\.reset\(\);\s*setScheduleHistory\(\[\]\); setEditWeekModal\(null\);[\s\S]{0,120}await auth\.signOut\(\);/.test(nsrcW));
  check("SE-W Undo is all-or-nothing through the engine's undoPlan (each step carries its epoch)",
    count("const plan = schedSyncRef.current.undoPlan(step.sched, step.epoch);") === 1 && count("epoch: schedSyncRef.current ? schedSyncRef.current.epochNow() : 0") === 1
      && count("const pushUndo = useCallback((counts) => {") === 1 && count("pushUndo({ prior: priorCounts, y1: year1Counts })") === 1 && (src.match(/pushUndo\([a-z]/g) || []).length === 0);
  check("SE-W destructive snapshots pass minWeeks (an RLS-empty schedule read fails the capture): clear, regenerate, reset, restore",
    count("{ minWeeks: Object.keys(schedSyncRef.current.knownSchedule()).length ? 1 : 0 }") === 5); // + Accept & Publish's backup (A14)
}

// SE-A. Sync v2 app wiring, EXECUTED (9/n). The real component code, sliced
// by its anchors and run with stubs — and, for the header, the real engine on
// the emulated table: the stale-removal line (A14(1)), the resume hook
// (A5(b)), the soft stale-token warning (A7(3)) and the swap refusals that
// drop the stale suggestions (A13). JSX can't run here (no Babel in CI), so
// the markup is pinned and the decisions it renders are executed.
console.log("\nSE-A. sync v2 app wiring, executed");
await (async () => {
  const nsrcA = src.replace(/\r\n/g, "\n");
  // The text after `start` (exactly one occurrence) up to the first `end` after it.
  const after = (start, end) => { const i = nsrcA.indexOf(start); if (i < 0 || nsrcA.indexOf(start, i + 1) !== -1) return null; const e = nsrcA.indexOf(end, i + start.length); return e < 0 ? null : nsrcA.slice(i + start.length, e); };
  const fnIn = (names, code) => { try { return vm.runInContext(`(function (env) { const { ${names} } = env; return (${code}); })`, sandbox); } catch (ex) { return null; } };
  const se = require("./sync-engine-se.js");
  const { createFakeWeeksTable } = require("./fake-weeks-table.js");
  const internalA = [];

  // ── A14(1): the stale-removal header line ──
  // The component's status state starts as EXACTLY the engine's own first
  // report (onStatus dedupes by JSON, so the keys AND their order matter).
  const defSrc = after("  const [schedSync, setSchedSync] = useState(", ");\n");
  let def = null; try { def = defSrc ? vm.runInContext("(" + defSrc + ")", sandbox) : null; } catch (ex) { def = null; }
  let createSchedSync = null; try { createSchedSync = se.compileEngine(se.extractEngine(src)); } catch (ex) { createSchedSync = null; }
  const engineFor = (o) => createSchedSync(Object.assign({ getState: () => ({}), commit: () => {}, fetch: () => new Promise(() => {}), url: "https://x.supabase.co",
    writeHeaders: () => ({}), readHeaders: () => ({}), canWrite: () => true, token: () => "TOK", userId: () => "p1", now: () => new Date().toISOString(), nowMs: () => Date.now(),
    onStatus: () => {}, onToast: () => {}, onWipeBlocked: () => {}, onInternalError: (e) => internalA.push(String(e && e.message || e)), log: () => {} }, o || {}));
  if (!def || !createSchedSync) { check("SE-A the schedSync default and the engine are extractable", false, JSON.stringify({ def: !!def, engine: !!createSchedSync })); return; }
  check("SE-A A14(1) the header's schedSync state starts as EXACTLY the engine's own first status — staleRemovals: 0 included (same keys, same order)",
    JSON.stringify(def) === JSON.stringify(engineFor().status()), JSON.stringify({ def, engine: engineFor().status() }));

  // The header's decisions (the reload helper + the two flags), executed.
  const hdrSrc = after("  const reloadToResync = ", "\n  // The amber");
  const hdrFn = hdrSrc ? fnIn("loaded, saveStatus, schedSync, confirmReloadWithPending, window", `(() => { const reloadToResync = ${hdrSrc}\n return { reloadToResync, schedStaleShown, schedSyncedShown }; })()`) : null;
  if (!hdrFn) { check("SE-A the header's sync decisions are extractable", false, "anchor / compile"); return; }
  const HS = (st, o = {}) => hdrFn({ loaded: o.loaded !== false, saveStatus: o.saveStatus || "", schedSync: st, confirmReloadWithPending: o.confirm || (() => true), window: o.window || { location: { reload: () => {} } } });
  const clean = Object.assign({}, def, { seeded: true });
  const H = (extra, o) => HS(Object.assign({}, clean, extra), o);
  check("SE-A A14(1) the header decides: staleRemovals > 0 → the 'fewer weeks' line and NOT \"☁ Synced\"; 0 and clean → Synced alone; nothing before the load; Synced still waits for pending / busy / the blob's status",
    H({ staleRemovals: 6 }).schedStaleShown === true && H({ staleRemovals: 6 }).schedSyncedShown === false && H({}).schedStaleShown === false && H({}).schedSyncedShown === true
      && H({ staleRemovals: 6 }, { loaded: false }).schedStaleShown === false && H({ pending: 1 }).schedSyncedShown === false && H({ busy: "clear" }).schedSyncedShown === false && H({}, { saveStatus: "Saved" }).schedSyncedShown === false,
    JSON.stringify([H({ staleRemovals: 6 }), H({})]));
  // …and over a real lifecycle: the REAL engine on the emulated table, the
  // header fed by onStatus as the component's state is — a scheduler session
  // and an OR board (read-only, no token), while another device clears.
  {
    let ms = Date.UTC(2026, 9, 14, 12, 0, 0);
    const clock = () => new Date(ms += 1000).toISOString();
    const WK = ["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16"];
    const wkA = (dc) => ({ dayCall: dc, nights: { mon: "s2", tue: "s3", wed: "s4", thu: "s5", wknd: "s6" }, off: "s1" });
    const t = createFakeWeeksTable({ baseUrl: "https://x.supabase.co", anonKey: "ANON", users: { TOK_A: "user-a", TOK_B: "user-b" }, clock,
      rows: WK.map((k, i) => ({ week_monday: k, data: wkA("s" + (i + 1)), version: 2, updated_by: "user-a", updated_at: "2026-10-01T08:00:00.000Z" })) });
    const mkS = (tok, canWrite) => {
      const s = { mirror: {}, st: def, toasts: [] };
      const h = () => ({ apikey: "ANON", Authorization: "Bearer " + (tok || "ANON") });
      s.engine = engineFor({ getState: () => s.mirror, commit: (n) => { s.mirror = n; }, fetch: (u, i) => t.fetch(u, i), writeHeaders: h, readHeaders: h,
        canWrite: () => canWrite, token: () => tok, now: clock, nowMs: () => ms, onStatus: (st) => { s.st = st; }, onToast: (m) => s.toasts.push(String(m)) });
      return s;
    };
    const A = mkS("TOK_A", true), B = mkS("TOK_B", true), OR = mkS(null, false);
    await A.engine.load(); await B.engine.load(); await OR.engine.load();
    const loadedB = HS(B.st), loadedOR = HS(OR.st);
    A.mirror = {}; await A.engine.authoritative({}, true, "clear");
    await B.engine.pull(); await OR.engine.pull();
    const staleB = HS(B.st), staleOR = HS(OR.st), keptB = Object.keys(B.mirror).length, keptOR = Object.keys(OR.mirror).length;
    A.mirror = {}; WK.forEach(k => { A.mirror[k] = wkA("regen"); }); await A.engine.push();
    await B.engine.pull(); await OR.engine.pull();
    const backB = HS(B.st), backOR = HS(OR.st);
    check("SE-A A14(1) a real clear elsewhere: the scheduler and the OR board both show the line (not \"☁ Synced\"; 6 weeks still on screen), and both clear it once a later pull sees the weeks again",
      !loadedB.schedStaleShown && loadedB.schedSyncedShown && !loadedOR.schedStaleShown && staleB.schedStaleShown && !staleB.schedSyncedShown && staleOR.schedStaleShown && keptB === 6 && keptOR === 6
        && !backB.schedStaleShown && backB.schedSyncedShown && !backOR.schedStaleShown && B.mirror[WK[0]].dayCall === "regen" && OR.mirror[WK[0]].dayCall === "regen" && writesIn({ calls: t.log }).length > 0,
      JSON.stringify({ loadedB, staleB, staleOR, backB, backOR, keptB, keptOR }));
    check("SE-A …the OR board never wrote, and no session hit an internal error", t.log.filter(e => e.method !== "GET" && /Bearer ANON/.test(JSON.stringify(e.headers || {}))).length === 0 && internalA.length === 0, internalA.join(" | "));
  }
  const rl = (ok) => { const r = { asked: 0, reloads: 0 }; H({ staleRemovals: 6 }, { confirm: (b) => { r.asked++; r.arg = b; return ok; }, window: { location: { reload: () => { r.reloads++; } } } }).reloadToResync(); return r; };
  const yes = rl(true), no = rl(false);
  check("SE-A A14(1) its Reload goes through the reload guard (which asks only while weeks are unsaved): reloads on yes, not on no",
    yes.asked === 1 && yes.arg === undefined && yes.reloads === 1 && no.asked === 1 && no.reloads === 0, JSON.stringify({ yes, no }));
  {
    const LINE = "⚠ The schedule on the server has fewer weeks than this screen — reload to resync <button onClick={reloadToResync}";
    const pub0 = nsrcA.indexOf('isOrView ? "OR board · read-only" : "Read-only view"'), sch0 = nsrcA.indexOf("Call Schedule · Surgeons + APPs"), conn = nsrcA.indexOf("Connecting…</span>}");
    const at1 = nsrcA.indexOf(LINE), at2 = nsrcA.indexOf(LINE, at1 + 1);
    check("SE-A A14(1) the line is rendered in BOTH headers — the public / OR-board branch and the scheduler's — each gated by schedStaleShown, with its Reload; \"☁ Synced\" renders only through schedSyncedShown",
      count(LINE) === 2 && count('{schedStaleShown && <span role="status"') === 2 && pub0 > 0 && at1 > pub0 && at1 < sch0 && at2 > sch0 && at2 < conn
        && count(">☁ Synced</span>") === 1 && count("{schedSyncedShown && <span") === 1 && count("schedSync.staleRemovals") === 1,
      JSON.stringify({ n: count(LINE), pub0, at1, sch0, at2, conn }));
  }
  {
    const decl = (s) => nsrcA.indexOf(s), at = decl("  const schedStaleShown = ");
    const reads = ["const isPublicMode = useMemo(", "const [loaded, setLoaded]", "const [saveStatus, setSaveStatus]", "const [authUser, setAuthUser]", "const [schedSync, setSchedSync]", "const [reauthNeeded, setReauthNeeded]", "const [staleTokenWarn, setStaleTokenWarn]", "const confirmReloadWithPending = "];
    check("SE-A the header decisions are computed AFTER every state they read is declared (a later const would be a TDZ crash at render)",
      at > 0 && reads.every(s => decl(s) > 0 && decl(s) < at), JSON.stringify(reads.map(s => [s, decl(s)]).concat([["flags", at]])));
  }

  // ── A5(b) + A7(3): the resume hook ──
  const visBody = after("  useEffect(() => {\n    if (!loaded) return;\n    const onVisible = () => {", "\n  }, [loaded]);");
  const visFx = visBody ? fnIn("loaded, document, window, schedSyncRef, auth, jwtIsFresh, schedSyncBridgeRef, setStaleTokenWarn", `() => {\n    if (!loaded) return;\n    const onVisible = () => {${visBody}\n}`) : null;
  if (!visFx) { check("SE-A the resume / reconnect effect is extractable", false, "anchor / compile"); return; }
  const resume = (o = {}) => {
    const r = { calls: [], warn: [], on: {} };
    const doc = { hidden: true, addEventListener: (ev, f) => { r.on["doc:" + ev] = f; }, removeEventListener: () => {} };
    const win = { addEventListener: (ev, f) => { r.on["win:" + ev] = f; }, removeEventListener: () => {} };
    visFx({ loaded: o.loaded !== false, document: doc, window: win,
      schedSyncRef: { current: { onResume: () => { r.calls.push("onResume"); }, pull: () => { r.calls.push("pull"); return Promise.resolve({ ok: true }); } } },
      auth: { getSession: () => (o.token ? { access_token: o.token, refresh_token: "R" } : null) },
      jwtIsFresh: (tok) => tok === "FRESH", schedSyncBridgeRef: { current: { canWrite: o.canWrite !== false } },
      setStaleTokenWarn: (v) => { r.warn.push(v); } })();
    doc.hidden = !!o.hidden;
    if (o.event === "online") { if (r.on["win:online"]) r.on["win:online"](); }
    else if (r.on["doc:visibilitychange"]) r.on["doc:visibilitychange"]();
    return r;
  };
  const vFresh = resume({ token: "FRESH" }), vStale = resume({ token: "STALE" }), vPub = resume({ token: "STALE", canWrite: false }), vNone = resume({}), vHidden = resume({ token: "STALE", hidden: true }), vOnline = resume({ token: "STALE", event: "online" }), vUnloaded = resume({ token: "STALE", loaded: false });
  check("SE-A A5(b) visible → engine.onResume() FIRST (abort requests older than their timeout — timers froze while suspended), THEN the pull; hidden → neither",
    vFresh.calls.join() === "onResume,pull" && vStale.calls.join() === "onResume,pull" && vHidden.calls.length === 0 && vHidden.warn.length === 0, JSON.stringify([vFresh, vHidden]));
  check("SE-A A7(3) on resume a stored token stale by the device clock, in a view that writes → the soft warning; a fresh token clears it; no token / a public or OR view → none",
    vStale.warn.join() === "true" && vFresh.warn.join() === "false" && vNone.warn.join() === "false" && vPub.warn.join() === "false", JSON.stringify([vStale.warn, vFresh.warn, vNone.warn, vPub.warn]));
  check("SE-A …and it never stops the resume: the pull still runs with the warning set; reconnecting (online) just pulls; nothing is wired before the load",
    vStale.calls.includes("pull") && vOnline.calls.join() === "pull" && vOnline.warn.length === 0 && Object.keys(vUnloaded.on).length === 0, JSON.stringify([vOnline, vUnloaded.on]));
  check("SE-A the resume pull keeps its literal (the pull-trigger census in E2 counts it)",
    /if \(document\.hidden\) return;\n      schedSyncRef\.current\.onResume\(\);[\s\S]{0,260}\n      schedSyncRef\.current\.pull\(\);\n    \};/.test(nsrcA) && count("schedSyncRef.current.onResume()") === 1);

  // ── A7(3): the amber banner's decision, its button, and what clears it ──
  const stSrc = after("  const staleTokenShown = ", ";\n");
  const stFn = stSrc ? fnIn("isPublicMode, authUser, staleTokenWarn, schedSync, reauthNeeded", stSrc) : null;
  if (!stFn) { check("SE-A the soft-warning decision is extractable", false, "anchor / compile"); return; }
  const ST = (o) => stFn(Object.assign({ isPublicMode: false, authUser: { id: "u1" }, staleTokenWarn: true, schedSync: { authNeeded: false }, reauthNeeded: false }, o));
  check("SE-A A7(3) the amber \"Sign in again\" shows for a signed-in writer with the warning set — and NOT while the red one shows (authNeeded / an edit refused), in a public view, or signed out",
    ST({}) === true && ST({ schedSync: { authNeeded: true } }) === false && ST({ reauthNeeded: true }) === false && ST({ isPublicMode: true }) === false && ST({ authUser: null }) === false && ST({ staleTokenWarn: false }) === false);
  {
    const amber = after("      {staleTokenShown && (", "\n      )}");
    check("SE-A A7(3) the amber banner: non-blocking (role=status, dismissible), the same reauthForSync button as the red one; the red banner's condition is unchanged",
      !!amber && /^\n        <div role="status"/.test(amber) && amber.includes("<button onClick={reauthForSync} disabled={reauthBusy}") && amber.includes('onClick={()=>setStaleTokenWarn(false)}')
        && count("onClick={reauthForSync}") === 2 && count("{!isPublicMode && authUser && (schedSync.authNeeded || reauthNeeded) && (") === 1, (amber || "").slice(0, 120));
  }
  const raSrc = after("  const reauthForSync = ", "\n  };\n");
  const raFn = raSrc ? fnIn("reauthBusy, setReauthBusy, auth, setReauthNeeded, setStaleTokenWarn, showToast, schedSyncRef", raSrc + "\n  }") : null;
  if (!raFn) { check("SE-A reauthForSync is extractable", false, "anchor / compile"); return; }
  const ra = async (res) => {
    const r = { warn: [], need: [], pushes: 0, toasts: [] };
    await raFn({ reauthBusy: false, setReauthBusy: () => {}, auth: { getUser: async () => res }, setReauthNeeded: (v) => r.need.push(v), setStaleTokenWarn: (v) => r.warn.push(v),
      showToast: (m) => r.toasts.push(String(m)), schedSyncRef: { current: { pending: () => [], push: () => { r.pushes++; } } } })();
    return r;
  };
  const raOk = await ra({ user: { id: "u1" } }), raDead = await ra({ user: null }), raNet = await ra({ user: null, error: "network" });
  check("SE-A A7(3) \"Sign in again\" that renews the session clears BOTH banners and sends what's pending; one that can't renew clears nothing (the warning stays, to retry)",
    raOk.warn.join() === "false" && raOk.need.join() === "false" && raOk.pushes === 1 && raDead.warn.length === 0 && raDead.need.length === 0 && raDead.pushes === 0 && raNet.warn.length === 0 && /reach the server/.test(raNet.toasts.join(" ")),
    JSON.stringify([raOk, raDead, raNet]));
  const geSrc = after("  const schedEditable = ", "\n  };\n");
  const geFn = geSrc ? fnIn("schedSyncRef, showToast, setReauthNeeded, staleTokenWarn, jwtIsFresh", geSrc + "\n  }") : null;
  if (!geFn) { check("SE-A schedEditable is extractable", false, "anchor / compile"); return; }
  const ge = (blocked) => { const r = { toasts: 0 }; r.ok = geFn({ schedSyncRef: { current: { isSeeded: () => true, authBlocked: () => blocked } }, showToast: () => { r.toasts++; }, setReauthNeeded: () => {}, staleTokenWarn: true, jwtIsFresh: () => false })(); return r; };
  check("SE-A A7(3) the soft warning is NOT an edit gate: with it set (the token stale by the clock) an edit is allowed; only the server's 401 (authBlocked) refuses",
    ge(false).ok === true && ge(false).toasts === 0 && ge(true).ok === false, JSON.stringify([ge(false), ge(true)]));
  check("SE-A A7(3) signing out (a boundary) and a renewed sign-in both drop the soft warning",
    count("setReauthNeeded(false); setStaleTokenWarn(false);") === 2 && /const handleSignOut = async \(\) => \{[\s\S]{0,1300}setReauthNeeded\(false\); setStaleTokenWarn\(false\);\n\s*await auth\.signOut\(\);/.test(nsrcA));

  // ── A13: an out-of-date swap also drops the stale suggestions ──
  const MON = "2030-01-07", MON2 = "2030-01-14";
  const mkCur = (tue, wed2) => ({ [MON]: { dayCall: "s3", nights: { mon: "s3", tue, wed: "s2", thu: "s2", wknd: "s3" }, off: null }, [MON2]: { dayCall: "s2", nights: { mon: "s2", tue: "s2", wed: wed2, thu: "s2", wknd: "s2" }, off: null } });
  const swapEnv = (rec, cur) => ({ schedEditable: () => true, schedule: cur, scheduleRef: { current: cur }, showToast: (m) => rec.toasts.push(String(m)),
    silvisActive: false, silvisBlock: () => null, silvisRefuse: () => false, pushUndo: () => { rec.undo++; }, updateSchedule: (f) => { rec.writes++; rec.next = f(cur); },
    surgeons: [{ id: "s1" }, { id: "s2" }, { id: "s3" }], setEditShift: () => {}, setEditingWeek: () => {},
    setSwapSuggestions: (v) => rec.cleared.push("suggestions:" + v), setSwapTarget: (v) => rec.cleared.push("target:" + v),
    sMap: { s1: { name: "AAA" }, s2: { name: "BBB" }, s3: { name: "CCC" } }, schedulerAdminIds: [], addNotification: () => { rec.notes++; }, sendEmailNotif: () => { rec.emails++; } });
  const newRec = () => ({ toasts: [], undo: 0, writes: 0, notes: 0, emails: 0, cleared: [] });
  const SWAP_ENV = "schedEditable, schedule, scheduleRef, showToast, silvisActive, silvisBlock, silvisRefuse, pushUndo, updateSchedule, surgeons, setEditShift, setEditingWeek, setSwapSuggestions, setSwapTarget, sMap, schedulerAdminIds, addNotification, sendEmailNotif";
  const ssSrc = after("  const swapShift = ", "\n  };\n");
  const ssFn = ssSrc ? fnIn(SWAP_ENV, ssSrc + "\n  }") : null;
  const twSrc = after("  const executeTwoWaySwap = useCallback(", "\n  }, [surgeons, sMap, addNotification, sendEmailNotif, schedulerAdminIds, silvisActive, silvisBlock, silvisRefuse]);");
  const twFn = twSrc ? fnIn(SWAP_ENV, twSrc + "\n  }") : null;
  if (!ssFn || !twFn) { check("SE-A swapShift and executeTwoWaySwap are extractable", false, JSON.stringify({ ssFn: !!ssFn, twFn: !!twFn })); return; }
  const oneWay = (holder) => { const rec = newRec(); ssFn(swapEnv(rec, mkCur(holder, "s3")))(MON, "tue", "s3", "s1"); return rec; };
  const twoWay = (holder, ret) => { const rec = newRec(); twFn(swapEnv(rec, mkCur(holder, ret)))(MON, "tue", "s1", "s3", MON2, "wed"); return rec; };
  const refusedClean = (r) => /This swap is out of date/.test(r.toasts.join(" ")) && r.cleared.join() === "suggestions:null,target:null" && r.undo === 0 && r.writes === 0 && r.notes === 0 && r.emails === 0;
  const owStale = oneWay("s2"), owOk = oneWay("s1"), twStale = twoWay("s2", "s3"), twRet = twoWay("s1", "s2"), twOk = twoWay("s1", "s3");
  check("SE-A A13 an out-of-date one-way swap (the slot no longer holds the surgeon it was suggested for) → refused, zero writes / undo / notices, AND the stale suggestions + target are cleared",
    refusedClean(owStale), JSON.stringify(owStale));
  check("SE-A A13 an out-of-date two-way swap (target holder or return holder changed) → refused, zero writes / undo / notices, AND the suggestions + target are cleared",
    refusedClean(twStale) && refusedClean(twRet), JSON.stringify([twStale, twRet]));
  check("SE-A A13 positive controls: a current one-way and two-way swap still land (one write, one undo step, the notices) and clear the suggestions as before",
    owOk.writes === 1 && owOk.undo === 1 && owOk.notes === 1 && owOk.emails === 1 && owOk.next[MON].nights.tue === "s3" && owOk.cleared.join() === "suggestions:null,target:null" && owOk.toasts.length === 0
      && twOk.writes === 1 && twOk.undo === 1 && twOk.notes === 1 && twOk.emails === 1 && twOk.next[MON].nights.tue === "s3" && twOk.next[MON2].nights.wed === "s1" && twOk.cleared.join() === "suggestions:null,target:null" && twOk.toasts.length === 0,
    JSON.stringify([owOk, twOk].map(r => ({ w: r.writes, u: r.undo, n: r.notes, c: r.cleared, t: r.toasts }))));
})().catch(ex => check("SE-A harness ran without crashing", false, String(ex && ex.stack || ex).split("\n").slice(0, 3).join(" | ")));
{
  const { spawnSync } = require("child_process");
  const r = spawnSync(process.execPath, [path.join(__dirname, "fake-weeks-table.test.js")], { encoding: "utf8" });
  const m = /(\d+)\/(\d+) tests passed/.exec(r.stdout || "");
  check("SE-T the emulated schedule_weeks table passes its own contract tests",
    r.status === 0 && !!m && m[1] === m[2] && Number(m[2]) >= 36,
    ((r.stdout || "").split("\n").filter(l => /^FAIL/.test(l)).join(" | ") || r.stderr || "no verdict").slice(0, 300));
}

// ─── Verdict ───
verdictReached = true;
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
