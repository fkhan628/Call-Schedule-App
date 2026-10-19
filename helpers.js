// DSG Call Schedule — Date Helpers, ICS Generation & Utilities

/* ═══ Date helpers ═══ */
const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const parse = s => { const [y,m,d]=s.split("-").map(Number); return new Date(y,m-1,d); };
const addD = (d,n) => { const r=new Date(d); r.setDate(r.getDate()+n); return r; };
const monOf = d => { const r=new Date(d); r.setDate(r.getDate()-((r.getDay()+6)%7)); return r; };

function getMondays(yr,mo,numWeeks) {
  const ms=[], s=new Date(yr,mo,1);
  let d=monOf(s); if(d<s) d=addD(d,7);
  while(ms.length<numWeeks){ ms.push(new Date(d)); d=addD(d,7); }
  return ms;
}

function onVac(id,ds,v){ return (v[id]||[]).some(([a,b])=>ds>=a&&ds<=b); }

// A date range's end once its start is picked (owner 2026-10-18: "the end
// date calendar should start where the start date was placed"). A native
// date input's calendar opens at its value, or at today when it is empty, so
// the end follows the start when it is empty, now before the start, or still
// on the previous start (a one-day range, or a form's default of today/today)
// — then the end's calendar opens on the start. An end the user set later
// than the start is kept. Dates are "YYYY-MM-DD", so string order is date
// order. A cleared start leaves the end alone.
function endOnOrAfter(start, end, prevStart) { return start && (!end || end < start || end === prevStart) ? start : end; }

// Start date of a shift, for time-based gating (nav cleanup 2026-09-06):
// a night = its own date, the weekend = its Friday, a service week = its
// Monday — once a shift has STARTED it is history and trade/swap paths
// refuse it. The picker builders in index-source.html inline the same rule.
function shiftStartDate(mondayStr, shiftKey) {
  if (shiftKey === "dayCall") return mondayStr;
  const off = { mon: 0, tue: 1, wed: 2, thu: 3, wknd: 4 }[shiftKey];
  return off === undefined ? mondayStr : fmt(addD(parse(mondayStr), off));
}

// Last day of a shift, the partner of shiftStartDate (Mine tab, 2026-09-25):
// a Mon–Thu night ends on its own date; the service week, the weekend and an
// OFF week (null key) run to the week's Sunday. Same rule as the Next call
// card. A role is DONE once this date is before today.
function shiftLastDay(mondayStr, shiftKey) {
  return NIGHT_KEYS.includes(shiftKey) ? shiftStartDate(mondayStr, shiftKey) : fmt(addD(parse(mondayStr), 6));
}

// The Mine tab's "My Shifts" list: only shifts not yet done. Keeps each role
// whose last day is today or later and marks canSwap only while the shift has
// not started, the exact rule every swap and trade path refuses on, so the
// button never opens a swap that would be refused. Weeks with no roles left
// drop out. Returns new objects and never touches its input (the Next call
// card reads the unfiltered list). todayStr is passed in, so there is no clock
// here and the harness can pin the date.
function mineUpcoming(myShifts, todayStr) {
  return myShifts
    .map(w => ({
      ...w,
      // A role with a date (a holiday 24h or a single service day, 2026-10-02)
      // ends on that date and never offers a swap; every other role is as before.
      roles: w.roles
        .filter(r => (r.date || shiftLastDay(w.mStr, r.shiftKey)) >= todayStr)
        .map(r => ({ ...r, canSwap: !r.date && !!r.shiftKey && shiftStartDate(w.mStr, r.shiftKey) >= todayStr })),
    }))
    .filter(w => w.roles.length > 0);
}

// The Mine tab for an APP (UX audit 2026-10-19): two of the seven users are
// APPs, and Mine read only the surgeon schedule. appShifts maps a date to the
// APP on call that day ({ "2026-10-20": "a1", ... }: the Calendar's and the
// full export's source). Returns that APP's days from todayStr on (today
// included), oldest first, as { ds, weekend }: a Saturday or Sunday is the
// 7a–7a 24h shift, a weekday the 5p–7a night (buildAppICSEvents' rule).
// Pure: todayStr is passed in, nothing is read but the arguments.
function appUpcoming(appShifts, appId, todayStr) {
  if (!appShifts || typeof appShifts !== "object" || !appId || typeof todayStr !== "string") return [];
  return Object.keys(appShifts)
    .filter(ds => appShifts[ds] === appId && /^\d{4}-\d{2}-\d{2}$/.test(ds) && ds >= todayStr)
    .sort()
    .map(ds => { const dow = parse(ds).getDay(); return { ds, weekend: dow === 0 || dow === 6 }; });
}

// Billing credits for one week (Stats → Billing, owner rule 2026-10-01). Each
// credit is { ds, sid, kind, n }: kind "dc" for a service day (each of the 7
// days Mon–Sun, a single-day override winning its date), "nights" for a Mon–Thu
// night, "wknd" for Fri, Sat and Sun, all n = 1; and "hol" with n = 2 (the day
// and the night) for the surgeon who covers a holiday. On a covered date every
// regular credit drops, whoever held it. A covered date is a holidayCoverage
// entry that names a coverer, falls inside this week, and is not type "swap"
// (the imported swap Saturdays keep their regular billing; any other type,
// spelled however it was entered, counts as a holiday). A backup week bills
// nothing, holiday included. Pure: no clock, no state.
function weekBillingCredits(mondayStr, wk) {
  if (!wk || wk.isBackup) return [];
  const mon = parse(mondayStr);
  const days = [0, 1, 2, 3, 4, 5, 6].map(i => fmt(addD(mon, i)));
  const covered = {};
  Object.entries(wk.holidayCoverage || {}).forEach(([ds, cov]) => {
    if (cov && cov.surgeonId && cov.type !== "swap" && days.includes(ds)) covered[ds] = cov.surgeonId;
  });
  const credits = [];
  const add = (ds, sid, kind) => { if (sid && !covered[ds]) credits.push({ ds, sid, kind, n: 1 }); };
  if (wk.dayCall) days.forEach(ds => add(ds, (wk.dayCallOverrides && wk.dayCallOverrides[ds]) || wk.dayCall, "dc"));
  NIGHT_KEYS.forEach((sk, i) => add(days[i], wk.nights?.[sk], "nights"));
  if (wk.nights?.wknd) [4, 5, 6].forEach(i => add(days[i], wk.nights.wknd, "wknd"));
  Object.entries(covered).forEach(([ds, sid]) => credits.push({ ds, sid, kind: "hol", n: 2 }));
  return credits;
}

/* ═══ Personal call totals: DSG + Silvis (owner request 2026-10-09; decisions 2026-10-11) ═══
   The ONE counter behind the FAK-only totals card in the Mine tab AND the Silvis
   app's copy of that card, so both apps show the same numbers for the same period.
   Pure: no clock (`today` is passed in), no state, nothing read but the arguments.
   Keyed by the roster CODE.
   PARITY CONTRACT for the Silvis port (Silvis Prompt 31):
   - copy weekBillingCredits, callTotalPeriods and callTotalsFor VERBATIM, plus this
     app's NIGHT_KEYS value (["mon","tue","wed","thu"], config.js), into a NEW
     classic-script module loaded after Silvis's helpers.js, with its own Node export
     guard. Reuse Silvis's own fmt / parse / addD (byte-identical to the ones at the top
     of this file) - declaring them a second time is a SyntaxError. Not in Silvis
     helpers.js or config.js: Silvis's data-layer test bans these names there.
   - `today` is the DEVICE date, fmt(new Date()), in BOTH apps (decision 2026-10-11) -
     not Silvis's todayCentral(), or the cards disagree on the month and on worked vs
     scheduled whenever the device is not on Central time.
   - the port must give test/fixtures/call-totals-card-synthetic-2026-10-14.json's
     `expected` from its `input`, exactly. */

// callTotalPeriods(today) -> { month, ytd, year, rolling12, months:[12] } | null
//   month     = today's calendar month         ytd    = Jan 1 .. today
//   year      = Jan 1 .. Dec 31                 months = Jan .. Dec of today's year
//   rolling12 = the day after (today minus 12 months; Feb 29 -> Feb 28) .. today
//   Each is { from, to } ('YYYY-MM-DD', both inclusive); months[i] also has month:'YYYY-MM'.
//   A malformed or impossible date gives null, never a guessed period.
function callTotalPeriods(today) {
  if (typeof today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(today) || fmt(parse(today)) !== today) return null;
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)), d = Number(today.slice(8, 10));
  const p2 = (n) => String(n).padStart(2, "0");
  const lastDay = (yy, mm) => new Date(yy, mm, 0).getDate(); // mm is 1-based: day 0 of the next month
  const months = [];
  for (let mm = 1; mm <= 12; mm++) months.push({ month: `${y}-${p2(mm)}`, from: `${y}-${p2(mm)}-01`, to: `${y}-${p2(mm)}-${p2(lastDay(y, mm))}` });
  const back = `${y - 1}-${p2(m)}-${p2(Math.min(d, lastDay(y - 1, m)))}`;
  return {
    month: { from: months[m - 1].from, to: months[m - 1].to },
    ytd: { from: `${y}-01-01`, to: today },
    year: { from: `${y}-01-01`, to: `${y}-12-31` },
    rolling12: { from: fmt(addD(parse(back), 1)), to: today },
    months,
  };
}

