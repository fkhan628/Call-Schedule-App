// DSG Call Schedule — Schedule Generator & Holiday Logic

/* ─── PIPELINE & RULES MAP — the one top-level narrative (distilled from the
   retired CALL-SCHEDULE-APP-REFERENCE.md §8, 2026-08-08; archived in the
   private repo's docs/ history). Per-phase detail lives at each phase's own
   comment; the hard rules are ALSO pinned executably in
   test/generator-regression.js, which re-states them independently so a
   generator bug can't hide in shared code.

   ENTRY: generate(surgeons, mondays, vac, backupMondays, priorCounts,
   preferences, fierceBackupMondays, holAssignments, locks, prevWeekSeed,
   vacationsOnly, yearCounts, opts). Randomized across runs. Since
   2026-10-12 a SEARCH (createScheduleSearch, end of file) deals starting
   schedules with generateOnce and improves each by local search, ranked by
   scheduleRules' tiers (catalog #4 below); the app runs it for SEARCH_MS
   with a progress line and "🔍 Search more", generate() for a fixed number
   of schedules; both stop early on a perfect schedule.

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

   4. THE RANKING — `scheduleRules(ctx)` (owner brief 2026-10-12; replaces
      the best-of-50 scoreOf). A tier VECTOR compared in order, never a
      blended sum (RULE_TIERS): floor (locks, time off incl. the service
      week's Sunday, two overnights in a row, empty slots) → FAK's last
      resort → service weeks even → weekends even → strain (partners) →
      bends (BEND_COST + FLEX strain) → totals even → 1st-call splits →
      avoided nights. Spacing (service weeks ≤ MIN_DC_GAP apart) is strain
      item b there.

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
      The service week is checked Mon–SUN since 2026-10-12 (rule 1: its
      surgeon must be free that Sunday too). Nothing in this file may place a
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
   bends. listScheduleBends() lists the bends of ANY schedule — through
   scheduleRules, the same reading the search ranks by — for the preview's
   "Needs your OK" box and the tests. */
const BEND_COST = {
  monWknd: 6,       // weekend surgeon also takes that week's Mon night ("double duty")
  tueWknd: 8,       // a Tue night + that same weekend
  wedWknd: 10,      // a Wed night + that same weekend
  nightsApart: 12,  // two non-consecutive weeknights in one week
  svcThenMon: 30,   // service week → the next Mon night
  wkndThenMon: 40,  // weekend → the next Mon night
  wkndThenSvc: 45,  // weekend → straight into the next service week
  svcThenSvc: 45,   // two service weeks in a row
  backToBack: 50,   // back-to-back weeknights                    } HARD since 2026-10-12
  thuWknd: 50,      // a Thu night + that same weekend            } (rule 2 — never priced;
  svcWknd: 60,      // service week + that weekend (Fri→Sat→Sun)  }  see HARD_BEND_KEYS)
  svcPlus: 60,      // service-week surgeon also on a weeknight
  svcWkndSplit: 60, // service week + that weekend when a holiday 24h row (someone else's) holds the Saturday
  empty: 400,       // nobody can take the slot
};
// Rule 2 (owner 2026-10-12): nobody works two overnight shifts in a row —
// weeknights, Thu night → Fri, Fri night → service Saturday, Saturday →
// Sunday, Sunday → next Monday. These four keys are those pairs at the slot
// level; they are the FLOOR now, not bends (designed holiday runs exempt).
// The one exception is FLEX (FAK) on a service week + that weekend, a LAST
// RESORT ranked just below the floor (scheduleRules below).
const HARD_BEND_KEYS = ["backToBack", "thuWknd", "svcWknd", "wkndThenMon"];
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
  svcWknd: "service week + that weekend (Fri → Sat → Sun in a row)",
  svcPlus: "service week + a weeknight the same week",
  svcWkndSplit: "service week + that weekend (a holiday 24h holds the Saturday)",
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
  // Service week: Mon–Sat AND its Sunday (rule 1, owner 2026-10-12 — the
  // service-week surgeon must be free that Sunday: no vacation, no-call or
  // Silvis primary day).
  if (slot === "dayCall") { for (let o = 0; o < 7; o++) if (onVac(id, d(o), v)) return false; return true; }
  if (slot === "wknd") return !onVac(id, d(4), v) && !onVac(id, d(6), v) && !onVac(id, d(7), vo);
  const o = BEND_NIGHT_OFF[slot];
  if (o === undefined) return true;
  return !onVac(id, d(o), v) && !onVac(id, d(o + 1), vo);
}

