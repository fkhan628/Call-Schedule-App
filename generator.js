// DSG Call Schedule — Schedule Generator & Holiday Logic

/* ─── PIPELINE & RULES MAP — the one top-level narrative (distilled from the
   retired CALL-SCHEDULE-APP-REFERENCE.md §8, 2026-08-08; archived in the
   private repo's docs/ history). Per-phase detail lives at each phase's own
   comment; the hard rules are ALSO pinned executably in
   test/generator-regression.js, which re-states them independently so a
   generator bug can't hide in shared code.

   ENTRY: generate(surgeons, mondays, vac, backupMondays, priorCounts,
   preferences, fierceBackupMondays, holAssignments, locks, prevWeekSeed,
   vacationsOnly, yearCounts). Deterministic per run, randomized across runs;
   a BEST-OF-50 wrapper generates candidates and keeps the fairest by the
   tiered score (catalog #4 below), early-exiting on a perfect score.

   PIPELINE (one candidate, generateOnce):
     initial deal (soft prefs applied; holiday surgeons reserved via preAssign)
     → fixup passes (repair hard-rule violations the deal created)
     → VALIDATION PASS (~line 785: remaining hard-rule conflicts fixed via
       swaps, every repair through canTakeSlot — the 2026-07 vacation-overlap
       fix lives here)
     → PHASE 1 (service weeks driven to ≤1 apart, high→low reassignment)
     → PHASE 1B (weekends ≤1 apart via 2-hop chain swaps; FINAL — Phase 2
       moves weeknights only, so it can never un-spread weekends)
     → PHASE 2 (raw headcount PRIMARY, weighted burden tiebreak only).

   canTakeSlot(...) is the single eligibility chokepoint — every assignment
   and every rebalancing move passes through it.

   HARD RULES (enforced; bend only if a week otherwise can't be covered):
     - No Service Week + a weeknight for the same surgeon in one week.
     - No back-to-back weeknights (Mon then Tue, etc.).
     - Recovery: weekend surgeon doesn't get the following Mon/Tue night;
       Thu night + that same weekend is blocked (Mon/Tue/Wed + weekend OK).
     - Holiday coverage is 24h by one surgeon, reserved across that week and
       never moved by a rebalancing pass.
     - Never schedule over VACATION (matched to each shift's real hours).
       NO-CALL differs on the trailing edge only: on call the night BEFORE a
       no-call day is allowed; before a vacation day it is not — that is why
       the separate vacationsOnly map is threaded through generate().
       Since 2026-10-11 this is the FLOOR (slotFloorOk), never bent: when a
       week can't be covered under the hard rules above, the generator takes
       the MILDEST bend of them by the BEND_COST table (an exact search over
       the squeezed weeks) and listScheduleBends lists it for the preview's
       "Needs your OK" box. Card eves on Mon–Thu are pinned regular nights;
       Christmas week is FAK's (service week, Eve night, Day, weekend).
     - Manual locks are honored exactly and skipped by every pass. A
       WEEKNIGHT lock bypasses availability (honored even over a listed
       vacation / no-call / Silvis day); a Service-Week or Weekend lock on a
       surgeon the availability map blocks that week is DROPPED silently by
       the pre-assignment step — the app's lock UI says so at lock time and
       doGenerate toasts every lock the result did not honor (2026-09-24).
       (The lock UI's "dc" slot key is normalized to "dayCall" on
       application.)
     - silvisBusy (2026-09-24, rule as DATA — config blob silvisRule
       { enabled, code:"FAK" }): FAK is also primary trauma call at Silvis
       (separate app + Supabase project). On a Silvis PRIMARY day D (one 24h
       shift, 07:00 D → 07:00 D+1) no Davenport call of his may overlap:
       the night OF D, the service week containing D (Mon..Sat), the
       weekend when D is its Friday or Sunday, a holiday 24h on D. NOTHING
       in this file implements it: the app (index-source.html doGenerate)
       folds his Silvis primary days — from the silvis_feed cache this
       project keeps, written only by the silvis-feed edge function — into
       the `vac` availability map as single-day [D,D] ranges, which is
       exactly NO-CALL semantics (the night BEFORE D, ending 07:00 D, stays
       allowed; never into vacationsOnly). Like a vacation it is part of the
       FLOOR (slotFloorOk, 2026-10-11): nothing in this file places him on
       it — a squeezed week bends a softer rule instead (BEND_COST). Silvis BACKUP
       days are standby and never block (soft note only). Pinned two-sided
       in test/generator-regression.js scenario E; the app-side refusals
       (editor, trade accept, swaps, locks) in test/sync-guards.js §O.
       GENERATION ORDER across the two apps: whichever app generates first
       wins the day — the second respects the other's feed (Silvis reads
       this project's schedule_weeks the same way). Silvis generates rolling
       3-month periods (next: Feb–Apr 2027, offers close 12/21); Silvis
       days also move by trade/claim after publish, so the mechanism is
       the continuous feed refresh (app load + Refresh button) plus the
       Warnings line, not a one-time check at generation.

   SOFT RULES (preferred against at the deal; fairness passes may override):
     Service week (its Saturday) → next weekend; back-to-back weekends;
     weekend → next Tuesday night; same surgeon's service weeks ≤ MIN_DC_GAP
     (= 2) weeks apart — i.e. service → one week off → service (soft floor at
     the DC pick, both branches, 2026-08-31; a ×50 scoreOf term steers
     best-of-50 away from candidates where the floor's fallback fired or a
     fairness pass recreated a tight pair).

   FAIRNESS OBJECTIVE: raw shift count is PRIMARY — the metric people
   actually perceive by tallying the calendar. Per-type tightness first
   (service weeks ≤1, weekends ≤1), then total ≤1; weighted burden ONLY
   breaks ties among equal raw counts and can never widen a raw spread. A
   clean 14-week period (14 SW / 14 wknd / 56 nights ÷ 7 = 2/2/8) can hit
   every goal at once; uneven periods keep SW/weekends tightest and absorb
   the off-by-one in weeknights.

   HOLIDAYS (getHolidays + the app's holidayAssignments): each holiday has
   surgeon A (the 24h holiday day) and B (the surrounding day-after/night —
   collapsed pairs allowed, surgeonB:null). Monday holidays: A covers the
   Monday 24h, B the night before; the service-week doctor starts Tuesday.
   Friday holidays: Fri (A) + Sat (B). CHRISTMAS STANDING RULE (2026-08):
   FAK covers BOTH Eve and Day, capped at exactly two days, with a fail-LOUD
   lock — an unresolvable designated surgeon leaves Christmas unassigned and
   warns, never silently rotates. Major/minor pools are tracked separately;
   pair fairness is tenure-normalized by dated ELIGIBLE holidays
   (holidayRate in config.js; zero-eligible → 0, never NaN).
   ─── */

/* ─── WEIGHTING & SCORING SCHEMES — one catalog so no future reader has to
   reverse-engineer which number governs what. FOUR distinct weightings live in
   this file (a fifth — billing — lives in the app UI, not here). They are
   INTENTIONALLY different; each answers a different question. Anchors are the
   function/variable names; line numbers are approximate and will drift.

   1. ASSIGNMENT PRIORITY — `priority(id)` (~line 191, inside generateOnce).
      Greedy "who gets the next shift". LOWER = more deserving.
        0.85·periodShifts  +  0.10·(priorYearScore/20)  +  0.05·(priorMultiScore/40)
      (within-period count is the primary goal; past-year 10%; multi-year 5%)
      The 10% term reads DEDICATED 1-year input (yearCounts — wired
      2026-08-06; the app passes live year1Counts). Without it the old
      multi-year/2 proxy applies, under which the 10% term was the
      multi-year signal again and no real recency weighting existed.

   2. HISTORICAL BURDEN — `priorMultiScore[id]` = dc·7 + nights·1 + wknd·3
      (~line 149, inside generateOnce). The "old formula." Feeds the 5% term
      of #1 and seeds the mutable `burden` map that the weekend-swap post-pass
      increments (7/3/1) to reason about swaps via delta comparisons.
      Same 7/1/3 numbers as the UI billing scheme, DIFFERENT purpose.

   3. RAW-COUNT PRIMARY + WEIGHTED TIEBREAK — the Phase-2 rebalance pass:
      `rawCount(id)` / `weightedTotal(id)` (~line 1187, inside generateOnce).
        rawCount(id)      = dc + nights + wknd           (PRIMARY — driven tight)
        weightedTotal(id) = dc·6 + nights·1 + wknd·2     (SW×6/wknd×2/night×1;
                                                          TIEBREAK among equal raw)
      Surgeons perceive raw headcount; weighted only breaks ties so nobody
      quietly carries the heaviest mix while looking even on count.

   4. BEST-OF-N CANDIDATE SCORE — `scoreOf(sched)` (inside the
      generate() best-of-50 wrapper). Picks the fairest candidate schedule.
      Lexicographic via powers of ten (LOWER = fairer):
        droppedLocks·1e9  +  bendCost·1e6   (2026-10-11: never trade a lock
                                             or a bend for fairness)
        + spread(combinedServiceWeeks)·10000
        + spread(weekends)·1000  + spread(total)·100
        + gapViolations·50  (service-week pairs ≤ MIN_DC_GAP apart, seam-aware)
        + spread(1stCallServiceWeeks)·10  + spread(1stCallWeekends)·1
      Note gapViolations is a COUNT, not a spread: 2+ violations outweigh one
      total-spread step — accepted; in practice it is 0 or 1.

   NOT here: BILLING (SW=7 / night=1 / wknd=3), used only for the pay/'$'
   display in the app UI. Equal weights to #2 but computed and shown
   separately — don't unify them.
   ─── */

/* ═══ Schedule Generator (surgeons only — APPs are manual) ═══ */

// Holiday definitions — returns holidays for a given year
function getHolidays(year) {
  // Thanksgiving = 4th Thursday of November
  const nov1 = new Date(year, 10, 1);
  let thxDay = 1 + ((4 - nov1.getDay() + 7) % 7);
  thxDay += 21;
  const thx = fmt(new Date(year, 10, thxDay));
  // Memorial Day = last Monday of May
  const may31 = new Date(year, 4, 31);
  let memDay = 31 - ((may31.getDay() - 1 + 7) % 7);
  const mem = fmt(new Date(year, 4, memDay));
  // Labor Day = first Monday of September
  const sep1 = new Date(year, 8, 1);
  let labDay = 1 + ((1 - sep1.getDay() + 7) % 7);
  const lab = fmt(new Date(year, 8, labDay));

  return {
    major: [
      { name: "New Year's", date: fmt(new Date(year, 11, 31)), emoji: "🎆", startDate: fmt(new Date(year, 11, 31)), endDate: fmt(new Date(year+1, 0, 1)) },
      { name: "Thanksgiving", date: thx, emoji: "🦃" },
      { name: "Christmas Day", date: fmt(new Date(year, 11, 25)), emoji: "🎄" },
    ],
    minor: [
      { name: "Memorial Day", date: mem, emoji: "🇺🇸" },
      { name: "July 4th", date: fmt(new Date(year, 6, 4)), emoji: "🎆" },
      { name: "Labor Day", date: lab, emoji: "🇺🇸" },
    ]
  };
}

// SOFT FLOOR on service-week spacing (2026-08-31, owner request after two
// gap-2 pairs — RPC 08-17→08-31, REH 10-12→10-26 — both free choices where
// spacing sat 4th in the tiebreak and was never consulted). A surgeon whose
// last service week started ≤ MIN_DC_GAP weeks ago is filtered out of the DC
// pick pool; if that empties the pool the unfiltered pool is used (the same
// filter + if-empty-fallback idiom as dcPoolNoConsec), so vacation-dense
// weeks still generate. MIN_DC_GAP = 2 bans service → one week off → service.
// This is "less of a possibility," not a new hard rule: the fallback may
// still place a gap-2 week, and Phase 1 rebalancing (which only knows the
// consecutive ban via canTakeSlot) may create one — both cases are caught by
// the ×50 gap-violation term in scoreOf, so best-of-50 discards them
// whenever any candidate managed without.
const MIN_DC_GAP = 2;

/* ═══ TIME OFF, HOLIDAY EVES, BENDS (owner decisions 2026-10-11) ═══
   1. Vacation is a hard stop — the FLOOR (slotFloorOk): no shift on a
      vacation / no-call / Silvis-primary day (the merged `vac` map), and no
      overnight ending on a VACATION morning (vacationsOnly): a weeknight is
      blocked if the next day is vacation, the weekend if the next Monday is.
      The service week is checked Mon–Sat (its Saturday 24h is not checked
      against a Sunday vacation start). Nothing in this file may place a
      surgeon below the floor; a slot nobody can take stays EMPTY (null).
      Only a manual lock can (today's lock semantics) — it is then listed.
   2. Holiday eves are real night assignments: a card's "Night Before" row on
      a Mon–Thu night pins that night to the card's eve surgeon (a REGULAR
      night, never a holidayCoverage row — that would take the whole date).
   3. Christmas week = FAK's whole week + Eve (service week, Eve night,
      Christmas Day 24h, Saturday, the weekend).
   When a week can't be covered under the hard rules, the generator takes
   the MILDEST bend by this one table (lowest total wins; ties go to the
   fairness order). Designed holiday patterns (holidayDesign below) are not
   bends. listScheduleBends() lists the bends of ANY schedule — it is
   scoreOf's first tier, the preview's "Needs your OK" box and the tests'. */
const BEND_COST = {
  monWknd: 6,       // weekend surgeon also takes that week's Mon night ("double duty")
  tueWknd: 8,       // a Tue night + that same weekend
  wedWknd: 10,      // a Wed night + that same weekend
  nightsApart: 12,  // two non-consecutive weeknights in one week
  svcThenMon: 30,   // service week → the next Mon night
  wkndThenMon: 40,  // weekend → the next Mon night
  wkndThenSvc: 45,  // weekend → straight into the next service week
  svcThenSvc: 45,   // two service weeks in a row
  backToBack: 50,   // back-to-back weeknights
  thuWknd: 50,      // a Thu night + that same weekend
  svcPlus: 60,      // service-week surgeon also on a weeknight or the weekend
  empty: 400,       // nobody can take the slot
};
const BEND_TEXT = {
  monWknd: "weekend + that week's Mon night (double duty)",
  tueWknd: "Tue night + that same weekend",
  wedWknd: "Wed night + that same weekend",
  nightsApart: "two weeknights in one week",
  svcThenMon: "service week → the next Mon night",
  wkndThenMon: "weekend → the next Mon night",
  wkndThenSvc: "weekend → straight into the next service week",
  svcThenSvc: "two service weeks in a row",
  backToBack: "back-to-back nights",
  thuWknd: "Thu night + that same weekend",
  svcPlus: "service week + a shift the same week",
  empty: "nobody can take it",
};
const BEND_NIGHT_OFF = { mon: 0, tue: 1, wed: 2, thu: 3 };
const BEND_SLOTS = ["dayCall", "mon", "tue", "wed", "thu", "wknd"];

// The FLOOR (decision 1) for one slot. monday: a Date or "YYYY-MM-DD".
function slotFloorOk(id, monday, slot, vac, vacOnly) {
  if (!id) return false;
  const mon = typeof monday === "string" ? parse(monday) : monday;
  const d = (o) => fmt(addD(mon, o));
  const v = vac || {}, vo = vacOnly || v;
  if (slot === "dayCall") { for (let o = 0; o < 6; o++) if (onVac(id, d(o), v)) return false; return true; }
  if (slot === "wknd") return !onVac(id, d(4), v) && !onVac(id, d(6), v) && !onVac(id, d(7), vo);
  const o = BEND_NIGHT_OFF[slot];
  if (o === undefined) return true;
  return !onVac(id, d(o), v) && !onVac(id, d(o + 1), vo);
}

// Same surgeon on two slots of ONE week → its BEND_COST key (null = no bend).
function sameWeekBendKey(a, b) {
  if (a === b) return null;
  if (a === "dayCall" || b === "dayCall") return "svcPlus";
  if (a === "wknd" || b === "wknd") {
    const n = a === "wknd" ? b : a;
    return { mon: "monWknd", tue: "tueWknd", wed: "wedWknd", thu: "thuWknd" }[n] || null;
  }
  return Math.abs(BEND_NIGHT_OFF[a] - BEND_NIGHT_OFF[b]) === 1 ? "backToBack" : "nightsApart";
}
// Same surgeon on slot `a` of week w and slot `b` of week w+1 → BEND_COST key.
function crossWeekBendKey(a, b) {
  if (a === "dayCall" && b === "mon") return "svcThenMon";
  if (a === "wknd" && b === "mon") return "wkndThenMon";
  if (a === "wknd" && b === "dayCall") return "wkndThenSvc";
  if (a === "dayCall" && b === "dayCall") return "svcThenSvc";
  return null;
}