// callTotalsFor({ weeks, roster, silvisRows, code, today })
//   -> { ok:true, code, sid, today, range:{ dsgFrom, dsgTo, silvisFrom, silvisTo },
//        periods:{ month, ytd, year, rolling12 }, months:[12] }   (each { from, to, worked, scheduled })
//   -> { ok:false, error }   for a missing/unknown code or a bad date — never zeros that look like "no call"
//   weeks      the PUBLISHED schedule { 'YYYY-MM-DD' Monday: week row } — never a draft or preview
//   roster     [{ id, name }]; the Davenport code IS the roster name (compared case-insensitively)
//   silvisRows silvis_feed rows [{ day, primary_code, backup_code }]
//   code       the roster CODE counted (silvisRule.code — FAK)
//   today      'YYYY-MM-DD'; a day on or before it is worked, after it scheduled
// worked / scheduled: { dc, nights, wknd, hol, dcB, nightsB, wkndB, holB, silvisP, silvisB, dsg, dsgB, total, weighted }
//   DSG = Stats → Billing's own credits (weekBillingCredits; no second definition). A backup
//   week is counted by the SAME function as if it were 1st call and lands in the ...B kinds.
//   Silvis: one 07:00–07:00 day = 1, primary (silvisP) or backup (silvisB).
//   dsg = dc+nights+wknd+hol   dsgB = dcB+nightsB+wkndB+holB   total = dsg+dsgB+silvisP+silvisB
//   weighted = dsg + silvisP + ½ (dsgB + silvisB) — every backup role counts half (Faraz 10/9)
//   range: first published Monday .. the last published week's Sunday; first .. last Silvis
//   row; null when there is none.
function callTotalsFor(input) {
  const inp = input || {};
  const want = String(inp.code || "").trim().toUpperCase();
  if (!want) return { ok: false, error: "no roster code to count" };
  const periods = callTotalPeriods(inp.today);
  if (!periods) return { ok: false, error: `not a date: ${JSON.stringify(inp.today)}` };
  const who = (inp.roster || []).find(s => s && String(s.name || "").toUpperCase() === want);
  if (!who || !who.id) return { ok: false, error: `no roster entry for code ${want}` };
  const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && fmt(parse(s)) === s;
  const items = []; // every dated credit of this person: { ds, kind, n }
  let dsgFrom = null, dsgTo = null, silvisFrom = null, silvisTo = null;
  Object.keys(inp.weeks || {}).sort().forEach(mStr => {
    const wk = inp.weeks[mStr];
    if (!wk || typeof wk !== "object" || !isDay(mStr)) return;
    if (!dsgFrom) dsgFrom = mStr;
    dsgTo = fmt(addD(parse(mStr), 6));
    const backup = !!wk.isBackup;
    weekBillingCredits(mStr, backup ? Object.assign({}, wk, { isBackup: false }) : wk).forEach(c => {
      if (c.sid === who.id) items.push({ ds: c.ds, kind: backup ? c.kind + "B" : c.kind, n: c.n });
    });
  });
  const seenP = {}, seenB = {};
  (inp.silvisRows || []).forEach(r => {
    if (!r || !isDay(r.day)) return;
    if (!silvisFrom || r.day < silvisFrom) silvisFrom = r.day;
    if (!silvisTo || r.day > silvisTo) silvisTo = r.day;
    if (!seenP[r.day] && String(r.primary_code || "").toUpperCase() === want) { seenP[r.day] = true; items.push({ ds: r.day, kind: "silvisP", n: 1 }); }
    if (!seenB[r.day] && String(r.backup_code || "").toUpperCase() === want) { seenB[r.day] = true; items.push({ ds: r.day, kind: "silvisB", n: 1 }); }
  });
  const KINDS = ["dc", "nights", "wknd", "hol", "dcB", "nightsB", "wkndB", "holB", "silvisP", "silvisB"];
  const tally = (from, to) => {
    const zero = () => { const o = {}; KINDS.forEach(k => { o[k] = 0; }); return o; };
    const worked = zero(), scheduled = zero();
    items.forEach(it => { if (it.ds >= from && it.ds <= to) (it.ds <= inp.today ? worked : scheduled)[it.kind] += it.n; });
    const sums = (o) => {
      o.dsg = o.dc + o.nights + o.wknd + o.hol;
      o.dsgB = o.dcB + o.nightsB + o.wkndB + o.holB;
      o.total = o.dsg + o.dsgB + o.silvisP + o.silvisB;
      o.weighted = o.dsg + o.silvisP + (o.dsgB + o.silvisB) / 2;
      return o;
    };
    return { from, to, worked: sums(worked), scheduled: sums(scheduled) };
  };
  const P = periods;
  return {
    ok: true, code: want, sid: who.id, today: inp.today,
    range: { dsgFrom, dsgTo, silvisFrom, silvisTo },
    periods: { month: tally(P.month.from, P.month.to), ytd: tally(P.ytd.from, P.ytd.to), year: tally(P.year.from, P.year.to), rolling12: tally(P.rolling12.from, P.rolling12.to) },
    months: P.months.map(p => Object.assign({ month: p.month }, tally(p.from, p.to))),
  };
}

// The coverage rows a stored holiday assignment actually means (2026-10-02).
// The standing Christmas two-day cap (2026-08-06, buildCoverage): when one
// surgeon holds both halves of Christmas, coverage is the Eve + the day itself
// and nothing more; the days after go back to the service-week doctor. An
// assignment saved before the cap can still carry later rows (2026 stored Sat
// 12/26), so every READ of stored rows goes through here instead of the data
// being rewritten. Any other assignment comes back unchanged. The swap remap
// in index-source.html still works on the stored rows. Pure; never mutates.
function effectiveHolidayCoverage(h) {
  const rows = h && Array.isArray(h.coverage) ? h.coverage : [];
  if (h && h.name === "Christmas Day" && h.surgeonA && h.surgeonA === h.surgeonB) {
    return rows.filter(c => c.isEve || c.date === h.date);
  }
  return rows;
}

// Who actually holds each date of one week, slot by slot (2026-10-02). This
// is the calendar's rule: calData in index-source.html is the reference, and
// sync-guards section X proves the two agree on every live week. For each of
// the 7 dates:
//   svc      Mon–Fri daytime service: the date's override, else the dayCall
//   sat      the service Saturday 24h, by the same rule
//   night    the Mon–Thu night holder (nightKey "mon".."thu")
//   wkndFri  the weekend's Friday night; wkndSun its Sunday 24h
//   cover    the holidayCoverage entry on that date, if any
// A date with ANY holidayCoverage entry (any type, swaps and backup weeks
// included) drops every regular slot, and the entry's surgeon holds it 7a–7a.
// Billing's exclusions (swaps, backup weeks) are billing-only and live in
// weekBillingCredits. covers lists every entry, including one dated outside
// the week, because the calendar draws those too. Service slots exist only
// when the week has a dayCall, as on the calendar. Pure: no clock, no state.
function weekHolders(mondayStr, wk) {
  const w = wk || {};
  const hc = w.holidayCoverage || {};
  const ovr = w.dayCallOverrides || {};
  const n = w.nights || {};
  const mon = parse(mondayStr);
  const covers = Object.entries(hc).filter(([, c]) => !!c).map(([ds, c]) => ({
    ds, sid: c.surgeonId || null, label: c.name || "", type: c.type || null, holiday: c.holiday || null,
  }));
  const days = [0, 1, 2, 3, 4, 5, 6].map(i => {
    const ds = fmt(addD(mon, i));
    const day = { ds, i, svc: null, sat: null, night: null, nightKey: null, wkndFri: null, wkndSun: null, cover: covers.find(c => c.ds === ds) || null };
    if (hc[ds]) return day;
    if (w.dayCall && i <= 4) day.svc = ovr[ds] || w.dayCall;
    if (w.dayCall && i === 5) day.sat = ovr[ds] || w.dayCall;
    if (i <= 3 && n[NIGHT_KEYS[i]]) { day.night = n[NIGHT_KEYS[i]]; day.nightKey = NIGHT_KEYS[i]; }
    if (n.wknd && i === 4) day.wkndFri = n.wknd;
    if (n.wknd && i === 6) day.wkndSun = n.wknd;
    return day;
  });
  return { mondayStr, isBackup: !!w.isBackup, days, covers };
}

// Who holds the OVERNIGHT of date ds in a published schedule, by weekHolders'
// rule: a holiday 24h row, else the Mon–Thu night, Fri / Sun the weekend, Sat
// the service week (or its single-day override). null for nobody / no week.
function overnightHolderOn(schedule, ds) {
  const x = parse(ds), dow = x.getDay(), mStr = fmt(addD(x, dow === 0 ? -6 : 1 - dow));
  const wk = schedule && schedule[mStr];
  if (!wk) return null;
  const day = weekHolders(mStr, wk).days[(dow + 6) % 7];
  if (day.cover) return day.cover.sid || null;
  return day.night || day.wkndFri || day.sat || day.wkndSun || null;
}