// Same surgeon on two slots of ONE week → its BEND_COST key (null = no bend).
function sameWeekBendKey(a, b) {
  if (a === b) return null;
  if ((a === "dayCall" && b === "wknd") || (a === "wknd" && b === "dayCall")) return "svcWknd";
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

// Decision 3's Christmas DESIGN week for one holiday card: null unless it is a
// Christmas card wholly the Christmas surgeon's (A = B = christmasDcId — FAK by
// the standing rule); else the Monday of the week holding Christmas (the week
// before for a Monday Christmas — the Monday-holiday convention). It is his
// WHOLE week, its service week and its weekend, in every year (owner
// 2026-10-13): on a Tuesday Christmas (2029, 2035…) the New Year's card on
// Mon 12/31 would claim the same week by its Monday convention — decision 3
// wins, and New Year's keeps its own 24h rows. Read by holidayDesign, the
// rules engine and generateOnce alike.
function christmasDesignWeek(h, christmasDcId) {
  if (!h || h.name !== "Christmas Day" || !h.date || !christmasDcId || h.surgeonA !== christmasDcId || h.surgeonB !== christmasDcId) return null;
  const x = parse(h.date), dow = x.getDay();
  return fmt(addD(x, dow === 0 ? -6 : dow === 1 ? -7 : 1 - dow));
}

// Decision 3's slot test (owner 2026-10-13): FAK takes a slot of his
// Christmas design week only when he can work it — free by the floor
// (slotFloorOk) and no Silvis primary 24h right next to its overnights (rule 2
// across the two jobs). Otherwise whatever the other cards pin there (a
// Monday convention) stands, or the search fills it. One builder for every
// holidayDesign caller: the rules engine, generateOnce, the app's Warnings.
function christmasSlotOk(vac, vacOnly, silvisPrimary) {
  const sd = silvisPrimary && silvisPrimary.id ? new Set(Array.from(silvisPrimary.dates || [])) : null;
  return (id, mondayStr, slot) => {
    if (!slotFloorOk(id, mondayStr, slot, vac, vacOnly)) return false;
    if (!sd || id !== silvisPrimary.id) return true;
    const m = typeof mondayStr === "string" ? parse(mondayStr) : mondayStr, nights = slot === "dayCall" ? [5] : slot === "wknd" ? [4, 6] : [];
    return !nights.some(o => sd.has(fmt(addD(m, o - 1))) || sd.has(fmt(addD(m, o + 1))));
  };
}

// Who works a holiday card's Night Before (owner 2026-10-13): its surgeon B —
// except a weekend night (Fri / Sun) of FAK's Christmas design week when the
// cards give him that weekend (decision 3: a Tuesday Christmas's New Year's
// eve, Sun 12/30). takesWknd(mondayStr) answers from the generator's own pins
// (holidayDesign with christmasSlotOk), so time off or a Silvis day added
// after the cards were made moves the eve back to B with them.
function holidayEveHolder(hol, eveDate, holAssignments, christmasDcId, takesWknd) {
  const b = hol ? hol.surgeonB : null;
  if (!hol || !eveDate || !christmasDcId || hol.name === "Christmas Day") return b;
  const x = parse(eveDate), dow = x.getDay();
  if (dow !== 5 && dow !== 0) return b;
  const arr = holAssignments && holAssignments[String(x.getFullYear())];
  const mon = christmasDesignWeek((Array.isArray(arr) ? arr : []).find(h => h && h.name === "Christmas Day"), christmasDcId);
  if (!mon || eveDate < mon || eveDate > fmt(addD(parse(mon), 6))) return b;
  return takesWknd && takesWknd(mon) ? christmasDcId : b;
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
//     (applied after the cards: it wins a week a Tue–Fri pin also claims, in
//     either card order — generateOnce's preDc does too)
//   - decision 3, applied last: FAK's whole Christmas design week → its
//     service week AND its weekend, over a Monday convention too
//     (christmasDesignWeek — a Tuesday Christmas's New Year's card) — each
//     slot only when slotOk(id, mondayStr, slot) passes (christmasSlotOk), and
//     the weekend not when another card's 24h of his sits next to it (Thu
//     before, Mon after: two nights in a row)
// Eves on a Fri or Sun (the weekend slot) keep today's handling (not pinned).
function holidayDesign(holAssignments, mondayStrs, christmasDcId, slotOk) {
  const pins = {}, eves = {};
  const inPeriod = new Set(mondayStrs || []);
  const mondayOf = (ds) => { const d = parse(ds); const dow = d.getDay(); return fmt(addD(d, dow === 0 ? -6 : 1 - dow)); };
  const pin = (m, slot, id) => { if (!id || !inPeriod.has(m)) return; (pins[m] = pins[m] || {})[slot] = id; };
  if (!holAssignments) return { pins, eves };
  const monConv = [], christWeeks = [], fakRows = new Set(); // fakRows: his 24h rows on OTHER cards
  Object.values(holAssignments).forEach(arr => {
    if (!Array.isArray(arr)) return;
    arr.forEach(h => {
      if (!h || !h.date) return;
      const rows = effectiveHolidayCoverage(h) || []; // helpers.js — the Christmas cap applies here too (sync-guards W5)
      const hDow = parse(h.date).getDay();
      const hMon = mondayOf(h.date);
      if (h.name !== "Christmas Day" && christmasDcId) rows.forEach(c => { if (c && !c.isEve && c.date && c.surgeon === christmasDcId) fakRows.add(c.date); });
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
      if ((hDow >= 2 && hDow <= 5) || (h.name === "Christmas Day" && christmasDcId && (hDow === 6 || hDow === 0))) { // decision 3: Christmas week (Sat / Sun Christmas included) is FAK's
        const dcId = h.name === "Christmas Day" && christmasDcId ? christmasDcId : h.surgeonA;
        pin(hMon, "dayCall", dcId);
      } else if (hDow === 1) {
        const prevM = fmt(addD(parse(hMon), -7));
        monConv.push([prevM, "dayCall", h.surgeonA], [prevM, "wknd", h.surgeonB]);
      }
      // Decision 3: when FAK holds the Christmas card (A = B, the standing
      // rule), Christmas week is his whole week + Eve — the design week's
      // WEEKEND too, whatever weekday Christmas falls on. (A Fri / Sun row or the
      // Monday convention already pinned it; this covers Tue–Thu and Saturday.)
      const cw = christmasDesignWeek(h, christmasDcId);
      if (cw) christWeeks.push({ m: cw, eve: fmt(addD(parse(h.date), -1)) });
    });
  });
  monConv.forEach(([m, slot, id]) => pin(m, slot, id));
  christWeeks.forEach(({ m, eve }) => {
    const ok = (slot) => !slotOk || slotOk(christmasDcId, m, slot);
    const d = (o) => fmt(addD(parse(m), o));
    if (ok("dayCall")) pin(m, "dayCall", christmasDcId);
    if (ok("wknd") && !fakRows.has(d(3)) && !fakRows.has(d(7))) pin(m, "wknd", christmasDcId);
    // …and a pin of his there that another rule set (his Fri / Sun Christmas
    // 24h's weekend, a Monday convention) but he cannot work is dropped — the
    // search fills it — except the weekend holding his own Christmas Eve (a
    // Monday Christmas: that Sunday night is the card's)
    if (slotOk && pins[m]) ["dayCall", "wknd"].forEach(slot => {
      if (pins[m][slot] !== christmasDcId || ok(slot) || (slot === "wknd" && (eve === d(4) || eve === d(6)))) return;
      delete pins[m][slot];
    });
  });
  return { pins, eves };
}

/* ═══ RULES ENGINE — the floor, strain and the ranking (owner brief 2026-10-12) ═══
   ONE reading of a schedule, shared by the generator's search (scoring every
   schedule it considers), the preview's "Needs your OK" box
   (listScheduleBends) and the tests. A schedule is ranked by these tiers IN
   ORDER — a lower tier never buys a higher one (not a blended sum):
     1. FLOOR: a lock not honored; a shift on time off (slotFloorOk — the
        service week now includes its Sunday, rule 1); two overnight shifts
        in a row for anyone (rule 2: weeknights, Thu night → Fri, Fri night →
        service Saturday, Saturday → Sunday, Sunday → next Monday — any two
        consecutive dates, holiday 24h rows included); an EMPTY slot.
        Designed holiday runs are exempt: both nights fixed by the holiday
        cards (a card's Night Before + its own 24h; FAK's Christmas week).
     2. LAST RESORT: a FLEX surgeon (FAK) on a service week + that weekend
        (Fri → Sat → Sun) — taken only when nothing else clears the floor.
     3. Service weeks even, then 4. weekends even (a holiday weekend counts
        for its weekend-slot holder): the spread, then the sum of squares.
     5. STRAIN for every partner but FLEX, counted in units:
        a. weekends worked back to back (Fri night, service Saturday, Sunday
           or a holiday 24h on Fri/Sat/Sun) — one unit per consecutive pair;
        b. service weeks every other week or closer (≤ MIN_DC_GAP apart,
           seam-aware) — one unit per pair;
        c. every-other-night runs of 3+ overnights — one unit per triple.
        A pair / triple is exempt when EVERY shift in it is fixed — by the
        holiday cards (designed pins, 24h rows) or by the published weeks
        before the period: RPC Wed eve 11/25 → Fri 24h 11/27 → Sun 11/29,
        DJA 12/30 → 1/1 → 1/3, MCC's Thanksgiving service week 11/23 after
        his published 11/9, FAK's Christmas week.
     6. BENDS: the BEND_COST ladder (rule-2 keys excluded — they are floor),
        plus FLEX strain at FLEX_STRAIN_COST a unit ("allowed, but it costs
        something").
     7. Totals even. 8. Soft: the 1st-call-only splits. 9. Avoided nights
        (preferences).
   A holiday 24h row holds its date 7a–7a and drops that date's regular slot
   (weekHolders' rule). */
const FLEX = ["FAK"];           // codes whose strain is allowed (at a cost) — one named list
const FLEX_STRAIN_COST = 10;    // per FLEX strain unit, in the bend tier
const RULE_TIERS = ["floor", "lastResort", "svc", "wknd", "strain", "bend", "total", "soft", "prefs"];
const RULE_SLOT_OF_DAY = [1, 2, 3, 4, 5, 0, 5]; // Mon..Sun → the slot whose overnight the date is
const RULE_LADDER = ["monWknd", "tueWknd", "wedWknd", "nightsApart", "svcPlus", "svcThenMon", "wkndThenSvc", "svcThenSvc", "svcWkndSplit"];

// ctx = { surgeons, mondays (consecutive), vac, vacationsOnly, holAssignments,
// prevWeekSeed {dayCall, wknd, nights?, holidayCoverage?, dayCallOverrides?, recentDc?}, locks?, preferences?,
// backupMondays?, christmasDcId?, sched?, silvisPrimary? } — sched (optional)
// supplies each week's stored holidayCoverage and isBackup, and marks absent
// weeks; silvisPrimary { id, dates } — FAK's Silvis primary 24h days (rule 2
// across the two jobs: his last resort).
function scheduleRules(ctx) {
  const c = ctx || {};
  const surgeons = c.surgeons || [];
  const ids = surgeons.map(s => s.id), P = ids.length;
  const pOf = new Map(ids.map((id, p) => [id, p]));
  const sp = (id) => (id && pOf.has(id)) ? pOf.get(id) : -1;
  const code = (p) => p >= 0 && p < P ? String(surgeons[p].name || ids[p]) : "";
  const vac = c.vac || {}, vacOnly = c.vacationsOnly || vac;
  const mStrs = (c.mondays || []).map(m => typeof m === "string" ? m : fmt(m));
  const W = mStrs.length, X = W * 6, ND = 7 + 7 * W, TN = RULE_TIERS.length;
  const m0 = W ? parse(mStrs[0]) : new Date(2000, 0, 3);
  const dayStr = []; for (let d = 0; d <= ND; d++) dayStr.push(fmt(addD(m0, d - 7))); // [ND] = the Monday after the period
  const md = (d) => { const x = parse(dayStr[d]); return (x.getMonth() + 1) + "/" + x.getDate(); };
  const dml = (d) => dayMonthLabel(dayStr[d]);
  const sched = c.sched || null;
  const present = new Uint8Array(W).fill(1);
  if (sched) for (let w = 0; w < W; w++) if (!sched[mStrs[w]]) present[w] = 0;
  const isBackup = new Uint8Array(W);
  const bset = c.backupMondays;
  for (let w = 0; w < W; w++) {
    const wk = sched && sched[mStrs[w]];
    isBackup[w] = (wk && wk.isBackup) || (bset && (typeof bset.has === "function" ? bset.has(mStrs[w]) : Array.isArray(bset) && bset.includes(mStrs[w]))) ? 1 : 0;
  }
  const fakId = c.christmasDcId || (surgeons.find(s => String(s.name || "").toUpperCase() === "FAK") || {}).id || null;
  const flex = new Uint8Array(P);
  surgeons.forEach((s, p) => { if (FLEX.includes(String(s.name || "").toUpperCase())) flex[p] = 1; });
  const design = holidayDesign(c.holAssignments, mStrs, fakId, christmasSlotOk(vac, vacOnly, c.silvisPrimary));
  const pin = new Int8Array(X).fill(-1);
  for (let w = 0; w < W; w++) {
    const pw = design.pins[mStrs[w]];
    if (pw) for (let s = 0; s < 6; s++) pin[w * 6 + s] = sp(pw[BEND_SLOTS[s]]);
  }
  const floorTab = new Uint8Array(X * P);
  for (let w = 0; w < W; w++) for (let s = 0; s < 6; s++) for (let p = 0; p < P; p++)
    floorTab[(w * 6 + s) * P + p] = slotFloorOk(ids[p], mStrs[w], BEND_SLOTS[s], vac, vacOnly) ? 1 : 0;
  // Holiday 24h rows: -1 none, -2 a row whose surgeon is not on the roster, else who holds the date.
  const rowOwner = new Int8Array(ND).fill(-1);
  const { holCoverage } = holidayCoverageMap(c.holAssignments);
  for (let w = 0; w < W; w++) {
    const wk = sched && sched[mStrs[w]];
    const stored = wk && Object.prototype.hasOwnProperty.call(wk, "holidayCoverage") ? (wk.holidayCoverage || {}) : null;
    for (let k = 0; k < 7; k++) {
      const d = 7 + 7 * w + k, cv = stored ? stored[dayStr[d]] : holCoverage[dayStr[d]];
      if (cv) rowOwner[d] = cv.surgeonId && pOf.has(cv.surgeonId) ? pOf.get(cv.surgeonId) : -2;
    }
  }
  // The Monday after the period: a holiday 24h there (e.g. Memorial Day after
  // a period ending the week before) is already fixed by its card, so the
  // last Sunday → that Monday is checked too (rule 2).
  const nextRow = holCoverage[dayStr[ND]];
  const nextOwn = nextRow && nextRow.surgeonId && pOf.has(nextRow.surgeonId) ? pOf.get(nextRow.surgeonId) : -1;
  // Rule 2's DESIGNED runs, exactly the brief's: a card's Night Before → its
  // own 24h the next date, and FAK's Christmas week — when FAK holds the
  // Christmas card (A = B, the standing rule), the overnights decision 3 gives
  // him: the eve, Christmas Day, and the Friday night, service Saturday and
  // Sunday of the Christmas DESIGN week (christmasDesignWeek: the week holding
  // Christmas; the week before when Christmas is a Monday). Read from the card
  // by date, for every weekday Christmas can fall on (a Tuesday Christmas
  // too — decision 3 wins over New Year's Monday convention). Those dates
  // count as fixed by the cards when he holds them (christOwner), and that
  // week is never his "last resort". A pair is exempt only when both dates
  // are fixed by the cards (fix 1) AND marked here — another night he takes
  // that week is not.
  const designedPair = new Uint8Array(ND + 1);
  const christOwner = new Int8Array(ND + 1).fill(-1), christWeekP = new Int8Array(W).fill(-1);
  const dIdx = new Map(dayStr.map((ds, d) => [ds, d]));
  Object.values(c.holAssignments || {}).forEach(arr => (Array.isArray(arr) ? arr : []).forEach(h => {
    if (!h || !h.date) return;
    const rows = effectiveHolidayCoverage(h) || [];
    rows.forEach(r => {
      if (!r || !r.isEve || !r.date || !dIdx.has(r.date)) return;
      const d = dIdx.get(r.date);
      if (rows.some(q => q && !q.isEve && q.date === dayStr[d + 1] && q.surgeon === r.surgeon)) designedPair[d] = 1;
    });
    const cw = christmasDesignWeek(h, fakId);
    if (cw && sp(fakId) >= 0) {
      const p = sp(fakId), desMon = parse(cw), w = mStrs.indexOf(cw);
      // in the period: only the slots the cards' pins give him (christmasSlotOk);
      // the week before the period is history — all of it
      const dp = w >= 0 ? (design.pins[cw] || {}) : { dayCall: fakId, wknd: fakId };
      const eve = rows.find(r => r && r.isEve && r.date);
      const desDays = new Set([h.date]);
      if (dp.wknd === fakId) { desDays.add(fmt(addD(desMon, 4))); desDays.add(fmt(addD(desMon, 6))); }
      if (dp.dayCall === fakId) desDays.add(fmt(addD(desMon, 5)));
      if (eve) desDays.add(eve.date);
      desDays.forEach(ds => { if (dIdx.has(ds)) christOwner[dIdx.get(ds)] = p; });
      desDays.forEach(ds => { const nx = fmt(addD(parse(ds), 1)); if (desDays.has(nx) && dIdx.has(ds)) designedPair[dIdx.get(ds)] = 1; });
      if (w >= 0 && dp.dayCall === fakId && dp.wknd === fakId) christWeekP[w] = p;
    }
  }));
  // Rule 2 across the two jobs (owner 2026-10-13): FAK's Silvis PRIMARY days
  // (ctx.silvisPrimary { id, dates } — each one 24h, 07:00 → 07:00) are
  // overnights too. A Davenport overnight of his on the date right before or
  // after one is two overnights in a row — allowed only as his LAST RESORT,
  // like his service week + weekend: ranked just below the floor and listed.
  // (Davenport call ON a Silvis day is time off: the app folds those days
  // into vac.) silAt[d] = a Silvis primary on dayStr[d].
  const silP = c.silvisPrimary ? sp(c.silvisPrimary.id) : -1;
  const silAt = new Uint8Array(ND + 1);
  if (silP >= 0) { const sd = new Set(Array.from(c.silvisPrimary.dates || [])); for (let d = 0; d <= ND; d++) if (sd.has(dayStr[d])) silAt[d] = 1; }
  // The week before the period (prevWeekSeed): its overnights, and service-week history.
  const seed = c.prevWeekSeed || null;
  const seedOwn = new Int8Array(7).fill(-1);
  if (seed) {
    const n = seed.nights || {};
    ["mon", "tue", "wed", "thu"].forEach((k, i) => { seedOwn[i] = sp(n[k]); });
    seedOwn[4] = sp(seed.wknd); seedOwn[6] = sp(seed.wknd); seedOwn[5] = sp(seed.dayCall);
    // who really held those dates (weekHolders' rule, helpers.js): a single-day
    // override holds the service Saturday; any holidayCoverage row (holiday,
    // swap) holds its date instead of the regular slot
    const ovr = seed.dayCallOverrides || {}, hc = seed.holidayCoverage || {};
    if (seed.dayCall && ovr[dayStr[5]]) seedOwn[5] = sp(ovr[dayStr[5]]);
    for (let k = 0; k < 7; k++) { const cv = hc[dayStr[k]]; if (cv) seedOwn[k] = sp(cv.surgeonId); }
  }
  const seedDc = seed ? sp(seed.dayCall) : -1, seedWk = seed ? sp(seed.wknd) : -1;
  const lastSvc0 = new Int16Array(P).fill(-999);
  if (seed && seed.recentDc) for (const id in seed.recentDc) { const p = sp(id), v = seed.recentDc[id]; if (p >= 0 && typeof v === "number" && v < 0) lastSvc0[p] = v; }
  if (seedDc >= 0) lastSvc0[seedDc] = -1;
  // Locks (in the period, on roster surgeons), avoided nights.
  const lockX = [], lockP = [];
  (Array.isArray(c.locks) ? c.locks : []).forEach(l => {
    if (!l || !l.mondayStr || !l.slot || !l.surgeonId) return;
    const w = mStrs.indexOf(l.mondayStr), s = BEND_SLOTS.indexOf(l.slot === "dc" ? "dayCall" : l.slot), p = sp(l.surgeonId);
    if (w >= 0 && s >= 0 && p >= 0) { lockX.push(w * 6 + s); lockP.push(p); }
  });
  const avoid = new Int8Array(P).fill(-1), prefer = new Int8Array(P).fill(-1);
  const prefs = c.preferences || {};
  const slotIx = (k) => k ? BEND_SLOTS.indexOf(k === "dc" ? "dayCall" : k) : -1;
  ids.forEach((id, p) => { const pr = prefs[id] || {}; avoid[p] = slotIx(pr.avoidShift); prefer[p] = slotIx(pr.preferShift); });
  // Slots the search never moves: a designed holiday pin, a holiday-covered weeknight.
  const fixedHolder = new Int8Array(X).fill(-1);
  for (let x = 0; x < X; x++) if (pin[x] >= 0 && floorTab[x * P + pin[x]]) fixedHolder[x] = pin[x];
  for (let w = 0; w < W; w++) for (let s = 1; s <= 4; s++) {
    const r = rowOwner[7 + 7 * w + s - 1], x = w * 6 + s;
    if (r >= 0 && floorTab[x * P + r]) fixedHolder[x] = r;
  }
  const swKey = new Int8Array(36).fill(-1);
  for (let s1 = 0; s1 < 6; s1++) for (let s2 = s1 + 1; s2 < 6; s2++) {
    const key = sameWeekBendKey(BEND_SLOTS[s1], BEND_SLOTS[s2]);
    if (key && !HARD_BEND_KEYS.includes(key)) swKey[s1 * 6 + s2] = RULE_LADDER.indexOf(key);
  }
  const ladderCost = RULE_LADDER.map(k => BEND_COST[k]);
  const K_SVCMON = RULE_LADDER.indexOf("svcThenMon"), K_WKSVC = RULE_LADDER.indexOf("wkndThenSvc"), K_SVCSVC = RULE_LADDER.indexOf("svcThenSvc"), K_SPLIT = RULE_LADDER.indexOf("svcWkndSplit");

  // scratch
  const svc = new Int16Array(P), wkc = new Int16Array(P), ntc = new Int16Array(P), svcR = new Int16Array(P), wkR = new Int16Array(P), tot = new Int16Array(P);
  const own = new Int8Array(ND + 1), fix = new Uint8Array(ND + 1); // fix: 0 free, 1 holiday card, 2 published history; [ND] = the Monday after
  const wkd = new Uint8Array((W + 1) * P), wfx = new Uint8Array((W + 1) * P);
  const lrWeek = new Uint8Array(W);
  const spreadSq = (m) => { let mn = 1e9, mx = -1e9, sq = 0; for (let p = 0; p < P; p++) { const v = m[p]; if (v < mn) mn = v; if (v > mx) mx = v; sq += v * v; } return P ? (mx - mn) * 1e5 + sq : 0; };
  const spread = (m) => { let mn = 1e9, mx = -1e9; for (let p = 0; p < P; p++) { const v = m[p]; if (v < mn) mn = v; if (v > mx) mx = v; } return P ? mx - mn : 0; };

  // One pass over schedule `a` (Int8Array, W×6: dayCall, mon, tue, wed, thu, wknd; -1 empty).
  // Fills T (RULE_TIERS order). With `out` (an object), also collects the raw findings for list().
  function scan(a, T, out) {
    svc.fill(0); wkc.fill(0); ntc.fill(0); svcR.fill(0); wkR.fill(0);
    let empty = 0, timeoff = 0, avoided = 0, dropped = 0; // avoided: avoided nights held − preferred nights held
    for (let w = 0; w < W; w++) {
      if (!present[w]) continue;
      for (let s = 0; s < 6; s++) {
        const x = w * 6 + s, p = a[x];
        if (p < 0) { empty++; if (out) out.empty.push(x); continue; }
        if (!floorTab[x * P + p]) { timeoff++; if (out) out.timeoff.push(x); }
        if (s === 0) { svc[p]++; if (!isBackup[w]) svcR[p]++; }
        else if (s === 5) { wkc[p]++; if (!isBackup[w]) wkR[p]++; }
        else ntc[p]++;
        if (avoid[p] === s) avoided++; else if (prefer[p] === s) avoided--;
      }
    }
    for (let i = 0; i < lockX.length; i++) if (a[lockX[i]] !== lockP[i]) { dropped++; if (out) out.dropped.push(i); }
    // who holds each date overnight (seed week first)
    for (let d = 0; d < 7; d++) { own[d] = seedOwn[d]; fix[d] = 2; }
    for (let w = 0; w < W; w++) for (let k = 0; k < 7; k++) {
      const d = 7 + 7 * w + k, r = rowOwner[d];
      if (r !== -1) { own[d] = r; fix[d] = 1; continue; }
      const x = w * 6 + RULE_SLOT_OF_DAY[k], p = present[w] ? a[x] : -1;
      own[d] = p; fix[d] = p >= 0 && pin[x] === p ? 1 : 0;
    }
    own[ND] = nextOwn; fix[ND] = 1;
    for (let d = 0; d <= ND; d++) if (christOwner[d] >= 0 && own[d] === christOwner[d]) fix[d] = 1; // the seed week too (a period starting on Christmas Monday)
    // rule 2 (+ FLEX's last resort: service week + that weekend)
    let lastRes = 0, hard = 0;
    // FLEX on a service week + that weekend that really runs Fri → Sat → Sun
    // (the Saturday is theirs, not someone's holiday row): those pairs are
    // never "two nights in a row" for them — it is their LAST RESORT, unless
    // the cards pin both slots (designed) or it is their Christmas design week.
    for (let w = 0; w < W; w++) {
      const p = a[w * 6];
      lrWeek[w] = present[w] && p >= 0 && flex[p] && a[w * 6 + 5] === p && own[7 + 7 * w + 5] === p && christWeekP[w] !== p ? 1 : 0;
      if (lrWeek[w] && !(pin[w * 6] === p && pin[w * 6 + 5] === p)) { lastRes++; if (out) out.lastResort.push(w); }
    }
    // …and FAK's Davenport overnight next to his Silvis primary 24h (one unit per side)
    let silAdj = 0;
    if (silP >= 0) for (let d = 7; d < ND; d++) {
      if (own[d] !== silP) continue;
      const n = silAt[d - 1] + silAt[d + 1];
      if (n) { silAdj += n; if (out) out.silvisAdj.push(d); }
    }
    lastRes += silAdj;
    for (let d = 6; d < ND; d++) {
      const p = own[d];
      if (p < 0 || own[d + 1] !== p) continue;
      if (designedPair[d] && fix[d] === 1 && fix[d + 1] === 1) continue; // a designed holiday run
      if (d >= 7) { const k = (d - 7) % 7; if ((k === 4 || k === 5) && lrWeek[(d - 7 - k) / 7]) continue; }
      hard++; if (out) out.hard.push(d);
    }
    // strain a: weekends worked back to back
    wkd.fill(0); wfx.fill(1);
    for (let w = -1; w < W; w++) for (let k = 4; k <= 6; k++) {
      const d = 7 + 7 * w + k, p = own[d];
      if (p < 0) continue;
      const i = (w + 1) * P + p;
      wkd[i] = 1; if (fix[d] === 0) wfx[i] = 0;
    }
    let strain = 0, flexU = 0;
    for (let w = 0; w < W; w++) for (let p = 0; p < P; p++) {
      const i0 = w * P + p, i1 = (w + 1) * P + p;
      if (!wkd[i0] || !wkd[i1] || (wfx[i0] && wfx[i1])) continue;
      if (flex[p]) flexU++; else strain++;
      if (out) out.wkndPair.push([w, p]);
    }
    // strain b: service weeks ≤ MIN_DC_GAP apart
    for (let p = 0; p < P; p++) {
      let prev = lastSvc0[p], prevFixed = true;
      for (let w = 0; w < W; w++) {
        if (a[w * 6] !== p || !present[w]) continue;
        const fixedNow = pin[w * 6] === p;
        if (prev > -900 && w - prev <= MIN_DC_GAP && !(prevFixed && fixedNow)) { if (flex[p]) flexU++; else strain++; if (out) out.svcPair.push([prev, w, p]); }
        prev = w; prevFixed = fixedNow;
      }
    }
    // strain c: every other night, 3 in a run
    for (let d = 7; d < ND; d++) {
      const p = own[d];
      if (p < 0 || own[d - 2] !== p || own[d - 4] !== p) continue;
      if (fix[d] && fix[d - 2] && fix[d - 4]) continue;
      if (flex[p]) flexU++; else strain++;
      if (out) out.triple.push(d);
    }
    // bends (the ladder; designed pairs waived)
    let bend = 0;
    for (let w = 0; w < W; w++) {
      if (!present[w]) continue;
      const b = w * 6;
      for (let s1 = 0; s1 < 5; s1++) {
        const p = a[b + s1]; if (p < 0) continue;
        for (let s2 = s1 + 1; s2 < 6; s2++) {
          if (a[b + s2] !== p) continue;
          const ki = swKey[s1 * 6 + s2];
          if (ki < 0 || (pin[b + s1] === p && pin[b + s2] === p)) continue;
          bend += ladderCost[ki]; if (out) out.bend.push([ki, w, s1, s2, p, -1]);
        }
      }
      // Service week + that weekend is rule 2 (Fri → Sat → Sun) — unless someone
      // else's holiday 24h holds that Saturday: then no two nights are in a row,
      // but it is still the week's heaviest pair (the Warnings line says so), so
      // it is priced like the old svcPlus bend. Not for FAK's last resort or his
      // Christmas design week, not for a pair the cards pin.
      { const p = a[b];
        if (p >= 0 && a[b + 5] === p && own[7 + 7 * w + 5] !== p && !lrWeek[w] && christWeekP[w] !== p && !(pin[b] === p && pin[b + 5] === p)) {
          bend += ladderCost[K_SPLIT]; if (out) out.bend.push([K_SPLIT, w, 0, 5, p, -1]);
        } }
      const pd = w === 0 ? seedDc : (present[w - 1] ? a[b - 6] : -1), pk = w === 0 ? seedWk : (present[w - 1] ? a[b - 1] : -1);
      const des = (s1, s2, p) => w > 0 && pin[b - 6 + s1] === p && pin[b + s2] === p;
      if (pd >= 0 && a[b + 1] === pd && !des(0, 1, pd)) { bend += ladderCost[K_SVCMON]; if (out) out.bend.push([K_SVCMON, w, 0, 1, pd, w - 1]); }
      if (pk >= 0 && a[b] === pk && !des(5, 0, pk)) { bend += ladderCost[K_WKSVC]; if (out) out.bend.push([K_WKSVC, w, 5, 0, pk, w - 1]); }
      if (pd >= 0 && a[b] === pd && !des(0, 0, pd)) { bend += ladderCost[K_SVCSVC]; if (out) out.bend.push([K_SVCSVC, w, 0, 0, pd, w - 1]); }
    }
    for (let p = 0; p < P; p++) tot[p] = svc[p] + wkc[p] + ntc[p];
    T[0] = dropped * 1e6 + (hard + timeoff) * 1e3 + empty;
    T[1] = lastRes;
    T[2] = spreadSq(svc);
    T[3] = spreadSq(wkc);
    T[4] = strain;
    T[5] = bend + FLEX_STRAIN_COST * flexU;
    T[6] = spreadSq(tot);
    T[7] = spread(svcR) * 10 + spread(wkR);
    T[8] = avoided;
    if (out) Object.assign(out.n, { empty, timeoff, dropped, hard, lastRes, silvisAdj: silAdj, strain, flexUnits: flexU, ladder: bend });
  }

  const encode = (s) => {
    const a = new Int8Array(X).fill(-1);
    for (let w = 0; w < W; w++) {
      const wk = s && s[mStrs[w]]; if (!wk) continue;
      a[w * 6] = sp(wk.dayCall);
      for (let k = 1; k < 6; k++) a[w * 6 + k] = sp(wk.nights && wk.nights[BEND_SLOTS[k]]);
    }
    return a;
  };
  // A fresh schedule object: `base`'s weeks (flags, holiday coverage) with a's slots.
  const decode = (a, base) => {
    const out = {};
    for (let w = 0; w < W; w++) {
      const m = mStrs[w], bw = (base && base[m]) || {};
      if (base && !base[m]) continue;
      const id = (x) => a[x] >= 0 ? ids[a[x]] : null;
      const nights = { wknd: id(w * 6 + 5), mon: id(w * 6 + 1), tue: id(w * 6 + 2), wed: id(w * 6 + 3), thu: id(w * 6 + 4) };
      const dc = id(w * 6);
      const used = new Set([dc, ...Object.values(nights)].filter(Boolean));
      out[m] = { ...bw, dayCall: dc, nights, off: ids.find(i => !used.has(i)) || null };
    }
    return out;
  };
  const evaluate = (a, T) => { scan(a, T, null); return T; };
  const tiersOf = (T) => {
    const o = {}; RULE_TIERS.forEach((k, i) => { o[k] = T[i]; });
    o.svcSpread = Math.floor(T[2] / 1e5); o.wkndSpread = Math.floor(T[3] / 1e5); o.totalSpread = Math.floor(T[6] / 1e5);
    return o;
  };

  // Findings → plain-word items (the preview's "Needs your OK", the tests).
  function list(s, costOnly) {
    const a = encode(s);
    const T = new Float64Array(TN);
    const F = { empty: [], timeoff: [], dropped: [], hard: [], lastResort: [], silvisAdj: [], wkndPair: [], svcPair: [], triple: [], bend: [], n: {} };
    scan(a, T, F);
    const items = [];
    const mOf = (w) => w >= 0 ? mStrs[w] : fmt(addD(m0, 7 * w));
    const wOfDay = (d) => Math.floor((d - 7) / 7);
    const slotName = (w, s) => {
      const b = 7 + 7 * w;
      if (s === 0) return "service week of " + md(b);
      if (s === 5) return "weekend " + md(b + 4) + "–" + md(b + 6);
      return ["Mon", "Tue", "Wed", "Thu"][s - 1] + " night " + md(b + s - 1);
    };
    const slotType = (s) => s === 0 ? "service week" : s === 5 ? "weekend" : ["Mon", "Tue", "Wed", "Thu"][s - 1] + " night";
    const freeFor = (w, s) => costOnly ? [] : ids.map((_, p) => p).filter(p => floorTab[(w * 6 + s) * P + p]).map(code);
    const whoElse = (p, parts) => {
      if (costOnly) return "";
      const bits = parts.map(([w, s]) => { const o = freeFor(w, s).filter(n => n !== code(p)); return o.length ? "also free for the " + slotType(s) + ": " + o.join(", ") : "only " + code(p) + " is free for the " + slotType(s); });
      const anyOther = parts.some(([w, s]) => freeFor(w, s).some(n => n !== code(p)));
      return " (" + bits.join("; ") + (anyOther ? " — any other choice bends more" : "") + ")";
    };
    const push = (it) => { if (costOnly) it.text = ""; items.push(it); };
    F.dropped.forEach(i => { const x = lockX[i], w = (x / 6) | 0, s = x % 6, p = lockP[i];
      push({ kind: "lock", key: "lock", cost: 0, who: ids[p], mondayStr: mStrs[w], slots: [BEND_SLOTS[s]], free: [], text: `${code(p)}: ${slotName(w, s)} — locked, but not honored` }); });
    F.empty.forEach(x => { const w = (x / 6) | 0, s = x % 6, free = freeFor(w, s);
      push({ kind: "empty", key: "empty", cost: 0, who: null, mondayStr: mStrs[w], slots: [BEND_SLOTS[s]], free,
        text: `${slotName(w, s)} is EMPTY — ${free.length ? "everyone free for it is blocked by a harder rule (free: " + free.join(", ") + ")" : "nobody is free for it"}` }); });
    F.timeoff.forEach(x => { const w = (x / 6) | 0, s = x % 6, p = a[x], b = 7 + 7 * w;
      const sunOnly = s === 0 && onVac(ids[p], dayStr[b + 6], vac) && [0, 1, 2, 3, 4, 5].every(o => !onVac(ids[p], dayStr[b + o], vac));
      push({ kind: "timeoff", key: sunOnly ? "sunday" : "timeoff", cost: 0, who: ids[p], mondayStr: mStrs[w], slots: [BEND_SLOTS[s]], date: sunOnly ? dayStr[b + 6] : undefined,
        text: sunOnly ? `${code(p)}: ${slotName(w, s)} — off Sun ${md(b + 6)}; the service-week surgeon must be free that Sunday`
                      : `${code(p)}: ${slotName(w, s)} — on time off (or the night before a vacation)` }); });
    // rule 2: consecutive pairs merged into runs per surgeon
    { const seen = new Set();
      F.hard.forEach(d0 => {
        if (seen.has(d0)) return;
        const p = own[d0]; let d1 = d0 + 1;
        while (F.hard.includes(d1) && own[d1] === p) { seen.add(d1); d1++; }
        seen.add(d0);
        const days = []; for (let d = d0; d <= d1; d++) days.push(d);
        const w = Math.min(Math.max(wOfDay(d1), 0), W - 1), wp = wOfDay(d0);
        push({ kind: "hard", key: "consecutive", cost: 0, who: ids[p], mondayStr: mOf(w), prevMondayStr: wp !== w ? mOf(wp) : undefined, date: dayStr[d0], slots: [],
          text: `${code(p)}: ${days.map(dml).join(" → ")} — overnight shifts back to back (nobody works two nights in a row)` });
      }); }
    F.lastResort.forEach(w => { const p = a[w * 6], b = 7 + 7 * w;
      const run = [4, 5, 6].filter(k => own[b + k] === p).map(k => dml(b + k)).join(" → "); // only the nights they really hold
      push({ kind: "lastResort", key: "svcWknd", cost: 0, who: ids[p], mondayStr: mStrs[w], slots: ["dayCall", "wknd"],
        text: `${code(p)}: ${slotName(w, 0)} + ${slotName(w, 5)} — ${run} in a row, the last resort${whoElse(p, [[w, 5]])}` }); });
    F.silvisAdj.forEach(d => { const p = silP, w = wOfDay(d), s = RULE_SLOT_OF_DAY[(d - 7) % 7];
      // a holiday 24h row (the card's) or a slot the cards fix is not a free choice: no "also free", no slot
      const row = rowOwner[d] !== -1, fixed = !row && fixedHolder[w * 6 + s] === p;
      const what = row ? "holiday 24h " + dml(d) + ", the card's" : slotName(w, s) + (fixed ? ", fixed by the holiday cards" : "");
      const chain = [d - 1, d, d + 1].filter(x => x === d || silAt[x]).map(x => x === d ? "Davenport " + dml(d) + " (" + what + ")" : "Silvis 24h " + dml(x)).join(" → ");
      push({ kind: "lastResort", key: "silvisAdj", cost: 0, who: ids[p], mondayStr: mStrs[w], date: dayStr[d], slots: row || fixed ? [] : [BEND_SLOTS[s]],
        text: `${code(p)}: ${chain} — two overnights in a row across the two jobs, the last resort${row || fixed ? "" : whoElse(p, [[w, s]])}` }); });
    const strainItem = (p, key, units, w, text, extra) => push({ kind: flex[p] ? "flexStrain" : "strain", key, cost: flex[p] ? FLEX_STRAIN_COST * units : 0, units, who: ids[p], mondayStr: mOf(w), slots: [], text, ...(extra || {}) });
    // a: runs of weekends worked — one item per run (every worked weekend in a
    // row, exempt pairs included in the span), units = its non-exempt pairs.
    // Week v's flags sit at row v + 1 (row 0 = the week before the period).
    { const spans = new Map();
      F.wkndPair.forEach(([w, p]) => {
        let first = w - 1, last = w;
        while (first - 1 >= -1 && wkd[first * P + p]) first--;
        while (last + 1 < W && wkd[(last + 2) * P + p]) last++;
        const k = p + ":" + first + ":" + last, sp0 = spans.get(k);
        if (sp0) sp0.units++; else spans.set(k, { p, first, last, units: 1 });
      });
      spans.forEach(({ p, first, last, units }) => {
        const d0 = [4, 5, 6].map(k => 7 + 7 * first + k).find(d => own[d] === p), d1 = [6, 5, 4].map(k => 7 + 7 * last + k).find(d => own[d] === p);
        strainItem(p, "wkndRun", units, last, `${code(p)}: ${last - first + 1} weekends in a row, ${md(d0)}–${md(d1)}`);
      }); }
    // b: service weeks close together
    const mdWeek = (w) => { const x = addD(m0, 7 * w); return (x.getMonth() + 1) + "/" + x.getDate(); };
    F.svcPair.forEach(([w1, w2, p]) => strainItem(p, "svcGap", 1, w2,
      `${code(p)}: service weeks ${w2 - w1 === 1 ? "back to back" : "two weeks apart"}, ${mdWeek(w1)} & ${mdWeek(w2)}`, { prevMondayStr: mOf(w1) }));
    // c: every-other-night chains
    { const done = new Set();
      F.triple.forEach(d => {
        const p = own[d];
        let s0 = d - 4; while (s0 - 2 >= 0 && own[s0 - 2] === p) s0 -= 2;
        if (done.has(p + ":" + s0)) return; done.add(p + ":" + s0);
        let e = d; while (e + 2 < ND && own[e + 2] === p) e += 2;
        const chain = []; for (let x = s0; x <= e; x += 2) chain.push(x);
        const units = F.triple.filter(t => own[t] === p && t >= s0 + 4 && t <= e && (t - s0) % 2 === 0).length;
        strainItem(p, "everyOther", units, wOfDay(e), `${code(p)}: every other night ×${chain.length}, ${chain.map(dml).join(" → ")}`);
      }); }
    F.bend.forEach(([ki, w, s1, s2, p, pw]) => {
      const key = RULE_LADDER[ki];
      if (pw < 0 && !(ki === K_SVCMON || ki === K_WKSVC || ki === K_SVCSVC)) {
        push({ kind: "bend", key, cost: ladderCost[ki], who: ids[p], mondayStr: mStrs[w], slots: [BEND_SLOTS[s1], BEND_SLOTS[s2]], free: freeFor(w, s2).filter(n => n !== code(p)),
          text: `${code(p)}: ${slotName(w, s1)} + ${slotName(w, s2)} — ${BEND_TEXT[key]}${whoElse(p, [[w, s1], [w, s2]])}` });
      } else {
        const prevName = pw >= 0 ? slotName(pw, s1) : "the " + (s1 === 5 ? "weekend" : "service week") + " before the period";
        push({ kind: "bend", key, cost: ladderCost[ki], who: ids[p], mondayStr: mStrs[w], slots: [BEND_SLOTS[s1], BEND_SLOTS[s2]], prevMondayStr: pw >= 0 ? mStrs[pw] : null, free: freeFor(w, s2).filter(n => n !== code(p)),
          text: `${code(p)}: ${prevName} → ${slotName(w, s2)} — ${BEND_TEXT[key]}${whoElse(p, [[w, s2]])}` });
      }
    });
    // days with more than 4 surgeons off (information; costs nothing)
    if (W && !costOnly) for (let d = 7; d < ND; d++) {
      const off = ids.filter(id => onVac(id, dayStr[d], vac));
      if (off.length > 4) push({ kind: "crowded", key: "crowded", cost: 0, who: null, mondayStr: null, date: dayStr[d], slots: [], free: ids.filter(id => !off.includes(id)).map(id => code(sp(id))),
        text: `${md(d)}: ${off.length} of ${ids.length} surgeons are off (${off.map(id => code(sp(id))).join(", ")})` });
    }
    const tiers = tiersOf(T);
    return { cost: T[5], items, tiers, counts: F.n };
  }

  return { W, X, P, TN, ids, mStrs, floorTab, fixedHolder, present, flex, pin, isBackup, encode, decode, evaluate, list, tiersOf, scan, silvisPrimary: c.silvisPrimary || null };
}

// Every finding of ANY schedule — generated, loaded or hand-edited — for the
// preview's "Needs your OK" box, the Generate & Publish check and the tests.
// ctx = { surgeons, mondays, vac, vacationsOnly, holAssignments, prevWeekSeed,
// christmasDcId?, costOnly? }. Returns { cost, items, tiers, counts }: cost is
// the BEND tier (the BEND_COST ladder + FLEX strain), tiers every RULE_TIERS
// value. Item kinds: "lock", "empty", "timeoff" (key "sunday" for rule 1),
// "hard" (rule 2), "lastResort", "strain", "flexStrain", "bend", "crowded" —
// each { kind, key, cost, who, mondayStr, slots, text, … }.
function listScheduleBends(sched, ctx) {
  const c = ctx || {};
  const mondays = (c.mondays || Object.keys(sched || {}).sort()).map(m => typeof m === "string" ? m : fmt(m)).filter(m => sched && sched[m]);
  const R = scheduleRules({ ...c, mondays, sched });
  return R.list(sched, !!c.costOnly);
}

// ═══ HOLIDAY COVERAGE — one definition (generateOnce and the JSON loader) ═══
// The holiday cards' coverage rows as a map by date:
//   holCoverage { "YYYY-MM-DD": { surgeonId, role: "holiday_24h", hours, name, type, holiday } }
//   holByDate   { "YYYY-MM-DD": { surgeonA, surgeonB, name, type } }
// Rows come through effectiveHolidayCoverage (helpers.js), which applies the
// Christmas two-day cap to assignments saved before it. Eve rows are skipped:
// the eve is informational only — the regular schedule stays.
function holidayCoverageMap(holAssignments) {
  const holCoverage = {}, holByDate = {};
  if (holAssignments) {
    Object.values(holAssignments).forEach(yearArr => {
      if (!Array.isArray(yearArr)) return;
      yearArr.forEach(h => {
        holByDate[h.date] = { surgeonA: h.surgeonA, surgeonB: h.surgeonB, name: h.name, type: h.type };
        effectiveHolidayCoverage(h).forEach(c => {
          if (c.isEve) return;
          // holiday: the holiday's own name — a multi-day label is only "Fri 24h" / "Sat 24h"
          holCoverage[c.date] = { surgeonId: c.surgeon, role: "holiday_24h", hours: "7a–7a", name: c.label, type: h.type, holiday: h.name };
        });
      });
    });
  }
  return { holCoverage, holByDate };
}
// The coverage rows that fall in the week starting `monday` (a Date), or null.
function weekHolidayCoverage(holCoverage, monday) {
  const out = {};
  for (let i = 0; i < 7; i++) {
    const ds = fmt(addD(monday, i));
    if (holCoverage[ds]) out[ds] = holCoverage[ds];
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ═══ JSON LOADER (benchmark loader, owner 2026-10-12) ═══
// The app's "📋 Load schedule (JSON)" reads
//   { "startMonday": "YYYY-MM-DD", "numWeeks": N,
//     "weeks": { "YYYY-MM-DD": { "dayCall": "sN", "nights": { "mon", "tue", "wed", "thu", "wknd" } } } }
// into the preview. validateScheduleJson refuses the WHOLE file, with the
// reason, unless its Mondays are exactly the current Generate settings'
// (mondayStrs) and every id is a roster id. A week may also carry the fields
// the app computes itself (off, isBackup, isFierceBackup, holidayCoverage —
// an exported schedule has them); they are ignored and recomputed. Anything
// else is refused, so a typo can't be mistaken for an empty slot.
// → { ok: true, weeks: { mStr: { dayCall, nights } } } | { ok: false, error }
const LOADER_NIGHT_KEYS = ["mon", "tue", "wed", "thu", "wknd"];
function validateScheduleJson(o, mondayStrs, rosterIds, nameOf) {
  const bad = (error) => ({ ok: false, error });
  if (!o || typeof o !== "object" || Array.isArray(o)) return bad("the file must be one JSON object with startMonday, numWeeks and weeks");
  const want = (mondayStrs || []).slice();
  if (!want.length) return bad("the Generate settings have no weeks");
  if (o.startMonday !== want[0]) return bad(`the file starts on ${o.startMonday === undefined ? "(no startMonday)" : JSON.stringify(o.startMonday)}, but Generate is set to start on ${want[0]}`);
  if (o.numWeeks === undefined) return bad(`the file has no numWeeks (Generate is set to ${want.length} weeks)`);
  if (typeof o.numWeeks !== "number") return bad(`numWeeks must be the number ${want.length} (the file has ${JSON.stringify(o.numWeeks)}, which is ${typeof o.numWeeks === "string" ? "text" : "not a number"})`);
  if (o.numWeeks !== want.length) return bad(`the file has numWeeks ${JSON.stringify(o.numWeeks)}, but Generate is set to ${want.length} weeks`);
  if (!o.weeks || typeof o.weeks !== "object" || Array.isArray(o.weeks)) return bad("the file has no \"weeks\" object");
  const got = Object.keys(o.weeks).sort();
  const missing = want.filter(m => !(m in o.weeks)), extra = got.filter(m => !want.includes(m));
  if (missing.length || extra.length) {
    const list = (a) => a.slice(0, 4).map(k => JSON.stringify(k)).join(", ") + (a.length > 4 ? ` and ${a.length - 4} more` : "");
    return bad(`the file's weeks don't match the Generate settings (${want[0]} × ${want.length})${missing.length ? " — missing " + list(missing) : ""}${extra.length ? " — not in the settings: " + list(extra) : ""}`);
  }
  const roster = new Set(rosterIds || []), computed = ["off", "isBackup", "isFierceBackup", "holidayCoverage"];
  const rosterList = [...roster].map(id => nameOf && nameOf[id] ? id + " " + nameOf[id] : id).join(", ");
  const okId = (v) => v === null || v === undefined || v === "" || (typeof v === "string" && roster.has(v));
  const weeks = {};
  for (const m of want) {
    const w = o.weeks[m];
    if (!w || typeof w !== "object" || Array.isArray(w)) return bad(`week ${m} is not an object`);
    const unknown = Object.keys(w).filter(k => k !== "dayCall" && k !== "nights" && !computed.includes(k));
    if (unknown.length) return bad(`week ${m} has an unknown field "${unknown[0]}" (allowed: dayCall, nights; off, isBackup, isFierceBackup and holidayCoverage are ignored and recomputed)`);
    if (!okId(w.dayCall)) return bad(`week ${m}: dayCall ${JSON.stringify(w.dayCall)} is not a roster id (${rosterList})`);
    const n = w.nights === undefined || w.nights === null ? {} : w.nights;
    if (typeof n !== "object" || Array.isArray(n)) return bad(`week ${m}: nights must be an object`);
    const unknownN = Object.keys(n).filter(k => !LOADER_NIGHT_KEYS.includes(k));
    if (unknownN.length) return bad(`week ${m}: unknown night "${unknownN[0]}" (allowed: ${LOADER_NIGHT_KEYS.join(", ")})`);
    for (const k of LOADER_NIGHT_KEYS) if (!okId(n[k])) return bad(`week ${m}: ${k} ${JSON.stringify(n[k])} is not a roster id (${rosterList})`);
    weeks[m] = { dayCall: w.dayCall || null, nights: Object.fromEntries(LOADER_NIGHT_KEYS.map(k => [k, n[k] || null])) };
  }
  return { ok: true, weeks };
}
// Shape validated weeks EXACTLY as generateOnce stores a week: the nights in
// its key order, off = the first roster surgeon not on the week, the backup
// flags from the Monday sets, holiday coverage from the holiday cards.
function shapeScheduleWeeks(weeks, surgeons, backupMondays, fierceBackupMondays, holAssignments) {
  const ids = surgeons.map(s => s.id);
  const has = (set, m) => !!set && (typeof set.has === "function" ? set.has(m) : Array.isArray(set) && set.includes(m));
  const { holCoverage } = holidayCoverageMap(holAssignments);
  const out = {};
  Object.keys(weeks || {}).sort().forEach(mStr => {
    const w = weeks[mStr] || {}, wn = w.nights || {};
    const dc = w.dayCall || null;
    const nights = { wknd: wn.wknd || null, mon: wn.mon || null, tue: wn.tue || null, wed: wn.wed || null, thu: wn.thu || null };
    const assigned = new Set([dc, ...Object.values(nights)].filter(Boolean));
    const off = ids.find(id => !assigned.has(id)) || null;
    out[mStr] = { dayCall: dc, nights, off, isBackup: has(backupMondays, mStr), isFierceBackup: has(fierceBackupMondays, mStr), holidayCoverage: weekHolidayCoverage(holCoverage, parse(mStr)) };
  });
  return out;
}

function generateOnce(surgeons, mondays, vac, backupMondays, priorCounts, preferences, fierceBackupMondays, holAssignments, locks, prevWeekSeed, vacationsOnly, yearCounts, floorMemo, rules) {
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
  // { "YYYY-MM-DD": { surgeonId, role, name, type } } — holidayCoverageMap
  // (below), shared with the JSON loader so a loaded week is shaped the same.
  const { holCoverage, holByDate } = holidayCoverageMap(holAssignments);

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
  // FLEX surgeons (FLEX, by code — scheduleRules): strain allowed at a cost,
  // and service week + that weekend allowed as the last resort.
  const isFlexId = (id) => !!id && FLEX.includes(String(nameMap[id] || "").toUpperCase());

  // Designed holiday patterns (holidayDesign, top of file): card eves on
  // Mon–Thu are pinned nights (decision 2); holiday weeks' service weeks,
  // 24h nights and weekends are pinned to their card surgeons (Christmas
  // week → FAK, decision 3). Pins are skipped by the validation and fairness
  // passes exactly like locks. The FLOOR applies to them too: an eve surgeon
  // who is off is not pinned (the night is filled normally and listed).
  const design = holidayDesign(holAssignments, mondays.map(m => fmt(m)), fakId, christmasSlotOk(vac, vacOnly, rules && rules.silvisPrimary));
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
        const aAvail = floorOk(surgeonA, prevMonday, "dayCall"); // Mon–Sun (rule 1)
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

  // A Monday holiday right AFTER the period still claims the period's last
  // week by the same convention (A → its service week, B → its weekend) —
  // holidayDesign pins them too — or the last Sunday could run into the
  // card's Monday 24h (rule 2, 2026-10-12).
  if (mondays.length) {
    const lastMon = mondays[mondays.length - 1], lastMStr = fmt(lastMon), nextHol = holByDate[fmt(addD(lastMon, 7))];
    if (nextHol) {
      if (nextHol.surgeonA && floorOk(nextHol.surgeonA, lastMon, "dayCall")) (preAssign[lastMStr] = preAssign[lastMStr] || {}).dayCall = nextHol.surgeonA;
      if (nextHol.surgeonB && wkndAvail(nextHol.surgeonB, lastMon)) (preAssign[lastMStr] = preAssign[lastMStr] || {}).wknd = nextHol.surgeonB;
    }
  }

  // Decision 3: FAK, holding the Christmas card (A = B, the standing rule),
  // has the Christmas DESIGN week whole — its service week AND its weekend —
  // over any Monday-holiday convention above that claims the same week (a
  // Tuesday Christmas: the New Year's card on Mon 12/31; owner 2026-10-13),
  // slot by slot as holidayDesign pins them (christmasSlotOk: where he can
  // work it). Dealt to him below although he is that week's service doctor;
  // a slot he cannot take keeps the convention's deal, as the pins do.
  // Manual locks (next) still win.
  const christWkndWeeks = new Set();
  Object.values(holAssignments || {}).forEach(arr => (Array.isArray(arr) ? arr : []).forEach(h => {
    const cw = christmasDesignWeek(h, fakId), i = cw ? mondays.findIndex(m => fmt(m) === cw) : -1;
    if (i < 0) return;
    const dp = design.pins[cw] || {}, pa = (preAssign[cw] = preAssign[cw] || {});
    if (dp.dayCall === fakId && floorOk(fakId, mondays[i], "dayCall")) pa.dayCall = fakId; else if (pa.dayCall === fakId) delete pa.dayCall;
    if (dp.wknd === fakId && floorOk(fakId, mondays[i], "wknd")) { pa.wknd = fakId; christWkndWeeks.add(cw); } else if (pa.wknd === fakId) delete pa.wknd; // a slot the pins don't give him (his Fri Christmas's weekend next to a Silvis day) is not dealt to him either
  }));

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
    const availDC = ids.filter(id => floorOk(id, monday, "dayCall")); // Mon–Sun (rule 1)

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
    // …and the Christmas design week's weekend goes to the card's surgeon even though they hold the service week (decision 3)
    const christWknd = !!preWknd && preWknd === dc && christWkndWeeks.has(mStr) && floorOk(dc, monday, "wknd");
    if (preWknd && ((availWknd.includes(preWknd) && preWknd !== dc) || christWknd)) {
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
      // above is everyone else who clears the FLOOR). Service week + that
      // weekend is Fri → Sat → Sun in a row — rule 2 (2026-10-12) — so only a
      // FLEX surgeon (FAK) may take it, as the LAST RESORT; anyone else leaves
      // the slot EMPTY (the search below may still fill it) and the preview
      // lists it. Below the floor nobody is ever placed.
      if (dc && isFlexId(dc) && floorOk(dc, monday, "wknd")) {
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
        // A rule-2 pair (two overnights in a row — HARD_BEND_KEYS) is never
        // offered: such a surgeon is out, like one below the floor.
        const priced = (key) => HARD_BEND_KEYS.includes(key) ? Infinity : BEND_COST[key];
        const bendOf = (id) => {
          let cst = 0;
          if (id === dc) cst += BEND_COST.svcPlus;
          if (id === nights.wknd) cst += priced(sameWeekBendKey(sk, "wknd"));
          for (const k of NIGHT_KEYS) if (k !== sk && nightAssignments[k] === id) cst += priced(sameWeekBendKey(sk, k));
          if (sk === "mon" && id === prevDcSurgeon) cst += BEND_COST.svcThenMon;
          if (sk === "mon" && id === prevWkndSurgeon) cst += priced("wkndThenMon");
          return cst;
        };
        const costs = floorPool.map(id => bendOf(id));
        const minCost = Math.min(...costs);
        avail = minCost === Infinity ? [] : floorPool.filter((id, i) => costs[i] === minCost);
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

    // Collect holiday coverage for this week (weekHolidayCoverage, below — shared with the JSON loader)
    sched[mStr] = { dayCall:dc, nights, off, isBackup, isFierceBackup, holidayCoverage: weekHolidayCoverage(holCoverage, monday) };
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
    const dealt = (rules || scheduleRules({ surgeons, mondays, vac, vacationsOnly: vacOnly, holAssignments, prevWeekSeed })).list(sched, true);
    const bent = new Set();
    dealt.items.forEach(it => {
      if (it.kind !== "bend" && it.kind !== "empty" && it.kind !== "hard" && it.kind !== "lastResort") return;
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
      // holding a value (fixed, or assigned earlier in the search). Rule 2
      // (2026-10-12): a HARD_BEND_KEYS pair costs more than leaving the slot
      // EMPTY, so it is never chosen; FLEX's service week + that weekend is
      // the LAST RESORT — dearer than any bends, cheaper than an empty slot.
      const S_EMPTY = 10000, S_LAST_RESORT = 5000, S_HARD = 1e7;
      const pairCost = (key, id) => !HARD_BEND_KEYS.includes(key) ? BEND_COST[key] : (key === "svcWknd" && isFlexId(id) ? S_LAST_RESORT : S_HARD);
      const addCost = (w, slot, id) => {
        if (!id) return S_EMPTY;
        const m = mStrs[w]; let c = 0;
        for (const s2 of BEND_SLOTS) {
          if (s2 === slot || at(w, s2) !== id) continue;
          const key = sameWeekBendKey(slot, s2);
          if (key && !isDesignedPair(m, slot, m, s2, id)) c += pairCost(key, id);
        }
        for (const [a, b] of LINKS) {
          if (a === slot && at(w + 1, b) === id && !isDesignedPair(m, a, mStrs[w + 1], b, id)) c += pairCost(crossWeekBendKey(a, b), id);
          if (b === slot && at(w - 1, a) === id && !(w > 0 && isDesignedPair(mStrs[w - 1], a, m, b, id))) c += pairCost(crossWeekBendKey(a, b), id);
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
      if (!floorOk(Y, monday, "dayCall")) return false; // Mon–Sun (rule 1)
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


  return sched;
}

// Lexicographic compare of two tier vectors (RULE_TIERS order): <0 when A ranks better.
function ruleCompare(A, B) {
  for (let i = 0; i < RULE_TIERS.length; i++) { if (A[i] < B[i]) return -1; if (A[i] > B[i]) return 1; }
  return 0;
}

/* ═══ SEARCH (owner brief 2026-10-12, item 5) ═══
   generateOnce deals a starting schedule (the deal + the exact mildest-bend
   search + the fairness passes); a LOCAL SEARCH then improves it under the
   scheduleRules tiers: it proposes small changes — two slots of a kind trade
   holders (counts kept), any two slots trade, one slot changes hands (while
   the totals are uneven, a quarter of those give the busiest surgeon's
   weeknight to the least busy — 2026-10-18: without it an 11/13 split, every
   tier above it at its floor, outlasted generate()'s 60,000 schedules in
   about 1 of 5,400 of the regression test's vacation and squeeze rolls), two
   surgeons trade everything they hold in a week, three slots of a kind
   rotate — keeps every change that ranks no worse, and from time to time
   "kicks" the best schedule (a few random changes) to leave a local optimum.
   Every proposal is a whole schedule, ranked from scratch by scheduleRules —
   that is the "schedules checked" count. Nothing it does goes below the
   floor table (slotFloorOk) or moves a designed holiday pin or a
   holiday-covered night; locks are held by the floor tier. */
const SEARCH_MS = 10000;          // one Generate / one "Search more", in the app
const SEARCH_KICK_AFTER = 4000;   // proposals without a new best → kick
const SEARCH_START_KICKS = 8;     // kicks without a new best → a fresh start
const SEARCH_PREFS_POLISH = 3000; // schedules more once every other tier is at its floor (preferences)

function createImprover(R, a0, rnd) {
  const X = R.X, P = R.P, TN = R.TN, ft = R.floorTab;
  const a = Int8Array.from(a0), best = Int8Array.from(a0);
  const T = new Float64Array(TN), Tn = new Float64Array(TN), Tb = new Float64Array(TN);
  R.evaluate(a, T); Tb.set(T);
  const isMov = new Uint8Array(X), mov = [], byT = [[], [], []];
  for (let x = 0; x < X; x++) {
    const w = (x / 6) | 0, s = x % 6;
    if (!R.present[w] || (R.fixedHolder[x] >= 0 && a0[x] === R.fixedHolder[x])) continue;
    isMov[x] = 1; mov.push(x); byT[s === 0 ? 0 : s === 5 ? 2 : 1].push(x);
  }
  const typeOf = (x) => { const s = x % 6; return s === 0 ? 0 : s === 5 ? 2 : 1; };
  const cx = new Int16Array(64), cv = new Int8Array(64); let nc = 0;
  const set = (x, p) => { cx[nc] = x; cv[nc] = a[x]; nc++; a[x] = p; };
  const revert = () => { while (nc > 0) { nc--; a[cx[nc]] = cv[nc]; } };
  const ok = (x, p) => p < 0 || ft[x * P + p] === 1;
  const pick = (arr) => arr[(rnd() * arr.length) | 0];
  const tl = new Int16Array(P), hiX = new Int16Array(X), loP = new Int8Array(P);
  let evals = 0, since = 0, kicks = 0;
  function propose() {
    nc = 0;
    if (!mov.length) return false;
    const r = rnd();
    if (r < 0.40) {                       // two slots of a kind trade holders
      const x = pick(mov), y = pick(byT[typeOf(x)]), px = a[x], py = a[y];
      if (x === y || px === py || !ok(x, py) || !ok(y, px)) return false;
      set(x, py); set(y, px);
    } else if (r < 0.55) {                // any two slots trade holders
      const x = pick(mov), y = pick(mov), px = a[x], py = a[y];
      if (x === y || px === py || !ok(x, py) || !ok(y, px)) return false;
      set(x, py); set(y, px);
    } else if (r < 0.75) {                // one slot changes hands — a quarter of the time, while the totals
      let x = -1, q = -1;                 // are uneven, the busiest surgeon's weeknight to the least busy
      if (r >= 0.70) {
        tl.fill(0);
        for (let y = 0; y < X; y++) if (a[y] >= 0 && R.present[(y / 6) | 0]) tl[a[y]]++;
        let mx = -1, mn = 1e9;
        for (let p = 0; p < P; p++) { if (tl[p] > mx) mx = tl[p]; if (tl[p] < mn) mn = tl[p]; }
        if (mx - mn >= 2) {
          let nh = 0, nl = 0;
          for (const y of byT[1]) if (a[y] >= 0 && tl[a[y]] === mx) hiX[nh++] = y;
          for (let p = 0; p < P; p++) if (tl[p] === mn) loP[nl++] = p;
          if (nh) { x = hiX[(rnd() * nh) | 0]; q = loP[(rnd() * nl) | 0]; }
        }
      }
      if (x < 0) { x = pick(mov); q = (rnd() * P) | 0; } // otherwise the old move, same draws
      if (q === a[x] || !ok(x, q)) return false;
      set(x, q);
    } else if (r < 0.87) {                // two surgeons trade their week
      const x = pick(mov), w = (x / 6) | 0, p = a[x], q = (rnd() * P) | 0;
      if (p < 0 || q === p) return false;
      for (let s = 0; s < 6; s++) {
        const y = w * 6 + s; if (!isMov[y]) continue;
        const h = a[y]; if (h !== p && h !== q) continue;
        const n = h === p ? q : p;
        if (!ok(y, n)) { revert(); return false; }
        set(y, n);
      }
    } else {                              // three slots of a kind rotate
      const x = pick(mov), L = byT[typeOf(x)], y = pick(L), z = pick(L);
      const px = a[x], py = a[y], pz = a[z];
      if (x === y || y === z || x === z || px === py || py === pz || px === pz) return false;
      if (!ok(x, py) || !ok(y, pz) || !ok(z, px)) return false;
      set(x, py); set(y, pz); set(z, px);
    }
    return nc > 0;
  }
  function step() {
    if (!propose()) return;
    R.evaluate(a, Tn); evals++;
    if (ruleCompare(Tn, T) <= 0) {
      T.set(Tn);
      if (ruleCompare(T, Tb) < 0) { Tb.set(T); best.set(a); since = 0; kicks = 0; }
    } else revert();
  }
  function kick() {
    a.set(best); T.set(Tb);
    const k = 2 + ((rnd() * 4) | 0);
    for (let i = 0; i < k; i++) { let t = 0; while (t++ < 30 && !propose()); }
    R.evaluate(a, T); evals++;
    kicks++; since = 0;
  }
  return {
    run(n) { for (let i = 0; i < n; i++) { step(); if (++since > SEARCH_KICK_AFTER) kick(); } },
    best, Tb,
    get evals() { return evals; },
    get spent() { return kicks >= SEARCH_START_KICKS; },
  };
}

// The search behind Generate / Preview and "🔍 Search more". Same inputs as
// generate(); opts { random, now }. step(ms) works for about ms and returns;
// run({ ms, proposals }) loops step until a limit or until the schedule is
// perfect (floor, last resort, strain and bends 0; service weeks, weekends,
// totals and the 1st-call splits as even as the slot counts allow) and the
// preferences have had SEARCH_PREFS_POLISH more schedules. best() is a fresh
// schedule object; status() { checked, starts, tiers, perfect (= done),
// improved }.
function createScheduleSearch(surgeons, mondays, vac, backupMondays, priorCounts, preferences, fierceBackupMondays, holAssignments, locks, prevWeekSeed, vacationsOnly, yearCounts, opts) {
  const o = opts || {};
  const rnd = o.random || Math.random;
  const now = o.now || (() => Date.now());
  const R = scheduleRules({ surgeons, mondays, vac, vacationsOnly, holAssignments, prevWeekSeed, locks, preferences, backupMondays, silvisPrimary: o.silvisPrimary || null });
  const floorMemo = new Map();
  const P = R.P, W = R.W;
  const tgt = (n) => (P && n % P) ? 1 : 0;
  const tgtSvc = tgt(W), tgtTot = tgt(6 * W);
  const nReg = R.mStrs.filter((m, w) => R.present[w] && !R.isBackup[w]).length, tgtReg = tgt(nReg);
  let bestA = null, bestBase = null, bestT = null, seedT = null, checked = 0, starts = 0, cur = null, curBase = null, curEvals = 0, perfectAt = null;
  // Every tier with a known floor at it: the floor, last resort, strain and
  // bends 0; service weeks, weekends, totals and the 1st-call splits as even
  // as the slot counts allow. Preferences have no known floor, so the search
  // then polishes for SEARCH_PREFS_POLISH more schedules and stops (done()).
  const isPerfect = (T) => !!T && T[0] === 0 && T[1] === 0 && Math.floor(T[2] / 1e5) <= tgtSvc && Math.floor(T[3] / 1e5) <= tgtSvc && T[4] === 0 && T[5] === 0 && Math.floor(T[6] / 1e5) <= tgtTot && T[7] <= tgtReg * 11;
  const done = () => { if (!isPerfect(bestT)) { perfectAt = null; return false; } if (perfectAt === null) perfectAt = checked; return checked - perfectAt >= SEARCH_PREFS_POLISH; };
  const newStart = () => {
    starts++;
    if (bestA && rnd() < 0.3) { cur = createImprover(R, bestA, rnd); curBase = bestBase; }  // intensify around the best
    else {
      const cand = generateOnce(surgeons, mondays, vac, backupMondays, priorCounts, preferences, fierceBackupMondays, holAssignments, locks, prevWeekSeed, vacationsOnly, yearCounts, floorMemo, R);
      cur = createImprover(R, R.encode(cand), rnd); curBase = cand;
      checked++;
    }
    curEvals = 0;
    if (!bestT || ruleCompare(cur.Tb, bestT) < 0) { bestT = Float64Array.from(cur.Tb); bestA = Int8Array.from(cur.best); bestBase = curBase; }
  };
  const work = (n) => {
    if (!cur || cur.spent) newStart();
    cur.run(n);
    checked += cur.evals - curEvals; curEvals = cur.evals;
    if (ruleCompare(cur.Tb, bestT) < 0) { bestT = Float64Array.from(cur.Tb); bestA = Int8Array.from(cur.best); bestBase = curBase; return true; }
    return false;
  };
  const self = {
    // Work for about `ms` (a time slice); true when the best got better. A
    // fresh start (a whole generateOnce, up to ~0.2 s on a squeezed period)
    // only ever opens a slice — it never runs on after other work (page
    // responsiveness).
    step(ms) {
      const end = now() + (ms || 0); let better = false, worked = false;
      do {
        if (done()) break;
        if ((!cur || cur.spent) && worked) break; // a fresh start only ever OPENS a slice
        if (work(400)) better = true;
        worked = true;
      } while (now() < end);
      return better;
    },
    run(lim) {
      const l = lim || {}, end = l.ms ? now() + l.ms : Infinity, cap = l.proposals || Infinity;
      const c0 = checked;
      if (!bestT) newStart();
      while (!done() && now() < end && checked - c0 < cap) work(400);
      return self;
    },
    // Start from an existing schedule ("🔍 Search more"): it is the best so
    // far, and status().improved says whether anything ranked better since.
    seed(s) {
      const a = R.encode(s), T = new Float64Array(R.TN);
      R.evaluate(a, T);
      bestA = a; bestT = T; bestBase = s; seedT = Float64Array.from(T); cur = null;
      return self;
    },
    best() { return bestA ? R.decode(bestA, bestBase) : null; },
    status() { return { checked, starts, tiers: bestT ? R.tiersOf(bestT) : null, perfect: done(), improved: !!bestT && (!seedT || ruleCompare(bestT, seedT) < 0) }; },
    rules: R,
  };
  return self;
}

// ═══ GENERATE — the synchronous entry point ═══
// One createScheduleSearch run, returned as a plain schedule object (the
// weeks only — nothing else enumerable). The app drives the search itself in
// time slices (SEARCH_MS, a progress line, "🔍 Search more"); this entry
// point serves the tests and any caller without a clock. opts { proposals,
// ms, random } — by default GENERATE_PROPOSALS schedules, or fewer when the
// schedule is perfect (every tier at its floor) sooner. 100,000 since
// 2026-10-18 (was 60,000; about 1–3% more test time): with the totals move
// above, none of 400,080 seeded vacation and squeeze rolls of the regression
// test is short of perfect at 100,000; at 60,000 one still ended on the 11/13
// split. The app never calls this (SEARCH_MS).
const GENERATE_PROPOSALS = 100000;
function generate(surgeons, mondays, vac, backupMondays, priorCounts, preferences, fierceBackupMondays, holAssignments, locks, prevWeekSeed, vacationsOnly, yearCounts, opts) {
  const o = opts || {};
  const search = createScheduleSearch(surgeons, mondays, vac, backupMondays, priorCounts, preferences, fierceBackupMondays, holAssignments, locks, prevWeekSeed, vacationsOnly, yearCounts, o);
  search.run({ ms: o.ms, proposals: o.proposals || GENERATE_PROPOSALS });
  return search.best() || generateOnce(surgeons, mondays, vac, backupMondays, priorCounts, preferences, fierceBackupMondays, holAssignments, locks, prevWeekSeed, vacationsOnly, yearCounts);
}