// Designed holiday patterns, from the holiday cards (effectiveHolidayCoverage
// rows): { pins: {mondayStr: {slot: id}}, eves: {mondayStr: {nightKey: id}},
// coverOff: [...] }. A pair of slots both pinned here to the same surgeon is a
// DESIGNED pattern — never a bend, never repaired, never rebalanced:
//   - a Mon–Thu "Night Before" row → that night (decision 2)
//   - a non-eve 24h row on a Mon–Thu → that night; on a Fri (else Sun) → the weekend
//   - a Tue–Fri holiday week's service week → the card's surgeon A
//     (Christmas week → christmasDcId, FAK by the standing rule — decision 3)
//   - a Monday holiday: the PREVIOUS week's service week → A, its weekend → B
// Eves on a Fri or Sun (the weekend slot) keep today's handling (not pinned).
function holidayDesign(holAssignments, mondayStrs, christmasDcId) {
  const pins = {}, eves = {};
  const inPeriod = new Set(mondayStrs || []);
  const mondayOf = (ds) => { const d = parse(ds); const dow = d.getDay(); return fmt(addD(d, dow === 0 ? -6 : 1 - dow)); };
  const pin = (m, slot, id) => { if (!id || !inPeriod.has(m)) return; (pins[m] = pins[m] || {})[slot] = id; };
  if (!holAssignments) return { pins, eves };
  Object.values(holAssignments).forEach(arr => {
    if (!Array.isArray(arr)) return;
    arr.forEach(h => {
      if (!h || !h.date) return;
      const rows = effectiveHolidayCoverage(h) || []; // helpers.js — the Christmas cap applies here too (sync-guards W5)
      const hDow = parse(h.date).getDay();
      const hMon = mondayOf(h.date);
      let wkndRow = null;
      rows.forEach(c => {
        if (!c || !c.date || !c.surgeon) return;
        const dow = parse(c.date).getDay();
        const m = mondayOf(c.date);
        if (c.isEve) {
          if (dow >= 1 && dow <= 4 && inPeriod.has(m)) { pin(m, NIGHT_KEYS[dow - 1], c.surgeon); (eves[m] = eves[m] || {})[NIGHT_KEYS[dow - 1]] = c.surgeon; }
          return;
        }
        if (dow >= 1 && dow <= 4) pin(m, NIGHT_KEYS[dow - 1], c.surgeon);
        else if (dow === 5) wkndRow = { m, id: c.surgeon, fri: true };
        else if (dow === 0 && !(wkndRow && wkndRow.m === m && wkndRow.fri)) wkndRow = wkndRow && wkndRow.m === m ? wkndRow : { m, id: c.surgeon, fri: false };
      });
      if (wkndRow) pin(wkndRow.m, "wknd", wkndRow.id);
      if (hDow >= 2 && hDow <= 5) {
        const dcId = h.name === "Christmas Day" && christmasDcId ? christmasDcId : h.surgeonA;
        pin(hMon, "dayCall", dcId);
      } else if (hDow === 1) {
        const prevM = fmt(addD(parse(hMon), -7));
        pin(prevM, "dayCall", h.surgeonA);
        pin(prevM, "wknd", h.surgeonB);
      }
    });
  });
  return { pins, eves };
}

// Every bend of a schedule — generated or hand-edited. Pure (no clock, no
// state). ctx = { surgeons, mondays (Dates or "YYYY-MM-DD"), vac,
// vacationsOnly, holAssignments, prevWeekSeed, christmasDcId? }. Returns
// { cost, items } — items are { kind: "bend"|"empty"|"timeoff"|"crowded",
// key, cost, who, mondayStr, slots, free, text }. "timeoff" (a lock or a hand
// edit below the floor) and "crowded" (a day with more than 4 surgeons off)
// cost nothing here; they are listed so the scheduler sees them.
function listScheduleBends(sched, ctx) {
  const c = ctx || {};
  const surgeons = c.surgeons || [];
  const ids = surgeons.map(s => s.id);
  const nameOf = (id) => { const s = surgeons.find(x => x.id === id); return s ? s.name : id; };
  const vac = c.vac || {}, vacOnly = c.vacationsOnly || vac;
  const mondayStrs = (c.mondays || Object.keys(sched || {}).sort()).map(m => typeof m === "string" ? m : fmt(m)).filter(m => sched && sched[m]);
  const fakId = c.christmasDcId || (surgeons.find(s => (s.name || "").toUpperCase() === "FAK") || {}).id || null;
  // The design depends only on the cards + the period: cached on ctx (scoreOf reuses one ctx for every candidate).
  const dKey = mondayStrs.join(",");
  if (!c._design || c._designKey !== dKey) { c._design = holidayDesign(c.holAssignments, mondayStrs, fakId); c._designKey = dKey; }
  const design = c._design;
  const pinned = (m, slot, id) => !!(design.pins[m] && design.pins[m][slot] === id);
  const designed = (m1, s1, m2, s2, id) => pinned(m1, s1, id) && pinned(m2, s2, id);
  const holder = (wk, slot) => !wk ? null : slot === "dayCall" ? (wk.dayCall || null) : ((wk.nights && wk.nights[slot]) || null);
  const slotName = (m, slot) => {
    const mon = parse(m);
    const md = (o) => { const d = addD(mon, o); return (d.getMonth() + 1) + "/" + d.getDate(); };
    if (slot === "dayCall") return "service week of " + md(0);
    if (slot === "wknd") return "weekend " + md(4) + "–" + md(6);
    return ["Mon", "Tue", "Wed", "Thu"][BEND_NIGHT_OFF[slot]] + " night " + md(BEND_NIGHT_OFF[slot]);
  };
  const costOnly = !!c.costOnly; // scoreOf / the search: cost + week attribution only
  const freeFor = (m, slot) => costOnly ? [] : ids.filter(id => slotFloorOk(id, m, slot, vac, vacOnly)).map(nameOf);
  const slotType = (slot) => slot === "dayCall" ? "service week" : slot === "wknd" ? "weekend" : ["Mon", "Tue", "Wed", "Thu"][BEND_NIGHT_OFF[slot]] + " night";
  // "(only FAK is free for the service week; also free for the weekend: DJA — any other choice bends more)"
  const whoElse = (who, parts) => {
    if (costOnly) return "";
    const bits = parts.map(([m, slot]) => {
      const others = freeFor(m, slot).filter(n => n !== nameOf(who));
      return others.length ? "also free for the " + slotType(slot) + ": " + others.join(", ") : "only " + nameOf(who) + " is free for the " + slotType(slot);
    });
    const anyOther = parts.some(([m, slot]) => freeFor(m, slot).some(n => n !== nameOf(who)));
    return " (" + bits.join("; ") + (anyOther ? " — any other choice bends more" : "") + ")";
  };
  const items = [];
  const seed = c.prevWeekSeed || null;
  for (let i = 0; i < mondayStrs.length; i++) {
    const m = mondayStrs[i], wk = sched[m];
    // empty slots
    BEND_SLOTS.forEach(slot => {
      if (holder(wk, slot)) return;
      const free = freeFor(m, slot);
      items.push({ kind: "empty", key: "empty", cost: BEND_COST.empty, who: null, mondayStr: m, slots: [slot], free,
        text: costOnly ? "" : `${slotName(m, slot)} is EMPTY — ${free.length ? "everyone free for it is blocked by a harder rule (free: " + free.join(", ") + ")" : "nobody is free for it"}` });
    });
    // below the floor (only a lock or a hand edit can do this) — listed, never costed
    if (!costOnly) BEND_SLOTS.forEach(slot => {
      const id = holder(wk, slot);
      if (id && !slotFloorOk(id, m, slot, vac, vacOnly)) items.push({ kind: "timeoff", key: "timeoff", cost: 0, who: id, mondayStr: m, slots: [slot],
        text: costOnly ? "" : `${nameOf(id)}: ${slotName(m, slot)} — on time off (or the night before a vacation)` });
    });
    // same-week pairs
    for (let a = 0; a < BEND_SLOTS.length; a++) for (let b = a + 1; b < BEND_SLOTS.length; b++) {
      const sa = BEND_SLOTS[a], sb = BEND_SLOTS[b], id = holder(wk, sa);
      if (!id || id !== holder(wk, sb)) continue;
      const key = sameWeekBendKey(sa, sb);
      if (!key || designed(m, sa, m, sb, id)) continue;
      const free = freeFor(m, sb).filter(n => n !== nameOf(id));
      items.push({ kind: "bend", key, cost: BEND_COST[key], who: id, mondayStr: m, slots: [sa, sb], free,
        text: costOnly ? "" : `${nameOf(id)}: ${slotName(m, sa)} + ${slotName(m, sb)} — ${BEND_TEXT[key]}${whoElse(id, [[m, sa], [m, sb]])}` });
    }
    // cross-week pairs (week i-1 → i; the seed stands in for the week before the period)
    const prevM = i > 0 ? mondayStrs[i - 1] : null;
    const prevWk = i > 0 ? sched[prevM] : (seed ? { dayCall: seed.dayCall || null, nights: { wknd: seed.wknd || null } } : null);
    if (prevWk && (i === 0 || Math.round((parse(m) - parse(prevM)) / 864e5) === 7)) { // consecutive weeks only (DST-safe)
      [["dayCall", "mon"], ["wknd", "mon"], ["wknd", "dayCall"], ["dayCall", "dayCall"]].forEach(([sa, sb]) => {
        const id = holder(prevWk, sa);
        if (!id || id !== holder(wk, sb)) return;
        const key = crossWeekBendKey(sa, sb);
        if (!key || (prevM && designed(prevM, sa, m, sb, id))) return;
        items.push({ kind: "bend", key, cost: BEND_COST[key], who: id, mondayStr: m, slots: [sa, sb], prevMondayStr: prevM, free: freeFor(m, sb).filter(n => n !== nameOf(id)),
          text: costOnly ? "" : `${nameOf(id)}: ${prevM ? slotName(prevM, sa) : "the " + (sa === "wknd" ? "weekend" : "service week") + " before the period"} → ${slotName(m, sb)} — ${BEND_TEXT[key]}${whoElse(id, [[m, sb]])}` });
      });
    }
  }
  // days with more than 4 surgeons off
  if (mondayStrs.length && !costOnly) {
    const first = parse(mondayStrs[0]), last = addD(parse(mondayStrs[mondayStrs.length - 1]), 6);
    for (let d = first; d <= last; d = addD(d, 1)) {
      const ds = fmt(d);
      const offIds = ids.filter(id => onVac(id, ds, vac));
      if (offIds.length > 4) items.push({ kind: "crowded", key: "crowded", cost: 0, who: null, mondayStr: null, date: ds, slots: [], free: ids.filter(id => !offIds.includes(id)).map(nameOf),
        text: `${(d.getMonth() + 1) + "/" + d.getDate()}: ${offIds.length} of ${ids.length} surgeons are off (${offIds.map(nameOf).join(", ")})` });
    }
  }
  return { cost: items.reduce((s, it) => s + (it.cost || 0), 0), items };
}