// The Calendar's day sheet (UX audit 2026-10-19): what one date holds, as
// plain lines. A tapped day shows these; an iPhone never shows the cells'
// title tooltips, and a cell has no room for hours or coverage notes.
// Who holds what is weekHolders' rule (the calendar's own; sync-guards X1),
// so the lines name exactly the holders the cell draws for that date —
// a holiday entry stored in a neighbouring week included, since the
// calendar draws it on its date too. Hours come from SHIFT_TIMES (config.js)
// with the leading day dropped (the sheet is headed with its date): service
// "7a–5p", the service Saturday "7a–Sun 7a", a night "5p–7a", the weekend's
// Friday "5p–Sat 7a" and its Sunday "7a–Mon 7a". A holiday entry shows the
// hours stored with it; an APP shift is 7a–7a on a Sat or Sun and 5p–7a on
// a weekday (the rule of buildAppICSEvents and the On Call Today banner).
// Each line is { slot, sid, backup, label, who, hours, note, holiday, text }:
//   slot    cover | svc | sat | night | wkndFri | wkndSun | app | fierce | fierceBkp
//   sid     the holder's id (the APP's id for "app"); null for an unassigned
//           cover and the two Fierce lines
//   backup  the week is a Fierce primary week, the group is backup (the cell's "B")
//   text    e.g. "Service week: ARW (7a–5p)", "Labor Day 24h: RPC (7a–7a)"
// opts = { appShifts, nameOf }. Pure: no clock, no state.
function dayDetailLines(schedule, ds, opts) {
  const o = opts || {};
  const nameOf = typeof o.nameOf === "function" ? o.nameOf : (id => id);
  const sched = schedule || {};
  const x = parse(ds), dow = x.getDay(), mStr = fmt(addD(x, dow === 0 ? -6 : 1 - dow));
  const T = typeof SHIFT_TIMES === "object" && SHIFT_TIMES ? SHIFT_TIMES : {};
  const hrs = (seg) => String(seg || "").replace(/^\S+\s+/, ""); // "Tue 5p–7a" → "5p–7a"
  const [svcSeg, satSeg] = String(T.dayCall || "").split(" + ");
  const [friSeg, sunSeg] = String(T.wknd || "").split(" & ");
  const lines = [];
  const add = (slot, sid, backup, label, hours, extra) => {
    const fierce = slot === "fierce" || slot === "fierceBkp";
    const line = Object.assign({ slot, sid: sid || null, backup: !!backup, label: label + (backup ? " (backup)" : ""),
      who: fierce ? null : sid ? nameOf(sid) : "Unassigned", hours: hours || "", note: "", holiday: null }, extra || {});
    line.text = fierce ? line.label : `${line.label}: ${line.who}${line.hours ? ` (${line.hours})` : ""}${line.note ? ` — ${line.note}` : ""}`;
    lines.push(line);
  };
  // A holiday or coverage entry dated ds, from whichever week stores it
  Object.keys(sched).sort().forEach(m => {
    const w = sched[m];
    if (!w || typeof w !== "object" || !/^\d{4}-\d{2}-\d{2}$/.test(m)) return;
    weekHolders(m, w).covers.filter(c => c.ds === ds).forEach(c => {
      const label = c.type === "swap" ? (c.label || "Coverage") : `${holidayTitleName(c)} 24h`;
      const stored = String(((w.holidayCoverage || {})[ds] || {}).hours || "");
      // "Memorial Day 24h" needs no second "(24h)"; "7a–7a", or a swap's "24h", is shown
      add("cover", c.sid, w.isBackup, label, /24h$/.test(label) && stored.trim() === "24h" ? "" : stored, { holiday: c.holiday || c.label || "" });
    });
  });
  const wk = sched[mStr];
  if (wk && typeof wk === "object") {
    const day = weekHolders(mStr, wk).days[(dow + 6) % 7];
    const bk = !!wk.isBackup;
    const ovr = (wk.dayCallOverrides || {})[ds];
    const note = ovr && wk.dayCall && ovr !== wk.dayCall ? `covering ${nameOf(wk.dayCall)}'s service week` : "";
    if (day.svc) add("svc", day.svc, bk, note ? "Service day" : "Service week", hrs(svcSeg), { note });
    if (day.sat) add("sat", day.sat, bk, note ? "Service day" : "Service week", hrs(satSeg), { note });
    if (day.night) add("night", day.night, bk, "Night", hrs(T[day.nightKey]));
    if (day.wkndFri) add("wkndFri", day.wkndFri, bk, "Weekend", hrs(friSeg));
    if (day.wkndSun) add("wkndSun", day.wkndSun, bk, "Weekend", hrs(sunSeg));
  }
  const aid = (o.appShifts || {})[ds];
  if (aid) add("app", aid, false, "APP", dow === 0 || dow === 6 ? "7a–7a" : "5p–7a");
  if (wk && wk.isBackup) add("fierce", null, false, "Fierce Primary week — the group is backup");
  if (wk && wk.isFierceBackup) add("fierceBkp", null, false, "Fierce Backup week");
  return lines;
}

// Who is on call RIGHT NOW (UX audit 2026-10-19). The On Call Today banner
// reads only today's date, so between midnight and 7a it named TONIGHT's
// holder instead of the one on call since last evening. The handover hours
// are weekHolders' slots (SHIFT_TIMES in config.js gives the same hours):
//   before 7a    the PREVIOUS date's overnight, overnightHolderOn's rule: a
//                holiday 24h on that date, else its Mon–Thu night, the Fri
//                night or Sun 24h weekend leg, or the service Saturday 24h
//   7a – 5p      today: a holiday 24h, else Mon–Fri the daytime service
//                holder (the date's override, else the dayCall) until 5p;
//                Sat the service Saturday 24h, Sun the weekend's Sunday 24h
//   5p – 12a     today's overnight, overnightHolderOn's rule again
// Every overnight and 24h slot runs to 7a. Returns { sid, slot, until } with
// until "7a" or "5p", or null when nobody holds that window (no week entry, a
// blank slot, an unassigned holiday). A backup (Fierce primary) week's slot
// says "(backup)". now is read in local time like every date in the app;
// it is passed in, so there is no clock here.
function onCallNow(schedule, now) {
  if (!now || typeof now.getHours !== "function" || isNaN(now.getTime())) return null;
  const h = now.getHours();
  const x = parse(fmt(h < 7 ? addD(now, -1) : now)), dow = x.getDay(), mStr = fmt(addD(x, dow === 0 ? -6 : 1 - dow));
  const wk = schedule && schedule[mStr];
  if (!wk) return null;
  const day = weekHolders(mStr, wk).days[(dow + 6) % 7];
  const svc = (sid) => (sid === wk.dayCall ? "Service Week" : "Service Day");
  let sid = null, slot = "", until = "7a";
  if (day.cover) { sid = day.cover.sid; slot = day.cover.type === "swap" ? (day.cover.label || "Coverage") : `${holidayTitleName(day.cover)} 24h`; }
  else if (h >= 7 && h < 17 && day.i <= 4) { sid = day.svc; slot = svc(sid); until = "5p"; }
  else if (day.night) { sid = day.night; slot = SHIFT_LABELS[day.nightKey]; }
  else if (day.wkndFri || day.wkndSun) { sid = day.wkndFri || day.wkndSun; slot = SHIFT_LABELS.wknd; }
  else if (day.sat) { sid = day.sat; slot = `${svc(day.sat)} (Sat 24h)`; }
  return sid ? { sid, slot: slot + (wk.isBackup ? " (backup)" : ""), until } : null;
}

// Why a calendar month is blank (UX audit, 2026-10-18). A month with no
// surgeon call looks the same whether nothing loaded or the month is simply
// not published yet, so the Calendar tab asks this for the month it shows
// (month is 0-based, like Date) and says which. A week counts for the month
// when any of its 7 days (Mon–Sun) falls in it AND it holds a dayCall, any
// night, or a holidayCoverage entry; a week entry holding none of these does
// not count, and does not widen the range either.
//   { kind: "empty" }                  no weeks at all (a failed or empty read)
//   { kind: "ok" }                     the month has a counting week
//   { kind: "unscheduled", from, to }  it has none: from = the first counting
//                                      week's Monday, to = the last one's
//                                      Sunday (both null when no week counts)
// Only YYYY-MM-DD keys are weeks, read in date order. Pure: no clock, no state.
function calMonthStatus(schedule, year, month) {
  const keys = Object.keys(schedule || {}).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
  if (!keys.length) return { kind: "empty" };
  const first = fmt(new Date(year, month, 1)), last = fmt(new Date(year, month + 1, 0));
  const holds = (w) => !!w && (!!w.dayCall || Object.values(w.nights || {}).some(Boolean) || Object.values(w.holidayCoverage || {}).some(Boolean));
  const counted = keys.filter(k => holds(schedule[k]));
  if (counted.some(k => k <= last && fmt(addD(parse(k), 6)) >= first)) return { kind: "ok" };
  if (!counted.length) return { kind: "unscheduled", from: null, to: null };
  return { kind: "unscheduled", from: counted[0], to: fmt(addD(parse(counted[counted.length - 1]), 6)) };
}

