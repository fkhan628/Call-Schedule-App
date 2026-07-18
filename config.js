// DSG Call Schedule — Configuration & Constants
// This file contains Supabase config, DB helpers, surgeon data, and shift constants.

/* ═══════════════════════════════════════════════════
   SUPABASE CONFIG
   ═══════════════════════════════════════════════════ */
const SUPABASE_URL = "https://xqongyahdnkozqunpwmu.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhxb25neWFoZG5rb3pxdW5wd211Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3Nzg2NDksImV4cCI6MjA5MTM1NDY0OX0.a2p_twcuDAfI_ju-oGzut_NCPNzKjBEbkhVsMGXYyww";

// Lightweight Supabase REST client (no SDK dependency needed)
const dbHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, "Content-Type": "application/json" };

// Session-aware headers: returns headers with the logged-in user's JWT when a
// session is stored in localStorage, else falls back to anon-key headers.
// This is what every authenticated query MUST use so RLS sees the real user.
function dbAuthHeaders() {
  try {
    const token = localStorage.getItem("dsg-auth-token");
    if (token) return { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  } catch(e) { console.warn("dbAuthHeaders: session read failed, using anon:", e); }
  return dbHeaders;
}

// The `supabase` wrapper is DELIBERATELY MINIMAL — it implements ONLY the two
// chains the app actually uses:
//   • supabase.from(t).select(cols).eq(col,val).single()  → { data, error }
//       .single() returns the FIRST row or null and never errors on zero rows
//       (maybeSingle semantics) — there is NO .maybeSingle(); use .single().
//   • supabase.from(t).upsert(row)                         → { error }
// For insert/update/delete/order/limit/multiple-filters use db.* (below),
// dbAuth.*, or a raw fetch (see the time_off deletes in index-source.html).
// Any unsupported method throws a clear "not implemented" error. Previously an
// absent method threw a bare "x is not a function" TypeError, which callers'
// catch blocks swallowed — that silence masked a broken delete and a dead
// .maybeSingle() call in the signup path.
const _notImpl = (sig, hint) => () => {
  throw new Error(`supabase wrapper: ${sig} is not implemented — ${hint || "use db.*, dbAuth.*, or a raw fetch."}`);
};
const supabase = {
  from: (table) => ({
    select: (cols) => ({
      eq: (col, val) => ({
        single: async () => {
          const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${cols}&${col}=eq.${val}`, { headers: dbAuthHeaders() });
          const rows = await res.json();
          return { data: rows?.[0] || null, error: rows?.error || null };
        },
        maybeSingle: _notImpl(".eq().maybeSingle()", "use .single(), which already has maybeSingle semantics (first row or null, no error on zero rows)."),
        order: _notImpl(".eq().order()"),
        limit: _notImpl(".eq().limit()"),
        eq: _notImpl("chained .eq().eq()"),
      }),
      single: _notImpl(".select().single() without .eq()"),
      maybeSingle: _notImpl(".select().maybeSingle()"),
      order: _notImpl(".select().order()"),
      limit: _notImpl(".select().limit()"),
      in: _notImpl(".select().in()"),
    }),
    upsert: async (row) => {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: "POST", headers: { ...dbAuthHeaders(), Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(row),
      });
      return { error: res.ok ? null : await res.text() };
    },
    insert: _notImpl("from().insert()", "use db.insert()."),
    update: _notImpl("from().update()", "use db.update()."),
    delete: _notImpl("from().delete()", "use a raw fetch (see the time_off deletes in index-source.html)."),
    eq: _notImpl("from().eq() without .select()"),
  }),
};

// Extended DB helpers for new tables
const db = {
  async query(table, { eq, order, limit, select } = {}) {
    let url = `${SUPABASE_URL}/rest/v1/${table}?select=${select || "*"}`;
    if (eq) Object.entries(eq).forEach(([k, v]) => { url += `&${k}=eq.${v}`; });
    if (order) url += `&order=${order}`;
    if (limit) url += `&limit=${limit}`;
    const res = await fetch(url, { headers: dbAuthHeaders() });
    // HTTP failure THROWS, exactly like a network failure already does — a
    // failed read must never be indistinguishable from an empty table. (An
    // RLS-filtered read is HTTP 200 + [] — that's data, not an error, and
    // still returns [].) Every call site already try/catches (the network
    // path has exercised those catches for years); on failure they now keep
    // prior state instead of adopting a wrongly-empty []. The old silent-[]
    // contract let a failed time_off read wipe the vacations state and
    // poison the blob mirror (the 2026-07-18 office-digest incident).
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`db.query(${table}) failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    return await res.json();
  },
  async insert(table, row) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST", headers: { ...dbAuthHeaders(), Prefer: "return=representation" },
      body: JSON.stringify(row),
    });
    const data = await res.json();
    // On failure, return data:null (NOT the PostgREST error body) so callers'
    // `if (data)` success-guards can't mis-fire on the error object — that
    // false-success masked the RLS-blocked notifications insert. `error` still
    // carries the failure detail for callers that check it.
    return { data: res.ok ? (Array.isArray(data) ? data[0] : data) : null, error: res.ok ? null : data };
  },
  async update(table, id, data) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
      method: "PATCH", headers: { ...dbAuthHeaders(), Prefer: "return=representation" },
      body: JSON.stringify(data),
    });
    return { error: res.ok ? null : await res.text() };
  },
  async upsert(table, row) {
    return supabase.from(table).upsert(row);
  },
};

/* ═══════════════════════════════════════════════════
   DATA-LOSS SAFEGUARDS
   ═══════════════════════════════════════════════════
   Context: the May/June 2026 wipe happened because LOAD is permissive
   (only adopts fields that are present) while AUTOSAVE is unconditional
   (always writes the full blob from current state). Any transiently-empty
   state therefore decays the DB one-way. These helpers let the component
   refuse empty-over-real writes and keep recoverable snapshots. */

// A payload "looks wiped" when it carries NONE of the operational data that is
// expensive to recreate: no schedule weeks, no vacations, no APP shifts.
// This deliberately ignores historical count config and the surgeon/APP roster
// (which default to INIT_* and are therefore always "present"). It is true for
// the literal {} blob that the old Reset button wrote, but FALSE for a normal
// clearSchedule (which keeps vacations/appShifts) — so legitimate clears still
// save.
function payloadLooksWiped(p) {
  if (!p || typeof p !== "object") return true;
  const noSchedule = !p.schedule || Object.keys(p.schedule).length === 0;
  const noVac      = !p.vacations || Object.keys(p.vacations).length === 0;
  const noApp      = !p.appShifts || Object.keys(p.appShifts).length === 0;
  return noSchedule && noVac && noApp;
}

// Snapshot helper. Before any destructive write, copy the row that is CURRENTLY
// persisted (not local state) into call_schedule_snapshots so it can always be
// restored by hand. Best-effort: never throws — a snapshot failure must not
// block the user, but it is surfaced to the console.
const snapshots = {
  async capture(reason) {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/call_schedule_data?id=eq.main&select=data,updated_at`,
        { headers: dbAuthHeaders() }
      );
      const rows = res.ok ? await res.json() : [];
      let current = rows?.[0]?.data ?? null;
      // The schedule now lives in the schedule_weeks table, not the blob, so
      // fold it back in here — otherwise the snapshot would have no schedule and
      // couldn't restore one. Best-effort: if this fetch fails we still snapshot
      // whatever the blob has.
      try {
        const wres = await fetch(
          `${SUPABASE_URL}/rest/v1/schedule_weeks?select=week_monday,data&order=week_monday.asc`,
          { headers: dbAuthHeaders() }
        );
        if (wres.ok) {
          const wrows = await wres.json();
          if (Array.isArray(wrows) && wrows.length) {
            const sched = {};
            wrows.forEach(r => { sched[r.week_monday] = r.data; });
            current = { ...(current || {}), schedule: sched };
          }
        }
      } catch (e) { console.warn("Snapshot: schedule_weeks fetch failed:", e); }
      // Don't bother snapshotting an already-empty row.
      if (current && !payloadLooksWiped(current)) {
        const ins = await fetch(`${SUPABASE_URL}/rest/v1/call_schedule_snapshots`, {
          method: "POST",
          headers: { ...dbAuthHeaders(), Prefer: "return=minimal" },
          body: JSON.stringify({
            reason: reason || "manual",
            data: current,
            source_updated_at: rows?.[0]?.updated_at ?? null,
          }),
        });
        return { ok: ins.ok };
      }
      return { ok: true, skipped: "empty_or_missing" };
    } catch (e) {
      console.warn("Snapshot capture failed:", e);
      return { ok: false, error: String(e) };
    }
  },
  async list(limit) {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/call_schedule_snapshots?select=id,reason,source_updated_at,created_at&order=created_at.desc&limit=${limit || 25}`,
        { headers: dbAuthHeaders() }
      );
      return res.ok ? await res.json() : [];
    } catch (e) { return []; }
  },
  // Periodic safety net: capture at most once per maxAgeHours (default 6), so
  // corruption that never passes through a destructive button still has a
  // recent restore point without flooding the table.
  async captureIfStale(reason, maxAgeHours) {
    try {
      const hours = maxAgeHours || 6;
      const recent = await this.list(1);
      const newest = recent?.[0]?.created_at ? new Date(recent[0].created_at).getTime() : 0;
      if (Date.now() - newest < hours * 3600 * 1000) return { ok: true, skipped: "fresh" };
      return await this.capture(reason || "periodic");
    } catch (e) { return { ok: false, error: String(e) }; }
  },
  // Restore a snapshot: roster/config back into the call_schedule_data blob,
  // schedule back into schedule_weeks. The schedule leg MUST go through the
  // app's own sync (syncSchedWeeks: per-week compare-and-swap + wipe guard),
  // which lives in the component — the caller passes it in as applySchedule.
  // A restore is itself destructive, so the CURRENT state is snapshotted
  // first and the restore aborts if that capture fails.
  async restore(snapshotId, applySchedule) {
    if (!snapshotId) return { ok: false, error: "No snapshot id" };
    if (typeof applySchedule !== "function") {
      return { ok: false, error: "restore() requires the app's schedule applier (the CAS sync path) — refusing to bypass it" };
    }
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/call_schedule_snapshots?id=eq.${encodeURIComponent(snapshotId)}&select=id,reason,created_at,data`,
        { headers: dbAuthHeaders() }
      );
      if (!res.ok) return { ok: false, error: `Snapshot fetch failed (${res.status})` };
      const rows = await res.json();
      const snap = rows?.[0];
      const payload = snap && (typeof snap.data === "string" ? JSON.parse(snap.data) : snap.data);
      if (!payload) return { ok: false, error: "Snapshot not found or has no data" };
      if (payloadLooksWiped(payload)) return { ok: false, error: "Snapshot looks empty — refusing to restore it" };
      const pre = await this.capture("before_restore");
      if (!pre.ok) return { ok: false, error: "Couldn't snapshot the current state first — restore aborted, nothing changed" };
      const schedule = payload.schedule || {};
      const blob = { ...payload }; delete blob.schedule;
      const ts = new Date().toISOString();
      const up = await db.upsert("call_schedule_data", { id: "main", data: blob, updated_at: ts });
      if (up && up.error) return { ok: false, error: "Config write failed: " + up.error };
      const applied = await applySchedule(schedule);
      if (applied && applied.ok === false) {
        return { ok: false, error: applied.error || "Schedule apply failed", blobRestored: true };
      }
      return { ok: true, blob, schedule, ts, reason: snap.reason, created_at: snap.created_at };
    } catch (e) {
      console.warn("Snapshot restore failed:", e);
      return { ok: false, error: String(e) };
    }
  },
};

/* ═══════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════ */
const NIGHT_KEYS = ["mon","tue","wed","thu"];
const ALL_SHIFT_KEYS = ["dayCall","mon","tue","wed","thu","wknd"];
const SHIFT_LABELS = { dayCall:"Service Week (incl. Sat)", mon:"Mon Night", tue:"Tue Night", wed:"Wed Night", thu:"Thu Night", wknd:"Weekend" };
const SHIFT_TIMES = { dayCall:"M–F 7a–5p + Sat 7a–Sun 7a", mon:"Mon 5p–7a", tue:"Tue 5p–7a", wed:"Wed 5p–7a", thu:"Thu 5p–7a", wknd:"Fri 5p–Sat 7a & Sun 7a–Mon 7a" };
const SHIFT_ICONS = { dayCall:"🏥", mon:"🌙", tue:"🌙", wed:"🌙", thu:"🌙", wknd:"🌗" };
const DAY_HDR = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MO = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const PAL = [
  { tx:"#0e6fa8", bd:"#a8d4f0", tg:"#e8f4fc" },
  { tx:"#a8306a", bd:"#e8a0c8", tg:"#fce8f4" },
  { tx:"#1a8040", bd:"#a0d8b0", tg:"#e8fce8" },
  { tx:"#8a7010", bd:"#e0d090", tg:"#faf4e0" },
  { tx:"#6030a8", bd:"#c0a8e8", tg:"#f0e8fc" },
  { tx:"#2868a8", bd:"#a0c8e8", tg:"#e8f0fc" },
  { tx:"#a85820", bd:"#e8c0a0", tg:"#fcf0e8" },
];

// Name-pinned surgeon colors — each surgeon has consistent colors across
// the entire app regardless of their position in the surgeons[] array.
// Muted palette chosen for visual harmony; tx is the primary accent color
// (labels, chips), bd is the border, tg is the soft background fill.
const SURGEON_COLOR_BY_NAME = {
  "DJA": { tx:"#8a6a10", bd:"#e0c870", tg:"#fcf3d0" }, // warm mustard yellow
  "MCC": { tx:"#7a5a40", bd:"#c8ac8c", tg:"#f0e4d4" }, // warm taupe / clay
  "RPC": { tx:"#3a7048", bd:"#a8c8a8", tg:"#e4f0e0" }, // sage green
  "KJH": { tx:"#a04878", bd:"#e0a8c4", tg:"#fce0ec" }, // dusty rose pink
  "REH": { tx:"#2a3040", bd:"#707888", tg:"#d8dce4" }, // deep charcoal (reads as black)
  "FAK": { tx:"#2c5888", bd:"#9cb8d4", tg:"#dde8f4" }, // slate blue
  "ARW": { tx:"#b06050", bd:"#e8b0a0", tg:"#fcdcd0" }, // soft coral
};

// Helper: look up colors for a surgeon by name, falling back to the indexed
// PAL palette if the name isn't in the pinned map (e.g. future surgeons).
function surgeonColors(name, idx) {
  if (name && SURGEON_COLOR_BY_NAME[name]) return SURGEON_COLOR_BY_NAME[name];
  return PAL[(idx || 0) % 7];
}

// APP palette — warm tones to distinguish from surgeon colors
const APP_PAL = [
  { tx:"#985020", bd:"#e0b890", tg:"#faf0e4" },
  { tx:"#883868", bd:"#d8a0c0", tg:"#f8e8f0" },
  { tx:"#487020", bd:"#b8d898", tg:"#f0f8e8" },
  { tx:"#306080", bd:"#a0c8d8", tg:"#e8f4f8" },
  { tx:"#5a4a90", bd:"#bcb0e0", tg:"#eeeafa" },
];

const INIT_SURGEONS = [
  { id:"s1", name:"DJA" }, { id:"s2", name:"MCC" }, { id:"s3", name:"RPC" },
  { id:"s4", name:"KJH" }, { id:"s5", name:"REH" }, { id:"s6", name:"FAK" },
  { id:"s7", name:"ARW" },
];

// Department membership — used by the calendar filter to quickly show
// only surgeons from a specific center. Name-based so it survives re-ordering.
// A surgeon can be in multiple departments.
const SURGEON_DEPTS = {
  "DJA": ["CWM", "CBH"],
  "MCC": ["CWM"],
  "RPC": ["CBH"],
  "KJH": ["CWM"],
  "REH": [],
  "FAK": ["CBH"],
  "ARW": ["CBH"],
};

// Department display labels (for dropdown)
const DEPT_LABELS = {
  "CWM": "CWM (Weight Mgmt)",
  "CBH": "CBH (Breast Health)",
};

const INIT_APPS = [
  { id:"a1", name:"MA" }, { id:"a2", name:"SJ" }, { id:"a3", name:"MS" }, { id:"a4", name:"SS" },
  { id:"a5", name:"JH" },
];

/* ═══ Verified Call Counts from Shift Distribution Spreadsheets ═══
   Regular vs backup split derived from 1st/2nd call ratios in monthly totals.
   totalDays/totalDaysB = actual call day counts from main sheets (used for pay). */

// 2025 only (1-Year)
const COUNTS_1YR = {
  s1: { dc:7, nights:49, wknd:7, off:0, dcB:1, nightsB:5, wkndB:1, offB:0, totalDays:100, totalDaysB:10 },  // DJA
  s2: { dc:6, nights:45, wknd:7, off:0, dcB:1, nightsB:6, wkndB:1, offB:0, totalDays:89,  totalDaysB:12 },  // MCC
  s3: { dc:7, nights:47, wknd:6, off:0, dcB:1, nightsB:6, wkndB:1, offB:0, totalDays:97,  totalDaysB:13 },  // RPC
  s4: { dc:6, nights:37, wknd:8, off:0, dcB:1, nightsB:6, wkndB:1, offB:0, totalDays:78,  totalDaysB:12 },  // KJH
  s5: { dc:7, nights:40, wknd:6, off:0, dcB:1, nightsB:8, wkndB:1, offB:0, totalDays:80,  totalDaysB:15 },  // REH
  s6: { dc:5, nights:45, wknd:5, off:0, dcB:2, nightsB:14, wkndB:2, offB:0, totalDays:89,  totalDaysB:27 },  // FAK
  s7: { dc:6, nights:50, wknd:6, off:0, dcB:1, nightsB:4, wkndB:0, offB:0, totalDays:99,  totalDaysB:8 },   // ARW
};

// Multi-Year totals — August 2022 through April 2026 (45 months of historical data)
// Extracted from Calendar Creator PDF via coordinate-based parser, verified against source.
// KJH normalized to peer average (of DJA/MCC/RPC/REH/FAK) to neutralize the
// effect of his 6-week surgical absence. Raw values were dc:27, nights:141,
// wknd:27 — adjusted up to peer-mean so the generator doesn't "catch him up"
// by over-loading future weeks for non-voluntary time off.
// ARW lower due to joining September 2023 (partial tenure — intentional, not
// adjusted because the generator balances per-week load going forward).
// Generator uses burden = dc*7 + nights + wknd*3 for fairness balancing.
const COUNTS_2YR = {
  s1: { dc:30, nights:149, wknd:32, off:0, dcB:0, nightsB:0, wkndB:0, offB:0, totalDays:394, totalDaysB:0 },  // DJA
  s2: { dc:28, nights:147, wknd:27, off:0, dcB:0, nightsB:0, wkndB:0, offB:0, totalDays:367, totalDaysB:0 },  // MCC
  s3: { dc:28, nights:147, wknd:28, off:0, dcB:0, nightsB:0, wkndB:0, offB:0, totalDays:369, totalDaysB:0 },  // RPC
  s4: { dc:29, nights:147, wknd:29, off:0, dcB:0, nightsB:0, wkndB:0, offB:0, totalDays:381, totalDaysB:0 },  // KJH (normalized — see note)
  s5: { dc:29, nights:146, wknd:29, off:0, dcB:0, nightsB:0, wkndB:0, offB:0, totalDays:379, totalDaysB:0 },  // REH
  s6: { dc:29, nights:148, wknd:30, off:0, dcB:0, nightsB:0, wkndB:0, offB:0, totalDays:381, totalDaysB:0 },  // FAK
  s7: { dc:19, nights:80,  wknd:19, off:0, dcB:0, nightsB:0, wkndB:0, offB:0, totalDays:234, totalDaysB:0 },  // ARW (joined Sept 2023)
};

/* ═══ 2026–2027 Vacation & Fierce Schedule ═══
   Parsed from Calendar Creator screenshots.
   Merged on first load; edit in app to adjust dates. */
const MAY_AUG_VACATIONS = {
  "s1": [["2026-05-01","2026-05-04"],["2026-05-14","2026-05-17"]], // DJA
  "s2": [["2026-05-08","2026-05-20"],["2026-06-27","2026-07-07"],["2026-08-07","2026-08-16"],["2026-08-24","2026-08-30"]], // MCC
  "s3": [["2026-05-18","2026-05-18"],["2026-06-13","2026-06-21"],["2026-07-30","2026-08-16"],["2026-10-21","2026-10-28"],["2026-12-25","2027-01-03"]], // RPC
  "s4": [["2026-05-27","2026-05-27"],["2026-06-24","2026-06-28"],["2026-08-07","2026-08-09"]], // KJH — Aug 7 is no-call (working, not on call)
  "s5": [["2026-05-15","2026-05-17"],["2026-05-23","2026-05-25"],["2026-05-29","2026-05-31"],["2026-06-05","2026-06-07"],["2026-07-10","2026-07-12"],["2026-07-24","2026-07-26"],["2026-08-13","2026-08-13"],["2026-09-18","2026-09-20"]], // REH
  "s6": [["2026-05-07","2026-05-10"],["2026-05-22","2026-05-23"],["2026-05-27","2026-06-14"],["2026-06-27","2026-06-28"]], // FAK
  "s7": [["2026-05-01","2026-05-03"],["2026-05-21","2026-05-27"],["2026-06-05","2026-06-09"],["2026-07-03","2026-07-05"],["2026-07-14","2026-07-15"]], // ARW
  "a1": [["2026-05-01","2026-05-03"],["2026-05-21","2026-05-21"],["2026-05-29","2026-05-29"],["2026-06-16","2026-06-19"],["2026-06-22","2026-06-22"]], // MA
  "a2": [["2026-05-15","2026-05-15"],["2026-05-18","2026-05-18"],["2026-05-27","2026-05-28"],["2026-06-01","2026-06-01"],["2026-06-19","2026-06-19"],["2026-07-06","2026-07-06"],["2026-07-27","2026-08-02"],["2026-11-20","2026-11-20"]], // SJ
  "a3": [["2026-05-27","2026-05-28"],["2026-12-28","2027-01-04"]], // MS
  "a4": [["2026-05-19","2026-05-20"],["2026-06-29","2026-07-03"],["2026-07-06","2026-07-10"],["2026-07-21","2026-07-24"],["2026-07-31","2026-08-01"],["2026-08-28","2026-08-30"],["2026-09-09","2026-09-13"],["2026-09-15","2026-09-15"],["2026-11-27","2026-12-03"]], // SS
};
const MAY_AUG_FIERCE_PRIMARY = ["2026-05-25","2026-07-20","2026-09-14","2026-11-09"];
const MAY_AUG_FIERCE_BACKUP = ["2026-05-04","2026-06-22","2026-08-17","2026-10-12","2026-12-07"];

/* ═══ May–August 2026 Hand-Built Schedule ═══
   Parsed from Calendar Creator PDFs uploaded by Faraz.
   Surgeon IDs: s1=DJA, s2=MCC, s3=RPC, s4=KJH, s5=REH, s6=FAK, s7=ARW
   Format: { "YYYY-MM-DD" (Monday): { dayCall, nights:{mon,tue,wed,thu,wknd}, off, isBackup, isFierceBackup, holidayCoverage } } */
const HAND_SCHEDULE_MAY_AUG = {
  "2026-05-04": { dayCall:"s5", nights:{mon:"s7",tue:"s2",wed:"s1",thu:"s4",wknd:"s3"}, off:"s6", isBackup:false, isFierceBackup:true },
  "2026-05-11": { dayCall:"s6", nights:{mon:"s7",tue:"s1",wed:"s5",thu:"s3",wknd:"s7"}, off:"s4", isBackup:false, isFierceBackup:false },
  "2026-05-18": { dayCall:"s1", nights:{mon:"s4",tue:"s3",wed:"s6",thu:"s5",wknd:"s2"}, off:"s7", isBackup:false, isFierceBackup:false },
  // May 25: Memorial Day. DJA covers Mon 24h (holiday), MCC covers Sun eve. RPC is Service Week starting Tue.
  "2026-05-25": { dayCall:"s3", nights:{mon:null,tue:"s5",wed:"s2",thu:"s7",wknd:"s4"}, off:"s6", isBackup:true, isFierceBackup:false,
                  holidayCoverage:{
                    "2026-05-24":{surgeonId:"s2",role:"holiday_24h",hours:"7a–7a",name:"Memorial Day Eve",type:"minor"},
                    "2026-05-25":{surgeonId:"s1",role:"holiday_24h",hours:"7a–7a",name:"Memorial Day",type:"minor"}
                  }},
  "2026-06-01": { dayCall:"s2", nights:{mon:"s1",tue:"s7",wed:"s4",thu:"s3",wknd:"s1"}, off:"s5", isBackup:false, isFierceBackup:false },
  "2026-06-08": { dayCall:"s4", nights:{mon:"s5",tue:"s2",wed:"s1",thu:"s7",wknd:"s5"}, off:"s6", isBackup:false, isFierceBackup:false },
  "2026-06-15": { dayCall:"s7", nights:{mon:"s6",tue:"s2",wed:"s4",thu:"s5",wknd:"s6"}, off:"s1", isBackup:false, isFierceBackup:false },
  "2026-06-22": { dayCall:"s1", nights:{mon:"s3",tue:"s2",wed:"s6",thu:"s7",wknd:"s3"}, off:"s4", isBackup:false, isFierceBackup:true },
  "2026-06-29": { dayCall:"s5", nights:{mon:"s6",tue:"s4",wed:"s3",thu:"s1",wknd:"s6"}, off:"s7", isBackup:false, isFierceBackup:false },
  "2026-07-06": { dayCall:"s3", nights:{mon:"s7",tue:"s5",wed:"s2",thu:"s6",wknd:"s4"}, off:"s1", isBackup:false, isFierceBackup:false },
  "2026-07-13": { dayCall:"s2", nights:{mon:"s5",tue:"s6",wed:"s3",thu:"s4",wknd:"s5"}, off:"s1", isBackup:false, isFierceBackup:false },
  "2026-07-20": { dayCall:"s4", nights:{mon:"s3",tue:"s2",wed:"s6",thu:"s1",wknd:"s7"}, off:"s5", isBackup:true, isFierceBackup:false },
  "2026-07-27": { dayCall:"s6", nights:{mon:"s3",tue:"s4",wed:"s7",thu:"s5",wknd:"s2"}, off:"s1", isBackup:false, isFierceBackup:false },
  "2026-08-03": { dayCall:"s7", nights:{mon:"s1",tue:"s4",wed:"s2",thu:"s6",wknd:"s1"}, off:"s3", isBackup:false, isFierceBackup:false },
};

/* ═══ Scheduling Period Settings ═══
   SCHEDULE_PERIOD_WEEKS — informational; documents the typical period length.
     Each period spans Sunday-to-Sunday (14 weeks = 98 days). The Mondays stored
     in the `schedule` object are the Mondays within that span — so the latest
     Monday is the start of the FINAL week of the current period, and the next
     period begins one week later (latest Monday + 7 days).
   VACATION_DEADLINE_WEEKS_BEFORE — vacation requests are due this many weeks
     before the next schedule period starts. */
const SCHEDULE_PERIOD_WEEKS = 14;
const VACATION_DEADLINE_WEEKS_BEFORE = 6;

/* ═══ 2026 Holiday Assignments (pre-set from handwritten schedule) ═══
   First surgeon = covers the actual holiday day (24h)
   Second surgeon = covers night before (and day after where applicable)
   Format: { "HolidayName": ["surgeonA_id", "surgeonB_id"] } */
const HOLIDAY_PRESETS = {
  "2026": {
    "Memorial Day":    ["s1", "s2"],  // DJA | MCC
    "July 4th":        ["s6", "s5"],  // FAK | REH
    "Labor Day":       ["s3", "s7"],  // RPC | ARW
    "Thanksgiving":    ["s2", "s3"],  // MCC | RPC
    "Christmas Day":   ["s6", "s4"],  // FAK | KJH
    "New Year's":      ["s5", "s1"],  // REH | DJA
  }
};



/* ═══════════════════════════════════════════════════
   SUPABASE AUTH HELPERS
   ═══════════════════════════════════════════════════ */
const AUTH_TOKEN_KEY = "dsg-auth-token";
const AUTH_REFRESH_KEY = "dsg-auth-refresh";

const auth = {
  // Get stored session
  getSession() {
    try {
      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      const refresh = localStorage.getItem(AUTH_REFRESH_KEY);
      return token ? { access_token: token, refresh_token: refresh } : null;
    } catch(e) { return null; }
  },

  // Store session
  _saveSession(data) {
    try {
      if (data?.access_token) {
        localStorage.setItem(AUTH_TOKEN_KEY, data.access_token);
        if (data.refresh_token) localStorage.setItem(AUTH_REFRESH_KEY, data.refresh_token);
      }
    } catch(e) { console.warn("Couldn't store session (you may be signed out on reload):", e); }
  },

  // Clear session
  _clearSession() {
    try {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem(AUTH_REFRESH_KEY);
    } catch(e) { console.warn("Couldn't clear stored session:", e); }
  },

  // Sign up with email & password
  async signUp(email, password) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) return { user: null, error: data.msg || data.error_description || data.message || "Sign up failed" };
    if (data.access_token) auth._saveSession(data);
    return { user: data.user || data, session: data, error: null };
  },

  // Sign in with email & password
  async signIn(email, password) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) return { user: null, error: data.msg || data.error_description || data.message || "Sign in failed" };
    auth._saveSession(data);
    return { user: data.user, session: data, error: null };
  },

  // Get current user from token
  async getUser() {
    const session = auth.getSession();
    if (!session) return { user: null };
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const user = await res.json();
        return { user };
      }
      // Token rejected. GoTrue may answer 401 OR 403 depending on version/
      // config — attempt a refresh on ANY auth failure when we hold a refresh
      // token, not only on 401. (This project returns 403, which the old
      // 401-only check skipped, silently logging users out on every refresh.)
      if (session.refresh_token) {
        const refreshed = await auth._refresh(session.refresh_token);
        if (refreshed?.user) return refreshed;
      }
      // Refresh wasn't possible or genuinely failed — token is dead.
      auth._clearSession();
      return { user: null };
    } catch (e) {
      // Network error (offline, transient blip). Do NOT clear the session —
      // the token may still be valid. Report no user for now; the next
      // attempt can recover without forcing a fresh login.
      return { user: null, error: "network" };
    }
  },

  // Refresh token
  async _refresh(refreshToken) {
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) { auth._clearSession(); return { user: null }; }
      const data = await res.json();
      auth._saveSession(data);
      return { user: data.user, session: data };
    } catch(e) { auth._clearSession(); return { user: null }; }
  },

  // Sign out
  async signOut() {
    const session = auth.getSession();
    if (session?.access_token) {
      try {
        await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
          method: "POST",
          headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
        });
      } catch(e) { console.warn("Server-side logout failed (session cleared locally anyway):", e); }
    }
    auth._clearSession();
  },

  // Send password reset email
  // The redirect URL is HARDCODED (not built from window.location) because:
  //   1. PWA shortcuts and bookmarks may point to inconsistent paths
  //   2. Some browsers/webviews strip the path segment under redirect
  //   3. Hardcoding ensures reset links always land at the hosted app regardless
  // The hosted app's useEffect detects #type=recovery in the URL hash and
  // switches into "newpassword" mode automatically.
  // NOTE: This URL must ALSO appear in the Supabase dashboard's "Redirect URLs"
  // allow-list (Authentication → URL Configuration). If the allow-list entry
  // doesn't match exactly (including trailing slash), Supabase silently strips
  // redirect_to and falls back to the Site URL default.
  async resetPassword(email) {
    const redirectUrl = "https://fkhan628.github.io/Call-Schedule-App/";
    const url = `${SUPABASE_URL}/auth/v1/recover?redirect_to=${encodeURIComponent(redirectUrl)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        redirect_to: redirectUrl,
        gotrue_meta_security: { captcha_token: "" }
      }),
    });
    if (!res.ok) {
      const data = await res.json();
      return { error: data.msg || data.error_description || data.message || "Reset failed" };
    }
    return { error: null };
  },

  // Update password (after clicking reset link — user has a valid session)
  async updatePassword(newPassword) {
    const session = auth.getSession();
    if (!session?.access_token) return { error: "No active session" };
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ password: newPassword }),
    });
    if (!res.ok) {
      const data = await res.json();
      return { error: data.msg || data.error_description || data.message || "Update failed" };
    }
    return { error: null };
  },

  // Get auth headers for DB queries (user-level RLS)
  getAuthHeaders() {
    const session = auth.getSession();
    if (!session) return dbHeaders;
    return { ...dbHeaders, Authorization: `Bearer ${session.access_token}` };
  },
};