function generateOnce(surgeons, mondays, vac, backupMondays, priorCounts, preferences, fierceBackupMondays, holAssignments, locks, prevWeekSeed, vacationsOnly, yearCounts, floorMemo) {
  // vacOnly = vacation-only ranges (no no-call). Used for "trailing edge" checks:
  // the night or weekend that ENDS the morning of an off day. Group rule (Jun
  // 2026): a surgeon may be on call the night before a NO-CALL day, but NOT the
  // night before VACATION. The merged `vac` (vacation + no-call) still gates the
  // shift's OWN day(s) — you can't be on call during your no-call day itself.
  const vacOnly = vacationsOnly || vac;
  const sched = {};
  const ids = surgeons.map(s=>s.id);
  const nameMap = {}; surgeons.forEach(s => nameMap[s.id] = s.name);

  // Build holiday coverage map from pre-computed coverage arrays
  // { "YYYY-MM-DD": { surgeonId, role, name, type } }
  const holCoverage = {};
  const holByDate = {}; // { "YYYY-MM-DD": { surgeonA, surgeonB, name, type } }
  if (holAssignments) {
    Object.values(holAssignments).forEach(yearArr => {
      if (!Array.isArray(yearArr)) return;
      yearArr.forEach(h => {
        // Store the holiday metadata by date
        holByDate[h.date] = { surgeonA: h.surgeonA, surgeonB: h.surgeonB, name: h.name, type: h.type };
        // Store each coverage day (skip Eve entries — those are display-only, not schedule overrides).
        // The rows come through effectiveHolidayCoverage (helpers.js), which applies the Christmas
        // two-day cap to assignments saved before it.
        effectiveHolidayCoverage(h).forEach(c => {
          if (c.isEve) return; // Eve is informational only — regular schedule stays
          // holiday: the holiday's own name — a multi-day label is only "Fri 24h" / "Sat 24h"
          holCoverage[c.date] = { surgeonId: c.surgeon, role: "holiday_24h", hours: "7a–7a", name: c.label, type: h.type, holiday: h.name };
        });
      });
    });
  }

  // ═══ FAIRNESS TRACKING ═══
  //
  // Goal per Faraz (Apr 2026): within-period shift equality is the PRIMARY
  // objective (85%), past-year totals secondary (10%), multi-year tertiary
  // (5%). "Total shifts" = every assignment counts as 1 (including backup).
  //
  // We track three separate running counters:
  //   periodShifts[id]   — shifts assigned in THIS period only. This drives
  //                        the primary balance — everyone should end near the
  //                        same value. Starts at 0.
  //   priorYear[id]      — 1-year burden from the dedicated yearCounts input
  //                        (falls back to multi-year / 2 when absent).
  //   priorMulti[id]     — multi-year totals (what the old code called burden).
  //                        Now used only as a tertiary tiebreaker.
  //
  // Composite score for assignment decisions:
  //   score = 0.85 * periodShifts[id]
  //         + 0.10 * priorYearScore[id]
  //         + 0.05 * priorMultiScore[id]
  // Lower score = more deserving of the next assignment.
  //
  // For the secondary service-week balance goal, we also track
  // periodServiceWeeks[id] — used as a tiebreaker in DC assignments.
  //
  // We keep dcCt/nCt/wkndCt around for post-optimization weekend swap logic
  // (which balances weekend assignments specifically).
  const dcCt={}; const nCt={}; const wkndCt={}; const offCt={}; const lastPos={};
  const periodShifts = {};        // total shifts assigned in this period
  const periodServiceWeeks = {};  // service weeks assigned in this period
  const priorYearScore = {};      // normalized 1-year burden score
  const priorMultiScore = {};     // normalized multi-year burden score
  // Track last DC week index per surgeon for spacing
  const lastDcWeek = {};
  // Track consecutive night assignments
  const prevNightSurgeon = {}; // { surgeonId: lastNightDate }
  ids.forEach(id=>{
    const p = priorCounts[id] || {};
    dcCt[id] = (p.dc||0) + (p.dcB||0);
    nCt[id] = (p.nights||0) + (p.nightsB||0);
    wkndCt[id] = (p.wknd||0) + (p.wkndB||0);
    offCt[id] = (p.off||0) + (p.offB||0);
    periodShifts[id] = 0;
    periodServiceWeeks[id] = 0;
    // Past burden = dc*7 + nights + wknd*3 (old formula, used as secondary signal).
    // Note: priorCounts here represents multi-year (seeded from config.js
    // COUNTS_MULTIYEAR; live values accrete in the call_schedule_data blob).
    priorMultiScore[id] = dcCt[id]*7 + nCt[id] + wkndCt[id]*3;
    lastDcWeek[id] = -99;
  });

  // ─── Cross-boundary seeding ───
  // When this generation continues from an existing schedule, seed the
  // "previous week" trackers from the real week immediately before mondays[0]
  // so the period seam obeys the same consecutive-shift rules as mid-block
  // weeks: no same surgeon on service two weeks running, no weekend→DC, and
  // no DC→Mon-night across the boundary. Without this, week 0 has no
  // predecessor and can repeat the prior schedule's last service-week surgeon.
  if (prevWeekSeed) {
    // Recent DC history → spacing continuity (negative week offsets, e.g. the
    // week before mondays[0] is -1, two weeks before is -2, ...).
    if (prevWeekSeed.recentDc) {
      for (const id in prevWeekSeed.recentDc) {
        if (lastDcWeek[id] !== undefined) lastDcWeek[id] = prevWeekSeed.recentDc[id];
      }
    }
    // Immediate prior week's DC is hard-excluded from week 0 (wkIdx-1 === -1).
    if (prevWeekSeed.dayCall && lastDcWeek[prevWeekSeed.dayCall] !== undefined) {
      lastDcWeek[prevWeekSeed.dayCall] = -1;
    }
  }

  // Note: an earlier version capped priorMultiScore to ±50% of group median
  // to prevent anomalous priors from dominating. That cap has been removed
  // because the spread-reduction pass at the end equalizes in-period shifts
  // regardless of prior history, making the cap redundant. The cap was also
  // actively hurting surgeons whose prior totals were legitimately low (e.g.
  // joined the group after the data-tracking window started) by raising
  // their effective prior to match the median.

  // 1-year burden from DEDICATED input (yearCounts — the app passes its live
  // year1Counts, rolled forward on publish and editable in Setup), same 7/1/3
  // burden formula as the multi-year term, backup splits included. Wired
  // 2026-08-06: under the old proxy (multi-year / 2) the 10% "past-year" term
  // was just the multi-year signal again at half scale — both prior terms
  // were one number wearing two hats, so the intended recency weighting
  // didn't exist. Fallback to the proxy only when no yearCounts is passed
  // (older callers), keeping the old behavior rather than zeroing the term.
  ids.forEach(id => {
    const y = yearCounts && yearCounts[id];
    priorYearScore[id] = y
      ? ((y.dc||0)+(y.dcB||0))*7 + ((y.nights||0)+(y.nightsB||0)) + ((y.wknd||0)+(y.wkndB||0))*3
      : priorMultiScore[id] / 2;
  });

  // Composite priority score — LOWER = more deserving of next shift.
  // 85% within-period, 10% past-year, 5% multi-year.
  function priority(id) {
    return 0.85 * periodShifts[id]
         + 0.10 * (priorYearScore[id] / 20)   // scaled down so 10% weight actually matters at decision margin
         + 0.05 * (priorMultiScore[id] / 40); // scaled down similarly
  }

  // Alias for backwards compatibility with post-optimization pass logic
  // that expects a mutable burden map. Keep it in sync with priorMultiScore
  // — it gets incremented by 7/3/1 on assignments for the post-opt pass to
  // reason about weekend swaps via delta comparisons.
  const burden = {};
  ids.forEach(id => { burden[id] = priorMultiScore[id]; });
  let prevWkndSurgeon = (prevWeekSeed && prevWeekSeed.wknd) || null;
  let prevDcSurgeon = (prevWeekSeed && prevWeekSeed.dayCall) || null;

  // Random jitter per surgeon — ensures Regenerate produces visibly different schedules
  // by perturbing sort order among closely-scored candidates
  const jitter = {};
  ids.forEach(id => { jitter[id] = (Math.random() - 0.5) * 3; }); // ±1.5 range

  const prefs = preferences || {};

  // Build holiday lookup for all years in the schedule
  const holidayMap = {}; // { "YYYY-MM-DD": { name, type:"major"|"minor" } }
  const years = new Set(mondays.map(m => m.getFullYear()));
  // Include next year for Dec→Jan overlap (build a separate array to avoid mutating Set during iteration)
  [...years].forEach(y => { years.add(y+1); });
  years.forEach(y => {
    const h = getHolidays(y);
    h.major.forEach(hol => { 
      holidayMap[hol.date] = { ...hol, type: "major" }; 
      if (hol.endDate && hol.endDate !== hol.date) holidayMap[hol.endDate] = { ...hol, date: hol.endDate, name: hol.name + " (Day 2)", type: "major" };
    });
    h.minor.forEach(hol => { holidayMap[hol.date] = { ...hol, type: "minor" }; });
  });

  // Find FAK's ID for Christmas exception
  const fakId = ids.find(id => (nameMap[id]||"").toUpperCase() === "FAK") || null;

  // Designed holiday patterns (holidayDesign, top of file): card eves on
  // Mon–Thu are pinned nights (decision 2); holiday weeks' service weeks,
  // 24h nights and weekends are pinned to their card surgeons (Christmas
  // week → FAK, decision 3). Pins are skipped by the validation and fairness
  // passes exactly like locks. The FLOOR applies to them too: an eve surgeon
  // who is off is not pinned (the night is filled normally and listed).
  const design = holidayDesign(holAssignments, mondays.map(m => fmt(m)), fakId);
  const isDesignPin = (m, slot, id) => !!(id && design.pins[m] && design.pins[m][slot] === id);
  const isDesignedPair = (m1, s1, m2, s2, id) => isDesignPin(m1, s1, id) && isDesignPin(m2, s2, id);
  // floorMemo: one Map per generate() call (its inputs never change across the
  // best-of-N attempts), so each (surgeon, week, slot) is checked once, not 50×.
  const floorOk = (id, monday, slot) => {
    if (!floorMemo) return slotFloorOk(id, monday, slot, vac, vacOnly);
    const k = id + "|" + (typeof monday === "string" ? monday : monday.getTime()) + "|" + slot;
    let v = floorMemo.get(k);
    if (v === undefined) { v = slotFloorOk(id, monday, slot, vac, vacOnly); floorMemo.set(k, v); }
    return v;
  };

  // Track holiday assignments this period for fairness
  const holidayCt = {}; // { surgeonId: { major: count, minor: count } }
  ids.forEach(id => { holidayCt[id] = { major: 0, minor: 0 }; });

  // ═══ HOLIDAY PRE-ASSIGNMENTS ═══
  //
  // Conventions (Faraz, May 2026):
  //
  // MONDAY holidays:
  //   - Surgeon A (holiday-Monday surgeon) takes the PREVIOUS week's
  //     full Service Week.
  //   - Surgeon B (second holiday surgeon) takes the holiday week's
  //     Weekend (Fri 5p–Sat 7a + Sun 7a–Mon 7a).
  //
  // FRIDAY holidays:
  //   - Surgeon A (holiday-Friday surgeon) covers Fri 24h AND Sun 24h.
  //     Encoded by pre-assigning that week's Weekend slot to Surgeon A.
  //   - Saturday is covered by whoever ends up as DC (no pre-assignment;
  //     it falls out of normal service-week assignment).
  //
  // Pre-assignments are SOFT: if the target surgeon is on vacation during
  // their relevant window, the slot falls back to the normal algorithm.
  // The existing holidayWkndOverride (downstream) still acts as a hard
  // override for explicit Setup-time holiday coverage.
  const preAssign = {}; // { mondayStr: { dayCall?: id, wknd?: id } }

  // Helper: surgeon available for a weekend slot (Fri, Sun, next Mon).
  // Saturday is DC's day, so it's intentionally not checked here.
  const wkndAvail = (id, weekMonday) => {
    return !onVac(id, fmt(addD(weekMonday, 4)), vac)  // Fri
        && !onVac(id, fmt(addD(weekMonday, 6)), vac)  // Sun
        && !onVac(id, fmt(addD(weekMonday, 7)), vac); // next Mon
  };

  for (let i = 0; i < mondays.length; i++) {
    const mStr = fmt(mondays[i]);

    // MONDAY-holiday pattern (Monday itself is a holiday date)
    if (holByDate[mStr]) {
      const { surgeonA, surgeonB } = holByDate[mStr];

      // Surgeon A → previous week's Service Week (DC)
      if (surgeonA && i > 0) {
        const prevMonday = mondays[i-1];
        const prevMStr = fmt(prevMonday);
        let aAvail = true;
        for (let d = 0; d < 6; d++) {
          if (onVac(surgeonA, fmt(addD(prevMonday, d)), vac)) { aAvail = false; break; }
        }
        if (aAvail) {
          if (!preAssign[prevMStr]) preAssign[prevMStr] = {};
          preAssign[prevMStr].dayCall = surgeonA;
        }
      }

      // Surgeon B → the weekend that leads INTO the Monday holiday, which
      // belongs to the PREVIOUS week (Fri 5p–Sat 7a + Sun 7a–Mon-holiday 7a) —
      // NOT the holiday week's own trailing weekend. Mirrors surgeon A's use of
      // the previous week. (e.g. Labor Day Mon → surgeon B covers that Sat/Sun.)
      if (surgeonB && i > 0) {
        const prevMondayB = mondays[i - 1];
        const prevMStrB = fmt(prevMondayB);
        if (wkndAvail(surgeonB, prevMondayB)) {
          if (!preAssign[prevMStrB]) preAssign[prevMStrB] = {};
          preAssign[prevMStrB].wknd = surgeonB;
        }
      }
    }

    // FRIDAY-holiday pattern (Friday of this week is a holiday date)
    const friStr = fmt(addD(mondays[i], 4));
    if (holByDate[friStr]) {
      const { surgeonA: friSurgeonA } = holByDate[friStr];
      if (friSurgeonA && wkndAvail(friSurgeonA, mondays[i])) {
        if (!preAssign[mStr]) preAssign[mStr] = {};
        // Don't overwrite a Monday-holiday wknd pre-assignment if both
        // happened to apply (very unlikely — would need a Mon AND Fri holiday
        // in the same week).
        if (!preAssign[mStr].wknd) preAssign[mStr].wknd = friSurgeonA;
      }
    }
  }

  // MANUAL LOCKS override convention-based pre-assignments. These come from
  // the scheduler explicitly pinning a surgeon to a slot via the UI. They
  // win over any holiday-pattern preference and bypass vacation checks
  // (the scheduler took responsibility by setting them).
  if (Array.isArray(locks)) {
    locks.forEach(lock => {
      if (!lock || !lock.mondayStr || !lock.slot || !lock.surgeonId) return;
      // The UI stores the service-week slot as "dc"; the generator keys day-call
      // pre-assignments as "dayCall" (see preAssign[mStr].dayCall and
      // isPreAssigned(...,"dayCall",...)). Normalize so a Service Week lock is
      // actually honored instead of silently dropped.
      const slot = lock.slot === "dc" ? "dayCall" : lock.slot;
      if (!preAssign[lock.mondayStr]) preAssign[lock.mondayStr] = {};
      preAssign[lock.mondayStr][slot] = lock.surgeonId;
    });
  }

  // SPACING LOOKAHEAD over pre-assigned service weeks. preAssign is complete
  // here (holiday conventions + manual locks), so the deal knows every week
  // whose DC is already spoken for. Without this, the free pick MIN_DC_GAP
  // weeks BEFORE a pre-assigned week can hand the same surgeon a tight pair
  // the floor never sees — that is exactly how the real RPC 08-17→08-31 pair
  // happened: Labor Day's surgeon A (RPC) owned 08-31 by the Monday-holiday
  // convention, and the 08-17 pick, blind to it, chose RPC anyway (verified
  // by replay 2026-08-31: 200/200 candidates re-created the pair; with this
  // lookahead the deal avoids it). Used by the soft floor in both DC pick
  // branches; same fallback-if-empty semantics, so it can never block
  // coverage. Note it also softly discourages the previously-possible
  // CONSECUTIVE pair via pre-assignment (free pick the week before a
  // pre-assigned week), which the dcPoolNoConsec filter cannot see either.
  const preAssignedDcIdx = {}; // id -> [wkIdx, ...] of pre-assigned DC weeks
  for (let i = 0; i < mondays.length; i++) {
    const pa = preAssign[fmt(mondays[i])];
    if (pa && pa.dayCall) { (preAssignedDcIdx[pa.dayCall] = preAssignedDcIdx[pa.dayCall] || []).push(i); continue; }
    // Tue–Fri holiday weeks are claimed too: the DC pick below hands them
    // straight to the holiday's surgeon A (dc = holDcSurgeon — e.g.
    // Thanksgiving week → its surgeon A; Christmas week → FAK, whose standing
    // rule makes him surgeon A). Monday holidays are the opposite case and are
    // already covered by the preAssign entry on the PRECEDING week above.
    for (let d = 1; d <= 4; d++) {
      const hb = holByDate[fmt(addD(mondays[i], d))];
      if (hb && hb.surgeonA) { (preAssignedDcIdx[hb.surgeonA] = preAssignedDcIdx[hb.surgeonA] || []).push(i); break; }
    }
  }
  const preAssignedDcNear = (id, wkIdx) =>
    (preAssignedDcIdx[id] || []).some(w => w > wkIdx && w - wkIdx <= MIN_DC_GAP);

  for (let wkIdx = 0; wkIdx < mondays.length; wkIdx++) {
    const monday = mondays[wkIdx];
    const mStr = fmt(monday);
    const isBackup = backupMondays.has(mStr);
    const isFierceBackup = (fierceBackupMondays||new Set()).has(mStr);

    // Check for holidays this week
    const weekDates = [];
    for (let i = 0; i < 7; i++) weekDates.push(fmt(addD(monday, i)));
    const weekHolidays = weekDates.map(ds => holidayMap[ds] ? { ...holidayMap[ds], ds } : null).filter(Boolean);
    const hasHoliday = weekHolidays.length > 0;
    const hasMajorHoliday = weekHolidays.some(h => h.type === "major");
    const isChristmasWeek = weekHolidays.some(h => h.name === "Christmas Day");
    const christmasDate = weekHolidays.find(h => h.name === "Christmas Day")?.ds;

    // ═══ DAY CALL ═══
    const availDC = ids.filter(id => {
      for(let i=0;i<6;i++) if(onVac(id, fmt(addD(monday,i)), vac)) return false;
      return true;
    });

    let dc = null;
    if (availDC.length) {
      // Monday-holiday convention: prev-week DC pre-assigned to next week's
      // holiday surgeon A. Apply if the pre-assigned surgeon is available.
      const preDc = preAssign[mStr]?.dayCall;
      if (preDc && availDC.includes(preDc)) {
        dc = preDc;
      } else {
      // Check for pre-assigned holiday surgeonA for DC this week
      const weekdayHoliday = weekHolidays.find(h => {
        const dow = parse(h.ds).getDay();
        return dow >= 1 && dow <= 5; // M-F holiday
      });
      const holDcSurgeon = weekdayHoliday && holByDate[weekdayHoliday.ds]?.surgeonA;

      // Christmas exception: FAK takes Christmas, so prefer FAK for DC that week
      if (isChristmasWeek && fakId && availDC.includes(fakId)) {
        dc = fakId;
      } else if (holDcSurgeon && availDC.includes(holDcSurgeon)) {
        // For Monday holidays, the holiday surgeon only covers Monday 24h
        // A different surgeon should handle service week (Tue-Fri)
        const holDow = weekdayHoliday ? parse(weekdayHoliday.ds).getDay() : -1;
        if (holDow === 1) {
          // Monday holiday — do NOT force holiday surgeon as DC
          // Instead, prefer someone else for service week
          // HARD RULE: also exclude previous weekend surgeon and consecutive-DC surgeon
          let nonHolPool = availDC.filter(id => id !== holDcSurgeon && id !== prevWkndSurgeon && lastDcWeek[id] !== wkIdx - 1);
          if (nonHolPool.length === 0) nonHolPool = availDC.filter(id => id !== holDcSurgeon && lastDcWeek[id] !== wkIdx - 1);
          if (nonHolPool.length === 0) nonHolPool = availDC.filter(id => id !== holDcSurgeon); // fallback
          // SOFT FLOOR: prefer surgeons more than MIN_DC_GAP weeks past their
          // last service week (see the constant's comment). Falls back to the
          // unfiltered pool rather than leave the week uncovered.
          const nonHolSpaced = nonHolPool.filter(id => wkIdx - lastDcWeek[id] > MIN_DC_GAP && !preAssignedDcNear(id, wkIdx));
          if (nonHolSpaced.length > 0) nonHolPool = nonHolSpaced;
          if (nonHolPool.length > 0) {
            nonHolPool.sort((a,b) => {
              // PRIMARY: fewer total shifts this period (equality goal)
              const ts = periodShifts[a] - periodShifts[b]; if (ts) return ts;
              // SECONDARY: fewer service weeks this period (service balance)
              const sw = periodServiceWeeks[a] - periodServiceWeeks[b]; if (sw) return sw;
              // TERTIARY: composite priority (past-year 10% + multi-year 5%)
              const pd = (priority(a) + jitter[a]*0.1) - (priority(b) + jitter[b]*0.1);
              if (Math.abs(pd) > 0.01) return pd;
              // Spacing: prefer larger gap since last DC week
              const spacingA = wkIdx - lastDcWeek[a];
              const spacingB = wkIdx - lastDcWeek[b];
              if (spacingA !== spacingB) return spacingB - spacingA;
              return Math.random() - 0.5;
            });
            dc = nonHolPool[0];
          } else {
            dc = holDcSurgeon; // fallback if no one else available
          }
        } else {
          dc = holDcSurgeon; // Non-Monday holiday: holiday surgeon takes DC
        }
      } else {
        // HARD RULE: exclude previous weekend surgeon from DC (no back-to-back wknd→DC)
        // HARD RULE: exclude surgeon who just did DC last week (no consecutive service weeks)
        let dcPool = prevWkndSurgeon ? availDC.filter(id => id !== prevWkndSurgeon) : availDC;
        if (dcPool.length === 0) dcPool = availDC; // fallback if no one else
        const dcPoolNoConsec = dcPool.filter(id => lastDcWeek[id] !== wkIdx - 1);
        if (dcPoolNoConsec.length > 0) dcPool = dcPoolNoConsec;
        // SOFT FLOOR: prefer surgeons more than MIN_DC_GAP weeks past their
        // last service week (see the constant's comment). Falls back to the
        // unfiltered pool rather than leave the week uncovered.
        const dcPoolSpaced = dcPool.filter(id => wkIdx - lastDcWeek[id] > MIN_DC_GAP && !preAssignedDcNear(id, wkIdx));
        if (dcPoolSpaced.length > 0) dcPool = dcPoolSpaced;
        dcPool.sort((a,b) => {
          // PRIMARY: fewer total shifts this period (equality goal)
          const ts = periodShifts[a] - periodShifts[b]; if (ts) return ts;
          // SECONDARY: fewer service weeks this period (service balance)
          const sw = periodServiceWeeks[a] - periodServiceWeeks[b]; if (sw) return sw;
          // TERTIARY: composite priority
          const pd = (priority(a) + jitter[a]*0.1) - (priority(b) + jitter[b]*0.1);
          if (Math.abs(pd) > 0.01) return pd;
          // Day Call spacing: prefer surgeons who haven't had DC recently
          const spacingA = wkIdx - lastDcWeek[a];
          const spacingB = wkIdx - lastDcWeek[b];
          if (spacingA !== spacingB) return spacingB - spacingA;
          return Math.random() - 0.5;
        });
        dc = dcPool[0];
      }
      } // close else block for pre-assignment override
      dcCt[dc]++; burden[dc]+=7; lastDcWeek[dc] = wkIdx;
      periodShifts[dc]++; periodServiceWeeks[dc]++;

      // Holiday tracking for DC surgeon
      weekHolidays.forEach(h => {
        holidayCt[dc][h.type]++;
      });
    }

    const rem = ids.filter(id=>id!==dc);
    const nights = {};
    const used = new Set();

    // ═══ WEEKEND SHIFT ═══
    const friDate = fmt(addD(monday,4));
    const sunDate = fmt(addD(monday,6));
    const nextMonDate = fmt(addD(monday,7));

    let availWknd = rem.filter(id => !onVac(id,friDate,vac) && !onVac(id,sunDate,vac));
    availWknd = availWknd.filter(id => !onVac(id, nextMonDate, vacOnly)); // weekend ends Mon 7a — OK if Mon is no-call, blocked only if Mon is vacation

    // Check if Friday or Sunday is a holiday — special handling
    const friHoliday = holidayMap[friDate];
    const sunHoliday = holidayMap[sunDate];

    // Monday-holiday convention: holiday week's Weekend pre-assigned to
    // surgeon B (the second holiday surgeon). Apply if available.
    const preWknd = preAssign[mStr]?.wknd;
    if (preWknd && availWknd.includes(preWknd) && preWknd !== dc) {
      nights.wknd = preWknd; used.add(preWknd); wkndCt[preWknd]++; burden[preWknd]+=3;
      periodShifts[preWknd]++;
      if (friHoliday) holidayCt[preWknd][friHoliday.type]++;
      if (sunHoliday) holidayCt[preWknd][sunHoliday.type]++;
    } else {
    // Avoid back-to-back weekends (last week's weekend surgeon) AND service-week
    // → weekend (last week's service-week/DC surgeon worked through Saturday).
    // Both soft: prefer excluding both, then fall back to just the weekend rule,
    // then to anyone available. Across the period boundary these use the seeded
    // prevWkndSurgeon / prevDcSurgeon so the seam obeys the same rules.
    let prefWknd = availWknd.filter(id => id !== prevWkndSurgeon && id !== prevDcSurgeon);
    if (prefWknd.length === 0) prefWknd = availWknd.filter(id => id !== prevWkndSurgeon);
    const wkndPool = prefWknd.length > 0 ? prefWknd : availWknd;

    if (wkndPool.length) {
      wkndPool.sort((a,b) => {
        // PRIMARY: fewer total shifts this period
        const ts = periodShifts[a] - periodShifts[b]; if (ts) return ts;
        // Holiday fairness: if weekend includes a holiday, prefer surgeon with fewer holiday shifts
        if (friHoliday || sunHoliday) {
          const hType = (friHoliday || sunHoliday).type;
          const ha = holidayCt[a][hType] || 0;
          const hb = holidayCt[b][hType] || 0;
          if (ha !== hb) return ha - hb;
        }
        // SECONDARY: fewer weekend assignments this period (weekend balance)
        const wd = wkndCt[a] - wkndCt[b]; if (wd) return wd;
        // TERTIARY: composite priority
        const pd = (priority(a) + jitter[a]*0.1) - (priority(b) + jitter[b]*0.1);
        if (Math.abs(pd) > 0.01) return pd;
        if(lastPos[a]==="wknd"&&lastPos[b]!=="wknd") return 1;
        if(lastPos[b]==="wknd"&&lastPos[a]!=="wknd") return -1;
        return Math.random() - 0.5;
      });
      nights.wknd = wkndPool[0]; used.add(wkndPool[0]); wkndCt[wkndPool[0]]++; burden[wkndPool[0]]+=3;
      periodShifts[wkndPool[0]]++;
      if (friHoliday) holidayCt[wkndPool[0]][friHoliday.type]++;
      if (sunHoliday) holidayCt[wkndPool[0]][sunHoliday.type]++;
    } else {
      // Nobody but the service-week surgeon is free for the weekend (the pool
      // above is everyone else who clears the FLOOR). The mildest bend is the
      // service doctor taking it too (svcPlus); below the floor nobody is
      // ever placed — the slot stays EMPTY and the preview lists it.
      // (Was: rem.filter(id => !used.has(id))[0] — anyone, vacation or not.)
      if (dc && floorOk(dc, monday, "wknd")) {
        nights.wknd = dc; used.add(dc); wkndCt[dc]++; burden[dc] += 3; periodShifts[dc]++;
      } else nights.wknd = null;
    }
    } // close else block for wknd pre-assignment override

    // ═══ WEEKNIGHT SHIFTS ═══

    // Shuffle night keys to prevent positional bias
    const shuffledNightKeys = [...NIGHT_KEYS];
    for(let i=shuffledNightKeys.length-1;i>0;i--){
      const j=Math.floor(Math.random()*(i+1));
      [shuffledNightKeys[i],shuffledNightKeys[j]]=[shuffledNightKeys[j],shuffledNightKeys[i]];
    }

    const nightAssignments = {};
    const nightUsed = new Set();

    // Pre-assign nights that are covered by holiday 24h shifts
    // Holiday surgeon covers the full 24h — no separate night shift needed
    const holidayNightOverrides = {};
    NIGHT_KEYS.forEach((sk, i) => {
      const dayOffset = {mon:0,tue:1,wed:2,thu:3}[sk];
      const nightDate = fmt(addD(monday, dayOffset));
      const cov = holCoverage[nightDate];
      if (cov && cov.role === "holiday_24h" && floorOk(cov.surgeonId, monday, sk)) {
        // Mark this night as covered by the holiday surgeon (suppresses separate assignment).
        // A card surgeon below the FLOOR is not placed (the night is filled normally; listed).
        holidayNightOverrides[sk] = cov.surgeonId;
      }
    });
    // Card eves on a Mon–Thu night (decision 2): a REGULAR night for the card's
    // "Night Before" surgeon, pinned like a lock — not dropped because that
    // surgeon holds the Friday 24h / weekend or (Christmas) the service week.
    // Below the FLOOR the pin is skipped and the night is filled normally.
    const evePins = {};
    Object.entries(design.eves[mStr] || {}).forEach(([sk, eid]) => {
      if (!holidayNightOverrides[sk] && floorOk(eid, monday, sk)) evePins[sk] = eid;
    });
    // Reserve the holiday-coverage and eve surgeons up front. The per-slot override below
    // only fires when its slot is reached in the SHUFFLED order, so without this
    // a holiday surgeon could be handed an earlier weeknight first and end up
    // double-booked (covering the holiday 24h AND another night that week).
    Object.values(holidayNightOverrides).forEach(hid => nightUsed.add(hid));
    Object.values(evePins).forEach(eid => nightUsed.add(eid));

    // Also check weekend for holiday coverage
    const holFriDate = fmt(addD(monday, 4));
    const holSunDate = fmt(addD(monday, 6));
    const friCov = holCoverage[holFriDate];
    const sunCov = holCoverage[holSunDate];
    let holidayWkndOverride = null;
    if (friCov && friCov.role === "holiday_24h") {
      holidayWkndOverride = friCov.surgeonId;
    } else if (sunCov && sunCov.role === "holiday_24h") {
      holidayWkndOverride = sunCov.surgeonId;
    }

    // If weekend has holiday override, use it instead of normal weekend assignment
    // — unless its surgeon is below the FLOOR for the weekend (then the normal
    // pick stands and the preview lists the card surgeon as off). Applies even
    // when the normal pass left the weekend empty.
    if (holidayWkndOverride && floorOk(holidayWkndOverride, monday, "wknd")) {
      // Undo the normal weekend assignment counts
      if (nights.wknd) { wkndCt[nights.wknd]--; burden[nights.wknd]-=3; used.delete(nights.wknd); periodShifts[nights.wknd]--; }
      nights.wknd = holidayWkndOverride;
      used.add(holidayWkndOverride);
      wkndCt[holidayWkndOverride] = (wkndCt[holidayWkndOverride]||0) + 1;
      burden[holidayWkndOverride] = (burden[holidayWkndOverride]||0) + 3;
      periodShifts[holidayWkndOverride] = (periodShifts[holidayWkndOverride]||0) + 1;
    }

    for (const sk of shuffledNightKeys) {
      // Manual lock for this weeknight slot — overrides holiday coverage and
      // normal selection. The scheduler explicitly pinned this surgeon.
      const preNight = preAssign[mStr]?.[sk];
      if (preNight && preNight !== dc && !nightUsed.has(preNight) && !used.has(preNight)) {
        nightAssignments[sk] = preNight;
        nightUsed.add(preNight);
        nCt[preNight]++; burden[preNight]++;
        periodShifts[preNight]++;
        const dayOffsetLock = {mon:0,tue:1,wed:2,thu:3}[sk];
        prevNightSurgeon[preNight] = fmt(addD(monday, dayOffsetLock));
        lastPos[preNight] = sk;
        continue;
      }
      // If this night is overridden by holiday coverage, use the holiday surgeon
      if (holidayNightOverrides[sk]) {
        nightAssignments[sk] = holidayNightOverrides[sk];
        nightUsed.add(holidayNightOverrides[sk]);
        nCt[holidayNightOverrides[sk]]++; burden[holidayNightOverrides[sk]]++;
        periodShifts[holidayNightOverrides[sk]]++;
        continue;
      }
      // Card eve (decision 2) — pinned above the hard rules, never below the floor.
      if (evePins[sk]) {
        const eid = evePins[sk];
        nightAssignments[sk] = eid;
        nCt[eid]++; burden[eid]++; periodShifts[eid]++;
        prevNightSurgeon[eid] = fmt(addD(monday, {mon:0,tue:1,wed:2,thu:3}[sk]));
        const eveNext = holidayMap[fmt(addD(monday, {mon:0,tue:1,wed:2,thu:3}[sk] + 1))];
        if (eveNext) holidayCt[eid][eveNext.type]++;
        continue;
      }
      const dayOffset = {mon:0,tue:1,wed:2,thu:3}[sk];
      const sd = fmt(addD(monday, dayOffset));
      const nextDayStr = fmt(addD(monday, dayOffset + 1));
      const nightHoliday = holidayMap[sd]; // is this night a holiday?
      const nextDayHoliday = holidayMap[nextDayStr]; // is tomorrow a holiday?

      // FLOOR (decision 1): never this night's own day off, never the night
      // before a VACATION day (a no-call next day is fine). Nobody below it is
      // ever a candidate — not even as a last resort.
      const floorPool = ids.filter(id => floorOk(id, monday, sk));
      // HARD rules (each one is a bend in BEND_COST): not the service doctor,
      // not the weekend surgeon, at most one weeknight a week (so never back to
      // back), and not last week's weekend / service surgeon on Monday.
      let avail = floorPool.filter(id => id !== dc && !used.has(id) && !nightUsed.has(id));
      if (sk === "mon") avail = avail.filter(id => id !== prevWkndSurgeon && id !== prevDcSurgeon);

      // SOFT: weekend → the next Tuesday night (group rule, Jun 2026) — avoided
      // here when anyone else is free; the fairness passes may still use it.
      if (sk === "tue" && prevWkndSurgeon) {
        const nonWknd = avail.filter(id => id !== prevWkndSurgeon);
        if (nonWknd.length > 0) avail = nonWknd;
      }

      // MILDEST BEND (decision E): nobody clears the hard rules, so rank every
      // surgeon who clears the FLOOR by the bend cost this placement adds
      // (BEND_COST, top of file) and keep the cheapest; the fairness order
      // below breaks ties. E.g. the weekend surgeon taking this week's Monday
      // (6) beats two weeknights (12) beats the service doctor (60). Replaces
      // the old fallback layers, which dropped the vacation checks entirely.
      if (!avail.length) {
        const bendOf = (id) => {
          let cst = 0;
          if (id === dc) cst += BEND_COST.svcPlus;
          if (id === nights.wknd) cst += BEND_COST[sameWeekBendKey(sk, "wknd")];
          for (const k of NIGHT_KEYS) if (k !== sk && nightAssignments[k] === id) cst += BEND_COST[sameWeekBendKey(sk, k)];
          if (sk === "mon" && id === prevDcSurgeon) cst += BEND_COST.svcThenMon;
          if (sk === "mon" && id === prevWkndSurgeon) cst += BEND_COST.wkndThenMon;
          return cst;
        };
        const costs = floorPool.map(id => bendOf(id));
        const minCost = Math.min(...costs);
        avail = floorPool.filter((id, i) => costs[i] === minCost);
      }

      if(!avail.length){ nightAssignments[sk]=null; continue; }

      avail.sort((a,b) => {
        // HOLIDAY ASSIGNMENT: prefer pre-assigned surgeonB for this night
        const holNight = holByDate[sd] || holByDate[nextDayStr];
        const holSurgeonB = holNight?.surgeonB;
        if (holSurgeonB) {
          if (a === holSurgeonB && b !== holSurgeonB) return -1;
          if (b === holSurgeonB && a !== holSurgeonB) return 1;
        }

        // Holiday fairness: if this night is a holiday or eve of holiday
        if (nextDayHoliday) {
          const hType = nextDayHoliday.type;
          const ha = holidayCt[a]?.[hType] || 0;
          const hb = holidayCt[b]?.[hType] || 0;
          if (ha !== hb) return ha - hb; // fewer holiday shifts → gets this one
        }

        // PRIMARY: fewer total shifts this period (equality goal)
        const ts = periodShifts[a] - periodShifts[b]; if (ts) return ts;
        // SECONDARY: fewer weeknights this period (night balance)
        const nd = nCt[a] - nCt[b]; if (nd) return nd;
        // TERTIARY: composite priority
        const pd = (priority(a) + jitter[a]*0.1) - (priority(b) + jitter[b]*0.1);
        if (Math.abs(pd) > 0.01) return pd;

        // Preferences
        const aPref = prefs[a]; const bPref = prefs[b];
        const aBonus = (aPref?.preferShift===sk ? -10 : 0) + (aPref?.avoidShift===sk ? 10 : 0);
        const bBonus = (bPref?.preferShift===sk ? -10 : 0) + (bPref?.avoidShift===sk ? 10 : 0);
        if(aBonus !== bBonus) return aBonus - bBonus;

        if(lastPos[a]===sk&&lastPos[b]!==sk) return 1;
        if(lastPos[b]===sk&&lastPos[a]!==sk) return -1;
        return Math.random() - 0.5;
      });

      const chosen = avail[0];
      nightAssignments[sk] = chosen;
      nightUsed.add(chosen);
      nCt[chosen]++; burden[chosen]++; lastPos[chosen] = sk;
      periodShifts[chosen]++;
      prevNightSurgeon[chosen] = sd; // track for consecutive night detection

      // Track holiday assignments
      if (nextDayHoliday) holidayCt[chosen][nextDayHoliday.type]++;
    }

    for (const sk of NIGHT_KEYS) nights[sk] = nightAssignments[sk] || null;

    if(nights.wknd) lastPos[nights.wknd] = "wknd";
    prevWkndSurgeon = nights.wknd || null;
    prevDcSurgeon = dc || null;

    const assigned = new Set([dc, ...Object.values(nights)].filter(Boolean));
    const off = ids.find(id => !assigned.has(id)) || null;
    if(off) offCt[off]++;

    // Collect holiday coverage for this week
    const weekHolCoverage = {};
    for (let i = 0; i < 7; i++) {
      const ds = fmt(addD(monday, i));
      if (holCoverage[ds]) weekHolCoverage[ds] = holCoverage[ds];
    }

    sched[mStr] = { dayCall:dc, nights, off, isBackup, isFierceBackup, holidayCoverage: Object.keys(weekHolCoverage).length > 0 ? weekHolCoverage : null };
  }

  // ═══ MILDEST BEND — exact search over the squeezed weeks (decision E) ═══
  // The deal fills week by week, so a bend it takes can't see the weeks after
  // it. Here every run of consecutive weeks that holds a bend or an empty slot
  // is re-solved TOGETHER: all their slots except pins (locks, holiday
  // conventions, designed holiday pins, holiday 24h nights) are searched
  // exactly (branch and bound) for the lowest total BEND_COST, including the
  // rules that link them to the fixed weeks before and after. Candidates per
  // slot are only surgeons who clear the FLOOR (or EMPTY at 400), tried in the
  // fairness order (fewest shifts so far, jittered), so the first optimum
  // found is the fairest one among them. Bounded at SEARCH_NODE_LIMIT nodes
  // per run — far above what a real squeezed run needs.
  {
    const SEARCH_NODE_LIMIT = 400000;
    const mStrs = mondays.map(m => fmt(m));
    const holderOf = (wk, slot) => !wk ? null : slot === "dayCall" ? (wk.dayCall || null) : ((wk.nights && wk.nights[slot]) || null);
    const coveredNight = (m, slot) => {
      const o = BEND_NIGHT_OFF[slot]; if (o === undefined) return null;
      const cv = holCoverage[fmt(addD(parse(m), o))]; return cv && cv.role === "holiday_24h" ? cv.surgeonId : null;
    };
    const isFixed = (m, slot, id) => !!id && (preAssign[m]?.[slot] === id || isDesignPin(m, slot, id) || coveredNight(m, slot) === id);
    const dealt = listScheduleBends(sched, { surgeons, mondays, vac, vacationsOnly: vacOnly, holAssignments, prevWeekSeed, costOnly: true });
    const bent = new Set();
    dealt.items.forEach(it => {
      if (it.kind !== "bend" && it.kind !== "empty") return;
      const w = mStrs.indexOf(it.mondayStr); if (w >= 0) bent.add(w);
      const pw = it.prevMondayStr ? mStrs.indexOf(it.prevMondayStr) : -1; if (pw >= 0) bent.add(pw);
    });
    const runs = [];
    [...bent].sort((a, b) => a - b).forEach(w => { const r = runs[runs.length - 1]; if (r && r[r.length - 1] === w - 1) r.push(w); else runs.push([w]); });
    const LINKS = [["dayCall", "mon"], ["wknd", "mon"], ["wknd", "dayCall"], ["dayCall", "dayCall"]];
    for (const run of runs) {
      const inRun = new Set(run);
      const cur = {}; // w -> {slot: id|null|undefined}  (undefined = not yet assigned in the search)
      const vars = [];
      run.forEach(w => {
        const m = mStrs[w], wk = sched[m]; cur[w] = {};
        BEND_SLOTS.forEach(slot => {
          const id = holderOf(wk, slot); cur[w][slot] = id;
          if (isFixed(m, slot, id)) return;
          // Fairness order, per slot type: the service week goes first to whoever has
          // the fewest service weeks, the weekend to the fewest weekends, then total.
          const typeCt = slot === "dayCall" ? periodServiceWeeks : slot === "wknd" ? wkndCt : nCt;
          const dom = ids.filter(x => floorOk(x, mondays[w], slot))
            .sort((a, b) => ((typeCt[a] || 0) - (typeCt[b] || 0)) || ((periodShifts[a] + jitter[a] * 0.1) - (periodShifts[b] + jitter[b] * 0.1)));
          dom.push(null);
          vars.push({ w, m, slot, dom });
        });
      });
      if (!vars.length) continue;
      const at = (w, slot) => {
        if (inRun.has(w)) return cur[w][slot];
        if (w === -1) return prevWeekSeed ? (slot === "dayCall" ? prevWeekSeed.dayCall || null : slot === "wknd" ? prevWeekSeed.wknd || null : null) : null;
        if (w < 0 || w >= mStrs.length) return null;
        return holderOf(sched[mStrs[w]], slot);
      };
      // Cost a slot's current holder adds against every OTHER slot already
      // holding a value (fixed, or assigned earlier in the search).
      const addCost = (w, slot, id) => {
        if (!id) return BEND_COST.empty;
        const m = mStrs[w]; let c = 0;
        for (const s2 of BEND_SLOTS) {
          if (s2 === slot || at(w, s2) !== id) continue;
          const key = sameWeekBendKey(slot, s2);
          if (key && !isDesignedPair(m, slot, m, s2, id)) c += BEND_COST[key];
        }
        for (const [a, b] of LINKS) {
          if (a === slot && at(w + 1, b) === id && !isDesignedPair(m, a, mStrs[w + 1], b, id)) c += BEND_COST[crossWeekBendKey(a, b)];
          if (b === slot && at(w - 1, a) === id && !(w > 0 && isDesignedPair(mStrs[w - 1], a, m, b, id))) c += BEND_COST[crossWeekBendKey(a, b)];
        }
        return c;
      };
      // Most constrained slot first; the incumbent (the deal's own assignment)
      // is the first bound, so the search only ever replaces it with cheaper.
      vars.sort((x, y) => x.dom.length - y.dom.length);
      const incumbent = vars.map(v => cur[v.w][v.slot]);
      vars.forEach(v => { cur[v.w][v.slot] = undefined; });
      let best = 0;
      vars.forEach((v, k) => { cur[v.w][v.slot] = incumbent[k]; best += addCost(v.w, v.slot, incumbent[k]); });
      vars.forEach(v => { cur[v.w][v.slot] = undefined; });
      let bestAssign = incumbent.slice();
      let nodes = 0;
      const pick = new Array(vars.length);
      // Each pair of slots is costed once: when the LATER of the two is set.
      const dfs = (k, cost) => {
        if (cost >= best || nodes > SEARCH_NODE_LIMIT) return;
        if (k === vars.length) { best = cost; bestAssign = pick.slice(); return; }
        const v = vars[k];
        for (const id of v.dom) {
          nodes++;
          cur[v.w][v.slot] = id; pick[k] = id;
          dfs(k + 1, cost + addCost(v.w, v.slot, id));
          cur[v.w][v.slot] = undefined;
        }
      };
      dfs(0, 0);
      // Write the best assignment back (vars are in the search order here).
      vars.forEach((v, k) => {
        const wk = sched[v.m], id = bestAssign[k];
        if (v.slot === "dayCall") wk.dayCall = id; else wk.nights[v.slot] = id;
      });
      run.forEach(w => {
        const wk = sched[mStrs[w]];
        const a = new Set([wk.dayCall, ...Object.values(wk.nights)].filter(Boolean));
        wk.off = ids.find(id => !a.has(id)) || null;
      });
    }
    if (runs.length) {
      // Recount from the schedule (the passes below read these running counters).
      ids.forEach(id => { dcCt[id] = 0; nCt[id] = 0; wkndCt[id] = 0; });
      mStrs.forEach(m => {
        const wk = sched[m];
        if (wk.dayCall) dcCt[wk.dayCall]++;
        if (wk.nights?.wknd) wkndCt[wk.nights.wknd]++;
        NIGHT_KEYS.forEach(sk => { if (wk.nights?.[sk]) nCt[wk.nights[sk]]++; });
      });
      ids.forEach(id => { periodShifts[id] = dcCt[id] + nCt[id] + wkndCt[id]; });
    }
  }

  // ═══ POST-OPTIMIZATION PASS ═══
  const mondayStrs = mondays.map(m => fmt(m));
  const calcSpread = (ct) => { const vals = Object.values(ct); return Math.max(...vals)-Math.min(...vals); };

  // Guard so spread-reducing weekend swaps don't reintroduce service-week(Sat)→
  // weekend or back-to-back weekends. (weekend→next-Mon-night is checked inline.)
  const wkndAdjOk = (X, idx) => {
    const prev = idx > 0 ? sched[mondayStrs[idx-1]] : null;
    const next = idx < mondayStrs.length-1 ? sched[mondayStrs[idx+1]] : null;
    if (prev && prev.dayCall === X) return false;       // service week → weekend
    if (prev && prev.nights?.wknd === X) return false;  // back-to-back weekend
    if (next && next.nights?.wknd === X) return false;  // back-to-back weekend
    if (next && next.dayCall === X) return false;       // weekend → next service week
    return true;
  };

  for (let pass = 0; pass < 50; pass++) {
    let improved = false;

    // Try swapping weekend assignments to reduce spread
    for (let i = 0; i < mondayStrs.length && !improved; i++) {
      for (let j = i+1; j < mondayStrs.length && !improved; j++) {
        const wkA = sched[mondayStrs[i]];
        const wkB = sched[mondayStrs[j]];
        const a = wkA.nights?.wknd, b = wkB.nights?.wknd;
        if (!a || !b || a === b) continue;

        const monA = parse(mondayStrs[i]), monB = parse(mondayStrs[j]);
        const friA = fmt(addD(monA,4)), sunA = fmt(addD(monA,6)), nMonA = fmt(addD(monA,7));
        const friB = fmt(addD(monB,4)), sunB = fmt(addD(monB,6)), nMonB = fmt(addD(monB,7));

        const bCanDoA = !onVac(b,friA,vac) && !onVac(b,sunA,vac) && !onVac(b,nMonA,vac) && b !== wkA.dayCall;
        const aCanDoB = !onVac(a,friB,vac) && !onVac(a,sunB,vac) && !onVac(a,nMonB,vac) && a !== wkB.dayCall;
        if (!bCanDoA || !aCanDoB) continue;

        // No weeknight + that same weekend (all four are bends since
        // 2026-10-11; Thu was the only one before), and never move a designed
        // holiday weekend.
        if (["mon","tue","wed","thu"].some(sk => wkA.nights?.[sk] === b)) continue;
        if (["mon","tue","wed","thu"].some(sk => wkB.nights?.[sk] === a)) continue;
        if (isDesignPin(mondayStrs[i], "wknd", a) || isDesignPin(mondayStrs[j], "wknd", b)) continue;

        // Check weekend→Monday night conflict: new weekend surgeon shouldn't be
        // Mon night next week (needs recovery after Fri–Sun). Monday is HARD;
        // weekend→Tuesday is now SOFT (Jun 2026), so it's no longer blocked here.
        const nextWkA = i + 1 < mondayStrs.length ? sched[mondayStrs[i + 1]] : null;
        const nextWkB = j + 1 < mondayStrs.length ? sched[mondayStrs[j + 1]] : null;
        if (nextWkA?.nights?.mon === b) continue;
        if (nextWkB?.nights?.mon === a) continue;

        // Don't reintroduce service-week→weekend or back-to-back weekends.
        // Adjacent weeks share a neighbor, so the pre-swap adjacency check is
        // unreliable there — skip those (a minor spread optimization at worst).
        if (Math.abs(i - j) <= 1) continue;
        if (!wkndAdjOk(b, i) || !wkndAdjOk(a, j)) continue;

        if (wkndCt[a] > wkndCt[b] + 1) {
          wkndCt[a]--; wkndCt[b]++;
          burden[a]-=3; burden[b]+=3;
          periodShifts[a]--; periodShifts[b]++;
          wkA.nights.wknd = b; wkB.nights.wknd = a;
          const fixOff = (wk) => {
            const assigned = new Set([wk.dayCall, ...Object.values(wk.nights)].filter(Boolean));
            wk.off = ids.find(id => !assigned.has(id)) || null;
          };
          fixOff(wkA); fixOff(wkB);
          improved = true;
        } else if (wkndCt[b] > wkndCt[a] + 1) {
          wkndCt[b]--; wkndCt[a]++;
          burden[b]-=3; burden[a]+=3;
          periodShifts[b]--; periodShifts[a]++;
          wkA.nights.wknd = b; wkB.nights.wknd = a;
          const fixOff = (wk) => {
            const assigned = new Set([wk.dayCall, ...Object.values(wk.nights)].filter(Boolean));
            wk.off = ids.find(id => !assigned.has(id)) || null;
          };
          fixOff(wkA); fixOff(wkB);
          improved = true;
        }
      }
    }

    if (!improved) break;
  }

  // ═══ VALIDATION PASS — fix any remaining hard-rule violations via swaps ═══
  // A night covered by a holiday 24h shift is intentional — the holiday surgeon
  // covers it (and for Monday holidays that surgeon also holds the prior service
  // week by design). These slots must be exempt from "fix" swaps and rebalancing,
  // or the coverage gets torn out and the surgeon freed for an adjacent night.
  const isHolCoveredNight = (mStr, sk) => {
    const off = {mon:0,tue:1,wed:2,thu:3}[sk];
    if (off === undefined) return false;
    const d = fmt(addD(parse(mStr), off));
    return !!(holCoverage[d] && holCoverage[d].role === "holiday_24h");
  };
  // N10 (Jul 2026): a repair must never hand a shift to someone who can't
  // legally take it. This pass previously assigned the week's `off` surgeon
  // or raw-swapped nights with NO vacation/rule check — and in a vacation
  // week the off surgeon IS the vacationer, so ~15% of vacation-week rolls
  // put a surgeon on the Mon/Tue night of their own vacation. Every repair
  // candidate now clears canTakeSlot — the same chokepoint the fairness
  // passes use. Its definition moved here (above first use); the fairness
  // passes further down share this single definition.
  // Can surgeon Y take this slot in this week without violating any rules?
  const canTakeSlot = (Y, mStr, monday, slot, wk, wkIdx) => {
    if (!Y) return false;
    if (Y === wk.dayCall && slot !== "dayCall") return false;

    // Same-week double assignment rules:
    if (slot === "dayCall") {
      if (wk.nights?.wknd === Y) return false;
      if (["mon","tue","wed","thu"].some(sk => wk.nights?.[sk] === Y)) return false;
    } else if (slot === "wknd") {
      if (wk.dayCall === Y) return false;
      // Any weeknight + that weekend is a BEND (2026-10-11 table: Mon 6, Tue 8,
      // Wed 10, Thu 50) — only the deal's mildest-bend step may create one,
      // never a fairness move. (Was: Thu only; Mon/Tue/Wed + wknd allowed.)
      if (["mon","tue","wed","thu"].some(sk => wk.nights?.[sk] === Y)) return false;
    } else {
      // weeknight slot
      if (wk.dayCall === Y) return false;
      if (wk.nights?.wknd === Y) return false; // weeknight + that weekend — a bend (see above)
      // No double-up on weeknights
      for (const sk of ["mon","tue","wed","thu"]) {
        if (sk !== slot && wk.nights?.[sk] === Y) return false;
      }
    }

    // Vacation checks scoped to slot's actual hours
    if (slot === "dayCall") {
      for (let d = 0; d < 6; d++) if (onVac(Y, fmt(addD(monday, d)), vac)) return false;
    } else if (slot === "wknd") {
      if (onVac(Y, fmt(addD(monday, 4)), vac)) return false; // Fri
      if (onVac(Y, fmt(addD(monday, 6)), vac)) return false; // Sun
      if (onVac(Y, fmt(addD(monday, 7)), vacOnly)) return false; // next Mon (trailing edge — vacation only; no-call Mon is OK)
    } else {
      const dayOffset = {mon:0, tue:1, wed:2, thu:3}[slot];
      if (onVac(Y, fmt(addD(monday, dayOffset)), vac)) return false;
      if (onVac(Y, fmt(addD(monday, dayOffset + 1)), vacOnly)) return false; // next day (trailing edge — vacation only; no-call next day is OK)
    }

    // Inter-week constraints. Week 0's "previous week" is the SEED (the real week
    // before the period: its service week and weekend) — without it, a move
    // could hand week 0's service week to the seed weekend surgeon or the
    // first Monday night to the seed service doctor (2026-10-11).
    const prevWk = wkIdx > 0 ? sched[mondayStrs[wkIdx-1]]
      : (prevWeekSeed ? { dayCall: prevWeekSeed.dayCall || null, nights: { wknd: prevWeekSeed.wknd || null } } : null);
    const nextWk = wkIdx < mondayStrs.length-1 ? sched[mondayStrs[wkIdx+1]] : null;

    if (slot === "dayCall") {
      if (prevWk?.nights?.wknd === Y) return false; // wknd → DC forbidden
      if (prevWk?.dayCall === Y) return false; // consecutive SW forbidden
      if (nextWk?.dayCall === Y) return false; // consecutive SW forbidden (forward — a bend since 2026-10-11)
      if (nextWk?.nights?.mon === Y) return false; // DC → next Mon forbidden
    }
    if (slot === "mon") {
      if (prevWk?.nights?.wknd === Y) return false; // wknd → next Mon forbidden
      if (prevWk?.dayCall === Y) return false; // DC → next Mon forbidden
    }
    // wknd → next Tue is SOFT (group rule, Jun 2026): NOT blocked here, so the
    // fairness passes may use it to even raw headcount. Monday stays HARD (above).
    // The initial night pass still prefers to avoid Tue, so it only appears when
    // the count genuinely needs it. (Formerly hard: `slot==="tue"` blocked
    // prevWk weekend, and the wknd branch blocked nextWk Tue — both removed.)
    if (slot === "wknd") {
      if (nextWk?.nights?.mon === Y) return false; // wknd → next Mon forbidden (recovery, HARD)
      if (nextWk?.dayCall === Y) return false; // weekend → next service week forbidden (HARD)
      // SOFT (group rule, Jun 2026): "service week → next weekend", "back-to-back
      // weekends", and "weekend → next Tuesday" are discouraged but ALLOWED. The
      // initial weekend pass still prefers to avoid them (prefWknd above), so they
      // only appear when the fairness passes need them to even out the load.
      // Formerly hard:
      //   prevWk?.dayCall === Y          — service week (Sat) → next weekend
      //   prevWk?.nights?.wknd === Y     — back-to-back weekend (with prior week)
      //   nextWk?.nights?.wknd === Y     — back-to-back weekend (with next week)
      //   nextWk?.nights?.tue === Y      — weekend → next Tuesday night
    }

    // Back-to-back weeknights within same week
    if (["tue","wed","thu"].includes(slot)) {
      const prevSk = {tue:"mon", wed:"tue", thu:"wed"}[slot];
      if (wk.nights?.[prevSk] === Y) return false;
    }
    if (["mon","tue","wed"].includes(slot)) {
      const nextSk = {mon:"tue", tue:"wed", wed:"thu"}[slot];
      if (wk.nights?.[nextSk] === Y) return false;
    }

    return true;
  };
  // Swap the holders of two night slots (same or different weeks), only if
  // BOTH movers clear canTakeSlot for their NEW slot. The two slots are
  // vacated during the check because canTakeSlot treats a mover's own
  // current assignment as a conflict. Commits on success, restores on
  // failure.
  const trySwapNights = (mA, iA, skA, mB, iB, skB) => {
    const wkA = sched[mA], wkB = sched[mB];
    const a = wkA?.nights?.[skA], b = wkB?.nights?.[skB];
    if (!a || !b) return false;
    wkA.nights[skA] = null; wkB.nights[skB] = null;
    const ok = canTakeSlot(b, mA, parse(mA), skA, wkA, iA) && canTakeSlot(a, mB, parse(mB), skB, wkB, iB);
    wkA.nights[skA] = ok ? b : a;
    wkB.nights[skB] = ok ? a : b;
    return ok;
  };
  // A violation no legal swap can repair is a deliberate BEND now (the deal's
  // mildest-bend step) — listed by listScheduleBends in the preview's "Needs
  // your OK" box, so it is no longer a console warning (was console.warn).
  const unresolvedNote = () => {};
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < mondayStrs.length; i++) {
      const wk = sched[mondayStrs[i]];
      const recalcOff = (w) => {
        const a = new Set([w.dayCall, ...Object.values(w.nights)].filter(Boolean));
        w.off = ids.find(id => !a.has(id)) || null;
      };

      // Fix: DC surgeon should not also have a night in same week
      if (wk.dayCall) {
        NIGHT_KEYS.forEach(sk => {
          if (wk.nights?.[sk] === wk.dayCall && !isDesignedPair(mondayStrs[i], "dayCall", mondayStrs[i], sk, wk.dayCall)) {
            if (wk.off && canTakeSlot(wk.off, mondayStrs[i], parse(mondayStrs[i]), sk, wk, i)) {
              // Swap the conflicting night with the off surgeon
              wk.nights[sk] = wk.off;
              recalcOff(wk);
            } else if (pass === 2) {
              unresolvedNote(`[validation] UNRESOLVED: ${wk.dayCall} has Service Week AND ${sk} night, week ${mondayStrs[i]} (no legal repair candidate)`);
            }
          }
        });
        // Fix: DC surgeon should not have weekend in same week
        if (wk.nights?.wknd === wk.dayCall && !isDesignedPair(mondayStrs[i], "dayCall", mondayStrs[i], "wknd", wk.dayCall)) {
          if (wk.off && canTakeSlot(wk.off, mondayStrs[i], parse(mondayStrs[i]), "wknd", wk, i)) {
            wk.nights.wknd = wk.off;
            recalcOff(wk);
          } else if (pass === 2) {
            unresolvedNote(`[validation] UNRESOLVED: ${wk.dayCall} has Service Week AND weekend, week ${mondayStrs[i]} (no legal repair candidate)`);
          }
        }
      }

      // Fix: Weekend surgeon should not also have Thursday night in same week
      // (back-to-back: Thu 5p–Fri 7a then wknd starts Fri 5p, no recovery).
      // Mon/Tue/Wed + wknd are all allowed — enough gap before wknd starts.
      if (wk.nights?.wknd && wk.nights?.thu === wk.nights?.wknd && !isDesignedPair(mondayStrs[i], "thu", mondayStrs[i], "wknd", wk.nights.wknd) && !isDesignPin(mondayStrs[i], "thu", wk.nights.thu)) {
        if (wk.off && canTakeSlot(wk.off, mondayStrs[i], parse(mondayStrs[i]), "thu", wk, i)) {
          wk.nights.thu = wk.off;
          recalcOff(wk);
        } else if (pass === 2) {
          unresolvedNote(`[validation] UNRESOLVED: ${wk.nights.wknd} has Thu night AND weekend, week ${mondayStrs[i]} (no legal repair candidate)`);
        }
      }

      // Fix: Weekend surgeon should not have Monday night next week
      if (i < mondayStrs.length - 1 && wk.nights?.wknd) {
        const nextWk = sched[mondayStrs[i + 1]];
        if (nextWk?.nights?.mon === wk.nights.wknd && !isHolCoveredNight(mondayStrs[i + 1], "mon") && !isDesignPin(mondayStrs[i + 1], "mon", nextWk.nights.mon)) {
          // Try swapping Monday night with off surgeon of next week
          if (nextWk.off && canTakeSlot(nextWk.off, mondayStrs[i + 1], parse(mondayStrs[i + 1]), "mon", nextWk, i + 1)) {
            nextWk.nights.mon = nextWk.off;
            recalcOff(nextWk);
          } else {
            // Try swapping Monday night with another night surgeon in next
            // week — trySwapNights commits only if BOTH movers clear
            // canTakeSlot for their new slot.
            const otherNight = NIGHT_KEYS.find(sk => sk !== "mon" && nextWk.nights?.[sk] && !isDesignPin(mondayStrs[i + 1], sk, nextWk.nights[sk]) && preAssign[mondayStrs[i + 1]]?.[sk] !== nextWk.nights[sk] && nextWk.nights[sk] !== nextWk.dayCall && nextWk.nights[sk] !== wk.nights.wknd
              && trySwapNights(mondayStrs[i + 1], i + 1, "mon", mondayStrs[i + 1], i + 1, sk));
            if (!otherNight && pass === 2) {
              unresolvedNote(`[validation] UNRESOLVED: ${wk.nights.wknd} has weekend then next Monday night, weeks ${mondayStrs[i]}→${mondayStrs[i + 1]} (no legal repair candidate)`);
            }
          }
        }
      }

      // Fix: Service week surgeon should not have Monday night next week
      if (i < mondayStrs.length - 1 && wk.dayCall) {
        const nextWk = sched[mondayStrs[i + 1]];
        if (nextWk?.nights?.mon === wk.dayCall && !isHolCoveredNight(mondayStrs[i + 1], "mon") && !isDesignPin(mondayStrs[i + 1], "mon", nextWk.nights.mon)) {
          if (nextWk.off && canTakeSlot(nextWk.off, mondayStrs[i + 1], parse(mondayStrs[i + 1]), "mon", nextWk, i + 1)) {
            nextWk.nights.mon = nextWk.off;
            recalcOff(nextWk);
          } else {
            const otherNight = NIGHT_KEYS.find(sk => sk !== "mon" && nextWk.nights?.[sk] && !isDesignPin(mondayStrs[i + 1], sk, nextWk.nights[sk]) && preAssign[mondayStrs[i + 1]]?.[sk] !== nextWk.nights[sk] && nextWk.nights[sk] !== nextWk.dayCall && nextWk.nights[sk] !== wk.dayCall
              && trySwapNights(mondayStrs[i + 1], i + 1, "mon", mondayStrs[i + 1], i + 1, sk));
            if (!otherNight && pass === 2) {
              unresolvedNote(`[validation] UNRESOLVED: ${wk.dayCall} has Service Week then next Monday night, weeks ${mondayStrs[i]}→${mondayStrs[i + 1]} (no legal repair candidate)`);
            }
          }
        }
      }
      // Fix: No back-to-back nights within the same week
      const nightOrder = ["mon","tue","wed","thu"];
      for (let ni = 0; ni < nightOrder.length - 1; ni++) {
        const sk1 = nightOrder[ni], sk2 = nightOrder[ni + 1];
        const s1 = wk.nights?.[sk1], s2 = wk.nights?.[sk2];
        if (s1 && s1 === s2 && !isDesignedPair(mondayStrs[i], sk1, mondayStrs[i], sk2, s1) && !isDesignPin(mondayStrs[i], sk2, s2)) {
          // Try swapping sk2 with another night that doesn't create a new
          // consecutive pair — trySwapNights commits only if BOTH movers
          // clear canTakeSlot for their new slot.
          const swapCandidate = nightOrder.find(sk => sk !== sk1 && sk !== sk2 && wk.nights?.[sk] && !isDesignPin(mondayStrs[i], sk, wk.nights[sk]) && preAssign[mondayStrs[i]]?.[sk] !== wk.nights[sk] && wk.nights[sk] !== s1 && wk.nights[sk] !== wk.dayCall && !isHolCoveredNight(mondayStrs[i], sk)
            && trySwapNights(mondayStrs[i], i, sk2, mondayStrs[i], i, sk));
          if (swapCandidate) {
            recalcOff(wk);
          } else if (wk.off && canTakeSlot(wk.off, mondayStrs[i], parse(mondayStrs[i]), sk2, wk, i)) {
            wk.nights[sk2] = wk.off;
            recalcOff(wk);
          } else if (pass === 2) {
            unresolvedNote(`[validation] UNRESOLVED: ${s1} has back-to-back ${sk1}+${sk2} nights, week ${mondayStrs[i]} (no legal repair candidate)`);
          }
        }
      }
    }
  }

  // ═══ SPREAD REDUCTION PASS ═══
  //
  // Goal (Faraz, May 2026): tighten shift-count spread across surgeons.
  // Vacations create natural imbalance, but the algorithm should push as
  // close to equality as possible given the constraints.
  //
  // Strategy: one-way reassignment. Find the surgeon with the highest total
  // shifts and the surgeon with the lowest. For each slot the high surgeon
  // is currently assigned to, check if the low surgeon could take that slot
  // (vacation, conflicts, rules). If yes, reassign — high count drops by 1,
  // low count rises by 1, spread tightens. Iterate until no improvement.
  //
  // Slot priority: DC first (user explicitly called out service-week
  // balance), then weekend, then weeknights.
  //
  // Preserves: manual locks, holiday-pattern pre-assignments. These are
  // identified via the preAssign map and skipped.

  // Recalculate counts from the actual schedule state — the earlier weekend
  // swap optimization has known count-update bugs, so trust the assignments
  // not the running counters.
  ids.forEach(id => { dcCt[id] = 0; nCt[id] = 0; wkndCt[id] = 0; });
  mondayStrs.forEach(mStr => {
    const wk = sched[mStr];
    if (wk.dayCall) dcCt[wk.dayCall] = (dcCt[wk.dayCall] || 0) + 1;
    if (wk.nights?.wknd) wkndCt[wk.nights.wknd] = (wkndCt[wk.nights.wknd] || 0) + 1;
    ["mon","tue","wed","thu"].forEach(sk => {
      if (wk.nights?.[sk]) nCt[wk.nights[sk]] = (nCt[wk.nights[sk]] || 0) + 1;
    });
  });
  ids.forEach(id => { periodShifts[id] = (dcCt[id] || 0) + (nCt[id] || 0) + (wkndCt[id] || 0); });

  // Locks / holiday-convention pre-assignments AND designed holiday pins (card
  // eves, holiday weeks' service weeks, 24h nights and weekends) are untouchable.
  const isPreAssigned = (mStr, slot, surgeonId) => preAssign[mStr]?.[slot] === surgeonId || isDesignPin(mStr, slot, surgeonId);

  // canTakeSlot — the single eligibility chokepoint — is defined ABOVE the
  // validation pass (moved there in N10, Jul 2026) so the hard-rule repairs
  // and these fairness passes share one definition.

  const reassign = (mStr, slot, fromId, toId) => {
    const wk = sched[mStr];
    if (slot === "dayCall") {
      wk.dayCall = toId;
      dcCt[fromId]--; dcCt[toId] = (dcCt[toId]||0) + 1;
    } else if (slot === "wknd") {
      wk.nights.wknd = toId;
      wkndCt[fromId]--; wkndCt[toId] = (wkndCt[toId]||0) + 1;
    } else {
      wk.nights[slot] = toId;
      nCt[fromId]--; nCt[toId] = (nCt[toId]||0) + 1;
    }
    periodShifts[fromId]--; periodShifts[toId] = (periodShifts[toId]||0) + 1;
    const assigned = new Set([wk.dayCall, ...Object.values(wk.nights)].filter(Boolean));
    wk.off = ids.find(id => !assigned.has(id)) || null;
  };

  // 2-hop chain swap: when a direct hi→lo handoff of `slot` is blocked by a
  // constraint, route it through a middle surgeon — hi hands one week to mid, mid
  // hands a different week to lo, so mid nets zero and the spread still tightens
  // by one. This is what reliably gets WEEKENDS (and, less often, service weeks)
  // to an even split when the one-way swaps stall on a constrained period. With
  // the best-of-N wrapper, any rare attempt where a chain made another tier worse
  // is simply discarded, so the chain only ever helps.
  const slotHolder = (wk, slot) => slot === "dayCall" ? wk.dayCall : (wk.nights ? wk.nights.wknd : null);
  const tryChainSwap = (slot, hi, lo) => {
    for (let mi = 0; mi < ids.length; mi++) {
      const mid = ids[mi];
      if (mid === hi || mid === lo) continue;
      // leg 2: a week `mid` holds that `lo` can legally take
      for (let i2 = 0; i2 < mondayStrs.length; i2++) {
        const m2 = mondayStrs[i2];
        const wk2 = sched[m2];
        if (slotHolder(wk2, slot) !== mid) continue;
        if (isPreAssigned(m2, slot, mid)) continue;
        if (slot === "wknd" && isHolCoveredNight(m2, "wknd")) continue;
        if (!canTakeSlot(lo, m2, parse(m2), slot, wk2, i2)) continue;
        reassign(m2, slot, mid, lo);                 // tentatively take leg 2
        let done = false;
        // leg 1: a week `hi` holds that `mid` can now take
        for (let i1 = 0; i1 < mondayStrs.length && !done; i1++) {
          const m1 = mondayStrs[i1];
          if (m1 === m2) continue;
          const wk1 = sched[m1];
          if (slotHolder(wk1, slot) !== hi) continue;
          if (isPreAssigned(m1, slot, hi)) continue;
          if (slot === "wknd" && isHolCoveredNight(m1, "wknd")) continue;
          if (!canTakeSlot(mid, m1, parse(m1), slot, wk1, i1)) continue;
          reassign(m1, slot, hi, mid);
          done = true;
        }
        if (done) return true;
        reassign(m2, slot, lo, mid);                 // undo leg 2 if leg 1 failed
      }
    }
    return false;
  };

  // PHASE 1: DC balance — drive service weeks to even (2 each over 14 weeks).
  // Tries all viable high→low pairs each iteration so we don't bail just
  // because the absolute max↔min pair has a constraint conflict. Targets spread
  // ≤ 1 (for a multiple-of-7 period that means exactly even); vacations may force
  // a wider spread, in which case the !found break stops at the best achievable.
  for (let iter = 0; iter < 100; iter++) {
    const sorted = [...ids].sort((a,b) => (dcCt[b]||0) - (dcCt[a]||0));
    if ((dcCt[sorted[0]]||0) - (dcCt[sorted[sorted.length-1]]||0) <= 1) break;

    let found = false;
    for (let h = 0; h < sorted.length && !found; h++) {
      const hi = sorted[h];
      for (let l = sorted.length - 1; l > h && !found; l--) {
        const lo = sorted[l];
        if ((dcCt[hi]||0) - (dcCt[lo]||0) <= 1) break;
        for (let wkIdx = 0; wkIdx < mondayStrs.length && !found; wkIdx++) {
          const mStr = mondayStrs[wkIdx];
          const wk = sched[mStr];
          if (wk.dayCall !== hi) continue;
          if (isPreAssigned(mStr, "dayCall", hi)) continue;
          if (!canTakeSlot(lo, mStr, parse(mStr), "dayCall", wk, wkIdx)) continue;
          reassign(mStr, "dayCall", hi, lo);
          found = true;
        }
      }
    }
    if (!found) {
      // direct swaps stalled — try routing through a middle surgeon
      for (let h = 0; h < sorted.length && !found; h++) {
        for (let l = sorted.length - 1; l > h && !found; l--) {
          if ((dcCt[sorted[h]]||0) - (dcCt[sorted[l]]||0) <= 1) break;
          if (tryChainSwap("dayCall", sorted[h], sorted[l])) found = true;
        }
      }
    }
    if (!found) break;
  }

  // PHASE 1B: Weekend balance — drive weekends to even (2 each over 14 weeks),
  // same one-way high→low reassignment as DC. Weekends were previously only
  // balanced indirectly via the weighted total, which left ~half of schedules
  // with someone on 3 and someone on 1. This balance is now FINAL: Phase 2 moves
  // only weeknights, so it can never re-spread the weekends established here.
  for (let iter = 0; iter < 100; iter++) {
    const sorted = [...ids].sort((a,b) => (wkndCt[b]||0) - (wkndCt[a]||0));
    if ((wkndCt[sorted[0]]||0) - (wkndCt[sorted[sorted.length-1]]||0) <= 1) break;

    let found = false;
    for (let h = 0; h < sorted.length && !found; h++) {
      const hi = sorted[h];
      for (let l = sorted.length - 1; l > h && !found; l--) {
        const lo = sorted[l];
        if ((wkndCt[hi]||0) - (wkndCt[lo]||0) <= 1) break;
        for (let wkIdx = 0; wkIdx < mondayStrs.length && !found; wkIdx++) {
          const mStr = mondayStrs[wkIdx];
          const wk = sched[mStr];
          if (wk.nights?.wknd !== hi) continue;
          if (isPreAssigned(mStr, "wknd", hi)) continue;
          if (isHolCoveredNight(mStr, "wknd")) continue;
          if (!canTakeSlot(lo, mStr, parse(mStr), "wknd", wk, wkIdx)) continue;
          reassign(mStr, "wknd", hi, lo);
          found = true;
        }
      }
    }
    if (!found) {
      // direct swaps stalled — try routing through a middle surgeon. This is the
      // path that fixes the "someone on 3 weekends, someone on 1" case that
      // one-way swaps + best-of-N alone left behind on constrained live data.
      for (let h = 0; h < sorted.length && !found; h++) {
        for (let l = sorted.length - 1; l > h && !found; l--) {
          if ((wkndCt[sorted[h]]||0) - (wkndCt[sorted[l]]||0) <= 1) break;
          if (tryChainSwap("wknd", sorted[h], sorted[l])) found = true;
        }
      }
    }
    if (!found) break;
  }
  // PHASE 2: Raw headcount balance (PRIMARY) with weighted burden as a TIEBREAK.
  //
  // Surgeons perceive raw shift COUNT — they scan the calendar and tally "I'm on
  // 12, he's on 14"; nobody computes a weighted burden in their head. So raw
  // count is what we drive tight here. Service weeks (Phase 1) and weekends
  // (Phase 1B) are already ≤1 apart, so this pass evens the remaining total by
  // moving WEEKNIGHTS only (weekends excluded so we can't undo Phase 1B).
  //
  // Because raw = svc + wknd + nights and the two heavy categories are already
  // pinned, balancing raw count here keeps WEEKNIGHTS tight as a byproduct — the
  // residual falls out even on its own. No separate weeknight pass is needed.
  //
  // Weighted burden (SW×6 + Wknd×2 + Night×1) survives only as a TIEBREAK in the
  // sort: among surgeons tied on raw count, we strip a weeknight from the
  // weighted-heaviest and give it to the weighted-lightest. That gives burden a
  // voice — nobody quietly carries the heaviest mix while looking even on
  // headcount — but burden can NO LONGER widen the raw-count spread the way the
  // old weighted-primary pass did (that's what produced the lopsided Δ6
  // schedules). When a non-multiple-of-7 period forces a service-week imbalance,
  // raw count stays even and weighted simply reflects the real, unavoidable
  // heaviness — the accepted tradeoff.
  const slotOrder = ["mon", "tue", "wed", "thu"];
  const rawCount = (id) => (dcCt[id]||0) + (nCt[id]||0) + (wkndCt[id]||0);
  const weightedTotal = (id) => 6 * (dcCt[id]||0) + (nCt[id]||0) + 2 * (wkndCt[id]||0);

  for (let iter = 0; iter < 200; iter++) {
    // Primary key: raw count (descending). Tiebreak: weighted burden (descending)
    // — so on the high end the weighted-heaviest among equal-count surgeons sorts
    // first (we lighten them), and on the low end the weighted-lightest sorts last
    // (we fill them).
    const sorted = [...ids].sort((a,b) =>
      (rawCount(b) - rawCount(a)) || (weightedTotal(b) - weightedTotal(a))
    );
    if (rawCount(sorted[0]) - rawCount(sorted[sorted.length-1]) <= 1) break;

    let found = false;
    for (let h = 0; h < sorted.length && !found; h++) {
      const hi = sorted[h];
      for (let l = sorted.length - 1; l > h && !found; l--) {
        const lo = sorted[l];
        if (rawCount(hi) - rawCount(lo) <= 1) break;
        // A weeknight move shifts raw count by exactly 1 (hi−1, lo+1). The break
        // above guarantees rawCount(hi) − rawCount(lo) ≥ 2 here, so the move can't
        // overshoot (hi stays ≥ lo) — no separate overshoot guard needed.
        for (let wkIdx = 0; wkIdx < mondayStrs.length && !found; wkIdx++) {
          const mStr = mondayStrs[wkIdx];
          const wk = sched[mStr];
          const monday = parse(mStr);
          for (const slot of slotOrder) {
            const cur = wk.nights?.[slot];
            if (cur !== hi) continue;
            if (isPreAssigned(mStr, slot, hi)) continue;
            if (isHolCoveredNight(mStr, slot)) continue; // holiday 24h coverage is fixed — don't rebalance it away
            if (!canTakeSlot(lo, mStr, monday, slot, wk, wkIdx)) continue;
            reassign(mStr, slot, hi, lo);
            found = true;
            break;
          }
        }
      }
    }
    if (!found) break;
  }

  // ═══ TYPE-BALANCE POLISH (follow-up to #73, 2026-10-11) ═══
  // Phases 1/1B move one slot type at a time, so a weekend surplus can only
  // shed by finding someone with NO shift that week — on a squeezed period
  // (pinned holiday weekends, bends) that stalls at Δ2–4 weekends although a
  // Δ0 / Δ0 schedule exists at the same bend cost. This local search swaps
  // the holders of ANY two slots (a weekend for a weeknight keeps both
  // totals) or hands one slot to another surgeon, scored on the fairness
  // tiers of scoreOf. Every move passes canTakeSlot for the receiver(s) — the
  // FLOOR and every hard rule (so no new bend), and pinned slots (locks,
  // holiday conventions, designed holiday pins) never move — so bend cost,
  // time off and pins can only stay as they are. Sideways moves (equal score)
  // are taken sometimes to cross plateaus; the best state found is kept.
  // generate() runs it on its best candidates only (it is attached, not run
  // here, so the 50 attempts stay cheap).
  const polishTypeBalance = (budget, target) => {
    const tSvc = target ? target.svc : 0, tWk = target ? target.wknd : 0;
    const W = mondayStrs.length;
    if (!W) return;
    const SLOTS = ["dayCall", "mon", "tue", "wed", "thu", "wknd"];
    const monDates = mondayStrs.map(m => parse(m));
    const get = (i, s) => { const wk = sched[mondayStrs[i]]; return s === "dayCall" ? wk.dayCall : (wk.nights ? wk.nights[s] : null); };
    const put = (i, s, id) => { const wk = sched[mondayStrs[i]]; if (s === "dayCall") wk.dayCall = id; else wk.nights[s] = id; };
    const svc = {}, wkd = {}, nts = {}, svcR = {}, wkdR = {};
    ids.forEach(id => { svc[id] = 0; wkd[id] = 0; nts[id] = 0; svcR[id] = 0; wkdR[id] = 0; });
    const bump = (i, s, id, d) => {
      if (!id || svc[id] === undefined) return;
      const reg = !sched[mondayStrs[i]].isBackup;
      if (s === "dayCall") { svc[id] += d; if (reg) svcR[id] += d; }
      else if (s === "wknd") { wkd[id] += d; if (reg) wkdR[id] += d; }
      else nts[id] += d;
    };
    for (let i = 0; i < W; i++) SLOTS.forEach(s => bump(i, s, get(i, s), 1));
    const spread = (m) => { let mn = Infinity, mx = -Infinity; for (const id of ids) { const v = m[id]; if (v < mn) mn = v; if (v > mx) mx = v; } return mx - mn; };
    // Same seam-aware spacing count as scoreOf (gap ≤ MIN_DC_GAP).
    const gapViol = () => {
      const last = {};
      if (prevWeekSeed && prevWeekSeed.recentDc) for (const id in prevWeekSeed.recentDc) last[id] = prevWeekSeed.recentDc[id];
      if (prevWeekSeed && prevWeekSeed.dayCall) last[prevWeekSeed.dayCall] = -1;
      let v = 0;
      for (let i = 0; i < W; i++) { const id = get(i, "dayCall"); if (!id) continue; if (last[id] !== undefined && i - last[id] <= MIN_DC_GAP) v++; last[id] = i; }
      return v;
    };
    // Soft rules (never forbidden, but not added for nothing): service week →
    // next weekend, back-to-back weekends, weekend → next Tuesday.
    const softCt = () => {
      let v = 0;
      for (let i = 0; i + 1 < W; i++) {
        const dc = get(i, "dayCall"), we = get(i, "wknd"), ndc = get(i + 1, "wknd"), ntue = get(i + 1, "tue");
        if (dc && dc === ndc) v++;
        if (we && we === ndc) v++;
        if (we && we === ntue) v++;
      }
      return v;
    };
    // Integer part = scoreOf's fairness tiers exactly (so the polish can never
    // trade one away); the fraction (< 1) only GUIDES the search: sums of
    // squares per type (moving a weekend from a 3-holder to a 1-holder leaves
    // the spread at 2 until the last 3 is gone — the squares see the progress),
    // then the soft-rule count.
    const sq = (m) => { let t = 0; for (const id of ids) t += m[id] * m[id]; return t; };
    // gapViol / softCt read only service weeks, weekends and Tuesday nights:
    // cached, and recounted only when a move touches one of those slots.
    let gapC = gapViol(), softC = softCt();
    const recount = (...slots) => { if (slots.some(t => t === "dayCall" || t === "wknd" || t === "tue")) { gapC = gapViol(); softC = softCt(); } };
    const tot = {};
    const score = () => {
      for (const id of ids) tot[id] = svc[id] + wkd[id] + nts[id];
      const tiers = spread(svc) * 10000 + spread(wkd) * 1000 + spread(tot) * 100 + gapC * 50 + spread(svcR) * 10 + spread(wkdR);
      const guide = (sq(svc) * 1e4 + sq(wkd) * 1e2 + sq(tot) + softC * 1e-2) / 1e8;
      return tiers + guide;
    };
    // Done once service weeks AND weekends are even with no spacing violation —
    // the remaining tiers (totals) are Phase 2's job, not this polish's.
    // "Even" = the best the slot count allows: Δ0 when the period's service weeks
    // (weekends) divide by the surgeon count, Δ1 otherwise (8 weeks / 7 surgeons).
    const done = () => spread(svc) <= tSvc && spread(wkd) <= tWk && gapC === 0;
    const free = [];
    for (let i = 0; i < W; i++) SLOTS.forEach(s => { const id = get(i, s); if (id && !isPreAssigned(mondayStrs[i], s, id)) free.push([i, s]); });
    if (free.length < 2) return;
    const snap = () => { const a = []; for (let i = 0; i < W; i++) SLOTS.forEach(s => a.push(get(i, s))); return a; };
    let cur = score(), best = cur, bestSnap = snap();
    const can = (id, i, s) => canTakeSlot(id, mondayStrs[i], monDates[i], s, sched[mondayStrs[i]], i);
    const pick = () => free[Math.floor(Math.random() * free.length)];
    // TARGETED proposal: a service week / weekend held by a surgeon with the
    // MOST of that type, paired with a slot of a surgeon with the FEWEST —
    // usually in the same week (a weekend ↔ weeknight swap there is the move
    // that is most often legal and keeps both totals).
    const freeOfType = { wknd: free.filter(([, s]) => s === "wknd"), dayCall: free.filter(([, s]) => s === "dayCall") };
    const freeOfWeek = []; for (let i = 0; i < W; i++) freeOfWeek.push(free.filter(([j]) => j === i));
    const any = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const targeted = () => {
      const type = Math.random() < 0.5 ? "wknd" : "dayCall";
      const m = type === "wknd" ? wkd : svc;
      let mx = -Infinity, mn = Infinity; for (const id of ids) { if (m[id] > mx) mx = m[id]; if (m[id] < mn) mn = m[id]; }
      if (mx - mn < 1) return null;
      const from = freeOfType[type].filter(([i, s]) => m[get(i, s)] === mx);
      if (!from.length) return null;
      const A = any(from);
      const lows = ids.filter(id => m[id] === mn);
      const y = any(lows);
      const sameWeek = Math.random() < 0.6;
      const to = (sameWeek ? freeOfWeek[A[0]] : free).filter(([j, t]) => get(j, t) === y);
      return { A, B: to.length ? any(to) : null, y };
    };
    // 3-way rotation y→A, z→B, x→C (x held A, y held B, z held C): when y can
    // take x's slot only after shedding the slot B that blocks it (e.g. its
    // own Monday night in the weekend's week).
    const rotate3 = (A, B, C, strict) => {
      const [i, s] = A, [j, t] = B, [k, u] = C;
      const x = get(i, s), y = get(j, t), z = get(k, u);
      if (!x || !y || !z || x === y || y === z || x === z) return false;
      if ((i === j && s === t) || (j === k && t === u) || (i === k && s === u)) return false;
      put(i, s, null); put(j, t, null); put(k, u, null);
      if (!(can(y, i, s) && can(z, j, t) && can(x, k, u))) { put(i, s, x); put(j, t, y); put(k, u, z); return false; }
      put(i, s, y); put(j, t, z); put(k, u, x);
      bump(i, s, x, -1); bump(i, s, y, 1); bump(j, t, y, -1); bump(j, t, z, 1); bump(k, u, z, -1); bump(k, u, x, 1);
      recount(s, t, u);
      const nxt = score();
      if (nxt < cur || (!strict && nxt === cur && Math.random() < 0.5)) { cur = nxt; return true; }
      put(i, s, x); put(j, t, y); put(k, u, z);
      bump(i, s, y, -1); bump(i, s, x, 1); bump(j, t, z, -1); bump(j, t, y, 1); bump(k, u, x, -1); bump(k, u, z, 1);
      recount(s, t, u);
      return false;
    };
    // Bend cost that week w takes part in: its same-week pairs plus the links
    // to weeks w-1 and w+1 (BEND_COST; designed pairs waived; the seed stands
    // in for the week before the period) — the same rules as listScheduleBends.
    const weekBend = (w) => {
      let c = 0;
      const m = mondayStrs[w];
      for (let a = 0; a < SLOTS.length; a++) for (let b = a + 1; b < SLOTS.length; b++) {
        const id = get(w, SLOTS[a]);
        if (!id || id !== get(w, SLOTS[b])) continue;
        const key = sameWeekBendKey(SLOTS[a], SLOTS[b]);
        if (key && !isDesignedPair(m, SLOTS[a], m, SLOTS[b], id)) c += BEND_COST[key];
      }
      const link = (pw, nw) => {
        const LK = [["dayCall", "mon"], ["wknd", "mon"], ["wknd", "dayCall"], ["dayCall", "dayCall"]];
        for (const [a, b] of LK) {
          const id = pw < 0 ? (prevWeekSeed ? (a === "dayCall" ? prevWeekSeed.dayCall : prevWeekSeed.wknd) : null) : get(pw, a);
          if (!id || nw >= W || id !== get(nw, b)) continue;
          if (pw >= 0 && isDesignedPair(mondayStrs[pw], a, mondayStrs[nw], b, id)) continue;
          c += BEND_COST[crossWeekBendKey(a, b)];
        }
      };
      link(w - 1, w); if (w + 1 < W) link(w, w + 1);
      return c;
    };
    // WEEK SWAP: surgeons p and q trade EVERYTHING they hold in week w (pinned
    // slots stay). This is the only move that can hand a bend — e.g. a weekend
    // + that week's Monday night ("double duty") — from one surgeon to another;
    // single-slot moves can't (canTakeSlot refuses half a bend). Legal when
    // every moved slot clears the FLOOR and the bend cost around week w does
    // not go up.
    const weekSwap = (w, p, q, strict) => {
      if (!p || !q || p === q) return false;
      const mv = SLOTS.filter(t => { const h = get(w, t); return (h === p || h === q) && !isPreAssigned(mondayStrs[w], t, h); });
      if (!mv.length) return false;
      const was = mv.map(t => get(w, t));
      for (let k = 0; k < mv.length; k++) if (!floorOk(was[k] === p ? q : p, monDates[w], mv[k])) return false;
      const bendBefore = weekBend(w);
      mv.forEach((t, k) => { const h = was[k], n = h === p ? q : p; put(w, t, n); bump(w, t, h, -1); bump(w, t, n, 1); });
      recount(...mv);
      let keep = weekBend(w) <= bendBefore;
      if (keep) { const nxt = score(); keep = nxt < cur || (!strict && nxt === cur && Math.random() < 0.5); if (keep) cur = nxt; }
      if (!keep) { mv.forEach((t, k) => { const h = was[k], n = h === p ? q : p; put(w, t, h); bump(w, t, n, -1); bump(w, t, h, 1); }); recount(...mv); }
      return keep;
    };
    // Stop the random phase after STALL proposals without a new best (Δ0 may
    // simply not exist on a vacation-heavy period — don't burn the budget).
    const STALL = 8000;
    let lastGain = 0;
    for (let it = 0; it < budget && !done() && it - lastGain < STALL; it++) {
      if (Math.random() < 0.12) { // week swap between two random surgeons
        weekSwap(Math.floor(Math.random() * W), ids[Math.floor(Math.random() * ids.length)], ids[Math.floor(Math.random() * ids.length)], false);
        if (cur < best) { best = cur; bestSnap = snap(); lastGain = it; }
        continue;
      }
      let A = null, B = null, mode = Math.random();
      if (mode < 0.5) { const tg = targeted(); if (tg) { A = tg.A; B = tg.B; if (!B) { mode = 0.99; } } }
      // a targeted pair can also try the 3-way rotation through a random third slot
      if (A && B && Math.random() < 0.4) { rotate3(A, B, Math.random() < 0.6 ? any(freeOfWeek[B[0]]) : pick()); if (cur < best) { best = cur; bestSnap = snap(); lastGain = it; } continue; }
      if (!A) A = pick();
      const [i, s] = A; const x = get(i, s); if (!x) continue;
      if (B || mode < 0.8) {
        const [j, t] = B || pick(); const y = get(j, t);
        if (!y || y === x || (i === j && s === t)) continue;
        put(i, s, null); put(j, t, null);
        if (!(can(y, i, s) && can(x, j, t))) { put(i, s, x); put(j, t, y); continue; }
        put(i, s, y); put(j, t, x);
        bump(i, s, x, -1); bump(i, s, y, 1); bump(j, t, y, -1); bump(j, t, x, 1);
        recount(s, t);
        const nxt = score();
        if (nxt < cur || (nxt === cur && Math.random() < 0.5)) cur = nxt;
        else { put(i, s, x); put(j, t, y); bump(i, s, y, -1); bump(i, s, x, 1); bump(j, t, x, -1); bump(j, t, y, 1); recount(s, t); }
      } else {
        const y = ids[Math.floor(Math.random() * ids.length)];
        if (y === x) continue;
        put(i, s, null);
        if (!can(y, i, s)) { put(i, s, x); continue; }
        put(i, s, y); bump(i, s, x, -1); bump(i, s, y, 1);
        recount(s);
        const nxt = score();
        if (nxt < cur || (nxt === cur && Math.random() < 0.5)) cur = nxt;
        else { put(i, s, x); bump(i, s, y, -1); bump(i, s, x, 1); recount(s); }
      }
      if (cur < best) { best = cur; bestSnap = snap(); lastGain = it; }
    }
    let k = 0;
    for (let i = 0; i < W; i++) SLOTS.forEach(s => { put(i, s, bestSnap[k++]); });
    // FINISHER — deterministic. From the best state, enumerate EVERY 2-swap
    // and 3-way rotation that starts at a service week / weekend of a surgeon
    // holding the MOST of that type and gives it to one holding the FEWEST;
    // take the first strict improvement; repeat. Random search is luck-limited
    // on the last step; this is not (a few thousand legality checks).
    ids.forEach(id => { svc[id] = 0; wkd[id] = 0; nts[id] = 0; svcR[id] = 0; wkdR[id] = 0; });
    for (let i = 0; i < W; i++) SLOTS.forEach(s => bump(i, s, get(i, s), 1));
    recount("dayCall"); cur = score();
    for (let round = 0; round < 6 && !done(); round++) {
      let improved = false;
      for (const type of ["dayCall", "wknd"]) {
        const m = type === "wknd" ? wkd : svc;
        let mx = -Infinity, mn = Infinity; for (const id of ids) { if (m[id] > mx) mx = m[id]; if (m[id] < mn) mn = m[id]; }
        if (mx - mn < 1) continue;
        const As = freeOfType[type].filter(([i, s]) => m[get(i, s)] === mx);
        const lows = new Set(ids.filter(id => m[id] === mn));
        const Bs = free.filter(([j, t]) => lows.has(get(j, t)));
        for (const A of As) {
          for (const B of Bs) {
            // 2-swap A↔B
            const [i, s] = A, [j, t] = B, x = get(i, s), y = get(j, t);
            if (x && y && x !== y) {
              put(i, s, null); put(j, t, null);
              if (can(y, i, s) && can(x, j, t)) {
                put(i, s, y); put(j, t, x); bump(i, s, x, -1); bump(i, s, y, 1); bump(j, t, y, -1); bump(j, t, x, 1); recount(s, t);
                const nxt = score();
                if (nxt < cur) { cur = nxt; improved = true; break; }
                put(i, s, x); put(j, t, y); bump(i, s, y, -1); bump(i, s, x, 1); bump(j, t, x, -1); bump(j, t, y, 1); recount(s, t);
              } else { put(i, s, x); put(j, t, y); }
            }
            // 3-way rotations through every other free slot
            const before = cur;
            for (const C of free) { if (rotate3(A, B, C, true)) { improved = true; break; } }
            if (improved) break;
          }
          if (improved) break;
        }
        if (improved) break;
      }
      if (!improved) break;
    }
    // EJECTION (depth 2): the low surgeon y often can't take the surplus slot A
    // only because of its OWN slots — that week's shifts, or (for a weekend)
    // next week's Monday night / service week. Move each such blocker to
    // someone else by a SAME-TYPE swap (y takes their slot elsewhere — no
    // count changes), then retry the improving 2-swap / rotation. The whole
    // sequence is kept only if it strictly beats the score it started from.
    const swapIn = (j, t, k, u) => { // holders of (j,t) and (k,u) trade places, counts kept in step
      const p = get(j, t), q = get(k, u);
      put(j, t, q); put(k, u, p); bump(j, t, p, -1); bump(j, t, q, 1); bump(k, u, q, -1); bump(k, u, p, 1); recount(t, u);
    };
    const nightSlots = free.filter(([, u]) => u !== "dayCall" && u !== "wknd");
    for (let round = 0; round < 4 && !done(); round++) {
      let improved = false;
      for (const type of ["wknd", "dayCall"]) {
        if (improved) break;
        const m = type === "wknd" ? wkd : svc;
        let mx = -Infinity, mn = Infinity; for (const id of ids) { if (m[id] > mx) mx = m[id]; if (m[id] < mn) mn = m[id]; }
        if (mx - mn < 1) continue;
        const As = freeOfType[type].filter(([i, s]) => m[get(i, s)] === mx);
        const lows = ids.filter(id => m[id] === mn);
        for (const A of As) {
          if (improved) break;
          const [i, s] = A, x = get(i, s);
          for (const y of lows) {
            if (improved) break;
            const blockers = free.filter(([j, t]) => get(j, t) === y && (j === i || (j === i + 1 && (t === "mon" || t === "dayCall")) || (type === "dayCall" && j === i - 1 && (t === "wknd" || t === "dayCall"))));
            if (!blockers.length || blockers.length > 3) continue;
            // would y be free for A without them?
            const saved = blockers.map(([j, t]) => get(j, t));
            blockers.forEach(([j, t]) => put(j, t, null)); put(i, s, null);
            const freed = can(y, i, s);
            put(i, s, x); blockers.forEach(([j, t], q) => put(j, t, saved[q]));
            if (!freed) continue;
            const start = cur;
            const improve = () => { // y takes A; x takes one of y's slots (2-swap) or a rotation via that week
              const ys = free.filter(([j, t]) => get(j, t) === y);
              for (const B of ys) {
                const [j, t] = B; if (j === i && t === s) continue;
                put(i, s, null); put(j, t, null);
                if (can(y, i, s) && can(x, j, t)) {
                  put(i, s, y); put(j, t, x); bump(i, s, x, -1); bump(i, s, y, 1); bump(j, t, y, -1); bump(j, t, x, 1); recount(s, t);
                  if (score() < start) return true;
                  put(i, s, x); put(j, t, y); bump(i, s, y, -1); bump(i, s, x, 1); bump(j, t, x, -1); bump(j, t, y, 1); recount(s, t);
                } else { put(i, s, x); put(j, t, y); }
                cur = start;
                for (const C of freeOfWeek[j]) if (rotate3(A, B, C, true)) return true;
              }
              return false;
            };
            const rehome = (q) => {
              if (q === blockers.length) return improve();
              const [j, t] = blockers[q];
              if (get(j, t) !== y) return rehome(q + 1);
              const pool2 = t === "dayCall" || t === "wknd" ? freeOfType[t] : nightSlots;
              let tries = 0;
              for (const [k, u] of pool2) {
                if (tries >= 6) break;
                const z = get(k, u);
                if (!z || z === y || z === x || k === i || (k === j && u === t)) continue;
                put(j, t, null); put(k, u, null);
                const ok = can(z, j, t) && can(y, k, u);
                put(j, t, y); put(k, u, z);
                if (!ok) continue;
                tries++;
                swapIn(j, t, k, u);
                if (rehome(q + 1)) return true;
                swapIn(j, t, k, u); // undo
              }
              return false;
            };
            if (rehome(0)) { cur = score(); improved = true; } else cur = start;
          }
        }
      }
      if (!improved) break;
    }
    mondayStrs.forEach(m => {
      const wk = sched[m];
      const a = new Set([wk.dayCall, ...Object.values(wk.nights)].filter(Boolean));
      wk.off = ids.find(id => !a.has(id)) || null;
    });
  };
  Object.defineProperty(sched, "__polish", { value: polishTypeBalance, enumerable: false, configurable: true, writable: true });

  return sched;
}

