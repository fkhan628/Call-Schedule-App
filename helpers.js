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
      roles: w.roles
        .filter(r => shiftLastDay(w.mStr, r.shiftKey) >= todayStr)
        .map(r => ({ ...r, canSwap: !!r.shiftKey && shiftStartDate(w.mStr, r.shiftKey) >= todayStr })),
    }))
    .filter(w => w.roles.length > 0);
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

function buildICSEvents(schedule, surgeonId, surgeonName, opts) {
  const events = [];
  const who = opts?.withCode ? ` — ${surgeonName}` : "";
  const add = (first, endExclusive, title, bkLabel, hours) => events.push({
    allDay: true, transparent: true, start: icsDay(first), end: icsDay(endExclusive),
    summary: `${title}${bkLabel}${who}`,
    desc: `${hours}${bkLabel}\n${ICS_TZ_NOTE}`
  });

  Object.entries(schedule).forEach(([mondayStr, wk]) => {
    const mon = parse(mondayStr);
    const bkLabel = wk.isBackup ? " [BACKUP]" : "";

    if (wk.dayCall === surgeonId) {
      add(mon, addD(mon, 6), "DSG Service Week", bkLabel,
        "Mon–Fri 7:00 AM – 5:00 PM daytime call\nSat 7:00 AM – Sun 7:00 AM (24h)");
    }

    const nightDays = [["mon", "Mon", "Tue"], ["tue", "Tue", "Wed"], ["wed", "Wed", "Thu"], ["thu", "Thu", "Fri"]];
    nightDays.forEach(([sk, today, tomorrow], i) => {
      if (wk.nights?.[sk] === surgeonId) {
        const d = addD(mon, i);
        add(d, addD(d, 1), "DSG Night", bkLabel, `${today} 5:00 PM – ${tomorrow} 7:00 AM`);
      }
    });

    if (wk.nights?.wknd === surgeonId) {
      add(addD(mon, 4), addD(mon, 5), "DSG Weekend — Fri night", bkLabel, "Fri 5:00 PM – Sat 7:00 AM");
      add(addD(mon, 6), addD(mon, 7), "DSG Weekend — Sun", bkLabel, "Sun 7:00 AM – Mon 7:00 AM (24h)");
    }
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
