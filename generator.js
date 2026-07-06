// DSG Call Schedule — Schedule Generator & Holiday Logic

/* ─── WEIGHTING & SCORING SCHEMES — one catalog so no future reader has to
   reverse-engineer which number governs what. FOUR distinct weightings live in
   this file (a fifth — billing — lives in the app UI, not here). They are
   INTENTIONALLY different; each answers a different question. Anchors are the
   function/variable names; line numbers are approximate and will drift.

   1. ASSIGNMENT PRIORITY — `priority(id)` (~line 191, inside generateOnce).
      Greedy "who gets the next shift". LOWER = more deserving.
        0.85·periodShifts  +  0.10·(priorYearScore/20)  +  0.05·(priorMultiScore/40)
      (within-period count is the primary goal; past-year 10%; multi-year 5%)

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

   4. BEST-OF-N CANDIDATE SCORE — `scoreOf(sched)` (~line 1266, inside the
      generate() best-of-50 wrapper). Picks the fairest candidate schedule.
      Lexicographic via powers of ten (LOWER = fairer):
        spread(combinedServiceWeeks)·10000  (dominates)
        + spread(weekends)·1000  + spread(total)·100
        + spread(1stCallServiceWeeks)·10  + spread(1stCallWeekends)·1

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

function generateOnce(surgeons, mondays, vac, backupMondays, priorCounts, preferences, fierceBackupMondays, holAssignments, locks, prevWeekSeed, vacationsOnly) {
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
        // Store each coverage day (skip Eve entries — those are display-only, not schedule overrides)
        if (h.coverage && Array.isArray(h.coverage)) {
          h.coverage.forEach(c => {
            if (c.isEve) return; // Eve is informational only — regular schedule stays
            holCoverage[c.date] = { surgeonId: c.surgeon, role: "holiday_24h", hours: "7a–7a", name: c.label, type: h.type };
          });
        }
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
  //   priorYear[id]      — 1-year prior totals from priorCounts (if 1-yr data
  //                        is separate, fall back to multi-year / 2).
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
    // Note: priorCounts here represents multi-year (see config.js COUNTS_2YR).
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

  // Rough 1-year approximation: half the multi-year burden.
  // Without dedicated 1-year input, this proxy is fine since priorYearScore
  // is only 10% weight in the priority function.
  ids.forEach(id => {
    priorYearScore[id] = priorMultiScore[id] / 2;
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
      const fb=rem.filter(id=>!used.has(id));
      if(fb.length){nights.wknd=fb[0];used.add(fb[0]);} else nights.wknd=null;
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
      if (cov && cov.role === "holiday_24h") {
        // Mark this night as covered by the holiday surgeon (suppresses separate assignment)
        holidayNightOverrides[sk] = cov.surgeonId;
      }
    });
    // Reserve the holiday-coverage surgeons up front. The per-slot override below
    // only fires when its slot is reached in the SHUFFLED order, so without this
    // a holiday surgeon could be handed an earlier weeknight first and end up
    // double-booked (covering the holiday 24h AND another night that week).
    Object.values(holidayNightOverrides).forEach(hid => nightUsed.add(hid));

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
    if (holidayWkndOverride && nights.wknd) {
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
      const dayOffset = {mon:0,tue:1,wed:2,thu:3}[sk];
      const sd = fmt(addD(monday, dayOffset));
      const nextDayStr = fmt(addD(monday, dayOffset + 1));
      const nightHoliday = holidayMap[sd]; // is this night a holiday?
      const nextDayHoliday = holidayMap[nextDayStr]; // is tomorrow a holiday?

      let avail = rem.filter(id => !used.has(id) && !nightUsed.has(id) && !onVac(id,sd,vac));
      avail = avail.filter(id => !onVac(id, nextDayStr, vacOnly)); // night ends next-day 7a — OK before a no-call day, blocked only before vacation

      // Weekend surgeon needs recovery after Fri–Sun. Monday night next week is
      // HARD-forbidden (enforced in canTakeSlot + repaired by the wknd→Mon fixup
      // pass below). Tuesday is SOFT (group rule, Jun 2026): preferred-avoided
      // here so clean schedules skip it, but allowed by the fairness passes when
      // needed to even the count. We still avoid BOTH here when a non-weekend
      // surgeon is available; only Monday is later repaired if it's forced.
      if ((sk === "mon" || sk === "tue") && prevWkndSurgeon) {
        const nonWknd = avail.filter(id => id !== prevWkndSurgeon);
        if (nonWknd.length > 0) avail = nonWknd;
      }

      // HARD RULE: Service week surgeon cannot take Monday night the following week
      if (sk === "mon" && prevDcSurgeon) {
        const nonDc = avail.filter(id => id !== prevDcSurgeon);
        if (nonDc.length > 0) avail = nonDc;
      }

      // HARD RULE: No back-to-back nights — filter out anyone who had a night yesterday
      const yesterdayStr = fmt(addD(monday, dayOffset - 1));
      const nonConsec = avail.filter(id => prevNightSurgeon[id] !== yesterdayStr);
      if (nonConsec.length > 0) avail = nonConsec;

      // Fallback layers
      if(!avail.length) avail = rem.filter(id => !used.has(id) && !nightUsed.has(id) && !onVac(id,sd,vac));
      if(!avail.length) avail = rem.filter(id => !used.has(id) && !nightUsed.has(id));

      // DOUBLE DUTY: Allow weekend surgeon to also take Monday night when pool is short
      // Matches hand-schedule pattern: Mon night (5p-7a) then Tue-Thu off then Fri night (5p-7a)
      // Safe because there's a 3-day gap between the two assignments
      if (!avail.length && sk === "mon" && nights.wknd) {
        const wkndId = nights.wknd;
        if (!onVac(wkndId, sd, vac) && !onVac(wkndId, nextDayStr, vac)) {
          avail = [wkndId];
        }
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

        // Prevent back-to-back: b can't already be Thursday night in week A
        // (Thu+wknd is the only forbidden combo — Mon/Tue/Wed + wknd are all
        // fine, since wknd starts Fri 5p).
        if (wkA.nights?.thu === b) continue;
        if (wkB.nights?.thu === a) continue;

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
      if (wk.nights?.thu === Y) return false; // Thu+wknd forbidden
      // Mon/Tue/Wed + wknd are allowed
    } else {
      // weeknight slot
      if (wk.dayCall === Y) return false;
      if (slot === "thu" && wk.nights?.wknd === Y) return false; // Thu+wknd
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

    // Inter-week constraints
    const prevWk = wkIdx > 0 ? sched[mondayStrs[wkIdx-1]] : null;
    const nextWk = wkIdx < mondayStrs.length-1 ? sched[mondayStrs[wkIdx+1]] : null;

    if (slot === "dayCall") {
      if (prevWk?.nights?.wknd === Y) return false; // wknd → DC forbidden
      if (prevWk?.dayCall === Y) return false; // consecutive SW forbidden
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
          if (wk.nights?.[sk] === wk.dayCall) {
            if (wk.off && canTakeSlot(wk.off, mondayStrs[i], parse(mondayStrs[i]), sk, wk, i)) {
              // Swap the conflicting night with the off surgeon
              wk.nights[sk] = wk.off;
              recalcOff(wk);
            } else if (pass === 2) {
              console.warn(`[validation] UNRESOLVED: ${wk.dayCall} has Service Week AND ${sk} night, week ${mondayStrs[i]} (no legal repair candidate)`);
            }
          }
        });
        // Fix: DC surgeon should not have weekend in same week
        if (wk.nights?.wknd === wk.dayCall) {
          if (wk.off && canTakeSlot(wk.off, mondayStrs[i], parse(mondayStrs[i]), "wknd", wk, i)) {
            wk.nights.wknd = wk.off;
            recalcOff(wk);
          } else if (pass === 2) {
            console.warn(`[validation] UNRESOLVED: ${wk.dayCall} has Service Week AND weekend, week ${mondayStrs[i]} (no legal repair candidate)`);
          }
        }
      }

      // Fix: Weekend surgeon should not also have Thursday night in same week
      // (back-to-back: Thu 5p–Fri 7a then wknd starts Fri 5p, no recovery).
      // Mon/Tue/Wed + wknd are all allowed — enough gap before wknd starts.
      if (wk.nights?.wknd && wk.nights?.thu === wk.nights?.wknd) {
        if (wk.off && canTakeSlot(wk.off, mondayStrs[i], parse(mondayStrs[i]), "thu", wk, i)) {
          wk.nights.thu = wk.off;
          recalcOff(wk);
        } else if (pass === 2) {
          console.warn(`[validation] UNRESOLVED: ${wk.nights.wknd} has Thu night AND weekend, week ${mondayStrs[i]} (no legal repair candidate)`);
        }
      }

      // Fix: Weekend surgeon should not have Monday night next week
      if (i < mondayStrs.length - 1 && wk.nights?.wknd) {
        const nextWk = sched[mondayStrs[i + 1]];
        if (nextWk?.nights?.mon === wk.nights.wknd && !isHolCoveredNight(mondayStrs[i + 1], "mon")) {
          // Try swapping Monday night with off surgeon of next week
          if (nextWk.off && canTakeSlot(nextWk.off, mondayStrs[i + 1], parse(mondayStrs[i + 1]), "mon", nextWk, i + 1)) {
            nextWk.nights.mon = nextWk.off;
            recalcOff(nextWk);
          } else {
            // Try swapping Monday night with another night surgeon in next
            // week — trySwapNights commits only if BOTH movers clear
            // canTakeSlot for their new slot.
            const otherNight = NIGHT_KEYS.find(sk => sk !== "mon" && nextWk.nights?.[sk] && nextWk.nights[sk] !== nextWk.dayCall && nextWk.nights[sk] !== wk.nights.wknd
              && trySwapNights(mondayStrs[i + 1], i + 1, "mon", mondayStrs[i + 1], i + 1, sk));
            if (!otherNight && pass === 2) {
              console.warn(`[validation] UNRESOLVED: ${wk.nights.wknd} has weekend then next Monday night, weeks ${mondayStrs[i]}→${mondayStrs[i + 1]} (no legal repair candidate)`);
            }
          }
        }
      }

      // Fix: Service week surgeon should not have Monday night next week
      if (i < mondayStrs.length - 1 && wk.dayCall) {
        const nextWk = sched[mondayStrs[i + 1]];
        if (nextWk?.nights?.mon === wk.dayCall && !isHolCoveredNight(mondayStrs[i + 1], "mon")) {
          if (nextWk.off && canTakeSlot(nextWk.off, mondayStrs[i + 1], parse(mondayStrs[i + 1]), "mon", nextWk, i + 1)) {
            nextWk.nights.mon = nextWk.off;
            recalcOff(nextWk);
          } else {
            const otherNight = NIGHT_KEYS.find(sk => sk !== "mon" && nextWk.nights?.[sk] && nextWk.nights[sk] !== nextWk.dayCall && nextWk.nights[sk] !== wk.dayCall
              && trySwapNights(mondayStrs[i + 1], i + 1, "mon", mondayStrs[i + 1], i + 1, sk));
            if (!otherNight && pass === 2) {
              console.warn(`[validation] UNRESOLVED: ${wk.dayCall} has Service Week then next Monday night, weeks ${mondayStrs[i]}→${mondayStrs[i + 1]} (no legal repair candidate)`);
            }
          }
        }
      }
      // Fix: No back-to-back nights within the same week
      const nightOrder = ["mon","tue","wed","thu"];
      for (let ni = 0; ni < nightOrder.length - 1; ni++) {
        const sk1 = nightOrder[ni], sk2 = nightOrder[ni + 1];
        const s1 = wk.nights?.[sk1], s2 = wk.nights?.[sk2];
        if (s1 && s1 === s2) {
          // Try swapping sk2 with another night that doesn't create a new
          // consecutive pair — trySwapNights commits only if BOTH movers
          // clear canTakeSlot for their new slot.
          const swapCandidate = nightOrder.find(sk => sk !== sk1 && sk !== sk2 && wk.nights?.[sk] && wk.nights[sk] !== s1 && wk.nights[sk] !== wk.dayCall && !isHolCoveredNight(mondayStrs[i], sk)
            && trySwapNights(mondayStrs[i], i, sk2, mondayStrs[i], i, sk));
          if (swapCandidate) {
            recalcOff(wk);
          } else if (wk.off && canTakeSlot(wk.off, mondayStrs[i], parse(mondayStrs[i]), sk2, wk, i)) {
            wk.nights[sk2] = wk.off;
            recalcOff(wk);
          } else if (pass === 2) {
            console.warn(`[validation] UNRESOLVED: ${s1} has back-to-back ${sk1}+${sk2} nights, week ${mondayStrs[i]} (no legal repair candidate)`);
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

  const isPreAssigned = (mStr, slot, surgeonId) => preAssign[mStr]?.[slot] === surgeonId;

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
function generate(surgeons, mondays, vac, backupMondays, priorCounts, preferences, fierceBackupMondays, holAssignments, locks, prevWeekSeed, vacationsOnly) {
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
    return spreadOf(svc)    * 10000
         + spreadOf(wknd)   * 1000
         + spreadOf(tot)    * 100
         + spreadOf(svcReg) * 10
         + spreadOf(wkndReg);
  };

  let best = null, bestScore = Infinity;
  for (let i = 0; i < ATTEMPTS; i++) {
    const cand = generateOnce(surgeons, mondays, vac, backupMondays, priorCounts, preferences, fierceBackupMondays, holAssignments, locks, prevWeekSeed, vacationsOnly);
    if (!cand) continue;
    const s = scoreOf(cand);
    if (s < bestScore) { bestScore = s; best = cand; }
    // Combined service weeks, weekends, and total all even (score < 100 means
    // those three tiers are all Δ0) — only the unavoidable 1st-call split remains.
    // Good enough to stop; further attempts can't improve the tiers that matter.
    if (bestScore < 100) break;
  }
  // Fallback: if every attempt somehow scored Infinity (shouldn't happen), return a fresh pass.
  return best || generateOnce(surgeons, mondays, vac, backupMondays, priorCounts, preferences, fierceBackupMondays, holAssignments, locks, prevWeekSeed, vacationsOnly);
}
