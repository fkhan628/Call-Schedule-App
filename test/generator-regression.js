// DSG Call Schedule — generator regression test (N3)
//
// Loads the REAL browser-global app modules (helpers.js, config.js,
// generator.js) into a Node vm context, runs generate() many times, and
// asserts the properties the group actually relies on:
//   1. FAIRNESS: on a clean 14-week period (no vacations/holidays/locks),
//      service weeks, weekends, and total shift counts are perfectly even
//      across the 7 surgeons (Δ0 — the generator's hard-won behavior).
//   2. HARD RULES (asserted on clean + realistic-vacation scenarios):
//        - every week fully covered (Service Week + 4 weeknights + weekend)
//        - no Service Week + weeknight for the same surgeon in one week
//        - no back-to-back weeknights (Mon→Tue, Tue→Wed, Wed→Thu)
//        - no Thursday night + that same weekend
//        - weekend surgeon doesn't get the FOLLOWING week's Monday night
//        - nobody is scheduled over their vacation days
//      NOT asserted (soft by design — generator.js:548 "Tuesday is SOFT
//      (group rule, Jun 2026)"): weekend → next Tuesday night. It is
//      counted and printed as a stat instead.
//
// TIME OFF IS A HARD STOP (owner decision 2026-10-11): in EVERY roll of EVERY
// scenario nobody is on a shift on their vacation / no-call / Silvis day, and
// nobody works an overnight that ends on a VACATION morning (a weeknight
// before a vacation day, the weekend before a vacation Monday) — re-stated
// below in floorHits, independently of generator.js. The SQUEEZE scenario (a
// 2-week vacation) used to be informational because the old last-resort
// fallback covered nights with the vacationer; it is a hard assertion now
// (the generator bends a softer rule instead, and lists it).
//
// Run: node test/generator-regression.js   (exit 0 = pass, 1 = regression)
// CI runs this on every push that touches the generator or its data files.
// Do NOT weaken the assertions to make a failing generator change pass.

// SERVICE-WEEK SPACING (2026-08-31): the soft floor (generator.js MIN_DC_GAP)
// is pinned by BEHAVIOR, not by source text:
//   - every scenario's report includes a same-surgeon service-week gap
//     histogram and a spacing-violation stat (pairs with gap <= MIN_DC_GAP,
//     seam-aware) so a regression is visible at a glance;
//   - a two-sided STRESS fixture (scenario D) engineers a week where count
//     logic WANTS the tight pick and a spaced alternative exists: the real
//     generator must produce ZERO tight pairs across all rolls, and the same
//     fixture run against a floor-stripped copy of the source must produce at
//     least one — proving the fixture bites and the floor is what stops it.
//     If the strip-patterns no longer match the source, the test fails loudly
//     rather than passing vacuously.

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const ROLLS = 120;
const MIN_DC_GAP = 2; // keep in lockstep with generator.js

