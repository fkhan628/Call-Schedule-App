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
    } catch(e) {}
  },

  // Clear session
  _clearSession() {
    try {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem(AUTH_REFRESH_KEY);
    } catch(e) {}
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
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) {
      // Token expired — try refresh
      if (res.status === 401 && session.refresh_token) {
        const refreshed = await auth._refresh(session.refresh_token);
        if (refreshed?.user) return refreshed;
      }
      auth._clearSession();
      return { user: null };
    }
    const user = await res.json();
    return { user };
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
      } catch(e) {}
    }
    auth._clearSession();
  },

  // Send password reset email
  // Passes redirect_to so Supabase's email link bounces the user back to the
  // hosted app (where the URL hash carries the recovery access_token that the
  // app detects on load and uses to switch into "newpassword" mode).
  // NOTE: For this to work, the redirect URL must also be added to the
  // Supabase dashboard's "Redirect URLs" allow-list under
  // Authentication → URL Configuration. Without that, Supabase silently
  // strips the redirect parameter and uses the Site URL default.
  async resetPassword(email) {
    const redirectUrl = window.location.origin + window.location.pathname;
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
    const res = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?select=*`, { headers: dbHeaders });
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
  async isAvailable() {
    try {
      if (!window.PublicKeyCredential) return false;
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch(e) { return false; }
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
    } catch(e) {}
  },
};