// ═══ HOLIDAY PAIRS — who takes which holiday each year (owner 2026-10-13) ═══
// FAK (the Christmas surgeon) takes Christmas Eve + Christmas Day, both slots,
// every year — his major and his minor; the app sets that card itself. Every
// other partner takes ONE minor a year (Memorial Day, July 4th, Labor Day —
// 6 slots for 6 partners) and at most ONE major (New Year's, Thanksgiving —
// 4 slots for 6, so two sit out a major each year, and get one the next).
// The rest rotates. One group at a time (major, minor), every assignment of
// partners to its A / B slots is ranked, in order:
//   1. nobody on time off for the dates their role holds (unavailable)
//   2. nobody on two holidays of the group
//   3. nobody sits out the group two years running (who sat out last year
//      gets one this year)
//   4. nobody gets the same holiday as last year; 5. as two years ago
//   5b. a year already stored AFTER this one (re-generating): not the holiday
//      someone has there, and nobody without a major in both years
//   6. no two partners paired on two cards in the same year
//   7. the holiday each partner has had least often
//   8. who gets one: the shortest run of years with one, ending last year
//      (a major, a major, then a year off — the 3-year cycle)
//   9. then the lower lifetime rate of the group (rate, tenure-normalized)
//  10. new pairings: not the same pair on the same holiday before, nor a
//      pair from the last two years
//  11. the A / B role each has had less often
//   then a random pick among equals (random).
// o = { year, holidays: [{ name, date, type }] to plan (not Christmas),
//       partners: [ids], history: holidayAssignments (only years < year are
//       read), fixed: [{ name, type, surgeonA, surgeonB }] already set this
//       year (they count), unavailable(id, hol, role), rate(id, type), random }
// → { picks: { [name]: { surgeonA, surgeonB } }, notes: [plain words], cost: { major, minor } }
// A year already stored AFTER this one (re-generating) is checked too: the
// notes say what the new picks break against it.
function planHolidayPairs(o) {
  const year = Number(o.year), hist = o.history || {}, rnd = o.random || Math.random;
  const unavailable = o.unavailable || (() => false), rate = o.rate || (() => 0);
  const partners = (o.partners || []).filter(Boolean), fixed = o.fixed || [];
  const yearArr = (y) => Array.isArray(hist[String(y)]) ? hist[String(y)] : null;
  const heldMemo = {};
  const heldIn = (y) => { // { id: [{ name, type, role }] } — a collapsed A = B pair is ONE holiday
    if (heldMemo[y]) return heldMemo[y];
    const m = {};
    (yearArr(y) || []).forEach(h => {
      if (!h || !h.name) return;
      const add = (id, role) => { if (id) (m[id] = m[id] || []).push({ name: h.name, type: h.type, role }); };
      add(h.surgeonA, "A"); if (h.surgeonB !== h.surgeonA) add(h.surgeonB, "B");
    });
    return (heldMemo[y] = m);
  };
  const past = Object.keys(hist).map(Number).filter(y => Number.isFinite(y) && y < year);
  const nameCt = {}, roleCt = {}, run = {};
  const pairKey = (a, b) => a < b ? a + "|" + b : b + "|" + a;
  const pairsOf = (arr) => (arr || []).filter(h => h && h.surgeonA && h.surgeonB && h.surgeonA !== h.surgeonB).map(h => ({ name: h.name, k: pairKey(h.surgeonA, h.surgeonB) }));
  const pairHol = {}; past.forEach(y => pairsOf(yearArr(y)).forEach(({ name, k }) => { pairHol[name + "#" + k] = (pairHol[name + "#" + k] || 0) + 1; }));
  const pairY1 = new Set(pairsOf(yearArr(year - 1)).map(x => x.k)), pairY2 = new Set(pairsOf(yearArr(year - 2)).map(x => x.k));
  const pairNow = new Set(pairsOf(fixed).map(x => x.k)); // this year's cards so far (presets, then the major group's picks)
  const pairCost = (a, b, name) => { const k = pairKey(a, b); return 3 * (pairHol[name + "#" + k] || 0) + (pairY1.has(k) ? 2 : 0) + (pairY2.has(k) ? 1 : 0); };
  partners.forEach(id => { nameCt[id] = {}; roleCt[id] = { major: { A: 0, B: 0 }, minor: { A: 0, B: 0 } }; run[id] = { major: 0, minor: 0 }; });
  past.forEach(y => { const m = heldIn(y); partners.forEach(id => (m[id] || []).forEach(x => {
    nameCt[id][x.name] = (nameCt[id][x.name] || 0) + 1;
    if (roleCt[id][x.type]) roleCt[id][x.type][x.role]++;
  })); });
  partners.forEach(id => ["major", "minor"].forEach(t => {
    let k = 0; for (let y = year - 1; yearArr(y); y--) { if ((heldIn(y)[id] || []).some(x => x.type === t)) k++; else break; }
    run[id][t] = k;
  }));
  const hasLast = !!yearArr(year - 1), Y1 = heldIn(year - 1), Y2 = heldIn(year - 2), hasNext = !!yearArr(year + 1), YN = heldIn(year + 1);
  const had = (m, id, name) => (m[id] || []).some(x => x.name === name);
  const satOutLast = (id, t) => hasLast && !(Y1[id] || []).some(x => x.type === t);
  const picks = {}, notes = [], cost = {};
  const nm = o.nameOf || ((id) => id);
  ["minor", "major"].forEach(type => { // minors first: the tighter group (one each) — the majors then avoid its pairs
    const hols = (o.holidays || []).filter(h => h && h.type === type && h.name !== "Christmas Day");
    if (!hols.length || !partners.length) return;
    const fixedUse = {};
    fixed.filter(h => h && h.type === type).forEach(h => [h.surgeonA, h.surgeonB].filter((v, i, a) => v && a.indexOf(v) === i).forEach(id => { fixedUse[id] = (fixedUse[id] || 0) + 1; }));
    const slots = []; hols.forEach((h, hi) => { slots.push({ hi, role: "A" }); slots.push({ hi, role: "B" }); });
    const order = partners.slice();
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
    // additive per (slot, partner): [unavailable, same as last year, as two years ago, times had it, role had, as the stored next year]
    const add = slots.map(({ hi, role }) => { const h = hols[hi], r = {}; order.forEach(id => {
      r[id] = [unavailable(id, h, role) ? 1 : 0, had(Y1, id, h.name) ? 1 : 0, had(Y2, id, h.name) ? 1 : 0, nameCt[id][h.name] || 0, (roleCt[id][type] || {})[role] || 0, had(YN, id, h.name) ? 1 : 0];
    }); return r; });
    const score = (cur) => {
      const use = Object.assign({}, fixedUse);
      let un = 0, r1 = 0, r2 = 0, sp = 0, rl = 0, nx = 0;
      cur.forEach((id, k) => { const a = add[k][id]; un += a[0]; r1 += a[1]; r2 += a[2]; sp += a[3]; rl += a[4]; nx += a[5]; use[id] = (use[id] || 0) + 1; });
      let multi = 0, sat2 = 0, runs = 0, rates = 0, pairs = 0, twice = 0;
      for (let k = 0; k + 1 < cur.length; k += 2) { pairs += pairCost(cur[k], cur[k + 1], hols[k >> 1].name); if (cur[k] !== cur[k + 1] && pairNow.has(pairKey(cur[k], cur[k + 1]))) twice++; }
      partners.forEach(id => {
        const u = use[id] || 0;
        if (u > 1) multi += u - 1;
        if (u === 0 && satOutLast(id, type)) sat2++;
        if (u === 0 && hasNext && !(YN[id] || []).some(x => x.type === type && x.name !== "Christmas Day")) nx++;
        if (u > 0 && !fixedUse[id]) { runs += run[id][type]; rates += Math.round((rate(id, type) || 0) * 1000); }
      });
      return [un, multi, sat2, r1, r2, nx, twice, sp, runs, rates, pairs, rl];
    };
    const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
    let best = null, bestV = null;
    const cur = new Array(slots.length), useP = Object.assign({}, fixedUse);
    // the first two tiers (time off, two in a group) only grow down a path: cut a branch already worse than the best
    const dfs = (k, unP, multiP) => {
      if (bestV && (unP > bestV[0] || (unP === bestV[0] && multiP > bestV[1]))) return;
      if (k === slots.length) { const v = score(cur); if (!bestV || cmp(v, bestV) < 0) { bestV = v; best = cur.slice(); } return; }
      for (const id of order) {
        if (slots[k].role === "B" && cur[k - 1] === id && order.length > 1) continue; // A ≠ B
        const u0 = useP[id] || 0;
        cur[k] = id; useP[id] = u0 + 1;
        dfs(k + 1, unP + add[k][id][0], multiP + (u0 >= 1 ? 1 : 0));
        useP[id] = u0;
      }
    };
    dfs(0, 0, partners.reduce((n, id) => n + Math.max(0, (fixedUse[id] || 0) - 1), 0));
    if (!best) return;
    cost[type] = bestV;
    hols.forEach((h, hi) => { picks[h.name] = { surgeonA: best[2 * hi], surgeonB: best[2 * hi + 1] }; if (best[2 * hi] !== best[2 * hi + 1]) pairNow.add(pairKey(best[2 * hi], best[2 * hi + 1])); });
    // plain words for anything the rules could not all have
    hols.forEach((h, hi) => ["A", "B"].forEach((role, j) => { const id = best[2 * hi + j];
      if (add[2 * hi + j][id][0]) notes.push(`${nm(id)} is on time off for ${h.name} ${year} (surgeon ${role}) — nobody else fit; change it with the swap controls`);
      if (add[2 * hi + j][id][1]) notes.push(`${nm(id)} has ${h.name} again (${year - 1} too) — no other way this year`); }));
    const use = Object.assign({}, fixedUse); best.forEach(id => { use[id] = (use[id] || 0) + 1; });
    const free = partners.filter(id => !fixedUse[id]);
    const oneEach = free.length <= slots.length, short = free.length < slots.length; // everyone gets one (the minors); someone must take two
    const offAll = (id) => slots.every((sl, k) => add[k][id][0]); // off for every date this group's roles hold
    const offNames = partners.filter(id => !use[id] && offAll(id)).map(nm);
    partners.forEach(id => {
      if ((use[id] || 0) > 1) notes.push(`${nm(id)} has two ${type} holidays in ${year} — ${short ? "not enough partners for one each" : (offNames.length ? offNames.join(", ") + " off on every " + type + " holiday" : "the others' time off")}`);
      if (!use[id] && !fixedUse[id] && oneEach) notes.push(`${nm(id)} has no ${type} holiday in ${year}${offAll(id) ? " — off on every " + type + " holiday date" : ""}`);
      else if (!use[id] && satOutLast(id, type)) notes.push(`${nm(id)} has no ${type} holiday in ${year} or ${year - 1}`);
    });
  });
  // a year already stored AFTER this one: what the new picks break against it
  const next = yearArr(year + 1);
  if (next) {
    const typeOf = {}; (o.holidays || []).concat(fixed).forEach(h => { if (h && h.name) typeOf[h.name] = h.type; });
    const mine = (id) => Object.keys(picks).filter(n => picks[n].surgeonA === id || picks[n].surgeonB === id)
      .concat(fixed.filter(h => h && (h.surgeonA === id || h.surgeonB === id)).map(h => h.name));
    const plannedMajor = Object.keys(picks).some(n => typeOf[n] === "major");
    partners.forEach(id => {
      const nowH = mine(id), nextH = next.filter(h => h && (h.surgeonA === id || h.surgeonB === id));
      nowH.forEach(n => { if (nextH.some(h => h.name === n)) notes.push(`${nm(id)} has ${n} in ${year} and in ${year + 1} (already stored) — re-generate ${year + 1} too`); });
      if (plannedMajor && !nowH.some(n => typeOf[n] === "major") && !nextH.some(h => h.type === "major" && h.name !== "Christmas Day"))
        notes.push(`${nm(id)} has no major in ${year} or in ${year + 1} (already stored) — re-generate ${year + 1} too`);
    });
  }
  return { picks, notes, cost };
}

