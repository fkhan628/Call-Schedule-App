// DSG Call Schedule — Schedule Generator & Holiday Logic

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

function generate(surgeons, mondays, vac, backupMondays, priorCounts, preferences, fierceBackupMondays, holAssignments, locks) {
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
  let prevWkndSurgeon = null;
  let prevDcSurgeon = null;

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

      // Surgeon B → holiday week's Weekend
      if (surgeonB && wkndAvail(surgeonB, mondays[i])) {
        if (!preAssign[mStr]) preAssign[mStr] = {};
        preAssign[mStr].wknd = surgeonB;
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
      if (!preAssign[lock.mondayStr]) preAssign[lock.mondayStr] = {};
      preAssign[lock.mondayStr][lock.slot] = lock.surgeonId;
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
    availWknd = availWknd.filter(id => !onVac(id, nextMonDate, vac));

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
    const prefWknd = availWknd.filter(id => id !== prevWkndSurgeon);
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
      avail = avail.filter(id => !onVac(id, nextDayStr, vac));

      // HARD RULE: Weekend surgeon cannot take Monday night the following week
      if (sk === "mon" && prevWkndSurgeon) {
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

        // Check weekend→Monday night conflict: new weekend surgeon shouldn't be Monday night next week
        const nextWkA = i + 1 < mondayStrs.length ? sched[mondayStrs[i + 1]] : null;
        const nextWkB = j + 1 < mondayStrs.length ? sched[mondayStrs[j + 1]] : null;
        if (nextWkA?.nights?.mon === b) continue; // b doing weekend in A would conflict with Mon night
        if (nextWkB?.nights?.mon === a) continue; // a doing weekend in B would conflict with Mon night

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
          if (wk.nights?.[sk] === wk.dayCall && wk.off) {
            // Swap the conflicting night with the off surgeon
            wk.nights[sk] = wk.off;
            recalcOff(wk);
          }
        });
        // Fix: DC surgeon should not have weekend in same week
        if (wk.nights?.wknd === wk.dayCall && wk.off) {
          wk.nights.wknd = wk.off;
          recalcOff(wk);
        }
      }

      // Fix: Weekend surgeon should not also have Thursday night in same week
      // (back-to-back: Thu 5p–Fri 7a then wknd starts Fri 5p, no recovery).
      // Mon/Tue/Wed + wknd are all allowed — enough gap before wknd starts.
      if (wk.nights?.wknd && wk.nights?.thu === wk.nights?.wknd && wk.off && wk.off !== wk.dayCall) {
        wk.nights.thu = wk.off;
        recalcOff(wk);
      }

      // Fix: Weekend surgeon should not have Monday night next week
      if (i < mondayStrs.length - 1 && wk.nights?.wknd) {
        const nextWk = sched[mondayStrs[i + 1]];
        if (nextWk?.nights?.mon === wk.nights.wknd) {
          // Try swapping Monday night with off surgeon of next week
          if (nextWk.off && nextWk.off !== nextWk.dayCall) {
            nextWk.nights.mon = nextWk.off;
            recalcOff(nextWk);
          } else {
            // Try swapping Monday night with another night surgeon in next week
            const otherNight = NIGHT_KEYS.find(sk => sk !== "mon" && nextWk.nights?.[sk] && nextWk.nights[sk] !== nextWk.dayCall && nextWk.nights[sk] !== wk.nights.wknd);
            if (otherNight) {
              const temp = nextWk.nights.mon;
              nextWk.nights.mon = nextWk.nights[otherNight];
              nextWk.nights[otherNight] = temp;
            }
          }
        }
      }

      // Fix: Service week surgeon should not have Monday night next week
      if (i < mondayStrs.length - 1 && wk.dayCall) {
        const nextWk = sched[mondayStrs[i + 1]];
        if (nextWk?.nights?.mon === wk.dayCall) {
          if (nextWk.off && nextWk.off !== nextWk.dayCall && nextWk.off !== sched[mondayStrs[i]]?.nights?.wknd) {
            nextWk.nights.mon = nextWk.off;
            recalcOff(nextWk);
          } else {
            const otherNight = NIGHT_KEYS.find(sk => sk !== "mon" && nextWk.nights?.[sk] && nextWk.nights[sk] !== nextWk.dayCall && nextWk.nights[sk] !== wk.dayCall);
            if (otherNight) {
              const temp = nextWk.nights.mon;
              nextWk.nights.mon = nextWk.nights[otherNight];
              nextWk.nights[otherNight] = temp;
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
          // Try swapping sk2 with another night that doesn't create a new consecutive pair
          const swapCandidate = nightOrder.find(sk => sk !== sk1 && sk !== sk2 && wk.nights?.[sk] && wk.nights[sk] !== s1 && wk.nights[sk] !== wk.dayCall);
          if (swapCandidate) {
            const temp = wk.nights[sk2];
            wk.nights[sk2] = wk.nights[swapCandidate];
            wk.nights[swapCandidate] = temp;
            recalcOff(wk);
          } else if (wk.off && wk.off !== wk.dayCall) {
            wk.nights[sk2] = wk.off;
            recalcOff(wk);
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
      if (onVac(Y, fmt(addD(monday, 7)), vac)) return false; // next Mon
    } else {
      const dayOffset = {mon:0, tue:1, wed:2, thu:3}[slot];
      if (onVac(Y, fmt(addD(monday, dayOffset)), vac)) return false;
      if (onVac(Y, fmt(addD(monday, dayOffset + 1)), vac)) return false;
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
    if (slot === "wknd") {
      if (nextWk?.nights?.mon === Y) return false; // wknd → next Mon forbidden
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

  // PHASE 1: DC balance — target service-week equality first.
  // Tries all viable high→low pairs each iteration so we don't bail just
  // because the absolute max↔min pair has a constraint conflict.
  for (let iter = 0; iter < 100; iter++) {
    const sorted = [...ids].sort((a,b) => (dcCt[b]||0) - (dcCt[a]||0));
    if ((dcCt[sorted[0]]||0) - (dcCt[sorted[sorted.length-1]]||0) <= 2) break;

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
    if (!found) break;
  }

  // PHASE 2: Weighted total balance — matches the displayed Fairness Summary
  // (SW×6 + Night×1 + Weekend×2). DC is already balanced from Phase 1, so
  // Phase 2 only moves nights and weekends. Multi-pair fallback like Phase 1.
  const slotOrder = ["wknd", "mon", "tue", "wed", "thu"];
  const slotWeight = { wknd: 2, mon: 1, tue: 1, wed: 1, thu: 1 };
  const weightedTotal = (id) => 6 * (dcCt[id]||0) + (nCt[id]||0) + 2 * (wkndCt[id]||0);

  for (let iter = 0; iter < 200; iter++) {
    const sorted = [...ids].sort((a,b) => weightedTotal(b) - weightedTotal(a));
    if (weightedTotal(sorted[0]) - weightedTotal(sorted[sorted.length-1]) <= 2) break;

    let found = false;
    for (let h = 0; h < sorted.length && !found; h++) {
      const hi = sorted[h];
      for (let l = sorted.length - 1; l > h && !found; l--) {
        const lo = sorted[l];
        if (weightedTotal(hi) - weightedTotal(lo) <= 2) break;
        for (let wkIdx = 0; wkIdx < mondayStrs.length && !found; wkIdx++) {
          const mStr = mondayStrs[wkIdx];
          const wk = sched[mStr];
          const monday = parse(mStr);
          for (const slot of slotOrder) {
            const cur = wk.nights?.[slot];
            if (cur !== hi) continue;
            if (isPreAssigned(mStr, slot, hi)) continue;
            // Skip moves that would overshoot (flip the pair's direction)
            const w = slotWeight[slot];
            if ((weightedTotal(hi) - 2*w) < weightedTotal(lo)) continue;
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
