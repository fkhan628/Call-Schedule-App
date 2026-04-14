// DSG Call Schedule — Configuration & Constants
// This file contains Supabase config, DB helpers, surgeon data, and shift constants.

/* ═══════════════════════════════════════════════════
   SUPABASE CONFIG
   ═══════════════════════════════════════════════════ */
const SUPABASE_URL = "https://xqongyahdnkozqunpwmu.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhxb25neWFoZG5rb3pxdW5wd211Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3Nzg2NDksImV4cCI6MjA5MTM1NDY0OX0.a2p_twcuDAfI_ju-oGzut_NCPNzKjBEbkhVsMGXYyww";

// Lightweight Supabase REST client (no SDK dependency needed)
const dbHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, "Content-Type": "application/json" };
const supabase = {
  from: (table) => ({
    select: (cols) => ({
      eq: (col, val) => ({
        single: async () => {
          const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${cols}&${col}=eq.${val}`, { headers: dbHeaders });
          const rows = await res.json();
          return { data: rows?.[0] || null, error: rows?.error || null };
        }
      })
    }),
    upsert: async (row) => {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: "POST", headers: { ...dbHeaders, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(row),
      });
      return { error: res.ok ? null : await res.text() };
    },
  }),
};

// Extended DB helpers for new tables
const db = {
  async query(table, { eq, order, limit, select } = {}) {
    let url = `${SUPABASE_URL}/rest/v1/${table}?select=${select || "*"}`;
    if (eq) Object.entries(eq).forEach(([k, v]) => { url += `&${k}=eq.${v}`; });
    if (order) url += `&order=${order}`;
    if (limit) url += `&limit=${limit}`;
    const res = await fetch(url, { headers: dbHeaders });
    return res.ok ? await res.json() : [];
  },
  async insert(table, row) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST", headers: { ...dbHeaders, Prefer: "return=representation" },
      body: JSON.stringify(row),
    });
    const data = await res.json();
    return { data: Array.isArray(data) ? data[0] : data, error: res.ok ? null : data };
  },
  async update(table, id, data) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
      method: "PATCH", headers: { ...dbHeaders, Prefer: "return=representation" },
      body: JSON.stringify(data),
    });
    return { error: res.ok ? null : await res.text() };
  },
  async upsert(table, row) {
    return supabase.from(table).upsert(row);
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

// APP palette — warm tones to distinguish from surgeon colors
const APP_PAL = [
  { tx:"#985020", bd:"#e0b890", tg:"#faf0e4" },
  { tx:"#883868", bd:"#d8a0c0", tg:"#f8e8f0" },
  { tx:"#487020", bd:"#b8d898", tg:"#f0f8e8" },
  { tx:"#306080", bd:"#a0c8d8", tg:"#e8f4f8" },
];

const INIT_SURGEONS = [
  { id:"s1", name:"DJA" }, { id:"s2", name:"MCC" }, { id:"s3", name:"RPC" },
  { id:"s4", name:"KJH" }, { id:"s5", name:"REH" }, { id:"s6", name:"FAK" },
  { id:"s7", name:"ARW" },
];

const INIT_APPS = [
  { id:"a1", name:"MA" }, { id:"a2", name:"SJ" }, { id:"a3", name:"MS" }, { id:"a4", name:"SS" },
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

// 2024 + 2025 combined (2-Year / Multi-Year)
const COUNTS_2YR = {
  s1: { dc:14, nights:96,  wknd:13, off:0, dcB:2, nightsB:10, wkndB:2, offB:0, totalDays:197, totalDaysB:21 },  // DJA
  s2: { dc:13, nights:90,  wknd:15, off:0, dcB:2, nightsB:15, wkndB:2, offB:0, totalDays:183, totalDaysB:30 },  // MCC
  s3: { dc:13, nights:100, wknd:12, off:0, dcB:2, nightsB:10, wkndB:2, offB:0, totalDays:196, totalDaysB:21 },  // RPC
  s4: { dc:12, nights:75,  wknd:12, off:0, dcB:3, nightsB:19, wkndB:3, offB:0, totalDays:156, totalDaysB:39 },  // KJH
  s5: { dc:13, nights:90,  wknd:15, off:0, dcB:2, nightsB:19, wkndB:3, offB:0, totalDays:180, totalDaysB:36 },  // REH
  s6: { dc:12, nights:91,  wknd:13, off:0, dcB:2, nightsB:17, wkndB:2, offB:0, totalDays:184, totalDaysB:33 },  // FAK
  s7: { dc:11, nights:78,  wknd:10, off:0, dcB:2, nightsB:13, wkndB:1, offB:0, totalDays:159, totalDaysB:26 },  // ARW
};

/* ═══ May–August 2026 Vacation & Fierce Schedule ═══
   Parsed from Calendar Creator screenshots uploaded 2026-04-12.
   Merged on first load; edit in app to adjust dates. */
const MAY_AUG_VACATIONS = {
  "s1": [["2026-05-01","2026-05-04"],["2026-05-14","2026-05-17"]], // DJA
  "s2": [["2026-05-08","2026-05-20"],["2026-06-27","2026-07-07"],["2026-08-07","2026-08-16"],["2026-08-24","2026-08-30"]], // MCC
  "s3": [["2026-05-18","2026-05-18"],["2026-06-13","2026-06-21"],["2026-07-30","2026-08-16"]], // RPC
  "s4": [["2026-05-27","2026-05-27"],["2026-06-24","2026-06-28"],["2026-08-06","2026-08-06"],["2026-08-07","2026-08-09"]], // KJH
  "s5": [["2026-05-15","2026-05-17"],["2026-05-23","2026-05-25"],["2026-05-29","2026-05-31"],["2026-06-05","2026-06-07"],["2026-07-10","2026-07-12"],["2026-07-24","2026-07-26"],["2026-08-13","2026-08-13"]], // REH
  "s6": [["2026-05-07","2026-05-10"],["2026-05-22","2026-05-23"],["2026-05-27","2026-06-14"],["2026-06-27","2026-06-28"]], // FAK
  "s7": [["2026-05-01","2026-05-03"],["2026-05-21","2026-05-27"],["2026-06-05","2026-06-09"],["2026-07-03","2026-07-05"],["2026-07-14","2026-07-15"]], // ARW
  "a1": [["2026-05-01","2026-05-03"],["2026-05-21","2026-05-21"],["2026-05-29","2026-05-29"],["2026-06-16","2026-06-19"],["2026-06-22","2026-06-22"]], // MA
  "a2": [["2026-05-15","2026-05-15"],["2026-05-18","2026-05-18"],["2026-05-27","2026-05-28"],["2026-06-01","2026-06-01"],["2026-06-19","2026-06-19"],["2026-07-06","2026-07-06"],["2026-07-27","2026-08-02"]], // SJ
  "a3": [["2026-05-27","2026-05-28"]], // MS
  "a4": [["2026-05-19","2026-05-20"],["2026-06-29","2026-07-03"],["2026-07-06","2026-07-10"],["2026-07-21","2026-07-24"],["2026-07-31","2026-08-01"],["2026-08-28","2026-08-30"]], // SS
};
const MAY_AUG_FIERCE_PRIMARY = ["2026-05-25","2026-07-20"];
const MAY_AUG_FIERCE_BACKUP = ["2026-05-04","2026-06-22","2026-08-17"];

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