// The holiday card's rotation checks (owner 2026-10-13) — one pure function
// the card renders. Each group's holders (A = B is ONE holiday: FAK's
// Christmas), duplicates within a group, who sits out a major, and the issues:
// a partner with no minor, FAK on another holiday, no major two years running,
// a holiday again from last year. A hand-written preset year is a fact: no
// rotation issues (preset).
// o = { assignments, prior (last year's cards), surgeons, fakId, year, preset, nameOf? }
function holidayRotationCheck(o) {
  const assignments = (o.assignments || []).filter(Boolean), prior = (o.prior || []).filter(Boolean), surgeons = o.surgeons || [], fakId = o.fakId || null, year = Number(o.year);
  const holders = (h) => [h.surgeonA, h.surgeonB].filter((v, i, a) => v && a.indexOf(v) === i);
  const nm = o.nameOf || ((id) => (surgeons.find(s => s.id === id) || {}).name || id);
  const group = (type, label) => {
    const seen = {}, dupes = [];
    assignments.filter(h => h.type === type).forEach(h => holders(h).forEach(sid => { if (seen[sid]) dupes.push({ surgeon: sid, hol1: seen[sid], hol2: h.name }); else seen[sid] = h.name; }));
    return { label, ok: dupes.length === 0, dupes, uniqueCount: Object.keys(seen).length, none: surgeons.filter(sg => sg.id !== fakId && !seen[sg.id]).map(sg => sg.id) };
  };
  const major = group("major", "Major"), minor = group("minor", "Minor"), issues = [];
  if (!o.preset) {
    minor.none.forEach(id => issues.push(`${nm(id)} has no minor holiday`));
    if (fakId) assignments.filter(h => h.name !== "Christmas Day" && holders(h).includes(fakId)).forEach(h => issues.push(`${nm(fakId)} is on ${h.name} (his holidays are Christmas Eve + Day)`));
    if (prior.length) {
      const hadMajor = new Set(prior.filter(h => h.type === "major").flatMap(holders));
      major.none.filter(id => !hadMajor.has(id)).forEach(id => issues.push(`${nm(id)} has no major in ${year - 1} or ${year}`));
      assignments.forEach(h => holders(h).forEach(id => { if (id !== fakId && prior.some(p => p.name === h.name && holders(p).includes(id))) issues.push(`${nm(id)} has ${h.name} again (${year - 1} too)`); }));
    }
  }
  return { major, minor, issues, preset: !!o.preset };
}

// A covered date's holiday name: the generator's own holiday field when it
// stored one, else the label without its trailing "24h" ("Labor Day 24h" → "Labor Day").
function holidayTitleName(cover) {
  return (cover && cover.holiday) || String((cover && cover.label) || "").replace(/\s*\(?24h\)?\s*$/i, "").trim() || "Holiday";
}

// "Mon 9/7" for a YYYY-MM-DD date (local, via parse).
function dayMonthLabel(ds) {
  const d = parse(ds);
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
}

// Mine tab dates (UX audit 2026-10-19). My Shifts headed each week with ISO
// dates ("2026-10-19 → 2026-10-25") and listed rows like "Tue Night 5p–7a"
// with no date, so a member had to work out which night was theirs; the
// header showed the Generate tab's setup window, not what is published.
// Pure: no clock, no state; dates are local, via parse.
//   monthDayLabel("2026-10-19")       → "Oct 19"
//   monthDayLabel("2026-12-27", true) → "Dec 27, 2026"
//   weekRangeLabel("2026-10-19")      → "Oct 19 – Oct 25" (the week's Monday → Sunday)
function monthDayLabel(ds, withYear) {
  const d = parse(ds);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]} ${d.getDate()}${withYear ? `, ${d.getFullYear()}` : ""}`;
}
function weekRangeLabel(mStr) {
  return `${monthDayLabel(mStr)} – ${monthDayLabel(fmt(addD(parse(mStr), 6)))}`;
}

// The date chip on a My Shifts row (role = the Mine builder's role object):
//   a Mon–Thu night  → its own date, "Tue 10/20" (shiftStartDate's rule)
//   the weekend      → the legs this surgeon holds (role.held), "Fri 10/23 + Sun 10/25";
//                      with no held list, both legs
//   the service week → the days held, as runs of consecutive days: "Mon 10/19 – Sat 10/24";
//                      a day someone else holds (a covered holiday) splits it, so the chip
//                      never spans it: "Mon 11/23 – Wed 11/25 + Sat 11/28" (review 2026-10-19);
//                      with no held list, Monday to Saturday
//   null for a dated role (a holiday 24h, a single service day: its detail
//   already starts with the date), an OFF week (the week header has it), and a
//   held list that is empty (every day covered by someone else; the detail says so).
function roleDateLabel(mStr, role) {
  const r = role || {};
  if (r.date || !r.shiftKey) return null;
  if (NIGHT_KEYS.includes(r.shiftKey)) return dayMonthLabel(shiftStartDate(mStr, r.shiftKey));
  const held = (offsets) => (Array.isArray(r.held) ? r.held.slice().sort() : offsets.map(i => fmt(addD(parse(mStr), i))));
  if (r.shiftKey === "wknd") {
    const legs = held([4, 6]);
    return legs.length ? legs.map(dayMonthLabel).join(" + ") : null;
  }
  if (r.shiftKey === "dayCall") {
    const runs = []; // [first, last] of each run of consecutive held days
    for (const d of held([0, 1, 2, 3, 4, 5])) {
      const run = runs[runs.length - 1];
      if (run && d <= run[1]) continue; // a day listed twice
      if (run && fmt(addD(parse(run[1]), 1)) === d) run[1] = d;
      else runs.push([d, d]);
    }
    return runs.length ? runs.map(([a, b]) => (a === b ? dayMonthLabel(a) : `${dayMonthLabel(a)} – ${dayMonthLabel(b)}`)).join(" + ") : null;
  }
  return null;
}

// The last date of the published schedule, for the Mine header ("Published
// through Jan 3, 2027"): the Sunday of the last week that holds any call — a
// dayCall, a night or a holidayCoverage entry, calMonthStatus's rule, so this
// header and the Calendar's "the published schedule runs … → …" agree. Only
// YYYY-MM-DD keys are weeks. null when no week counts. Pure: no clock, no state.
function publishedThrough(schedule) {
  const holds = (w) => !!w && (!!w.dayCall || Object.values(w.nights || {}).some(Boolean) || Object.values(w.holidayCoverage || {}).some(Boolean));
  const keys = Object.keys(schedule || {}).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && holds(schedule[k])).sort();
  return keys.length ? fmt(addD(parse(keys[keys.length - 1]), 6)) : null;
}

// The line a service week or weekend carries for a date someone else holds,
// e.g. "Mon 9/7 covered by RPC (Labor Day)". holderSid is who holds it; a swap
// names its own label; a single-day override has no parenthesis.
function coverNote(day, holderSid, nameOf) {
  const name = holderSid ? (typeof nameOf === "function" ? nameOf(holderSid) : holderSid) : "someone else";
  const why = day.cover ? ` (${day.cover.type === "swap" ? (day.cover.label || "coverage") : holidayTitleName(day.cover)})` : "";
  return `${dayMonthLabel(day.ds)} covered by ${name}${why}`;
}

/* ═══ TRADE MESSAGE COMPOSERS (2026-09-07) ═══
   ONE composition per trade event, shared by in-app, push, and email — so
   the three channels cannot drift (push reuses addNotification's message
   verbatim; email carries the composed string as data.detail).

   WHO GETS WHAT, proven at the accept-time apply (index-source.html
   ~2610-2616) AND confirmed against the first real member accept (trade #5,
   2026-09-07: the schedule_weeks row came back thu=s4 wed=s6):
     to_surgeon   receives  shift_key  @ week_monday
     from_surgeon receives  return_shift @ return_week
   Every date is composed through slotLabel → shiftStartDate, so a trade
   message can never print the week-Monday for a Thursday night (the defect
   these replace, and the same class PR #51 removed from the pickers).

   One-way trades are legitimate (scheduler emergency override) and carry
   null return fields — they degrade EXPLICITLY, never silently back into
   the old one-leg shape. */
function tradeLegsText(req, tense) {
  // tense: "takes" (accepted) | "would take" (proposed) | "would have taken" (declined)
  const gets = slotLabel(req.week_monday, req.shift_key);
  if (!req.return_week || !req.return_shift) {
    return `${req.to_surgeon_name} ${tense} ${gets} (one-way — no return shift)`;
  }
  const back = slotLabel(req.return_week, req.return_shift);
  return `${req.to_surgeon_name} ${tense} ${gets}; ${req.from_surgeon_name} ${tense} ${back}`;
}
/* The same two legs, said to the person reading them (UX audit 2026-10-19),
   for each row of Requests → Pending Trades. The surgeon who has to answer
   reads what they would take and what they would give; the proposer reads
   the mirror; anyone else (the scheduler on two colleagues' trade) reads
   tradeLegsText's line. Who gets what is the rule above: to_surgeon takes
   shift_key @ week_monday, from_surgeon takes return_shift @ return_week.
   Composed with slotLabel HERE, so the card adds no slotLabel call site to
   index-source.html (sync-guards L keeps its ledger). A one-way trade names
   its one leg only: the row's badge line right above already says
   "(one-way — no return shift)", so the row says it once (review
   2026-10-19); tradeLegsText keeps the suffix for the notifications. */
function tradeLegsFor(req, viewerId) {
  const gets = slotLabel(req.week_monday, req.shift_key);
  const oneWay = !req.return_week || !req.return_shift;
  const back = oneWay ? "" : slotLabel(req.return_week, req.return_shift);
  if (viewerId && viewerId === req.to_surgeon_id) {
    return oneWay ? `You'd take ${gets}` : `You'd take ${gets}; you'd give ${back}`;
  }
  if (viewerId && viewerId === req.from_surgeon_id) {
    return oneWay ? `You'd give ${gets}` : `You'd give ${gets}; you'd take ${back}`;
  }
  return oneWay ? `${req.to_surgeon_name} would take ${gets}` : tradeLegsText(req, "would take");
}
/* The SWAP family (2026-09-07), same doctrine as the trade composers above.
   executeTwoWaySwap's semantics, read off its own apply:
     the CANDIDATE (newName) takes targetShift @ targetMon
     the ORIGINAL holder (oldName) takes returnShift @ returnMon
   One-way swaps are a first-class feature here (the scheduler's emergency
   override), so they degrade explicitly rather than looking two-way.
   No leading "Shift swap —" label: the in-app title is already "Shift Swap"
   and the email header is "Schedule Change" — a label here would stutter
   against both, the defect caught in v16 by rendering the email body. */