// ═══ BEST-OF-N WRAPPER ═══
//
// A single generateOnce() pass is always rule-legal, but its greedy assignment
// plus local one-way swaps only land a perfectly even SERVICE-WEEK split in a
// minority of runs. (For a 14-week period, 14 service weeks ÷ 7 = exactly 2 each
// IS achievable — only a few surgeons have any vacation conflict — but the local
// search doesn't reliably find it; weekends and total already come out tight.)
//
// Rather than chase service-week balance with ever-more-complex swap machinery,
// we run several independent attempts and keep the one whose distribution is
// tightest, scored on the metrics the group actually perceives. A single attempt
// is ~3-4 ms, so even 50 attempts stay well under a fifth of a second. This is
// NOT "regenerate 200 times hoping to stumble onto it": it is automatic, runs on
// one click, and is keyed on the exact fairness metrics — so every generation
// comes out tight, not as a lucky draw. The user can still re-roll for variety;
// every re-roll is now tight too.
function generate(surgeons, mondays, vac, backupMondays, priorCounts, preferences, fierceBackupMondays, holAssignments, locks, prevWeekSeed, vacationsOnly, yearCounts) {
  const ATTEMPTS = 50;
  const ids = surgeons.map(s => s.id);

  // Spread (max − min) of a per-surgeon count map.
  const spreadOf = (counts) => {
    let mn = Infinity, mx = -Infinity;
    for (const id of ids) { const v = counts[id] || 0; if (v < mn) mn = v; if (v > mx) mx = v; }
    return mx - mn;
  };

  // Score a candidate schedule — LOWER is fairer. The weights encode a strict
  // priority order: combined service weeks (1st + 2nd call, the group's headline
  // fairness number) dominate, then weekends, then total raw shift count, then
  // the 1st-call-only splits as a final tiebreak. The 1st-call-only splits can't
  // beat Δ1 when the regular-week count doesn't divide evenly by 7, but among
  // otherwise-equal schedules we still prefer the tighter split. Every candidate
  // is rule-legal, so this only ever chooses among valid schedules.
  const scoreOf = (sched) => {
    const svc = {}, wknd = {}, night = {}, svcReg = {}, wkndReg = {};
    ids.forEach(id => { svc[id]=0; wknd[id]=0; night[id]=0; svcReg[id]=0; wkndReg[id]=0; });
    for (const mStr in sched) {
      const wk = sched[mStr];
      if (!wk) continue;
      if (wk.dayCall) { svc[wk.dayCall] = (svc[wk.dayCall]||0) + 1; if (!wk.isBackup) svcReg[wk.dayCall] = (svcReg[wk.dayCall]||0) + 1; }
      if (wk.nights && wk.nights.wknd) { wknd[wk.nights.wknd] = (wknd[wk.nights.wknd]||0) + 1; if (!wk.isBackup) wkndReg[wk.nights.wknd] = (wkndReg[wk.nights.wknd]||0) + 1; }
      if (wk.nights) ["mon","tue","wed","thu"].forEach(sk => { if (wk.nights[sk]) night[wk.nights[sk]] = (night[wk.nights[sk]]||0) + 1; });
    }
    const tot = {}; ids.forEach(id => tot[id] = (svc[id]||0) + (wknd[id]||0) + (night[id]||0));
    // Spacing violations — same surgeon's service weeks starting ≤ MIN_DC_GAP
    // weeks apart. This is the candidate-level side of the soft floor: it
    // catches BOTH the in-pick fallback firing AND a Phase-1/validation move
    // recreating a tight pair (those passes only know the consecutive ban),
    // so best-of-50 discards a violating candidate whenever any candidate
    // managed without one. Seeded from prevWeekSeed.recentDc (negative week
    // offsets) so a violation across the period seam counts too. ×50 sits
    // between total-spread ×100 and svcReg ×10: fairness tiers still
    // dominate — calibrated by observation 2026-08-31 on the real Aug–Nov
    // inputs (see PR); at ×50 violations reach 0 with fairness unchanged.
    const lastIdx = {};
    if (prevWeekSeed && prevWeekSeed.recentDc) for (const id in prevWeekSeed.recentDc) { if (lastIdx[id] === undefined) lastIdx[id] = prevWeekSeed.recentDc[id]; }
    if (prevWeekSeed && prevWeekSeed.dayCall) lastIdx[prevWeekSeed.dayCall] = -1;
    let gapViolations = 0;
    const mKeys = Object.keys(sched).sort();
    const t0 = mKeys.length ? parse(mKeys[0]).getTime() : 0;
    for (const mStr of mKeys) {
      const wk = sched[mStr];
      if (!wk || !wk.dayCall) continue;
      const w = Math.round((parse(mStr).getTime() - t0) / 604800000);
      if (lastIdx[wk.dayCall] !== undefined && w - lastIdx[wk.dayCall] <= MIN_DC_GAP) gapViolations++;
      lastIdx[wk.dayCall] = w;
    }
    // FIRST tier (2026-10-11): total BEND cost of the FINAL schedule (every
    // pass done) — best-of-N never trades a bend for fairness. Bend costs are
    // integers ≥ 6 apart from 0, and every fairness tier below sums to < 1e6.
    const bends = listScheduleBends(sched, bendCtx).cost;
    // Above even the bends: a manual lock the candidate did NOT honor (the deal
    // still skips a weeknight lock whose surgeon was dealt another night that
    // week). Any attempt that honored every lock wins; the app toasts the rest.
    let droppedLocks = 0;
    (Array.isArray(locks) ? locks : []).forEach(l => {
      if (!l || !l.mondayStr || !l.slot || !l.surgeonId || !sched[l.mondayStr]) return;
      const slot = l.slot === "dc" ? "dayCall" : l.slot, wk = sched[l.mondayStr];
      if ((slot === "dayCall" ? wk.dayCall : wk.nights && wk.nights[slot]) !== l.surgeonId) droppedLocks++;
    });
    return droppedLocks     * 1e9
         + bends            * 1e6
         + spreadOf(svc)    * 10000
         + spreadOf(wknd)   * 1000
         + spreadOf(tot)    * 100
         + gapViolations    * 50
         + spreadOf(svcReg) * 10
         + spreadOf(wkndReg);
  };

  const bendCtx = { surgeons, mondays, vac, vacationsOnly, holAssignments, prevWeekSeed, costOnly: true };
  const floorMemo = new Map();
  let best = null, bestScore = Infinity;
  const pool = []; // every candidate with its score, for the type-balance polish below
  for (let i = 0; i < ATTEMPTS; i++) {
    const cand = generateOnce(surgeons, mondays, vac, backupMondays, priorCounts, preferences, fierceBackupMondays, holAssignments, locks, prevWeekSeed, vacationsOnly, yearCounts, floorMemo);
    if (!cand) continue;
    const s = scoreOf(cand);
    pool.push({ cand, s });
    if (s < bestScore) { bestScore = s; best = cand; }
    // Combined service weeks, weekends, and total all even AND zero spacing
    // violations (score < 50 means those four tiers are all clean) — only the
    // unavoidable 1st-call split remains. Good enough to stop; further
    // attempts can't improve the tiers that matter. (Was < 100 before the
    // gap-violation term: leaving it there would have early-stopped on a
    // 1-violation candidate that a later attempt could beat.)
    if (bestScore < 50) break;
  }
  // TYPE-BALANCE POLISH (follow-up to #73): the POLISH_TOP best candidates get
  // generateOnce's polishTypeBalance local search (every move through
  // canTakeSlot, pins untouched — locks, bends, the floor can't get worse),
  // then are re-scored by the same scoreOf. Skipped when the best is already
  // clean (score < 1: every fairness tier at 0).
  const POLISH_TOP = 8, POLISH_BUDGET = 15000;
  // Target spreads: 0 when the slots divide evenly among the surgeons, else 1.
  const slotTarget = (sched, which) => { let n = 0; for (const m in sched) { const wk = sched[m]; if (wk && (which === "dayCall" ? wk.dayCall : wk.nights && wk.nights.wknd)) n++; } return n % ids.length === 0 ? 0 : 1; };
  const target = best ? { svc: slotTarget(best, "dayCall"), wknd: slotTarget(best, "wknd") } : { svc: 0, wknd: 0 };
  const atTarget = (sc) => { const fair = sc % 1e6; return Math.floor(fair / 1e4) <= target.svc && Math.floor((fair % 1e4) / 1e3) <= target.wknd; };
  if (bestScore % 1e6 >= 1 && !atTarget(bestScore)) {
    pool.sort((a, b) => a.s - b.s);
    for (let k = 0; k < Math.min(POLISH_TOP, pool.length); k++) {
      const c = pool[k].cand;
      if (typeof c.__polish !== "function") continue;
      c.__polish(POLISH_BUDGET, target);
      const s = scoreOf(c);
      if (s < bestScore) { bestScore = s; best = c; }
      if (atTarget(bestScore)) break; // service weeks and weekends as even as the slot count allows
    }
  }
  pool.forEach(p => { delete p.cand.__polish; });
  // Fallback: if every attempt somehow scored Infinity (shouldn't happen), return a fresh pass.
  return best || generateOnce(surgeons, mondays, vac, backupMondays, priorCounts, preferences, fierceBackupMondays, holAssignments, locks, prevWeekSeed, vacationsOnly, yearCounts);
}
