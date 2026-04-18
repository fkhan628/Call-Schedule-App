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