function swapMsg(s) {
  const gets = slotLabel(s.targetMon, s.targetShift);
  if (!s.returnMon || !s.returnShift) {
    return `${s.newName} takes ${gets} (one-way — no return shift)`;
  }
  return `${s.newName} takes ${gets}; ${s.oldName} takes ${slotLabel(s.returnMon, s.returnShift)}`;
}
/* Cascade = the knock-on reassignment a trade forces on someone who was not
   party to it. Composed once and used for BOTH the in-app notification and
   the email that this PR adds (previously there was no email at all — the
   person with the least warning got the weakest notice). */
function cascadeMsg(c) {
  return `${slotLabel(c.week, c.shiftKey)} moved from ${c.fromName} to ${c.toName} due to a trade`;
}

function tradeProposeMsg(req) {
  return `${req.from_surgeon_name} proposed a trade: ${tradeLegsText(req, "would take")}`;
}
function tradeAcceptMsg(req) {
  return `${req.to_surgeon_name} accepted the trade: ${tradeLegsText(req, "takes")}`;
}
function tradeDeclineMsg(req) {
  return `${req.to_surgeon_name} declined the trade: ${tradeLegsText(req, "would have taken")}`;
}

// Dated slot label for pickers and rows where the WEEK is known (2026-09-06):
// composed THROUGH shiftStartDate, so a rendered date can never disagree with
// the validation that gates the same slot. SHIFT_LABELS stays context-free —
// this composes at the point a week is known, never mutates it.
//   dayCall  → "Service Wk of Sep 14"   (a week, not a single day)
//   mon..thu → "Thu Sep 17 — Night"
//   wknd     → "Wknd — Fri Sep 18"      (shift start, per shiftStartDate)
// Accepts the lock UI's legacy "dc" key (same normalization the lock
// applier does).
function slotLabel(mondayStr, shiftKey) {
  if (shiftKey === "dc") shiftKey = "dayCall";
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const d = parse(shiftStartDate(mondayStr, shiftKey));
  const md = `${MO[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
  if (shiftKey === "dayCall") return `Service Wk of ${md}`;
  if (shiftKey === "wknd") return `Wknd — ${DOW[d.getDay()]} ${md}`;
  return `${DOW[d.getDay()]} ${md} — Night`;
}

/* ═══ ICS Calendar Generation ═══ */
// ALL-DAY events (2026-09-25, same format as the calendar-sync v15 feed): a
// service week is one Mon–Sat event, each weeknight one event on its date, the
// weekend two events (Friday night, Sunday) so Saturday stays with the
// service-week holder. The exact Central hours go in the description. Personal
// exports use the short titles; the full export passes withCode so each title
// names the surgeon. DTEND is exclusive, so an event's end is the day AFTER
// its last day. There is no timed variant here; the live feed keeps one.
// Call events are marked transparent (owner decision 2026-09-25): an all-day
// event counts as busy by default, so an imported file would block the whole
// day on every call day. Vacations are built elsewhere without the flag and
// stay busy, because they are real unavailability. The live feed needs none
// of this, since a subscribed calendar never counts toward free/busy.
const icsDay = d => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
const ICS_TZ_NOTE = "Times are Central.";

// Holidays and single-day coverage (2026-10-02): who holds each date comes
// from weekHolders, the calendar's rule. A service week is one event per
// contiguous run of the days its surgeon actually holds (Mon–Sat), and each
// day someone else took adds a line such as "Mon 9/7 covered by RPC (Labor Day)".
// A night or weekend leg on a covered date drops. The surgeon covering a
// holiday gets an all-day event on its date ("DSG Holiday — <name>", or
// "DSG <label>" for a swap), and the surgeon covering a single service day
// gets "DSG Service Day". In a backup week every event carries " [BACKUP]".
// opts.nameOf maps an id to its code for those lines (the id itself without it).
function buildICSEvents(schedule, surgeonId, surgeonName, opts) {
  const events = [];
  const who = opts?.withCode ? ` — ${surgeonName}` : "";
  const nameOf = typeof opts?.nameOf === "function" ? opts.nameOf : (sid => sid);
  const add = (first, endExclusive, title, bkLabel, hours, notes) => events.push({
    allDay: true, transparent: true, start: icsDay(first), end: icsDay(endExclusive),
    summary: `${title}${bkLabel}${who}`,
    desc: `${hours}${bkLabel}${notes && notes.length ? "\n" + notes.join("\n") : ""}\n${ICS_TZ_NOTE}`
  });

  Object.entries(schedule).forEach(([mondayStr, wk]) => {
    const mon = parse(mondayStr);
    const bkLabel = wk.isBackup ? " [BACKUP]" : "";
    const H = weekHolders(mondayStr, wk);
    const svcDays = H.days.slice(0, 6); // Mon–Fri daytime + the service Saturday
    const svcHolder = (d) => (d.i <= 4 ? d.svc : d.sat);

    if (wk.dayCall === surgeonId) {
      // A day the surgeon still holds as its holiday coverer was not given away: no note
      const notes = svcDays.filter(d => svcHolder(d) !== surgeonId && !(d.cover && d.cover.sid === surgeonId))
        .map(d => coverNote(d, d.cover ? d.cover.sid : svcHolder(d), nameOf));
      const runs = [];
      svcDays.forEach(d => {
        if (svcHolder(d) !== surgeonId) return;
        const last = runs[runs.length - 1];
        if (last && last.last === d.i - 1) last.last = d.i; else runs.push({ first: d.i, last: d.i });
      });
      runs.forEach(r => add(addD(mon, r.first), addD(mon, r.last + 1), "DSG Service Week", bkLabel,
        "Mon–Fri 7:00 AM – 5:00 PM daytime call\nSat 7:00 AM – Sun 7:00 AM (24h)", notes));
    }

    // A single service day held by someone other than the week's service surgeon
    svcDays.forEach(d => {
      if (wk.dayCall === surgeonId || svcHolder(d) !== surgeonId) return;
      add(addD(mon, d.i), addD(mon, d.i + 1), "DSG Service Day", bkLabel,
        d.i === 5 ? "Sat 7:00 AM – Sun 7:00 AM (24h)" : "7:00 AM – 5:00 PM daytime call");
    });

    const nightDays = [["Mon", "Tue"], ["Tue", "Wed"], ["Wed", "Thu"], ["Thu", "Fri"]];
    H.days.slice(0, 4).forEach((d, i) => {
      if (d.night === surgeonId) add(addD(mon, i), addD(mon, i + 1), "DSG Night", bkLabel, `${nightDays[i][0]} 5:00 PM – ${nightDays[i][1]} 7:00 AM`);
    });

    if (H.days[4].wkndFri === surgeonId) add(addD(mon, 4), addD(mon, 5), "DSG Weekend — Fri night", bkLabel, "Fri 5:00 PM – Sat 7:00 AM");
    if (H.days[6].wkndSun === surgeonId) add(addD(mon, 6), addD(mon, 7), "DSG Weekend — Sun", bkLabel, "Sun 7:00 AM – Mon 7:00 AM (24h)");

    H.covers.forEach(c => {
      if (c.sid !== surgeonId) return;
      const d = parse(c.ds);
      add(d, addD(d, 1), c.type === "swap" ? `DSG ${c.label || "Coverage"}` : `DSG Holiday — ${holidayTitleName(c)}`, bkLabel,
        `${c.label || holidayTitleName(c)}: 7:00 AM – 7:00 AM next day (24h)`);
    });
  });

  return events;
}

// APP shifts for the FULL export: one all-day event per shift date. A weekend
// APP shift runs 7 AM to 7 AM; a weekday one runs 5 PM to 7 AM.
function buildAppICSEvents(appShifts, aMap) {
  return Object.entries(appShifts || {}).map(([ds, aid]) => {
    const d = parse(ds);
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    return {
      allDay: true, transparent: true, start: icsDay(d), end: icsDay(addD(d, 1)),
      summary: `DSG APP Call — ${aMap?.[aid]?.name || aid}`,
      desc: `${isWeekend ? "7:00 AM – 7:00 AM next day (24h)" : "5:00 PM – 7:00 AM next day"}\n${ICS_TZ_NOTE}`
    };
  });
}

// RFC 5545 TEXT escaping, and folding of content lines longer than 75 octets
// (a CRLF plus one space; the continuation's space counts toward its 75).
// Counts UTF-8 octets so a multi-byte character is never split.
const icsEsc = t => String(t).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
const icsOctets = ch => { const cp = ch.codePointAt(0); return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4; };
function icsFold(line) {
  let total = 0;
  for (const ch of line) total += icsOctets(ch);
  if (total <= 75) return line;
  const parts = [];
  let cur = "", bytes = 0, limit = 75;
  for (const ch of line) {
    const n = icsOctets(ch);
    if (bytes + n > limit) { parts.push(cur); cur = ""; bytes = 0; limit = 74; }
    cur += ch; bytes += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

function generateICS(events, calName) {
  const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2,9)}@callsched`;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//DSG Call Schedule//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${icsEsc(calName)}`];
  events.forEach(e => {
    lines.push("BEGIN:VEVENT", `UID:${uid()}`,
      e.allDay ? `DTSTART;VALUE=DATE:${e.start}` : `DTSTART:${e.start}`,
      e.allDay ? `DTEND;VALUE=DATE:${e.end}` : `DTEND:${e.end}`,
      // Free, not busy: TRANSP is the RFC 5545 property; Outlook reads its own for Show-as on import
      ...(e.transparent ? ["TRANSP:TRANSPARENT", "X-MICROSOFT-CDO-BUSYSTATUS:FREE"] : []),
      `SUMMARY:${icsEsc(e.summary)}`, `DESCRIPTION:${icsEsc(e.desc)}`, "END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

function downloadICS(content, filename) {
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// Download an arbitrary object as a pretty-printed JSON file. Used for the
// manual schedule backup in the Data Management card.
// Returns true if a real file download was triggered, false if it had to fall
// back to opening the JSON in a new view (standalone iOS PWAs ignore the
// <a download> attribute and would otherwise silently do nothing).
function downloadJSON(obj, filename) {
  const text = JSON.stringify(obj, null, 2);
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);

  if (isIOS && isStandalone) {
    // Open in a new view; user saves via Share → Save to Files.
    const w = window.open(url, "_blank");
    if (!w) { try { location.href = url; } catch(e) { console.warn("Couldn't open download (popup blocked and redirect failed):", e); } }
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return false;
  }

  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/* ═══════════════════════════════════════════════════════════════
   Printable Calendar Creator–style View
   Generates a self-contained HTML document for printing.
   Mimics the Calendar Creator for Windows style used by the group.
   ═══════════════════════════════════════════════════════════════ */
function buildPrintableCalendarHTML({
  startYear,        // e.g. 2026
  startMonth,       // 0-indexed (0=Jan, 11=Dec)
  numMonths,        // how many consecutive months to render
  schedule,         // live state — keyed by Monday YYYY-MM-DD
  vacations,        // live state — keyed by surgeon/APP id
  surgeons,         // [{id,name}, ...]
  apps,             // [{id,name}, ...]
  appShifts,        // live state — { "YYYY-MM-DD": appId }
  fierceBackupSet,  // Set of Monday strings (extra fierce backup weeks)
}) {
  const MONTH_NAMES = ["January","February","March","April","May","June",
                       "July","August","September","October","November","December"];

  const sMap = {};
  surgeons.forEach(s => { sMap[s.id] = s.name; });
  const aMap = {};
  apps.forEach(a => { aMap[a.id] = a.name; });
  const nameOf = pid => sMap[pid] || aMap[pid] || pid;

  // Build the bars list (vacations + fierce) once for the full range
  const bars = [];
  Object.entries(vacations || {}).forEach(([pid, ranges]) => {
    const isSurgeon = !!sMap[pid];
    const name = nameOf(pid);
    (ranges || []).forEach(([start, end]) => {
      bars.push({
        label: `${name} VAC`,
        start, end,
        type: isSurgeon ? "surgeon" : "app",
      });
    });
  });
  Object.entries(schedule || {}).forEach(([mondayStr, wk]) => {
    const mon = parse(mondayStr);
    const sun = addD(mon, 6);
    if (wk.isBackup) {
      bars.push({ label: "FIERCE 1ST/ND", start: fmt(mon), end: fmt(sun), type: "fierce" });
    }
    if (wk.isFierceBackup) {
      bars.push({ label: "FIERCE BACKUP", start: fmt(mon), end: fmt(sun), type: "fierce-backup" });
    }
  });
  // Extra fierce-backup weeks that aren't in schedule object
  if (fierceBackupSet) {
    fierceBackupSet.forEach(mondayStr => {
      // Skip if already added via schedule entry
      if (schedule && schedule[mondayStr]?.isFierceBackup) return;
      const mon = parse(mondayStr);
      const sun = addD(mon, 6);
      bars.push({ label: "FIERCE BACKUP", start: fmt(mon), end: fmt(sun), type: "fierce-backup" });
    });
  }

  // Shift text for a given date — Mon/Fri: "DC / Night", Sat: "DC", Sun: "Wknd"
  // Fri night IS the weekend slot. Holiday coverage overrides.
  function shiftTextFor(date) {
    const ds = fmt(date);
    const mon = monOf(date);
    const wkKey = fmt(mon);
    const wk = (schedule || {})[wkKey];
    if (!wk) return "";

    if (wk.holidayCoverage && wk.holidayCoverage[ds]) {
      return nameOf(wk.holidayCoverage[ds].surgeonId);
    }

    const dow = date.getDay();
    const dc = nameOf(wk.dayCall);
    if (dow === 0) {
      return wk.nights?.wknd ? nameOf(wk.nights.wknd) : "";
    }
    if (dow === 6) {
      return dc;
    }
    const slot = ["", "mon", "tue", "wed", "thu", "wknd"][dow];
    const night = wk.nights?.[slot];
    if (!night) return dc;
    return `${dc} / ${nameOf(night)}`;
  }

  function appShiftTextFor(date) {
    const ds = fmt(date);
    const aid = (appShifts || {})[ds];
    if (!aid) return "";
    return nameOf(aid);
  }

  function holidayNoteFor(date) {
    const ds = fmt(date);
    const mon = monOf(date);
    const wkKey = fmt(mon);
    const wk = (schedule || {})[wkKey];
    if (!wk?.holidayCoverage?.[ds]) return "";
    return wk.holidayCoverage[ds].name || "";
  }

  function buildWeeks(year, month) {
    const first = new Date(year, month, 1);
    const last = new Date(year, month+1, 0);
    const gridStart = new Date(first);
    gridStart.setDate(first.getDate() - first.getDay());
    const weeks = [];
    let cursor = new Date(gridStart);
    while (cursor <= last || cursor.getDay() !== 0) {
      const week = [];
      for (let i = 0; i < 7; i++) {
        week.push({
          date: new Date(cursor),
          ds: fmt(cursor),
          dayNum: cursor.getDate(),
          inMonth: cursor.getMonth() === month,
        });
        cursor = addD(cursor, 1);
      }
      weeks.push(week);
      if (weeks.length > 6) break;
    }
    return weeks;
  }

  function computeBarsForWeek(week) {
    const inMonthDays = week.filter(d => d.inMonth);
    if (inMonthDays.length === 0) return { bars: [], laneCount: 0 };

    const firstInMonthCol = week.findIndex(d => d.inMonth);
    const lastInMonthCol = week.length - 1 - [...week].reverse().findIndex(d => d.inMonth);
    const weekStart = week[firstInMonthCol].ds;
    const weekEnd = week[lastInMonthCol].ds;

    const weekBars = [];
    bars.forEach(b => {
      if (b.end < weekStart || b.start > weekEnd) return;
      const segStart = b.start < weekStart ? weekStart : b.start;
      const segEnd = b.end > weekEnd ? weekEnd : b.end;
      const startCol = week.findIndex(d => d.ds === segStart);
      const endCol = week.findIndex(d => d.ds === segEnd);
      if (startCol === -1 || endCol === -1) return;
      weekBars.push({
        label: b.label,
        type: b.type,
        startCol,
        span: endCol - startCol + 1,
      });
    });

    const typeOrder = { surgeon: 0, app: 1, "fierce-backup": 2, fierce: 3 };
    weekBars.sort((a, b) => {
      if (typeOrder[a.type] !== typeOrder[b.type]) return typeOrder[a.type] - typeOrder[b.type];
      return a.startCol - b.startCol;
    });

    const lanes = [];
    weekBars.forEach(bar => {
      const endCol = bar.startCol + bar.span - 1;
      let placed = false;
      for (let i = 0; i < lanes.length; i++) {
        const conflict = lanes[i].some(seg =>
          !(bar.startCol > seg.endCol || endCol < seg.startCol));
        if (!conflict) {
          lanes[i].push({ startCol: bar.startCol, endCol });
          bar.lane = i;
          placed = true;
          break;
        }
      }
      if (!placed) {
        lanes.push([{ startCol: bar.startCol, endCol }]);
        bar.lane = lanes.length - 1;
      }
    });
    return { bars: weekBars, laneCount: lanes.length };
  }

  function buildMiniCal(year, month) {
    const first = new Date(year, month, 1);
    const last = new Date(year, month+1, 0);
    const startDow = first.getDay();
    const days = last.getDate();

    let html = `<div class="mini-cal">`;
    html += `<div class="mini-name">${MONTH_NAMES[month]} ${year}</div>`;
    html += `<div class="mini-grid">`;
    ["S","M","T","W","T","F","S"].forEach(d => {
      html += `<div class="mini-dow">${d}</div>`;
    });
    for (let i = 0; i < startDow; i++) {
      html += `<div class="mini-day empty">0</div>`;
    }
    for (let d = 1; d <= days; d++) {
      html += `<div class="mini-day">${d}</div>`;
    }
    html += `</div></div>`;
    return html;
  }

  function renderMonth(year, month) {
    const weeks = buildWeeks(year, month);
    const firstWeek = weeks[0];
    const emptyLeading = firstWeek.filter(d => !d.inMonth).length;
    let miniPrev = null, miniNext = null;
    if (emptyLeading >= 2) {
      miniPrev = { col: 0 };
      miniNext = { col: 1 };
    } else if (emptyLeading === 1) {
      miniPrev = { col: 0 };
    }
    const prevMonth = month === 0 ? { y: year-1, m: 11 } : { y: year, m: month-1 };
    const nextMonth = month === 11 ? { y: year+1, m: 0 } : { y: year, m: month+1 };

    let html = `<div class="page">`;
    html += `<div class="month-title">${MONTH_NAMES[month]} ${year}</div>`;
    html += `<div class="dow-row">`;
    ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"]
      .forEach(d => html += `<div class="dow">${d}</div>`);
    html += `</div>`;

    weeks.forEach((week, weekIdx) => {
      const { bars: weekBars, laneCount } = computeBarsForWeek(week);
      const barZoneHeight = laneCount * 14 + 4;
      const cellMinHeight = 85 + barZoneHeight;

      html += `<div class="week-row" style="min-height:${cellMinHeight}px">`;

      week.forEach((d, col) => {
        if (weekIdx === 0 && miniPrev && col === miniPrev.col) {
          html += `<div class="cell empty">${buildMiniCal(prevMonth.y, prevMonth.m)}</div>`;
          return;
        }
        if (weekIdx === 0 && miniNext && col === miniNext.col) {
          html += `<div class="cell empty">${buildMiniCal(nextMonth.y, nextMonth.m)}</div>`;
          return;
        }
        if (!d.inMonth) {
          html += `<div class="cell empty"></div>`;
          return;
        }

        html += `<div class="cell">`;
        html += `<div class="day-num">${d.dayNum}</div>`;
        const shift = shiftTextFor(d.date);
        if (shift) html += `<div class="shift">${shift}</div>`;
        const appTxt = appShiftTextFor(d.date);
        if (appTxt) html += `<div class="app-shift">${appTxt}</div>`;
        const hol = holidayNoteFor(d.date);
        if (hol) html += `<div class="holiday-note">${hol}</div>`;
        html += `</div>`;
      });

      if (weekBars.length) {
        html += `<div class="bars-layer">`;
        weekBars.forEach(bar => {
          const leftPct = (bar.startCol / 7) * 100;
          const widthPct = (bar.span / 7) * 100;
          const bottom = (laneCount - 1 - bar.lane) * 14;
          const cls =
            bar.type === "surgeon"        ? "vac-surgeon" :
            bar.type === "app"            ? "vac-app" :
            bar.type === "fierce"         ? "fierce" :
            bar.type === "fierce-backup"  ? "fierce-backup" :
            "vac-surgeon";
          html += `<div class="bar ${cls}" style="`
               +  `left:calc(${leftPct}% + 2px);`
               +  `width:calc(${widthPct}% - 4px);`
               +  `bottom:${bottom}px">`
               +  `${bar.label}`
               +  `</div>`;
        });
        html += `</div>`;
      }

      html += `</div>`;
    });

    const today = new Date();
    const printed = `${today.getMonth()+1}/${today.getDate()}/${today.getFullYear()}`;
    html += `<div class="footer">Davenport Surgical Group Call Schedule · Printed ${printed}</div>`;
    html += `</div>`;
    return html;
  }

  // Assemble
  const css = `
    @page { size: letter portrait; margin: 0.4in; }
    body {
      margin: 0;
      padding: 20px;
      background: #e8e5dd;
      font-family: Arial, Helvetica, sans-serif;
    }
    .toolbar {
      max-width: 800px;
      margin: 0 auto 16px;
      text-align: center;
    }
    .toolbar button {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 13px;
      font-weight: 600;
      padding: 8px 18px;
      background: linear-gradient(135deg,#1a6fa8,#2488c8);
      color: #fff;
      border: 1px solid #1a6fa8;
      border-radius: 6px;
      cursor: pointer;
      margin: 0 4px;
    }
    .toolbar button.secondary {
      background: #f0f2f5;
      color: #5a6a78;
      border: 1px solid #c8d0d8;
    }
    .toolbar button:hover { opacity: 0.92; }
    .toolbar .hint { color:#5a6a78; font-size:12px; margin-left:10px; }
    .page {
      width: 800px;
      margin: 0 auto 28px;
      background: #fdfbf5;
      border: 1.5px solid #8a1838;
      padding: 0;
      box-shadow: 0 2px 12px rgba(0,0,0,0.12);
      position: relative;
    }
    /* Force browsers to print background colors, gradients, and images.
       Without this, Chrome/Safari/Edge default to "economy mode" and strip
       the maroon borders, navy DOW ribbon, vacation bars, and mini calendars. */
    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    @media print {
      body { background: white; padding: 0; }
      .toolbar { display: none; }
      .page {
        margin: 0 auto;
        box-shadow: none;
        page-break-after: always;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      .page:last-child { page-break-after: auto; }
    }
    .month-title {
      text-align: center;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 18pt;
      font-weight: 400;
      color: #7a1038;
      letter-spacing: 0.3px;
      padding: 10px 0 12px;
    }
    .dow-row {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      background: linear-gradient(180deg,
        #202048 0%, #2a2a55 35%, #4a4a78 50%, #2a2a55 65%, #1a1a3a 100%);
      border-top: 1px solid #8a1838;
      border-bottom: 1px solid #8a1838;
      height: 20px;
    }
    .dow {
      font-family: Georgia, "Times New Roman", serif;
      font-style: italic;
      font-size: 9pt;
      color: #ffffff;
      text-align: right;
      padding: 2px 6px 0 0;
      letter-spacing: 0.2px;
    }
    .week-row {
      position: relative;
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      border-bottom: 1px solid #8a1838;
      min-height: 120px;
    }
    .week-row:last-child { border-bottom: none; }
    .cell {
      position: relative;
      border-right: 1px solid #8a1838;
      padding: 3px 5px;
      min-height: 120px;
      box-sizing: border-box;
    }
    .cell:last-child { border-right: none; }
    .cell.empty { background: #fdfbf5; }
    .day-num {
      font-family: Georgia, "Times New Roman", serif;
      font-size: 12pt;
      font-weight: 400;
      color: #7a1038;
      text-align: center;
      line-height: 1.1;
      margin-top: 2px;
    }
    .shift {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 8.5pt;
      color: #000000;
      text-align: center;
      margin-top: 4px;
      letter-spacing: 0.2px;
    }
    .app-shift {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 8pt;
      color: #985020;
      text-align: center;
      margin-top: 2px;
      letter-spacing: 0.2px;
    }
    .holiday-note {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 7.5pt;
      color: #7a1038;
      text-align: center;
      margin-top: 2px;
      font-weight: 600;
      letter-spacing: 0.2px;
    }
    .mini-cal {
      background: #f5ebc8;
      border: 0.5px solid #d4c890;
      margin: 8px 6px;
      padding: 3px 4px;
      font-family: Georgia, "Times New Roman", serif;
    }
    .mini-name {
      text-align: center;
      font-size: 8pt;
      font-weight: 400;
      color: #000;
      margin-bottom: 2px;
      font-style: italic;
    }
    .mini-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 0;
      font-size: 7pt;
      text-align: center;
    }
    .mini-dow {
      font-style: italic;
      color: #000;
      font-weight: 400;
      padding: 1px 0;
    }
    .mini-day {
      color: #000;
      padding: 0.5px 0;
      font-family: Georgia, serif;
    }
    .mini-day.empty { visibility: hidden; }
    .bars-layer {
      position: absolute;
      left: 0; right: 0;
      bottom: 2px;
      pointer-events: none;
    }
    .bar {
      position: absolute;
      height: 13px;
      line-height: 13px;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 7.5pt;
      font-weight: 400;
      text-align: center;
      white-space: nowrap;
      overflow: hidden;
      border: 0.5px solid;
      letter-spacing: 0.2px;
    }
    .bar.vac-surgeon {
      background-image: repeating-linear-gradient(135deg,
        #c8d0dc 0px, #c8d0dc 3px,
        #bec6d2 3px, #bec6d2 4px);
      border-color: #98a0ac;
      color: #202020;
    }
    .bar.vac-app {
      background-image: repeating-linear-gradient(135deg,
        #f0e5b0 0px, #f0e5b0 3px,
        #e6d99e 3px, #e6d99e 4px);
      border-color: #c5b570;
      color: #201800;
    }
    .bar.fierce {
      background: #ba3070;
      border-color: #902050;
      color: #ffffff;
      font-weight: 600;
    }
    .bar.fierce-backup {
      background: #c8548c;
      border-color: #983868;
      color: #ffffff;
      font-weight: 600;
    }
    .footer {
      text-align: center;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 8pt;
      color: #000;
      padding: 6px 0 8px;
      border-top: 1px solid #8a1838;
    }
  `;

  // Generate all month pages
  let pages = "";
  let y = startYear, m = startMonth;
  for (let i = 0; i < numMonths; i++) {
    pages += renderMonth(y, m);
    m++;
    if (m > 11) { m = 0; y++; }
  }

  const firstMonthLabel = `${MONTH_NAMES[startMonth]} ${startYear}`;
  const title = numMonths === 1
    ? `${firstMonthLabel} — DSG Call Schedule`
    : `DSG Call Schedule — ${numMonths} months from ${firstMonthLabel}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
<div class="toolbar">
  <button onclick="window.print()">🖨 Print</button>
  <button class="secondary" onclick="
    try { window.close(); } catch(e) {}
    setTimeout(function() {
      if (!window.closed) {
        document.body.innerHTML = '<div style=\\'text-align:center;padding:60px 20px;font-family:Arial,Helvetica,sans-serif;color:#5a6a78\\'>You can close this tab now.</div>';
      }
    }, 100);
  ">✕ Close</button>
  <span class="hint">Use your browser's print dialog. Choose "Letter" portrait, margins: default. If colors don't print, enable "Background graphics" in the More settings.</span>
</div>
${pages}
</body>
</html>`;
}