// ─── Load the real app modules as browser globals ───
const sandbox = {
  console,
  window: {},
  document: undefined,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  fetch: () => { throw new Error("fetch called during generation — generator must be pure"); },
  navigator: { userAgent: "node-test" },
  setTimeout, clearTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ["helpers.js", "config.js", "generator.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
}
// Top-level const/let live in the context's global lexical scope, not on the
// sandbox object — pull what we need out with one last script.
const app = vm.runInContext("({ generate, INIT_SURGEONS, COUNTS_1YR, fmt, addD, parse })", sandbox);
const { generate, INIT_SURGEONS, COUNTS_1YR, fmt, addD, parse } = app;
if (typeof generate !== "function") { console.error("FAIL: generate() not found after loading modules"); process.exit(1); }

// Second context for scenario D's red side: same modules, but the generator
// source with the spacing floor stripped and the scoreOf gap term zeroed.
// Every strip must match, or the fixture would silently test nothing.
function loadFloorStripped() {
  const src = fs.readFileSync(path.join(ROOT, "generator.js"), "utf8");
  const strips = [
    [/const nonHolSpaced = nonHolPool\.filter\([^\n]*\n\s*if \(nonHolSpaced\.length > 0\) nonHolPool = nonHolSpaced;\r?\n/, ""],
    [/const dcPoolSpaced = dcPool\.filter\([^\n]*\n\s*if \(dcPoolSpaced\.length > 0\) dcPool = dcPoolSpaced;\r?\n/, ""],
    [/\+ gapViolations    \* 50/, "+ gapViolations    * 0"],
    [/\+ gapC \* 50 \+/, "+ gapC * 0 +"], // the type-balance polish's spacing tier too (2026-10-11)
  ];
  let out = src;
  for (const [re, rep] of strips) {
    const next = out.replace(re, rep);
    if (next === out) { console.error(`FAIL: floor-strip pattern did not match generator.js — ${re}`); process.exit(1); }
    out = next;
  }
  const sandbox = {
    console: { ...console, warn: () => {} }, // strip repairs may warn; irrelevant here
    window: {}, document: undefined,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: () => { throw new Error("fetch called during generation — generator must be pure"); },
    navigator: { userAgent: "node-test" },
    setTimeout, clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["helpers.js", "config.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
  }
  vm.runInContext(out, sandbox, { filename: "generator-floor-stripped.js" });
  return vm.runInContext("({ generate })", sandbox);
}

const SURGEONS = INIT_SURGEONS;
const IDS = SURGEONS.map(s => s.id);
const WEEKNIGHTS = ["mon", "tue", "wed", "thu"];

// 14 Mondays starting 2026-01-05 (a Monday) — holAssignments is null, so
// holiday logic stays out of the picture.
function buildMondays(startIso, weeks) {
  const out = [];
  let d = parse(startIso);
  for (let i = 0; i < weeks; i++) { out.push(d); d = addD(d, 7); }
  return out;
}
const MONDAYS = buildMondays("2026-01-05", 14);
const MONDAY_KEYS = MONDAYS.map(fmt);

// ─── Independent rule checks (deliberately NOT using canTakeSlot — the test
//     re-states the rules so a generator bug can't hide in shared code) ───
function checkWeekComplete(sched, failures, label) {
  for (const m of MONDAY_KEYS) {
    const wk = sched[m];
    if (!wk) { failures.push(`${label}: week ${m} missing entirely`); continue; }
    if (!wk.dayCall) failures.push(`${label}: week ${m} has no Service Week surgeon`);
    for (const k of [...WEEKNIGHTS, "wknd"]) {
      if (!wk.nights || !wk.nights[k]) failures.push(`${label}: week ${m} slot ${k} unfilled`);
    }
  }
}

function checkHardRules(sched, failures, stats, label) {
  for (let i = 0; i < MONDAY_KEYS.length; i++) {
    const m = MONDAY_KEYS[i];
    const wk = sched[m];
    if (!wk || !wk.nights) continue;
    const n = wk.nights;
    // Service Week surgeon takes no weeknight that week
    for (const k of WEEKNIGHTS) {
      if (wk.dayCall && n[k] === wk.dayCall) {
        failures.push(`${label}: ${m} — ${wk.dayCall} has Service Week AND ${k} night`);
      }
    }
    // No back-to-back weeknights
    for (let j = 0; j < WEEKNIGHTS.length - 1; j++) {
      const a = n[WEEKNIGHTS[j]], b = n[WEEKNIGHTS[j + 1]];
      if (a && a === b) failures.push(`${label}: ${m} — ${a} has back-to-back ${WEEKNIGHTS[j]}+${WEEKNIGHTS[j + 1]} nights`);
    }
    // Thursday night + that same weekend is blocked
    if (n.thu && n.thu === n.wknd) failures.push(`${label}: ${m} — ${n.thu} has Thu night AND that weekend`);
    const next = sched[MONDAY_KEYS[i + 1]];
    if (next && next.nights && n.wknd) {
      // HARD: weekend surgeon doesn't take the FOLLOWING Monday night
      if (next.nights.mon === n.wknd) failures.push(`${label}: ${m} — ${n.wknd} has weekend then next Monday night`);
      // SOFT (stat only): weekend → next Tuesday night
      if (next.nights.tue === n.wknd) stats.wkndThenTue++;
    }
  }
}

// Vacation overlap: conservative day-spans per shift (a subset of the real
// hour-level gating, so any hit here is unambiguously a violation).
//   Service Week -> Mon..Sat of that week
//   mon/tue/wed/thu night -> that day
//   wknd -> Fri, Sat, Sun of that week
const NIGHT_OFFSET = { mon: 0, tue: 1, wed: 2, thu: 3 };
function shiftDays(mondayIso, slot) {
  const mon = parse(mondayIso);
  if (slot === "dayCall") return [0, 1, 2, 3, 4, 5].map(o => fmt(addD(mon, o)));
  if (slot === "wknd") return [4, 5, 6].map(o => fmt(addD(mon, o)));
  return [fmt(addD(mon, NIGHT_OFFSET[slot]))];
}
function onVacDay(vac, id, ds) { return (vac[id] || []).some(([a, b]) => ds >= a && ds <= b); }
// The FLOOR, exactly (2026-10-11): own days from `vac` (vacation ∪ no-call ∪
// Silvis), the overnight's trailing edge from `vacOnly` (vacation only).
//   service week: Mon..Sat · a night on d: d, and d+1 not vacation ·
//   weekend: Fri and Sun, and the next Monday not vacation.
function floorHits(sched, mondayKeys, vac, vacOnly) {
  const hits = [];
  for (const m of mondayKeys) {
    const wk = sched[m]; if (!wk) continue;
    const mon = parse(m), d = (o) => fmt(addD(mon, o));
    if (wk.dayCall) for (let o = 0; o <= 5; o++) if (onVacDay(vac, wk.dayCall, d(o))) { hits.push(`${m} — ${wk.dayCall} service week over time off ${d(o)}`); break; }
    WEEKNIGHTS.forEach((k, o) => {
      const id = wk.nights && wk.nights[k]; if (!id) return;
      if (onVacDay(vac, id, d(o))) hits.push(`${m} — ${id} ${k} night on time off ${d(o)}`);
      else if (onVacDay(vacOnly, id, d(o + 1))) hits.push(`${m} — ${id} ${k} night runs into vacation ${d(o + 1)}`);
    });
    const w = wk.nights && wk.nights.wknd;
    if (w) {
      if (onVacDay(vac, w, d(4)) || onVacDay(vac, w, d(6))) hits.push(`${m} — ${w} weekend on time off`);
      else if (onVacDay(vacOnly, w, d(7))) hits.push(`${m} — ${w} weekend runs into vacation ${d(7)}`);
    }
  }
  return hits;
}
function collectVacationHits(sched, vac) {
  const hits = [];
  for (const m of MONDAY_KEYS) {
    const wk = sched[m];
    if (!wk) continue;
    const slots = { dayCall: wk.dayCall, ...(wk.nights || {}) };
    for (const [slot, id] of Object.entries(slots)) {
      if (!id) continue;
      for (const ds of shiftDays(m, slot)) {
        if (onVacDay(vac, id, ds)) { hits.push(`${m} — ${id} scheduled (${slot}) over vacation day ${ds}`); break; }
      }
    }
  }
  return hits;
}

// Same-surgeon service-week gap histogram + spacing violations (gap <=
// MIN_DC_GAP), seam-aware when a prevWeekSeed is provided (recentDc uses
// negative week offsets, mirroring generator.js scoreOf).
function gapStatsOf(sched, mondayKeys, seed) {
  const lastIdx = {};
  if (seed && seed.recentDc) for (const id in seed.recentDc) lastIdx[id] = seed.recentDc[id];
  if (seed && seed.dayCall) lastIdx[seed.dayCall] = -1;
  const hist = {};
  let violations = 0;
  for (let i = 0; i < mondayKeys.length; i++) {
    const wk = sched[mondayKeys[i]];
    const dc = wk && wk.dayCall;
    if (!dc) continue;
    if (lastIdx[dc] !== undefined) {
      const g = i - lastIdx[dc];
      hist[g] = (hist[g] || 0) + 1;
      if (g <= MIN_DC_GAP) violations++;
    }
    lastIdx[dc] = i;
  }
  return { hist, violations };
}

function countShifts(sched) {
  const c = {};
  IDS.forEach(id => c[id] = { dc: 0, wknd: 0, nights: 0, total: 0 });
  for (const m of MONDAY_KEYS) {
    const wk = sched[m];
    if (!wk) continue;
    if (wk.dayCall && c[wk.dayCall]) { c[wk.dayCall].dc++; c[wk.dayCall].total++; }
    for (const k of WEEKNIGHTS) { const id = wk.nights?.[k]; if (id && c[id]) { c[id].nights++; c[id].total++; } }
    const w = wk.nights?.wknd; if (w && c[w]) { c[w].wknd++; c[w].total++; }
  }
  return c;
}
function spread(counts, key) {
  const vals = IDS.map(id => counts[id][key]);
  return Math.max(...vals) - Math.min(...vals);
}

function runScenario(name, vac, opts, yearCounts) {
  const failures = [];
  const stats = { wkndThenTue: 0, vacationHits: 0, maxSpread: { dc: 0, wknd: 0, total: 0 }, gapHist: {}, spacingViolations: 0 };
  for (let roll = 0; roll < ROLLS; roll++) {
    const sched = generate(SURGEONS, MONDAYS, vac, new Set(), {}, {}, new Set(), null, [], null, vac, yearCounts);
    const label = `${name} roll ${roll}`;
    const gs = gapStatsOf(sched, MONDAY_KEYS, null);
    for (const g in gs.hist) stats.gapHist[g] = (stats.gapHist[g] || 0) + gs.hist[g];
    stats.spacingViolations += gs.violations;
    checkWeekComplete(sched, failures, label);
    if (!opts.bendsAllowed) checkHardRules(sched, failures, stats, label);
    const vacHits = collectVacationHits(sched, vac);
    stats.vacationHits += vacHits.length;
    if (opts.assertVacations) vacHits.forEach(h => failures.push(`${label}: ${h}`));
    const fl = floorHits(sched, MONDAY_KEYS, vac, vac); // runScenario passes vac as vacationsOnly too
    stats.floorHits = (stats.floorHits || 0) + fl.length;
    fl.forEach(h => failures.push(`${label}: FLOOR ${h}`)); // every scenario, always (decision 1)
    const counts = countShifts(sched);
    for (const key of ["dc", "wknd", "total"]) {
      const s = spread(counts, key);
      stats.maxSpread[key] = Math.max(stats.maxSpread[key], s);
      if (opts.maxSpread && s > opts.maxSpread[key]) {
        failures.push(`${label}: ${key} spread ${s} (limit ${opts.maxSpread[key]}) — ${JSON.stringify(Object.fromEntries(IDS.map(id => [id, counts[id][key]])))}`);
      }
    }
    if (failures.length > 25) break; // enough evidence
  }
  return { name, failures, stats };
}

// ─── Scenarios ───
// A: clean period — the Δ0 guarantee plus all hard rules, run BOTH WAYS
//    around the 2026-08-06 priorYearScore wiring:
//      clean      — WITH real 1-year priors (COUNTS_1YR, genuinely skewed:
//                   nights range 37–50). Δ0 must hold even when the 10%
//                   past-year term differentiates surgeons — the
//                   spread-reduction pass owns in-period fairness.
//      cleanProxy — WITHOUT yearCounts (the pre-wiring proxy fallback path,
//                   priorYearScore = multi-year/2). Locks the fallback.
const clean = runScenario("clean", {}, {
  assertVacations: true, // vacuously true (no vacations) — kept for symmetry
  maxSpread: { dc: 0, wknd: 0, total: 0 },
}, COUNTS_1YR);
const cleanProxy = runScenario("cleanProxy", {}, {
  assertVacations: true,
  maxSpread: { dc: 0, wknd: 0, total: 0 },
});

// B: realistic vacations — three surgeons, one week each, spread out.
//    Hard rules must hold, fairness stays within off-by-one bounds, and NO
//    vacation overlaps are tolerated. (History: before the N10 fix of
//    2026-07-02, the validation pass repaired hard-rule conflicts without a
//    vacation check and ~15% of rolls put a surgeon on the Mon/Tue night of
//    their own vacation. The freeForNight/freeForWknd guard in generator.js
//    is what this assertion locks in place. Do not flip it back off.)
const LIGHT_VACATIONS = {
  s1: [["2026-01-12", "2026-01-18"]],
  s3: [["2026-02-16", "2026-02-22"]],
  s5: [["2026-03-23", "2026-03-29"]],
};
const light = runScenario("vacation", LIGHT_VACATIONS, {
  assertVacations: true, // locked since the N10 validation-pass vacation guard
  maxSpread: { dc: 2, wknd: 2, total: 3 },
}, COUNTS_1YR);

// C: SQUEEZE (hard since 2026-10-11) — a 2-week vacation. Nobody on time off
//    or on the night before it, every slot covered; the hard rules may bend
//    here (bendsAllowed — the generator takes the mildest bend and lists it).
const SQUEEZE_VACATIONS = { s5: [["2026-03-23", "2026-04-05"]] };
const squeeze = runScenario("squeeze", SQUEEZE_VACATIONS, { assertVacations: true, bendsAllowed: true, maxSpread: null }, COUNTS_1YR);

// D: SPACING STRESS (two-sided) — a week-0 DC pool of exactly two surgeons
//    (the other five are vacation-blocked via that week's Saturday, which
//    kills DC eligibility but nothing else), where the seed says X's last
//    service week was 2 weeks back (gap 2 — the "service, one week off,
//    service" pattern the floor bans) and Z is fully rested. Counts are all
//    zero at week 0, so the comparator falls through to the jittered priority
//    composite, which picks X roughly half the time — meaning:
//      GREEN (real generator): the soft floor filters X, so Z must take
//        week 0 in EVERY roll and no schedule may contain a gap<=MIN_DC_GAP
//        pair (6 weeks / 7 surgeons — Phase 1 drives DC to <=1 each, so the
//        seeded X is the only surgeon who could ever pair tightly).
//      RED (floor-stripped generator): X must take week 0 in AT LEAST one
//        roll — proving the fixture actually tempts the pick and that the
//        floor, not luck, is what keeps green clean. If red never fires, the
//        fixture is vacuous and the test fails.
function runStress() {
  const X = "s4", Z = "s5";
  const D_MONDAYS = buildMondays("2026-01-05", 6);
  const D_KEYS = D_MONDAYS.map(fmt);
  const seed = { dayCall: null, wknd: null, recentDc: { [X]: -2 } };
  const vac = {};
  for (const id of IDS) if (id !== X && id !== Z) vac[id] = [["2026-01-10", "2026-01-10"]]; // Sat of week 0
  const stripped = loadFloorStripped();
  const failures = [];
  let redFired = 0;
  for (let roll = 0; roll < ROLLS; roll++) {
    const g = generate(SURGEONS, D_MONDAYS, vac, new Set(), {}, {}, new Set(), null, [], seed, vac, COUNTS_1YR);
    if (!g[D_KEYS[0]] || g[D_KEYS[0]].dayCall !== Z) failures.push(`stress roll ${roll}: week 0 DC is ${g[D_KEYS[0]] && g[D_KEYS[0]].dayCall} — floor should have left only ${Z}`);
    const gv = gapStatsOf(g, D_KEYS, seed).violations;
    if (gv > 0) failures.push(`stress roll ${roll}: ${gv} gap<=${MIN_DC_GAP} pair(s) with the floor active`);
    const r = stripped.generate(SURGEONS, D_MONDAYS, vac, new Set(), {}, {}, new Set(), null, [], seed, vac, COUNTS_1YR);
    if (r[D_KEYS[0]] && r[D_KEYS[0]].dayCall === X) redFired++;
    if (failures.length > 25) break;
  }
  if (redFired === 0) failures.push(`stress: floor-stripped generator NEVER picked ${X} at week 0 in ${ROLLS} rolls — fixture is vacuous, tighten it`);
  return { name: "stress", failures, redFired };
}
const stress = runStress();

// E: SILVIS BUSY (two-sided, 2026-09-24) — rule silvisBusy. FAK is also
//    primary trauma call at Silvis; on a Silvis PRIMARY day D (one 24h shift,
//    07:00 D → 07:00 D+1) no Davenport call of his may overlap it. The app
//    folds his Silvis primary days into the generator's availability map as
//    single-day [D,D] ranges — NO-CALL semantics: the shift's own day(s) are
//    blocked, the night BEFORE D (ends 07:00 D) stays allowed. Into `vac`
//    ONLY, never `vacationsOnly` (the trailing-edge map). Zero generator
//    change — so this fixture pins that the EXISTING pools honor such a range
//    exactly as the 07:00→07:00 contract requires. SIX Silvis primary days,
//    one of every kind that matters, all inside MONDAYS (2026-01-05 … 04-06)
//    and each in a week where NO OTHER surgeon is blocked (see the Monday note):
//      2026-03-02  Mon  — DC of 03-02's week and Mon night blocked; the
//                         weekend BEFORE (Sun 03-01 ends 07:00 Mon) allowed.
//                         (Was 01-12 until 2026-09-24: that is the ONE week
//                         where s1 vacations all week, so with Mon dealt last
//                         both remaining candidates were blocked and the
//                         deal's last-resort layer — coverage over rules, the
//                         accepted squeezed-week behavior — placed FAK in
//                         ~1-2 of 120 rolls. Every Silvis day here must sit
//                         in a week with NO other blocked surgeon, or the
//                         fixture tests the fallback, not the rule.)
//      2026-01-20  Tue  — a SERVICE-WEEK Tuesday (Mon 01-19's week) → FAK may
//                         not be DC that week, and not Tue night
//      2026-02-11  Wed  — a plain weeknight → FAK may not be Wed night that
//                         week (and not DC that week: Wed is a service day)
//      2026-02-22  Sun  — the weekend of 02-16 blocked (Sun 07:00→Mon 07:00
//                         is its second leg); DC of 02-16 (Mon..Sat) allowed
//      2026-03-13  Fri  — a Friday → FAK may not be the weekend of 03-09's week
//                         (Fri night is the weekend's first leg) nor DC
//      2026-03-28  Sat  — DC of 03-23 blocked (Sat 07:00→Sun 07:00 is the
//                         service week's); the weekend of 03-23 ALLOWED —
//                         a Saturday must never over-block the weekend
//    The overlap table is RE-STATED here on purpose (not canTakeSlot, not the
//    conservative shiftDays above — that one includes Saturday for wknd, which
//    would over-assert: a Silvis SATURDAY blocks only the service week).
//    GREEN: with the days in `vac`, FAK holds none of the overlapping slots in
//    any of ROLLS rolls, AND every NEIGHBOR slot that the contract leaves open
//    (the night before a Silvis day, the weekend before a Silvis Monday, the
//    service week around a Silvis Sunday, the weekend around a Silvis
//    Saturday) is still given to him at least once across the rolls — each
//    one separately, so an over-block on any single leg fails.
//    RED: the identical fixture WITHOUT the Silvis days must put FAK on at
//    least one overlapping slot in ≥1 roll — proving the fixture bites.
function silvisOverlapSlots(sched, days, id) {
  // -> [{ day, mondayStr, slot }] every (week, slot) FAK holds that overlaps a Silvis day.
  const hits = [];
  for (const m of MONDAY_KEYS) {
    const wk = sched[m]; if (!wk) continue;
    const mon = parse(m);
    const dayOf = (off) => fmt(addD(mon, off));
    for (const D of days) {
      // service week: Mon..Sat (offsets 0..5)
      if (wk.dayCall === id && [0, 1, 2, 3, 4, 5].some(o => dayOf(o) === D)) hits.push({ day: D, mondayStr: m, slot: "dayCall" });
      // weeknights: own day
      [["mon", 0], ["tue", 1], ["wed", 2], ["thu", 3]].forEach(([k, o]) => { if (wk.nights?.[k] === id && dayOf(o) === D) hits.push({ day: D, mondayStr: m, slot: k }); });
      // weekend: Fri (4) and Sun (6) — NOT Saturday
      if (wk.nights?.wknd === id && (dayOf(4) === D || dayOf(6) === D)) hits.push({ day: D, mondayStr: m, slot: "wknd" });
    }
  }
  return hits;
}
function runSilvis() {
  const FAK = SURGEONS.find(s => (s.name || "").toUpperCase() === "FAK")?.id;
  const failures = [];
  if (!FAK) { failures.push("silvis: no roster entry with name FAK — the fixture cannot run"); return { name: "silvis", failures, redFired: 0, trailingAllowed: 0 }; }
  const SILVIS_DAYS = ["2026-01-20", "2026-02-11", "2026-02-22", "2026-03-02", "2026-03-13", "2026-03-28"];
  const withSilvis = { ...LIGHT_VACATIONS, [FAK]: [...(LIGHT_VACATIONS[FAK] || []), ...SILVIS_DAYS.map(d => [d, d])] };
  const without = { ...LIGHT_VACATIONS };
  // Neighbor slots the contract leaves OPEN — each must be given to FAK in
  // at least one roll (an over-block on any leg fails on its own line):
  const openNeighbors = [
    ["2026-02-23", "wknd", "weekend before a Silvis Monday (Sun night ends 07:00 Mon)"],
    ["2026-01-19", "mon", "Mon night before a Silvis Tuesday"],
    ["2026-02-09", "tue", "Tue night before a Silvis Wednesday"],
    ["2026-02-16", "dayCall", "service week (Mon..Sat) around a Silvis Sunday"],
    ["2026-03-09", "thu", "Thu night before a Silvis Friday"],
    ["2026-03-23", "wknd", "weekend (Fri + Sun) around a Silvis Saturday"],
  ];
  const given = openNeighbors.map(() => 0);
  let redFired = 0, trailingAllowed = 0;
  for (let roll = 0; roll < ROLLS; roll++) {
    // GREEN — vac = vacations ∪ Silvis days; vacationsOnly = vacations ONLY
    const g = generate(SURGEONS, MONDAYS, withSilvis, new Set(), {}, {}, new Set(), null, [], null, LIGHT_VACATIONS, COUNTS_1YR);
    const hits = silvisOverlapSlots(g, SILVIS_DAYS, FAK);
    if (hits.length) failures.push(`silvis roll ${roll}: FAK on ${hits.map(h => h.slot + "@" + h.mondayStr + " (Silvis " + h.day + ")").join(", ")}`);
    openNeighbors.forEach(([m, k], i) => { const holder = k === "dayCall" ? g[m]?.dayCall : g[m]?.nights?.[k]; if (holder === FAK) { given[i]++; trailingAllowed++; } });
    // RED — same fixture, no Silvis days
    const r = generate(SURGEONS, MONDAYS, without, new Set(), {}, {}, new Set(), null, [], null, LIGHT_VACATIONS, COUNTS_1YR);
    if (silvisOverlapSlots(r, SILVIS_DAYS, FAK).length) redFired++;
    if (failures.length > 25) break;
  }
  if (redFired === 0) failures.push(`silvis: WITHOUT the Silvis days FAK never landed on an overlapping slot in ${ROLLS} rolls — the fixture is vacuous, tighten it`);
  openNeighbors.forEach(([m, k, why], i) => { if (given[i] === 0) failures.push(`silvis: ${k}@${m} (${why}) was NEVER given to FAK in ${ROLLS} rolls — that leg is over-blocked (a Silvis day must have no-call semantics on its own day only)`); });
  return { name: "silvis", failures, redFired, trailingAllowed, given: openNeighbors.map(([m, k], i) => `${k}@${m}=${given[i]}`).join(" ") };
}
const silvis = runSilvis();

// F: LIVE PERIOD (2026-10-11, owner decisions 1–3 + the bend table) — the
//    real next period (14 weeks from 2026-11-16) on its live inputs
//    (test/fixtures/generator-live-2026-11-16.json: codes + dates only).
//    Every roll must:
//      - put NOBODY on time off or on the night before a vacation (the
//        independent floor check above), and leave NO slot empty;
//      - give the card eves as regular nights: Thanksgiving Wed 11/25 → RPC,
//        Christmas Eve Thu 12/24 → FAK, New Year's Eve Wed 12/30 → DJA, with
//        no holidayCoverage row on an eve date;
//      - give FAK Christmas week whole: service week, Thu (Eve) night, weekend;
//      - list exactly its own bends: the test re-derives every bend with the
//        oracle's tables and LIVE_PINS (restated here from the cards, not
//        generator.js) and compares with listScheduleBends — both ways, and
//        no designed pattern may appear;
//      - (follow-up, 2026-10-11) be as EVEN per type as the calendar allows:
//        a Δ0 service-week AND Δ0 weekend schedule exists at the same bend
//        cost (owner's existence proof), and the type-balance polish must
//        reach service weeks Δ0 in ≥ 95% and weekends Δ0 in ≥ 90% of rolls
//        (observed: 200/200 and ~193/200 — the rest are Δ2 on one pair);
//      - cost exactly the minimum computed by test/bend-oracle.js, an
//        independent exact solver written from the spec by a separate agent
//        that never read generator.js (live minimum 96 = wk 1/4: 6,
//        wk 2/8: 72, wk 2/15: 18). Do NOT loosen this without the owner.
function runLive() {
  const oracle = require("./bend-oracle.js");
  const L = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "generator-live-2026-11-16.json"), "utf8"));
  const lsb = vm.runInContext("typeof listScheduleBends === 'function' ? listScheduleBends : null", sandbox);
  const failures = [];
  if (!lsb) failures.push("live: listScheduleBends() not found in generator.js"); // keep going: the other stats still matter (red runs)
  const S = L.surgeons, ids = S.map(s => s.id), code = Object.fromEntries(S.map(s => [s.id, s.name])), byCode = Object.fromEntries(S.map(s => [s.name, s.id]));
  const keys = L.mondays, mondays = keys.map(parse);
  const args = [S, mondays, L.avail, new Set(L.backupMondays), L.priorCounts, L.prefs, new Set(L.fierceBackupMondays), L.holAssignments, L.locks, L.prevWeekSeed, L.vacationsOnly, L.yearCounts];
  // The designed holiday patterns, restated from the 2026 cards (Thanksgiving A=MCC B=RPC eve RPC;
  // Christmas FAK; New Year's A=REH B=DJA eve DJA) — a pair of these is never a bend.
  const P = byCode;
  const LIVE_PINS = {
    "2026-11-23": { dayCall: P.MCC, thu: P.MCC, wed: P.RPC, wknd: P.RPC },
    "2026-12-21": { dayCall: P.FAK, thu: P.FAK, wknd: P.FAK },
    "2026-12-28": { dayCall: P.REH, thu: P.REH, wed: P.DJA, wknd: P.DJA },
  };
  const t0 = Date.now();
  const best = oracle.minBendCost({ ids, mondays: keys, avail: L.avail, vacOnly: L.vacationsOnly, pins: LIVE_PINS, seed: { dayCall: L.prevWeekSeed.dayCall, wknd: L.prevWeekSeed.wknd } });
  const oracleMs = Date.now() - t0;
  if (best.cost !== 96) failures.push(`live: the oracle's minimum is ${best.cost}, expected 96 — the fixture or the oracle changed`);
  const SL = oracle.SLOTS; // ["dayCall","mon","tue","wed","thu","wknd"]
  const holder = (wk, s) => !wk ? null : s === "dayCall" ? (wk.dayCall || null) : ((wk.nights && wk.nights[s]) || null);
  const pinned = (m, s, id) => !!(LIVE_PINS[m] && LIVE_PINS[m][s] === id);
  // The test's own bend list: oracle tables, LIVE_PINS waive same-week pin pairs.
  const ownBends = (sched) => {
    const out = [];
    keys.forEach((m, w) => {
      const wk = sched[m];
      SL.forEach(s => { if (!holder(wk, s)) out.push(`${m}|EMPTY|${s}|${oracle.EMPTY_COST}`); });
      for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) {
        const id = holder(wk, SL[a]); if (!id || id !== holder(wk, SL[b])) continue;
        const c = oracle.PAIR[a][b]; if (!c || (pinned(m, SL[a], id) && pinned(m, SL[b], id))) continue;
        out.push(`${m}|${code[id]}|${SL[a]}+${SL[b]}|${c}`);
      }
      const prev = w > 0 ? sched[keys[w - 1]] : { dayCall: L.prevWeekSeed.dayCall, nights: { wknd: L.prevWeekSeed.wknd } };
      [["dayCall", "mon", oracle.CROSS.dcMon], ["wknd", "mon", oracle.CROSS.wkMon], ["wknd", "dayCall", oracle.CROSS.wkDc], ["dayCall", "dayCall", oracle.CROSS.dcDc]].forEach(([a, b, c]) => {
        const id = holder(prev, a);
        if (id && id === holder(wk, b) && !(w > 0 && pinned(keys[w - 1], a, id) && pinned(m, b, id))) out.push(`${m}|${code[id]}|${a}+${b}|${c}`);
      });
    });
    return out.sort();
  };
  const listed = (sched) => lsb(sched, { surgeons: S, mondays, vac: L.avail, vacationsOnly: L.vacationsOnly, holAssignments: L.holAssignments, prevWeekSeed: L.prevWeekSeed }).items
    .filter(it => it.kind === "bend" || it.kind === "empty")
    .map(it => `${it.mondayStr}|${it.who ? code[it.who] : "EMPTY"}|${it.slots.join("+")}|${it.cost}`).sort();
  const EVES = [["2026-11-23", "wed", "RPC", "2026-11-25"], ["2026-12-21", "thu", "FAK", "2026-12-24"], ["2026-12-28", "wed", "DJA", "2026-12-30"]];
  const stats = { timeOff: 0, empty: 0, eves: EVES.map(() => 0), xmas: 0, costHist: {}, ms: 0, svcHist: {}, wkndHist: {} };
  const LIVE_ROLLS = ROLLS;
  for (let roll = 0; roll < LIVE_ROLLS; roll++) {
    const t = Date.now();
    const sched = generate(...args);
    stats.ms += Date.now() - t;
    const label = `live roll ${roll}`;
    const hits = floorHits(sched, keys, L.avail, L.vacationsOnly);
    stats.timeOff += hits.length; hits.forEach(h => failures.push(`${label}: ${h.replace(/\bs\d\b/g, x => code[x] || x)}`));
    keys.forEach(m => SL.forEach(s => { if (!holder(sched[m], s)) { stats.empty++; failures.push(`${label}: ${m} ${s} EMPTY`); } }));
    EVES.forEach(([m, k, c, d], i) => {
      if (code[sched[m]?.nights?.[k]] === c) stats.eves[i]++; else failures.push(`${label}: eve ${d} (${k} of ${m}) is ${code[sched[m]?.nights?.[k]] || "empty"}, the card says ${c}`);
      keys.forEach(mm => { if (sched[mm]?.holidayCoverage && sched[mm].holidayCoverage[d]) failures.push(`${label}: a holidayCoverage row sits on the eve ${d}`); });
    });
    const x = sched["2026-12-21"];
    if (x && code[x.dayCall] === "FAK" && code[x.nights?.thu] === "FAK" && code[x.nights?.wknd] === "FAK") stats.xmas++;
    else failures.push(`${label}: Christmas week is ${code[x?.dayCall]}/${code[x?.nights?.thu]}/${code[x?.nights?.wknd]} (service/Thu/weekend), not FAK's`);
    const own = ownBends(sched), lst = lsb ? listed(sched) : own;
    if (lsb && JSON.stringify(own) !== JSON.stringify(lst)) failures.push(`${label}: listScheduleBends disagrees with the test — test ${JSON.stringify(own)} vs list ${JSON.stringify(lst)}`);
    lst.forEach(k => { const [m, who, slots] = k.split("|"); const [a, b] = slots.split("+"); if (who !== "EMPTY" && pinned(m, a, byCode[who]) && pinned(m, b, byCode[who])) failures.push(`${label}: a designed pattern was listed as a bend: ${k}`); });
    const svcC = {}, wkC = {}; ids.forEach(id => { svcC[id] = 0; wkC[id] = 0; });
    keys.forEach(m => { const wk = sched[m]; if (wk && wk.dayCall) svcC[wk.dayCall]++; if (wk && wk.nights && wk.nights.wknd) wkC[wk.nights.wknd]++; });
    const spr = (o) => Math.max(...Object.values(o)) - Math.min(...Object.values(o));
    stats.svcHist[spr(svcC)] = (stats.svcHist[spr(svcC)] || 0) + 1; stats.wkndHist[spr(wkC)] = (stats.wkndHist[spr(wkC)] || 0) + 1;
    const cost = own.reduce((t, k) => t + Number(k.split("|")[3]), 0);
    stats.costHist[cost] = (stats.costHist[cost] || 0) + 1;
    if (cost !== best.cost) failures.push(`${label}: bend cost ${cost}, the exact minimum is ${best.cost} — ${own.join(", ")}`);
    if (failures.length > 25 && !process.env.LIVE_ALL_ROLLS) break;
  }
  const rolled = Object.values(stats.svcHist).reduce((a, b) => a + b, 0);
  if (rolled === LIVE_ROLLS) {
    if ((stats.svcHist[0] || 0) < Math.ceil(0.95 * LIVE_ROLLS)) failures.push(`live: service weeks Δ0 in only ${stats.svcHist[0] || 0}/${LIVE_ROLLS} rolls (need ≥ 95%) — ${JSON.stringify(stats.svcHist)}`);
    if ((stats.wkndHist[0] || 0) < Math.ceil(0.90 * LIVE_ROLLS)) failures.push(`live: weekends Δ0 in only ${stats.wkndHist[0] || 0}/${LIVE_ROLLS} rolls (need ≥ 90%) — ${JSON.stringify(stats.wkndHist)}`);
  }
  return { name: "live", failures, stats, rolls: LIVE_ROLLS, oracleCost: best.cost, oracleMs };
}
const live = runLive();

