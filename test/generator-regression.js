// DSG Call Schedule — generator regression test (N3)
//
// Loads the REAL browser-global app modules (helpers.js, config.js,
// generator.js) into a Node vm context, runs generate() many times, and
// asserts the properties the group actually relies on:
//   1. FAIRNESS: on a clean 14-week period (no vacations/holidays/locks),
//      service weeks, weekends, and total shift counts are perfectly even
//      across the 7 surgeons (Δ0 — the generator's hard-won behavior), with
//      no strain and no bend at all (clean periods unchanged by PR 2).
//   2. THE FLOOR, asserted in EVERY roll of EVERY scenario (owner decisions
//      2026-10-11 and 2026-10-12), re-stated below independently of
//      generator.js:
//        - nobody on a shift on their vacation / no-call / Silvis day, and no
//          overnight ending on a VACATION morning (floorHits);
//        - RULE 1: the service-week surgeon is also free that SUNDAY;
//        - RULE 2: nobody works two overnight shifts in a row, across every
//          pair of dates — weeknights, Thu night → Fri, Fri night → service
//          Saturday, Saturday → Sunday, Sunday → next Monday — except the
//          designed holiday runs (a card's Night Before + its own 24h; FAK's
//          Christmas week) and FAK's last resort (service week + weekend);
//        - every slot filled.
//      NOT asserted (soft by design): weekend → next Tuesday night. It is
//      counted and printed as a stat instead.
//   3. STRAIN and BENDS (owner brief 2026-10-12): the test re-derives both
//      from the brief — strain a (weekends worked back to back), b (service
//      weeks ≤ MIN_DC_GAP apart, seam-aware), c (every-other-night runs of
//      3+), counted in units, FLEX (FAK) apart; bends by the oracle's tables
//      — and checks generator.js's listScheduleBends agrees on every roll.
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
//     rather than passing vacuously. (Since 2026-10-12 spacing is strain item
//     b of the ranking, so the strip zeroes that item.)

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const ROLLS = 120;
const MIN_DC_GAP = 2; // keep in lockstep with generator.js
const FLEX_CODES = ["FAK"]; // the brief's FLEX list, restated (generator.js FLEX)
const FLEX_STRAIN_COST = 10; // restated: a FLEX strain unit in the bend tier
// The live scenario's search budget per roll, in schedules: about what the
// app's 10-second search checks on a phone (a desktop checks ~400k/s).
const LIVE_ROLLS = 30, LIVE_PROPOSALS = 1000000;