// DB helper that uses auth token for user_profiles table
const dbAuth = {
  async getProfile(userId) {
    const hdrs = auth.getAuthHeaders();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${userId}&select=*`, { headers: hdrs });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0] || null;
  },
  async upsertProfile(profile) {
    const hdrs = auth.getAuthHeaders();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
      method: "POST",
      headers: { ...hdrs, Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(profile),
    });
    if (!res.ok) return { error: await res.text() };
    const data = await res.json();
    return { data: data?.[0] || data, error: null };
  },
  async getAllProfiles() {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?select=*`, { headers: dbAuthHeaders() });
    if (!res.ok) return [];
    return await res.json();
  },
};

/* ═══════════════════════════════════════════════════
   BIOMETRIC AUTH (WebAuthn / Face ID / Touch ID)
   ═══════════════════════════════════════════════════ */
const BIOMETRIC_CRED_KEY = "dsg-biometric-cred";
const BIOMETRIC_USER_KEY = "dsg-biometric-user";

const biometric = {
  // Check if WebAuthn platform authenticator is available (Face ID, Touch ID, fingerprint)
  // Returns { available: bool, reason: string } for diagnostics.
  async isAvailable() {
    try {
      if (!window.PublicKeyCredential) {
        return { available: false, reason: "WebAuthn API not present (PublicKeyCredential is undefined). Likely a non-Safari browser or an in-app webview." };
      }
      if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== "function") {
        return { available: false, reason: "isUserVerifyingPlatformAuthenticatorAvailable is not a function on this browser." };
      }
      const result = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      if (result) {
        return { available: true, reason: "Platform authenticator detected." };
      }
      return { available: false, reason: "API returned false: no platform authenticator (Face ID / Touch ID) reported as available. On fresh PWA installs this sometimes resolves after a device restart, or by enrolling directly via the Try Anyway button below." };
    } catch(e) {
      return { available: false, reason: `API threw: ${e.name || "Error"} — ${e.message || "(no message)"}` };
    }
  },

  // Check if biometric is already enrolled
  isEnrolled() {
    try { return !!localStorage.getItem(BIOMETRIC_CRED_KEY); } catch(e) { return false; }
  },

  // Get stored user email for biometric
  getStoredUser() {
    try { return localStorage.getItem(BIOMETRIC_USER_KEY) || null; } catch(e) { return null; }
  },

  // Register biometric credential (call after successful email/password login)
  async enroll(userId, userEmail) {
    try {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const userIdBytes = new TextEncoder().encode(userId.slice(0, 32));

      const credential = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: "DSG Call Schedule", id: window.location.hostname },
          user: { id: userIdBytes, name: userEmail, displayName: userEmail.split("@")[0] },
          pubKeyCredParams: [
            { alg: -7, type: "public-key" },   // ES256
            { alg: -257, type: "public-key" },  // RS256
          ],
          authenticatorSelection: {
            authenticatorAttachment: "platform",  // built-in biometric only
            userVerification: "required",         // require Face ID / Touch ID
            residentKey: "preferred",
          },
          timeout: 60000,
        }
      });

      if (credential) {
        // Store credential ID for future authentication
        const credIdArray = Array.from(new Uint8Array(credential.rawId));
        localStorage.setItem(BIOMETRIC_CRED_KEY, JSON.stringify(credIdArray));
        localStorage.setItem(BIOMETRIC_USER_KEY, userEmail);
        return { success: true };
      }
      return { success: false, error: "No credential created" };
    } catch(e) {
      return { success: false, error: e.name === "NotAllowedError" ? "Biometric enrollment was cancelled" : e.message };
    }
  },

  // Authenticate with biometric (call on app open)
  async authenticate() {
    try {
      const credIdJson = localStorage.getItem(BIOMETRIC_CRED_KEY);
      if (!credIdJson) return { success: false, error: "No biometric enrolled" };

      const credIdArray = JSON.parse(credIdJson);
      const credId = new Uint8Array(credIdArray).buffer;
      const challenge = crypto.getRandomValues(new Uint8Array(32));

      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: [{ id: credId, type: "public-key", transports: ["internal"] }],
          userVerification: "required",
          timeout: 60000,
        }
      });

      return assertion ? { success: true } : { success: false, error: "Authentication failed" };
    } catch(e) {
      return { success: false, error: e.name === "NotAllowedError" ? "Biometric authentication was cancelled" : e.message };
    }
  },

  // Remove biometric enrollment
  unenroll() {
    try {
      localStorage.removeItem(BIOMETRIC_CRED_KEY);
      localStorage.removeItem(BIOMETRIC_USER_KEY);
    } catch(e) { console.warn("Couldn't remove biometric enrollment keys:", e); }
  },
};