// ─── Report ───
for (const r of [clean, cleanProxy, light, squeeze]) {
  const s = r.stats;
  const gaps = Object.keys(s.gapHist).map(Number).sort((a, b) => a - b).map(g => `${g}:${s.gapHist[g]}`).join(" ");
  console.log(`${r.name.padEnd(9)} ${ROLLS} rolls — max spreads dc=${s.maxSpread.dc} wknd=${s.maxSpread.wknd} total=${s.maxSpread.total}; ` +
    `wknd→Tue (soft) ×${s.wkndThenTue}; vacation-day assignments ×${s.vacationHits}; time-off placements (floor) ×${s.floorHits || 0}; ` +
    `SW gap histogram {${gaps || "no repeats"}}; spacing violations (gap<=${MIN_DC_GAP}, soft) ×${s.spacingViolations}`);
}
console.log(`stress    ${ROLLS} rolls — floor held every roll; floor-stripped control picked the gap-2 surgeon in ${stress.redFired}/${ROLLS} rolls`);
console.log(`live      ${live.rolls || 0} rolls — time-off placements ×${live.stats ? live.stats.timeOff : "?"}; empty slots ×${live.stats ? live.stats.empty : "?"}; eves RPC/FAK/DJA ${live.stats ? live.stats.eves.join("/") : "?"} of ${live.rolls}; Christmas week FAK ${live.stats ? live.stats.xmas : "?"}/${live.rolls}; bend cost ${live.stats ? JSON.stringify(live.stats.costHist) : "?"} vs the oracle's exact minimum ${live.oracleCost} (oracle ${live.oracleMs} ms); generate() ${live.stats ? Math.round(live.stats.ms / live.rolls) : "?"} ms/roll; service-week spread ${live.stats ? JSON.stringify(live.stats.svcHist) : "?"}; weekend spread ${live.stats ? JSON.stringify(live.stats.wkndHist) : "?"}`);
console.log(`silvis    ${ROLLS} rolls — FAK off every overlapping slot (6 Silvis days: Mon/Tue/Wed/Sun/Fri/Sat); control without them put him on one in ${silvis.redFired}/${ROLLS} rolls; open neighbor legs given to him: ${silvis.given}`);

const failures = [...clean.failures, ...cleanProxy.failures, ...light.failures, ...squeeze.failures, ...stress.failures, ...silvis.failures, ...live.failures];
if (failures.length) {
  console.error(`\nFAIL — ${failures.length} violation(s):`);
  failures.slice(0, 25).forEach(f => console.error("  • " + f));
  if (failures.length > 25) console.error(`  … and ${failures.length - 25} more`);
  process.exit(1);
}
console.log("PASS — Δ0 fairness on clean periods, zero hard-rule violations outside squeezed weeks, nobody on time off in any scenario, the live period at its exact minimum bend cost.");
process.exit(0);