// ─── Load the real app modules as browser globals ───
function loadApp(transform, label) {
  const sb = {
    console: transform ? { ...console, warn: () => {} } : console,
    window: {},
    document: undefined,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: () => { throw new Error("fetch called during generation — generator must be pure"); },
    navigator: { userAgent: "node-test" },
    setTimeout, clearTimeout,
  };
  sb.globalThis = sb;
  vm.createContext(sb);
  for (const f of ["helpers.js", "config.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sb, { filename: f });
  let gen = fs.readFileSync(path.join(ROOT, "generator.js"), "utf8");
  if (transform) gen = transform(gen);
  vm.runInContext(gen, sb, { filename: label || "generator.js" });
  return { sb, app: vm.runInContext("({ generate, createScheduleSearch, listScheduleBends, validateScheduleJson, shapeScheduleWeeks, INIT_SURGEONS, COUNTS_1YR, fmt, addD, parse })", sb) };
}
const { sb: sandbox, app } = loadApp(null);
// Top-level const/let live in the context's global lexical scope, not on the
// sandbox object — pulled out above with one last script.
const { generate, createScheduleSearch, listScheduleBends, validateScheduleJson, shapeScheduleWeeks, INIT_SURGEONS, COUNTS_1YR, fmt, addD, parse } = app;
if (typeof generate !== "function" || typeof createScheduleSearch !== "function") { console.error("FAIL: generate() / createScheduleSearch() not found after loading modules"); process.exit(1); }

// A copy of generator.js with source patterns replaced — the RED controls.
// Every strip must match, or the fixture would silently test nothing.
function loadStripped(strips, label) {
  return loadApp((src) => {
    let out = src;
    for (const [re, rep] of strips) {
      const next = out.replace(re, rep);
      if (next === out) { console.error(`FAIL: ${label} strip pattern did not match generator.js — ${re}`); process.exit(1); }
      out = next;
    }
    return out;
  }, `generator-${label}.js`).app;
}
// Scenario D's red side: the deal's spacing filters gone, strain item b (service weeks ≤ MIN_DC_GAP apart) never counted.
const loadFloorStripped = () => loadStripped([
  [/const nonHolSpaced = nonHolPool\.filter\([^\n]*\n\s*if \(nonHolSpaced\.length > 0\) nonHolPool = nonHolSpaced;\r?\n/, ""],
  [/const dcPoolSpaced = dcPool\.filter\([^\n]*\n\s*if \(dcPoolSpaced\.length > 0\) dcPool = dcPoolSpaced;\r?\n/, ""],
  [/if \(prev > -900 && w - prev <= MIN_DC_GAP && /, "if (false && "],
], "floor-stripped");
// Rule 1's red side: the service week checked Mon–Sat only (as before 2026-10-12).
const loadSundayStripped = () => loadStripped([
  [/if \(slot === "dayCall"\) \{ for \(let o = 0; o < 7; o\+\+\) if \(onVac\(id, d\(o\), v\)\) return false; return true; \}/,
   'if (slot === "dayCall") { for (let o = 0; o < 6; o++) if (onVac(id, d(o), v)) return false; return true; }'],
], "sunday-stripped");

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

// ─── Independent rule checks (deliberately NOT using generator.js — the test
//     re-states the rules so a generator bug can't hide in shared code) ───
function checkWeekComplete(sched, failures, label, keys) {
  for (const m of keys || MONDAY_KEYS) {
    const wk = sched[m];
    if (!wk) { failures.push(`${label}: week ${m} missing entirely`); continue; }
    if (!wk.dayCall) failures.push(`${label}: week ${m} has no Service Week surgeon`);
    for (const k of [...WEEKNIGHTS, "wknd"]) {
      if (!wk.nights || !wk.nights[k]) failures.push(`${label}: week ${m} slot ${k} unfilled`);
    }
  }
}
// Weekend → next Tuesday (soft, a stat only).
function countWkndThenTue(sched, keys) {
  let n = 0;
  for (let i = 0; i + 1 < keys.length; i++) { const a = sched[keys[i]], b = sched[keys[i + 1]]; if (a && b && a.nights && b.nights && a.nights.wknd && a.nights.wknd === b.nights.tue) n++; }
  return n;
}

const NIGHT_OFFSET = { mon: 0, tue: 1, wed: 2, thu: 3 };
function onVacDay(vac, id, ds) { return (vac[id] || []).some(([a, b]) => ds >= a && ds <= b); }
// The FLOOR, exactly (2026-10-11; the Sunday 2026-10-12): own days from `vac`
// (vacation ∪ no-call ∪ Silvis), the overnight's trailing edge from `vacOnly`
// (vacation only).
//   service week: Mon..SUN · a night on d: d, and d+1 not vacation ·
//   weekend: Fri and Sun, and the next Monday not vacation.
function floorHits(sched, mondayKeys, vac, vacOnly) {
  const hits = [];
  for (const m of mondayKeys) {
    const wk = sched[m]; if (!wk) continue;
    const mon = parse(m), d = (o) => fmt(addD(mon, o));
    if (wk.dayCall) for (let o = 0; o <= 6; o++) if (onVacDay(vac, wk.dayCall, d(o))) { hits.push(`${m} — ${wk.dayCall} service week over time off ${d(o)}${o === 6 ? " (its Sunday — rule 1)" : ""}`); break; }
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

// Same-surgeon service-week gap histogram + spacing violations (gap <=
// MIN_DC_GAP), seam-aware when a prevWeekSeed is provided (recentDc uses
// negative week offsets).
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

// ─── The owner's brief of 2026-10-12, RE-STATED (rule 2, strain, bends) ───
// Overnights by DATE: a weeknight is its own date; the weekend its Friday and
// Sunday; the service week its Saturday; a holiday 24h row (the week's
// holidayCoverage — what the calendar shows) its date, held by the row's
// surgeon instead of that date's slot. An overnight is FIXED when the holiday
// cards fix it (a 24h row, or a slot in `pins` — the cards' designed slots,
// restated per scenario) — f 1 — or it is the published week before the
// period (the seed) — f 2.
function overnights(sched, keys, seed, pins) {
  const H = {};
  const m0 = parse(keys[0]), at = (o) => fmt(addD(m0, o));
  if (seed) {
    const n = seed.nights || {};
    WEEKNIGHTS.forEach((k, o) => { if (n[k]) H[at(o - 7)] = { id: n[k], f: 2 }; });
    if (seed.wknd) { H[at(-3)] = { id: seed.wknd, f: 2 }; H[at(-1)] = { id: seed.wknd, f: 2 }; }
    if (seed.dayCall) H[at(-2)] = { id: seed.dayCall, f: 2 };
  }
  keys.forEach(m => {
    const wk = sched[m]; if (!wk) return;
    const mon = parse(m), d = (o) => fmt(addD(mon, o)), hc = wk.holidayCoverage || {};
    const pinned = (slot, id) => !!(pins && pins[m] && pins[m][slot] === id);
    const put = (o, slot, id) => { const ds = d(o); if (!id || hc[ds]) return; H[ds] = { id, f: pinned(slot, id) ? 1 : 0, m, slot }; };
    WEEKNIGHTS.forEach((k, o) => put(o, k, wk.nights && wk.nights[k]));
    put(4, "wknd", wk.nights && wk.nights.wknd); put(5, "dayCall", wk.dayCall); put(6, "wknd", wk.nights && wk.nights.wknd);
    for (let o = 0; o < 7; o++) { const c = hc[d(o)]; if (c && c.surgeonId) H[d(o)] = { id: c.surgeonId, f: 1, m, slot: "row" }; }
  });
  return H;
}
// Oracle tables (test/bend-oracle.js — written from the spec, not generator.js).
const oracle = require("./bend-oracle.js");
// → { hard, lastResort, partner, flex, ladder, bend, items } for one schedule.
//   designedRuns: Set of "date|id" — the pair (date, date+1) is a designed run.
function ruleFindings(sched, keys, { seed, pins, designedRuns, flexIds }) {
  const H = overnights(sched, keys, seed, pins);
  const first = keys[0], flex = new Set(flexIds || []);
  const out = { hard: [], lastResort: [], partner: 0, flex: 0, ladder: 0, items: [] };
  const next = (ds, n) => fmt(addD(parse(ds), n));
  const unit = (id, what) => { if (flex.has(id)) out.flex++; else out.partner++; out.items.push(`${flex.has(id) ? "flex" : "strain"}|${id}|${what}`); };
  // rule 2 — every two consecutive dates, the second in the period
  const lrWeeks = new Set();
  Object.keys(H).sort().forEach(ds => {
    const a = H[ds], nd = next(ds, 1), b = H[nd];
    if (!b || a.id !== b.id || nd < first) return;
    if (a.f === 1 && b.f === 1 && designedRuns && designedRuns.has(ds + "|" + a.id)) return;
    const dow = parse(ds).getDay();
    const wk = a.m && sched[a.m];
    if (flex.has(a.id) && a.m && a.m === b.m && (dow === 5 || dow === 6) && wk && wk.dayCall === a.id && wk.nights && wk.nights.wknd === a.id) { lrWeeks.add(a.m); return; }
    out.hard.push(`${a.id} ${ds}→${nd}`);
  });
  keys.forEach(m => { const wk = sched[m]; if (wk && wk.dayCall && flex.has(wk.dayCall) && wk.nights && wk.nights.wknd === wk.dayCall && !(pins && pins[m] && pins[m].dayCall === wk.dayCall && pins[m].wknd === wk.dayCall)) lrWeeks.add(m); });
  out.lastResort = [...lrWeeks].sort();
  // strain a — weekends worked (Fri, Sat, Sun overnights), the seed week included
  const weeks = [fmt(addD(parse(first), -7)), ...keys];
  const worked = weeks.map(m => { const w = {}; [4, 5, 6].forEach(o => { const x = H[fmt(addD(parse(m), o))]; if (x) { const r = w[x.id] || (w[x.id] = { fixed: true }); if (!x.f) r.fixed = false; } }); return w; });
  for (let i = 1; i < weeks.length; i++) for (const id of IDS_OF(sched, seed)) {
    const p = worked[i - 1][id], c = worked[i][id];
    if (p && c && !(p.fixed && c.fixed)) unit(id, `wknd ${weeks[i - 1]}+${weeks[i]}`);
  }
  // strain b — service weeks ≤ MIN_DC_GAP apart (history: the seed's recentDc, its dayCall at -1)
  const last = {};
  if (seed && seed.recentDc) for (const id in seed.recentDc) last[id] = { w: seed.recentDc[id], fixed: true };
  if (seed && seed.dayCall) last[seed.dayCall] = { w: -1, fixed: true };
  keys.forEach((m, w) => {
    const id = sched[m] && sched[m].dayCall; if (!id) return;
    const fixedNow = !!(pins && pins[m] && pins[m].dayCall === id);
    if (last[id] && w - last[id].w <= MIN_DC_GAP && !(last[id].fixed && fixedNow)) unit(id, `svc ${last[id].w}+${w}`);
    last[id] = { w, fixed: fixedNow };
  });
  // strain c — three overnights each two dates apart, the last in the period
  Object.keys(H).sort().forEach(ds => {
    if (ds < first) return;
    const a = H[next(ds, -4)], b = H[next(ds, -2)], c = H[ds];
    if (!a || !b || a.id !== c.id || b.id !== c.id) return;
    if (a.f && b.f && c.f) return;
    unit(c.id, `eon ${next(ds, -4)},${next(ds, -2)},${ds}`);
  });
  // bends — the oracle's tables, rule-2 pairs excluded (they are the floor), designed pairs waived
  const SL = oracle.SLOTS, holder = (wk, s) => !wk ? null : s === "dayCall" ? (wk.dayCall || null) : ((wk.nights && wk.nights[s]) || null);
  const pinned = (m, s, id) => !!(pins && pins[m] && pins[m][s] === id);
  keys.forEach((m, w) => {
    const wk = sched[m];
    for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) {
      const id = holder(wk, SL[a]); if (!id || id !== holder(wk, SL[b]) || oracle.isHardPair(a, b)) continue;
      if (pinned(m, SL[a], id) && pinned(m, SL[b], id)) continue;
      out.ladder += oracle.PAIR[a][b]; out.items.push(`bend|${id}|${m}|${SL[a]}+${SL[b]}`);
    }
    const prev = w > 0 ? sched[keys[w - 1]] : (seed ? { dayCall: seed.dayCall, nights: { wknd: seed.wknd } } : null);
    [["dayCall", "mon", oracle.CROSS.dcMon], ["wknd", "dayCall", oracle.CROSS.wkDc], ["dayCall", "dayCall", oracle.CROSS.dcDc]].forEach(([a, b, c]) => {
      const id = holder(prev, a);
      if (id && id === holder(wk, b) && !(w > 0 && pinned(keys[w - 1], a, id) && pinned(m, b, id))) { out.ladder += c; out.items.push(`bend|${id}|${m}|${a}>${b}`); }
    });
  });
  out.bend = out.ladder + FLEX_STRAIN_COST * out.flex;
  return out;
}
function IDS_OF(sched, seed) { const s = new Set(IDS); Object.values(sched).forEach(wk => { if (!wk) return; if (wk.dayCall) s.add(wk.dayCall); Object.values(wk.nights || {}).forEach(x => x && s.add(x)); }); return [...s]; }

function countShifts(sched, keys) {
  const c = {};
  IDS.forEach(id => c[id] = { dc: 0, wknd: 0, nights: 0, total: 0 });
  for (const m of keys || MONDAY_KEYS) {
    const wk = sched[m];
    if (!wk) continue;
    if (wk.dayCall && c[wk.dayCall]) { c[wk.dayCall].dc++; c[wk.dayCall].total++; }
    for (const k of WEEKNIGHTS) { const id = wk.nights?.[k]; if (id && c[id]) { c[id].nights++; c[id].total++; } }
    const w = wk.nights?.wknd; if (w && c[w]) { c[w].wknd++; c[w].total++; }
  }
  return c;
}
function spread(counts, key) {
  const vals = Object.keys(counts).map(id => counts[id][key]);
  return Math.max(...vals) - Math.min(...vals);
}

function runScenario(name, vac, opts, yearCounts) {
  const failures = [];
  const stats = { wkndThenTue: 0, maxSpread: { dc: 0, wknd: 0, total: 0 }, gapHist: {}, spacingViolations: 0, floorHits: 0, hard: 0, strain: {}, ladder: {} };
  const FAKID = (SURGEONS.find(s => FLEX_CODES.includes(String(s.name || "").toUpperCase())) || {}).id;
  for (let roll = 0; roll < ROLLS; roll++) {
    const sched = generate(SURGEONS, MONDAYS, vac, new Set(), {}, {}, new Set(), null, [], null, vac, yearCounts);
    const label = `${name} roll ${roll}`;
    const gs = gapStatsOf(sched, MONDAY_KEYS, null);
    for (const g in gs.hist) stats.gapHist[g] = (stats.gapHist[g] || 0) + gs.hist[g];
    stats.spacingViolations += gs.violations;
    checkWeekComplete(sched, failures, label);
    stats.wkndThenTue += countWkndThenTue(sched, MONDAY_KEYS);
    const fl = floorHits(sched, MONDAY_KEYS, vac, vac); // runScenario passes vac as vacationsOnly too
    stats.floorHits += fl.length;
    fl.forEach(h => failures.push(`${label}: FLOOR ${h}`)); // every scenario, always (decisions 1 + rule 1)
    // Rule 2 — every scenario, every roll (no holidays here, so nothing is designed)
    const rf = ruleFindings(sched, MONDAY_KEYS, { seed: null, pins: {}, designedRuns: new Set(), flexIds: [FAKID] });
    stats.hard += rf.hard.length;
    rf.hard.forEach(h => failures.push(`${label}: RULE 2 two overnights in a row — ${h}`));
    stats.strain[rf.partner] = (stats.strain[rf.partner] || 0) + 1;
    stats.ladder[rf.ladder] = (stats.ladder[rf.ladder] || 0) + 1;
    if (opts.perfect && (rf.partner || rf.flex || rf.ladder || rf.lastResort.length)) failures.push(`${label}: a clean period must have no strain and no bend — ${rf.items.join(", ")}${rf.lastResort.length ? "; last resort " + rf.lastResort : ""}`);
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
//                   past-year term differentiates surgeons.
//      cleanProxy — WITHOUT yearCounts (the pre-wiring proxy fallback path,
//                   priorYearScore = multi-year/2). Locks the fallback.
//    Since 2026-10-12 a clean period must also have NO strain and NO bend
//    (the search stops on a perfect schedule — clean periods are unchanged).
const clean = runScenario("clean", {}, { perfect: true, maxSpread: { dc: 0, wknd: 0, total: 0 } }, COUNTS_1YR);
const cleanProxy = runScenario("cleanProxy", {}, { perfect: true, maxSpread: { dc: 0, wknd: 0, total: 0 } });

// B: realistic vacations — three surgeons, one week each, spread out. The
//    floor and rule 2 hold, fairness stays within off-by-one bounds.
//    (History: before the N10 fix of 2026-07-02 the validation pass repaired
//    hard-rule conflicts without a vacation check and ~15% of rolls put a
//    surgeon on the Mon/Tue night of their own vacation. Do not flip it back.)
const LIGHT_VACATIONS = {
  s1: [["2026-01-12", "2026-01-18"]],
  s3: [["2026-02-16", "2026-02-22"]],
  s5: [["2026-03-23", "2026-03-29"]],
};
const light = runScenario("vacation", LIGHT_VACATIONS, { maxSpread: { dc: 2, wknd: 2, total: 3 } }, COUNTS_1YR);

// C: SQUEEZE (hard since 2026-10-11) — a 2-week vacation. Nobody on time off
//    or on the night before it, every slot covered, and rule 2 holds (since
//    2026-10-12 two overnights in a row are the floor, not a bend).
const SQUEEZE_VACATIONS = { s5: [["2026-03-23", "2026-04-05"]] };
const squeeze = runScenario("squeeze", SQUEEZE_VACATIONS, { maxSpread: null }, COUNTS_1YR);

// D: SPACING STRESS (two-sided) — a week-0 DC pool of exactly two surgeons
//    (the other five are vacation-blocked via that week's Saturday, which
//    kills DC eligibility but nothing else), where the seed says X's last
//    service week was 2 weeks back (gap 2 — the "service, one week off,
//    service" pattern) and Z is fully rested:
//      GREEN (real generator): Z takes week 0 in EVERY roll and no schedule
//        has a gap<=MIN_DC_GAP pair (strain item b + the deal's soft floor).
//      RED (floor-stripped generator): X takes week 0 in AT LEAST one roll —
//        the fixture tempts the pick and the floor, not luck, keeps green
//        clean. If red never fires, the fixture is vacuous and the test fails.
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
    if (!g[D_KEYS[0]] || g[D_KEYS[0]].dayCall !== Z) failures.push(`stress roll ${roll}: week 0 DC is ${g[D_KEYS[0]] && g[D_KEYS[0]].dayCall} — the spacing rule should have left only ${Z}`);
    const gv = gapStatsOf(g, D_KEYS, seed).violations;
    if (gv > 0) failures.push(`stress roll ${roll}: ${gv} gap<=${MIN_DC_GAP} pair(s) with the spacing rule active`);
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
//    ONLY, never `vacationsOnly` (the trailing-edge map). SIX Silvis primary
//    days, one of every kind that matters, all inside MONDAYS (2026-01-05 …
//    04-06) and each in a week where NO OTHER surgeon is blocked:
//      2026-03-02  Mon  — DC of 03-02's week and Mon night blocked; the
//                         weekend BEFORE (Sun 03-01 ends 07:00 Mon) allowed.
//      2026-01-20  Tue  — a SERVICE-WEEK Tuesday (Mon 01-19's week) → FAK may
//                         not be DC that week, and not Tue night
//      2026-02-11  Wed  — a plain weeknight → FAK may not be Wed night that
//                         week (and not DC that week: Wed is a service day)
//      2026-02-22  Sun  — the weekend of 02-16 blocked (Sun 07:00→Mon 07:00
//                         is its second leg); and since 2026-10-12 (rule 1)
//                         the service week of 02-16 too — its surgeon must be
//                         free that Sunday
//      2026-03-13  Fri  — a Friday → FAK may not be the weekend of 03-09's week
//                         (Fri night is the weekend's first leg) nor DC
//      2026-03-28  Sat  — DC of 03-23 blocked (Sat 07:00→Sun 07:00 is the
//                         service week's); the weekend of 03-23 ALLOWED —
//                         a Saturday must never over-block the weekend
//    The overlap table is RE-STATED here on purpose (not generator.js).
//    GREEN: with the days in `vac`, FAK holds none of the overlapping slots in
//    any roll, AND every NEIGHBOR slot the contract leaves open (the night
//    before a Silvis day, the weekend before a Silvis Monday, the service week
//    starting the Monday a Silvis Sunday ends, the weekend around a Silvis
//    Saturday) is still given to him at least once — each separately, so an
//    over-block on any single leg fails.
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
      // service week: Mon..Sun (offsets 0..6 — the Sunday is rule 1, 2026-10-12)
      if (wk.dayCall === id && [0, 1, 2, 3, 4, 5, 6].some(o => dayOf(o) === D)) hits.push({ day: D, mondayStr: m, slot: "dayCall" });
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
    ["2026-02-23", "dayCall", "service week starting the Monday a Silvis Sunday ends (07:00)"],
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

// F: LIVE PERIOD — the real next period (14 weeks from 2026-11-16) on its live
//    inputs (test/fixtures/generator-live-2026-11-16.json: codes + dates only)
//    PLUS the two locks of the owner's brief of 2026-10-12 (owner 2026-10-12):
//      - FAK on Thu 2/11 — the live pending lock (Faraz leaves it in place);
//      - DJA on the weekend 2/12–2/14 — as a LOCK too: no holiday convention
//        pre-assigns that weekend (2/12–14 has no holiday card), so a lock
//        is the only way the generator can hold it.
//    Each roll is the app's own search (createScheduleSearch) for
//    LIVE_PROPOSALS schedules — about what the app's 10-second search checks
//    on a phone. Every roll must:
//      - keep the FLOOR: nobody on time off or the night before a vacation,
//        the service-week surgeon free that Sunday (rule 1: ARW's 2/1 and
//        REH's 1/25 service weeks are out), no slot empty, both locks held;
//      - never put anyone on two overnights in a row (rule 2) outside the
//        designed runs — FAK's Christmas, Thu 12/24 → Sun 12/27 — and never
//        need FAK's last resort here (the oracle covers the period without);
//      - give the card eves as regular nights and FAK Christmas week whole;
//      - agree with the test's own strain and bend count (both ways);
//      - cost at least the oracle's exact minimum ladder (test/bend-oracle.js,
//        rules 1–2 restated there) — a lower cost means a miscount.
//    And over all rolls (the brief's distributions):
//      - service weeks 2 each (Δ0) and weekends 2 each (Δ0) in ≥ 90%;
//      - partner strain ≤ 1 (the minimum — the CP-SAT benchmark has 1) in ≥ 90%;
//      - bends no worse than the BENCHMARK's (CP-SAT v3, owner 2026-10-12:
//        test/fixtures/benchmark-2026-11-16-v3.json), scored by the app's own
//        listScheduleBends on the benchmark loaded through the PR 1 loader
//        (validateScheduleJson + shapeScheduleWeeks), in ≥ 90% of rolls.
//    The loaded benchmark itself must list, in Needs your OK, KJH's strain
//    (service weeks two weeks apart, 11/2 & 11/16 — across the seam) as the
//    only partner strain, FAK's items as FAK's, its six bends, and nothing
//    that breaks a rule.
function runLive() {
  const L = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "generator-live-2026-11-16.json"), "utf8"));
  const failures = [];
  const S = L.surgeons, ids = S.map(s => s.id), code = Object.fromEntries(S.map(s => [s.id, s.name])), byCode = Object.fromEntries(S.map(s => [s.name, s.id]));
  const P = byCode;
  const keys = L.mondays, mondays = keys.map(parse);
  const LOCKS = [{ mondayStr: "2027-02-08", slot: "thu", surgeonId: P.FAK }, { mondayStr: "2027-02-08", slot: "wknd", surgeonId: P.DJA }];
  const args = [S, mondays, L.avail, new Set(L.backupMondays), L.priorCounts, L.prefs, new Set(L.fierceBackupMondays), L.holAssignments, LOCKS, L.prevWeekSeed, L.vacationsOnly, L.yearCounts];
  // The designed holiday patterns, restated from the 2026 cards (Thanksgiving A=MCC B=RPC eve RPC;
  // Christmas FAK; New Year's A=REH B=DJA eve DJA) — a pair of these is never a bend.
  const LIVE_PINS = {
    "2026-11-23": { dayCall: P.MCC, thu: P.MCC, wed: P.RPC, wknd: P.RPC },
    "2026-12-21": { dayCall: P.FAK, thu: P.FAK, wknd: P.FAK },
    "2026-12-28": { dayCall: P.REH, thu: P.REH, wed: P.DJA, wknd: P.DJA },
  };
  // Rule 2's designed runs on these cards: only Christmas has a card's Night
  // Before followed by its own 24h by the same surgeon — FAK's Thu 12/24 →
  // Fri 12/25 → Sat 12/26 (service) → Sun 12/27 (weekend). Thanksgiving's
  // and New Year's eves (RPC, DJA) are followed by someone else's 24h.
  const DESIGNED_RUNS = new Set(["2026-12-24", "2026-12-25", "2026-12-26"].map(d => d + "|" + P.FAK));
  const ruleCtx = { seed: L.prevWeekSeed, pins: LIVE_PINS, designedRuns: DESIGNED_RUNS, flexIds: [P.FAK] };
  const lsbCtx = { surgeons: S, mondays, vac: L.avail, vacationsOnly: L.vacationsOnly, holAssignments: L.holAssignments, prevWeekSeed: L.prevWeekSeed, locks: LOCKS };
  // ── the oracle's exact minimum ladder (rules 1–2, the locks, FAK's last resort off) ──
  const lockPins = JSON.parse(JSON.stringify(LIVE_PINS)); lockPins["2027-02-08"] = { thu: P.FAK, wknd: P.DJA };
  const designedPairs = [];
  for (const m in LIVE_PINS) { const k = Object.keys(LIVE_PINS[m]); for (let i = 0; i < k.length; i++) for (let j = i + 1; j < k.length; j++) if (LIVE_PINS[m][k[i]] === LIVE_PINS[m][k[j]]) designedPairs.push([m, k[i], k[j]]); }
  const t0 = Date.now();
  const best = oracle.minBendCost({ ids, mondays: keys, avail: L.avail, vacOnly: L.vacationsOnly, pins: lockPins, designedPairs, seed: { dayCall: L.prevWeekSeed.dayCall, wknd: L.prevWeekSeed.wknd }, rule2: true, flex: [P.FAK] });
  const oracleMs = Date.now() - t0;
  if (best.cost !== 152) failures.push(`live: the oracle's minimum is ${best.cost}, expected 152 (rules 1–2, the two locks) — the fixture or the oracle changed`);
  // ── the benchmark, loaded through the PR 1 loader and scored by the app ──
  const B = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "benchmark-2026-11-16-v3.json"), "utf8"));
  const v = validateScheduleJson(B, keys, ids, code);
  let benchBend = Infinity, bench = null;
  if (!v.ok) failures.push(`live: the benchmark does not load — ${v.error}`);
  else {
    const shaped = shapeScheduleWeeks(v.weeks, S, new Set(L.backupMondays), new Set(L.fierceBackupMondays), L.holAssignments);
    bench = listScheduleBends(shaped, lsbCtx);
    benchBend = bench.cost;
    const own = ruleFindings(shaped, keys, ruleCtx);
    const kinds = (k) => bench.items.filter(it => it.kind === k);
    const broken = bench.items.filter(it => ["lock", "empty", "timeoff", "hard", "lastResort", "error"].includes(it.kind));
    if (broken.length) failures.push(`live: the benchmark breaks a rule in Needs your OK — ${broken.map(it => it.text).join(" | ")}`);
    const strain = kinds("strain").map(it => it.text);
    if (JSON.stringify(strain) !== JSON.stringify(["KJH: service weeks two weeks apart, 11/2 & 11/16"])) failures.push(`live: the benchmark's partner strain should be KJH's 11/2 & 11/16 only — ${JSON.stringify(strain)}`);
    if (kinds("flexStrain").some(it => it.who !== P.FAK) || !kinds("flexStrain").length) failures.push(`live: the benchmark's flexible strain should be FAK's (back-to-back weekends 2/5–7 and 2/13) — ${JSON.stringify(kinds("flexStrain").map(it => it.text))}`);
    const bends = kinds("bend").map(it => `${code[it.who]} ${it.key} ${it.mondayStr}`).sort();
    const WANT = ["ARW svcPlus 2027-02-15", "FAK nightsApart 2027-02-15", "FAK svcPlus 2027-02-08", "FAK wkndThenSvc 2027-02-08", "KJH monWknd 2027-01-04", "MCC nightsApart 2027-02-08"];
    if (JSON.stringify(bends) !== JSON.stringify(WANT)) failures.push(`live: the benchmark's bends should be the owner's six (195) — ${JSON.stringify(bends)}`);
    if (bench.counts.ladder !== 195 || bench.cost !== 195 + FLEX_STRAIN_COST * own.flex) failures.push(`live: the benchmark's bend cost is ${bench.cost} (ladder ${bench.counts.ladder}), expected the owner's 195 + FAK's strain`);
    if (own.partner !== bench.tiers.strain || own.bend !== bench.cost || own.hard.length !== 0) failures.push(`live: the test and listScheduleBends disagree on the benchmark — test strain ${own.partner} bend ${own.bend} hard ${own.hard.length} vs list ${bench.tiers.strain} / ${bench.cost}`);
  }
  // ── the rolls ──
  const EVES = [["2026-11-23", "wed", "RPC", "2026-11-25"], ["2026-12-21", "thu", "FAK", "2026-12-24"], ["2026-12-28", "wed", "DJA", "2026-12-30"]];
  const holder = (wk, s) => !wk ? null : s === "dayCall" ? (wk.dayCall || null) : ((wk.nights && wk.nights[s]) || null);
  const H = () => ({});
  const stats = { timeOff: 0, empty: 0, eves: EVES.map(() => 0), xmas: 0, locks: 0, ms: 0, checked: 0, starts: 0, svcHist: H(), wkndHist: H(), strainHist: H(), bendHist: H(), totHist: H(), ladderMin: Infinity, sundayARW: 0, sundayREH: 0 };
  const inc = (h, k) => { h[k] = (h[k] || 0) + 1; };
  for (let roll = 0; roll < LIVE_ROLLS; roll++) {
    const t = Date.now();
    const search = createScheduleSearch(...args, {});
    search.run({ proposals: LIVE_PROPOSALS });
    const sched = search.best(), st = search.status();
    stats.ms += Date.now() - t; stats.checked += st.checked; stats.starts += st.starts;
    const label = `live roll ${roll}`;
    const hits = floorHits(sched, keys, L.avail, L.vacationsOnly);
    stats.timeOff += hits.length; hits.forEach(h => failures.push(`${label}: ${h.replace(/\bs\d\b/g, x => code[x] || x)}`));
    keys.forEach(m => oracle.SLOTS.forEach(s => { if (!holder(sched[m], s)) { stats.empty++; failures.push(`${label}: ${m} ${s} EMPTY`); } }));
    if (code[sched["2027-02-01"]?.dayCall] === "ARW") stats.sundayARW++;
    if (code[sched["2027-01-25"]?.dayCall] === "REH") stats.sundayREH++;
    if (sched["2027-02-08"]?.nights?.thu === P.FAK && sched["2027-02-08"]?.nights?.wknd === P.DJA) stats.locks++; else failures.push(`${label}: a lock was dropped — Thu 2/11 ${code[sched["2027-02-08"]?.nights?.thu]}, weekend 2/12–14 ${code[sched["2027-02-08"]?.nights?.wknd]}`);
    EVES.forEach(([m, k, c, d], i) => {
      if (code[sched[m]?.nights?.[k]] === c) stats.eves[i]++; else failures.push(`${label}: eve ${d} (${k} of ${m}) is ${code[sched[m]?.nights?.[k]] || "empty"}, the card says ${c}`);
      keys.forEach(mm => { if (sched[mm]?.holidayCoverage && sched[mm].holidayCoverage[d]) failures.push(`${label}: a holidayCoverage row sits on the eve ${d}`); });
    });
    const x = sched["2026-12-21"];
    if (x && code[x.dayCall] === "FAK" && code[x.nights?.thu] === "FAK" && code[x.nights?.wknd] === "FAK") stats.xmas++;
    else failures.push(`${label}: Christmas week is ${code[x?.dayCall]}/${code[x?.nights?.thu]}/${code[x?.nights?.wknd]} (service/Thu/weekend), not FAK's`);
    const own = ruleFindings(sched, keys, ruleCtx);
    own.hard.forEach(h => failures.push(`${label}: RULE 2 two overnights in a row — ${h.replace(/\bs\d\b/g, x => code[x] || x)}`));
    if (own.lastResort.length) failures.push(`${label}: FAK's last resort used (${own.lastResort.join(", ")}) — the oracle covers this period without it`);
    const lst = listScheduleBends(sched, lsbCtx);
    if (lst.tiers.strain !== own.partner || lst.cost !== own.bend || lst.counts.hard !== own.hard.length || lst.counts.lastRes !== own.lastResort.length)
      failures.push(`${label}: listScheduleBends disagrees with the test — strain ${lst.tiers.strain} vs ${own.partner}, bend ${lst.cost} vs ${own.bend} (${own.items.join(", ")}), hard ${lst.counts.hard} vs ${own.hard.length}`);
    if (own.ladder < best.cost) failures.push(`${label}: ladder cost ${own.ladder} is BELOW the oracle's exact minimum ${best.cost} — a bend is being missed`);
    stats.ladderMin = Math.min(stats.ladderMin, own.ladder);
    const c = countShifts(sched, keys);
    inc(stats.svcHist, spread(c, "dc")); inc(stats.wkndHist, spread(c, "wknd")); inc(stats.totHist, spread(c, "total"));
    inc(stats.strainHist, own.partner); inc(stats.bendHist, own.bend);
    if (failures.length > 25 && !process.env.LIVE_ALL_ROLLS) break;
  }
  const rolled = Object.values(stats.svcHist).reduce((a, b) => a + b, 0);
  if (rolled === LIVE_ROLLS) {
    const need = Math.ceil(0.90 * LIVE_ROLLS), sum = (h, ok) => Object.entries(h).filter(([k]) => ok(Number(k))).reduce((a, [, n]) => a + n, 0);
    if ((stats.svcHist[0] || 0) < need) failures.push(`live: service weeks 2 each (Δ0) in only ${stats.svcHist[0] || 0}/${LIVE_ROLLS} rolls (need ≥ 90%) — ${JSON.stringify(stats.svcHist)}`);
    if ((stats.wkndHist[0] || 0) < need) failures.push(`live: weekends 2 each (Δ0) in only ${stats.wkndHist[0] || 0}/${LIVE_ROLLS} rolls (need ≥ 90%) — ${JSON.stringify(stats.wkndHist)}`);
    if (sum(stats.strainHist, k => k <= 1) < need) failures.push(`live: partner strain ≤ 1 in only ${sum(stats.strainHist, k => k <= 1)}/${LIVE_ROLLS} rolls (need ≥ 90%) — ${JSON.stringify(stats.strainHist)}`);
    if (sum(stats.bendHist, k => k <= benchBend) < need) failures.push(`live: bends no worse than the benchmark's ${benchBend} in only ${sum(stats.bendHist, k => k <= benchBend)}/${LIVE_ROLLS} rolls (need ≥ 90%) — ${JSON.stringify(stats.bendHist)}`);
  }
  return { name: "live", failures, stats, rolls: LIVE_ROLLS, oracleCost: best.cost, oracleMs, benchBend, bench };
}
const live = runLive();

// G: RULE 1 two-sided (2026-10-12) — a week-0 service-week pool of exactly
//    two surgeons (the other five are blocked on that week's Saturday), where
//    X is off on that week's SUNDAY and Z is free all week. Nothing else
//    tells them apart:
//      GREEN (real generator): Z holds week 0's service week in EVERY roll.
//      RED (a generator whose service week is checked Mon–Sat only, the rule
//        before 2026-10-12): X holds it in at least one roll — the fixture
//        tempts the pick, and the Sunday rule is what stops it.
function runSundayControl() {
  const X = "s2", Z = "s3";
  const G_MONDAYS = buildMondays("2026-01-05", 6), G_KEYS = G_MONDAYS.map(fmt);
  const vac = { [X]: [["2026-01-11", "2026-01-11"]] }; // Sun of week 0
  for (const id of IDS) if (id !== X && id !== Z) vac[id] = [["2026-01-10", "2026-01-10"]]; // Sat of week 0
  const stripped = loadSundayStripped();
  const failures = [];
  let fired = 0;
  for (let roll = 0; roll < ROLLS; roll++) {
    const g = generate(SURGEONS, G_MONDAYS, vac, new Set(), {}, {}, new Set(), null, [], null, vac, COUNTS_1YR);
    if (!g[G_KEYS[0]] || g[G_KEYS[0]].dayCall !== Z) failures.push(`sunday roll ${roll}: week 0's service week is ${g[G_KEYS[0]] && g[G_KEYS[0]].dayCall} — its surgeon must be free that Sunday, which leaves only ${Z}`);
    floorHits(g, G_KEYS, vac, vac).forEach(h => failures.push(`sunday roll ${roll}: FLOOR ${h}`));
    const r = stripped.generate(SURGEONS, G_MONDAYS, vac, new Set(), {}, {}, new Set(), null, [], null, vac, COUNTS_1YR);
    if (r[G_KEYS[0]] && r[G_KEYS[0]].dayCall === X) fired++;
    if (failures.length > 25) break;
  }
  if (fired === 0) failures.push(`sunday: the Mon–Sat-only generator NEVER gave ${X} week 0 in ${ROLLS} rolls — the fixture is vacuous, tighten it`);
  return { name: "sunday", failures, fired, rolls: ROLLS };
}
const sunday = runSundayControl();

// ─── Report ───
for (const r of [clean, cleanProxy, light, squeeze]) {
  const s = r.stats;
  const gaps = Object.keys(s.gapHist).map(Number).sort((a, b) => a - b).map(g => `${g}:${s.gapHist[g]}`).join(" ");
  console.log(`${r.name.padEnd(9)} ${ROLLS} rolls — max spreads dc=${s.maxSpread.dc} wknd=${s.maxSpread.wknd} total=${s.maxSpread.total}; ` +
    `wknd→Tue (soft) ×${s.wkndThenTue}; time-off placements (floor) ×${s.floorHits}; two overnights in a row ×${s.hard}; ` +
    `strain ${JSON.stringify(s.strain)}; ladder bends ${JSON.stringify(s.ladder)}; SW gap histogram {${gaps || "no repeats"}}; spacing violations (gap<=${MIN_DC_GAP}) ×${s.spacingViolations}`);
}
console.log(`stress    ${ROLLS} rolls — spacing held every roll; floor-stripped control picked the gap-2 surgeon in ${stress.redFired}/${ROLLS} rolls`);
if (live.stats) {
  const s = live.stats;
  console.log(`live      ${live.rolls} rolls × ${LIVE_PROPOSALS.toLocaleString("en-US")} schedules (+ locks FAK Thu 2/11, DJA weekend 2/12–14) — time-off placements ×${s.timeOff}; empty slots ×${s.empty}; locks held ${s.locks}/${live.rolls}; eves RPC/FAK/DJA ${s.eves.join("/")}; Christmas week FAK ${s.xmas}/${live.rolls}; ARW svc 2/1 ×${s.sundayARW}, REH svc 1/25 ×${s.sundayREH}`);
  console.log(`          service-week spread ${JSON.stringify(s.svcHist)}; weekend spread ${JSON.stringify(s.wkndHist)}; partner strain ${JSON.stringify(s.strainHist)}; bend cost ${JSON.stringify(s.bendHist)} vs the benchmark's ${live.benchBend}; total spread ${JSON.stringify(s.totHist)}`);
  console.log(`          oracle's exact minimum ladder ${live.oracleCost} (${live.oracleMs} ms; lowest rolled ${s.ladderMin}); ${Math.round(s.ms / live.rolls)} ms/roll; ${Math.round(s.checked / live.rolls).toLocaleString("en-US")} schedules checked per roll, ${Math.round(s.starts / live.rolls)} fresh starts`);
  if (live.bench) console.log(`          benchmark (loaded through the PR 1 loader): bend cost ${live.bench.cost} = ladder ${live.bench.counts.ladder} + FAK strain; partner strain ${live.bench.tiers.strain}; items: ${live.bench.items.filter(i => i.kind !== "crowded").map(i => i.kind + " " + i.text.split(" (")[0]).join(" | ")}`);
}
console.log(`sunday    ${sunday.rolls} rolls — the Sunday-off surgeon never held the service week; the Mon–Sat-only control gave it to them in ${sunday.fired}/${sunday.rolls} rolls`);
console.log(`silvis    ${ROLLS} rolls — FAK off every overlapping slot (6 Silvis days: Mon/Tue/Wed/Sun/Fri/Sat); control without them put him on one in ${silvis.redFired}/${ROLLS} rolls; open neighbor legs given to him: ${silvis.given}`);

const failures = [...clean.failures, ...cleanProxy.failures, ...light.failures, ...squeeze.failures, ...stress.failures, ...silvis.failures, ...live.failures, ...sunday.failures];
if (failures.length) {
  console.error(`\nFAIL — ${failures.length} violation(s):`);
  failures.slice(0, 25).forEach(f => console.error("  • " + f));
  if (failures.length > 25) console.error(`  … and ${failures.length - 25} more`);
  process.exit(1);
}
console.log("PASS — Δ0 fairness and no strain or bend on clean periods; the floor (time off, the service week's Sunday) and no two overnights in a row in every roll of every scenario; the live period at the brief's distributions and no worse than the benchmark.");
process.exit(0);
