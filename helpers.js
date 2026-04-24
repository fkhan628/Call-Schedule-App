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

/* ═══ ICS Calendar Generation ═══ */
function icsDate(y,m,d,h,min) {
  return `${y}${String(m).padStart(2,"0")}${String(d).padStart(2,"0")}T${String(h).padStart(2,"0")}${String(min||0).padStart(2,"0")}00`;
}

function buildICSEvents(schedule, surgeonId, surgeonName, appShifts, aMap) {
  const events = [];
  const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2,9)}@callsched`;

  Object.entries(schedule).forEach(([mondayStr, wk]) => {
    const mon = parse(mondayStr);
    const bkLabel = wk.isBackup ? " [BACKUP]" : "";

    // Day Call
    if (wk.dayCall === surgeonId) {
      // Mon-Fri 7a-5p
      for (let i = 0; i < 5; i++) {
        const d = addD(mon, i);
        const y=d.getFullYear(), m=d.getMonth()+1, day=d.getDate();
        events.push({
          start: icsDate(y,m,day,7), end: icsDate(y,m,day,17),
          summary: `Service Week${bkLabel} — ${surgeonName}`,
          desc: `Service Week 7:00 AM – 5:00 PM${bkLabel}`
        });
      }
      // Sat 7a - Sun 7a (24h)
      const sat = addD(mon, 5);
      const sunD = addD(mon, 6);
      events.push({
        start: icsDate(sat.getFullYear(),sat.getMonth()+1,sat.getDate(),7),
        end: icsDate(sunD.getFullYear(),sunD.getMonth()+1,sunD.getDate(),7),
        summary: `Weekend Saturday 24h${bkLabel} — ${surgeonName}`,
        desc: `Weekend Saturday 7:00 AM – Sunday 7:00 AM${bkLabel}`
      });
    }

    // Night shifts (Mon-Thu)
    const nightKeys = ["mon","tue","wed","thu"];
    nightKeys.forEach((sk, i) => {
      if (wk.nights?.[sk] === surgeonId) {
        const d = addD(mon, i);
        const next = addD(mon, i + 1);
        events.push({
          start: icsDate(d.getFullYear(),d.getMonth()+1,d.getDate(),17),
          end: icsDate(next.getFullYear(),next.getMonth()+1,next.getDate(),7),
          summary: `Night Call${bkLabel} — ${surgeonName}`,
          desc: `${SHIFT_LABELS[sk]} 5:00 PM – 7:00 AM${bkLabel}`
        });
      }
    });

    // Weekend (Fri night + Sunday)
    if (wk.nights?.wknd === surgeonId) {
      // Fri 5p - Sat 7a
      const fri = addD(mon, 4);
      const sat = addD(mon, 5);
      events.push({
        start: icsDate(fri.getFullYear(),fri.getMonth()+1,fri.getDate(),17),
        end: icsDate(sat.getFullYear(),sat.getMonth()+1,sat.getDate(),7),
        summary: `Weekend Call (Fri Night)${bkLabel} — ${surgeonName}`,
        desc: `Friday 5:00 PM – Saturday 7:00 AM${bkLabel}`
      });
      // Sun 7a - Mon 7a
      const sunD = addD(mon, 6);
      const nextMon = addD(mon, 7);
      events.push({
        start: icsDate(sunD.getFullYear(),sunD.getMonth()+1,sunD.getDate(),7),
        end: icsDate(nextMon.getFullYear(),nextMon.getMonth()+1,nextMon.getDate(),7),
        summary: `Weekend Call (Sunday 24h)${bkLabel} — ${surgeonName}`,
        desc: `Sunday 7:00 AM – Monday 7:00 AM${bkLabel}`
      });
    }
  });

  // APP shifts (only if surgeonId is null = export all, or for APP-specific export)
  if (!surgeonId) {
    Object.entries(appShifts).forEach(([ds, aid]) => {
      const d = parse(ds);
      const next = addD(d, 1);
      const appName = aMap?.[aid]?.name || aid;
      const dow = d.getDay(); // 0=Sun, 6=Sat
      const isWeekend = dow === 0 || dow === 6;
      const startHour = isWeekend ? 7 : 17;
      const timeLabel = isWeekend ? "7:00 AM – 7:00 AM" : "5:00 PM – 7:00 AM";
      events.push({
        start: icsDate(d.getFullYear(),d.getMonth()+1,d.getDate(),startHour),
        end: icsDate(next.getFullYear(),next.getMonth()+1,next.getDate(),7),
        summary: `APP Call — ${appName}`,
        desc: `APP Call ${timeLabel}`
      });
    });
  }

  return events;
}

function generateICS(events, calName) {
  const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2,9)}@callsched`;
  let ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//DSG Call Schedule//EN\r\nCALSCALE:GREGORIAN\r\nX-WR-CALNAME:${calName}\r\n`;
  events.forEach(e => {
    ics += `BEGIN:VEVENT\r\nUID:${uid()}\r\nDTSTART:${e.start}\r\nDTEND:${e.end}\r\nSUMMARY:${e.summary}\r\nDESCRIPTION:${e.desc}\r\nEND:VEVENT\r\n`;
  });
  ics += `END:VCALENDAR\r\n`;
  return ics;
}

function downloadICS(content, filename) {
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
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
    @media print {
      body { background: white; padding: 0; }
      .toolbar { display: none; }
      .page { margin: 0 auto; box-shadow: none; page-break-after: always; }
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
  <span class="hint">Use your browser's print dialog. Choose "Letter" portrait, margins: default.</span>
</div>
${pages}
</body>
</html>`;
}
