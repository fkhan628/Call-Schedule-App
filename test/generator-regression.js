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
// A third scenario (SQUEEZE) is INFORMATIONAL ONLY: a 2-week vacation can
// exhaust a night's candidate pool, and generator.js's last fallback layer
// (generator.js:570) deliberately prefers covering the night over honoring
// the vacation. That behavior predates this test; it is reported in the
// output but does not fail CI. If the squeeze counts change materially,
// investigate before shipping.
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
    checkHardRules(sched, failures, stats, label);
    const vacHits = collectVacationHits(sched, vac);
    stats.vacationHits += vacHits.length;
    if (opts.assertVacations) vacHits.forEach(h => failures.push(`${label}: ${h}`));
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

// C: SQUEEZE (informational, never fails CI) — a 2-week vacation. Known
//    behavior: the last fallback layer (generator.js:570) may schedule the
//    vacationing surgeon rather than leave a night uncovered.
const SQUEEZE_VACATIONS = { s5: [["2026-03-23", "2026-04-05"]] };
const squeeze = runScenario("squeeze", SQUEEZE_VACATIONS, { assertVacations: false, maxSpread: null }, COUNTS_1YR);

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
//    exactly as the 07:00→07:00 contract requires. Three Silvis primary days
//    of three kinds, all inside MONDAYS (2026-01-05 … 04-06):
//      2026-01-20  Tue  — a SERVICE-WEEK Tuesday (Mon 01-19's week) → FAK may
//                         not be DC that week, and not Tue night
//      2026-02-11  Wed  — a plain weeknight → FAK may not be Wed night that
//                         week (and not DC that week: Wed is a service day)
//      2026-03-13  Fri  — a Friday → FAK may not be the weekend of 03-09's week
//                         (Fri night is the weekend's first leg) nor DC
//    The overlap table is RE-STATED here on purpose (not canTakeSlot, not the
//    conservative shiftDays above — that one includes Saturday for wknd, which
//    would over-assert: a Silvis SATURDAY blocks only the service week).
//    GREEN: with the days in `vac`, FAK holds none of the overlapping slots in
//    any of ROLLS rolls, AND the night before each day is still allowed to
//    him at least once across the rolls (the trailing edge is not over-blocked).
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
  const SILVIS_DAYS = ["2026-01-20", "2026-02-11", "2026-03-13"];
  const withSilvis = { ...LIGHT_VACATIONS, [FAK]: [...(LIGHT_VACATIONS[FAK] || []), ...SILVIS_DAYS.map(d => [d, d])] };
  const without = { ...LIGHT_VACATIONS };
  // the night BEFORE each Silvis day (ends 07:00 D — allowed): the weeknight slot dated D-1
  const nightBefore = { "2026-01-20": ["2026-01-19", "mon"], "2026-02-11": ["2026-02-09", "tue"], "2026-03-13": ["2026-03-09", "thu"] };
  let redFired = 0, trailingAllowed = 0;
  for (let roll = 0; roll < ROLLS; roll++) {
    // GREEN — vac = vacations ∪ Silvis days; vacationsOnly = vacations ONLY
    const g = generate(SURGEONS, MONDAYS, withSilvis, new Set(), {}, {}, new Set(), null, [], null, LIGHT_VACATIONS, COUNTS_1YR);
    const hits = silvisOverlapSlots(g, SILVIS_DAYS, FAK);
    if (hits.length) failures.push(`silvis roll ${roll}: FAK on ${hits.map(h => h.slot + "@" + h.mondayStr + " (Silvis " + h.day + ")").join(", ")}`);
    for (const D of SILVIS_DAYS) { const [m, k] = nightBefore[D]; if (g[m]?.nights?.[k] === FAK) trailingAllowed++; }
    // RED — same fixture, no Silvis days
    const r = generate(SURGEONS, MONDAYS, without, new Set(), {}, {}, new Set(), null, [], null, LIGHT_VACATIONS, COUNTS_1YR);
    if (silvisOverlapSlots(r, SILVIS_DAYS, FAK).length) redFired++;
    if (failures.length > 25) break;
  }
  if (redFired === 0) failures.push(`silvis: WITHOUT the Silvis days FAK never landed on an overlapping slot in ${ROLLS} rolls — the fixture is vacuous, tighten it`);
  if (trailingAllowed === 0) failures.push("silvis: the night BEFORE a Silvis day was never given to FAK in any roll — the trailing edge is over-blocked (a Silvis day must have no-call semantics, not vacation semantics)");
  return { name: "silvis", failures, redFired, trailingAllowed };
}
const silvis = runSilvis();

// ─── Report ───
for (const r of [clean, cleanProxy, light, squeeze]) {
  const s = r.stats;
  const gaps = Object.keys(s.gapHist).map(Number).sort((a, b) => a - b).map(g => `${g}:${s.gapHist[g]}`).join(" ");
  console.log(`${r.name.padEnd(9)} ${ROLLS} rolls — max spreads dc=${s.maxSpread.dc} wknd=${s.maxSpread.wknd} total=${s.maxSpread.total}; ` +
    `wknd→Tue (soft) ×${s.wkndThenTue}; vacation-day assignments ×${s.vacationHits}${r.name === "squeeze" ? " (informational — see header)" : ""}; ` +
    `SW gap histogram {${gaps || "no repeats"}}; spacing violations (gap<=${MIN_DC_GAP}, soft) ×${s.spacingViolations}`);
}
console.log(`stress    ${ROLLS} rolls — floor held every roll; floor-stripped control picked the gap-2 surgeon in ${stress.redFired}/${ROLLS} rolls`);
console.log(`silvis    ${ROLLS} rolls — FAK off every overlapping slot; control without the Silvis days put him on one in ${silvis.redFired}/${ROLLS} rolls; night-before-a-Silvis-day given to him ×${silvis.trailingAllowed}`);

const failures = [...clean.failures, ...cleanProxy.failures, ...light.failures, ...stress.failures, ...silvis.failures];
if (failures.length) {
  console.error(`\nFAIL — ${failures.length} violation(s):`);
  failures.slice(0, 25).forEach(f => console.error("  • " + f));
  if (failures.length > 25) console.error(`  … and ${failures.length - 25} more`);
  process.exit(1);
}
console.log("PASS — Δ0 fairness on clean periods, zero hard-rule violations, zero vacation overlaps (squeeze scenario stays informational).");
process.exit(0);
