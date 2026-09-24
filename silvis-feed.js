// DSG Call Schedule — Silvis (trauma) feed, READ-ONLY on the client.
//
// FAK is also primary trauma call at Silvis (a separate app + Supabase
// project). The Silvis app already reads THIS project's schedule_weeks and
// refuses him Silvis primary on his Davenport call days (its east-feed.js).
// This module is the MIRROR: it reads this project's public.silvis_feed cache
// — one row per Silvis day { day, primary_code, backup_code, fetched_at },
// written ONLY by the silvis-feed edge function (service role) from the
// Silvis project's public schedule_days + roster — and derives, for rule
// silvisBusy:
//   - FAK's Silvis PRIMARY days  → HARD: no Davenport call may overlap
//                                   07:00 D → 07:00 D+1
//   - FAK's Silvis BACKUP days   → soft note only (backup is standby; the
//                                   Silvis side treats Davenport backup the
//                                   same way)
// A Silvis day is one 24-hour shift, 07:00 D → 07:00 D+1. Codes, never ids:
// Silvis ids are their own s1..s6 namespace (FAK is s1 there, s6 here).
//
// Loaded in the browser as a classic script (config → helpers → generator →
// app-styles → silvis-feed), so every top-level name here is prefixed sf/SF
// and must not collide with helpers.js / config.js (fmt, parse, addD, MO …).
// The pure functions are also require()-able from Node (test/sync-guards.js).
//
// CONTRACT (same sentence as the Silvis east-feed.js): a FAILED fetch must
// never look like "no Silvis call". sfLoadFeed throws on any non-2xx or
// non-array body; sfRefreshFeed throws on any non-2xx; callers keep their
// cached rows and WARN. Nothing here writes to silvis_feed (RLS: no client
// write policy — proven live 2026-09-24: anon POST → 42501).

// ---- private date helpers (local-time, same convention as helpers.js) ----
function sfPad2(n) { return (n < 10 ? "0" : "") + n; }
function sfFmt(d) { return d.getFullYear() + "-" + sfPad2(d.getMonth() + 1) + "-" + sfPad2(d.getDate()); }
function sfParse(s) { const p = String(s).split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function sfAddD(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
function sfIsDateStr(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }

// ---- the rule as DATA (same shape as the app's other rule flags) ----
// Stored in the config blob as `silvisRule`; missing → these defaults. The
// generator, editor, trade-accept and swap paths all read it through
// sfRuleActive(). `code` is the Silvis roster CODE the rule watches.
// The Davenport id is NOT stored here: the app resolves `code` against its
// roster at runtime (the generator's own idiom — the Davenport code IS the
// roster name), so a roster edit can never strand a stale id in the blob.
const SF_RULE_DEFAULT = { enabled: true, code: "FAK" };
// Tolerates a malformed blob value: a non-object is ignored (defaults), and
// enabled:"false" / 0 / "0" / "off" all read as OFF — a stringly-typed flag
// must never keep a hard rule silently ON; code is always a trimmed string.
function sfRule(blobRule) {
  const src = (blobRule && typeof blobRule === "object" && !Array.isArray(blobRule)) ? blobRule : {};
  const r = Object.assign({}, SF_RULE_DEFAULT, src);
  const e = r.enabled;
  r.enabled = !(e === false || e === 0 || e === "0" || (typeof e === "string" && /^(false|off|no)$/i.test(e.trim())));
  r.code = typeof r.code === "string" ? r.code.trim() : "";
  return r;
}
function sfRuleActive(blobRule) { const r = sfRule(blobRule); return r.enabled !== false && !!r.code; }

// ---- derive day sets from cache rows ----
// sfDaysFromRows(rows, code) -> { primary:Set<'YYYY-MM-DD'>, backup:Set, fetchedAt:string|null, from, to }
//   from/to: the first and last cached day (the feed's coverage horizon) — a
//   period generated beyond `to` has NO Silvis data, and the app must say so.
//   rows: silvis_feed rows [{ day, primary_code, backup_code, fetched_at }]
//   Codes compare case-insensitively. Malformed rows are ignored.
function sfDaysFromRows(rows, code) {
  const want = String(code || "").toUpperCase();
  const primary = new Set(), backup = new Set();
  let fetchedAt = null, from = null, to = null;
  (rows || []).forEach(r => {
    if (!r || !sfIsDateStr(r.day)) return;
    if (!from || r.day < from) from = r.day;
    if (!to || r.day > to) to = r.day;
    if (want && String(r.primary_code || "").toUpperCase() === want) primary.add(r.day);
    if (want && String(r.backup_code || "").toUpperCase() === want) backup.add(r.day);
    if (r.fetched_at && (!fetchedAt || r.fetched_at > fetchedAt)) fetchedAt = r.fetched_at;
  });
  return { primary, backup, fetchedAt, from, to };
}

// sfBusyRanges(daySet) -> [[D, D], ...] sorted — the shape the generator's
// availability map already uses for vacations/no-call ([start,end] pairs).
// Folding FAK's Silvis primary days in as single-day ranges gives EXACTLY
// the 07:00→07:00 overlap semantics with zero generator change, because the
// generator already tests: service week = days 0..5 of the week; a weeknight
// = its own day; the weekend = Fri + Sun (+ next-Mon vacation-only trailing
// edge); holiday pre-assignment = the surgeon's availability on that day.
// A no-call day and a Silvis primary day share the same trailing-edge rule:
// the night BEFORE D (ends 07:00 D) does not overlap; the night OF D does.
function sfBusyRanges(daySet) {
  return Array.from(daySet || []).filter(sfIsDateStr).sort().map(d => [d, d]);
}

// ---- the per-slot overlap check (editor / trade-accept / swap refusal) ----
// sfSlotDays(mondayStr, slotKey) -> ['YYYY-MM-DD', ...]: the calendar days a
// Davenport slot's on-call window touches, i.e. the days D whose Silvis
// 07:00 D → 07:00 D+1 shift would overlap it. The exact INVERSE of the
// Silvis side's deriveKhanBusyDays (east-feed.js):
//   dayCall  → Mon..Sat (Mon-Fri 7a-5p + Sat 7a-Sun 7a)
//   mon..thu → that weekday (5p → 7a next day: overlaps D only)
//   wknd     → Fri (Fri 5p-Sat 7a) and Sun (Sun 7a-Mon 7a) — NOT Saturday
//   "dc" (lock UI legacy key) → same as dayCall
// Holiday 24h coverage is a per-DATE assignment and is checked by the caller
// with the date itself (sfConflictDay(set, [date])).
const SF_SLOT_OFFSETS = { dayCall: [0, 1, 2, 3, 4, 5], dc: [0, 1, 2, 3, 4, 5], mon: [0], tue: [1], wed: [2], thu: [3], wknd: [4, 6] };
function sfSlotDays(mondayStr, slotKey) {
  if (!sfIsDateStr(mondayStr)) return [];
  const offs = SF_SLOT_OFFSETS[slotKey];
  if (!offs) return [];
  const m = sfParse(mondayStr);
  return offs.map(o => sfFmt(sfAddD(m, o)));
}
// sfHeldDays(wk, mondayStr, slotKey, id) -> the days of sfSlotDays that the
// holder `id` would ACTUALLY be on call for in week row `wk` (may be
// undefined): minus any day whose holiday 24h coverage is held by someone
// else, and — for the service week — minus any Service Day overridden to
// someone else. The ONE precedence rule (holiday > override > slot) shared by
// sfOverlaps (the Warnings net) and every per-path refusal, so a refusal can
// never fire where the net would show nothing (and vice versa).
function sfHeldDays(wk, mondayStr, slotKey, id) {
  const days = sfSlotDays(mondayStr, slotKey);
  if (!wk) return days;
  const hc = wk.holidayCoverage || {}, ov = wk.dayCallOverrides || {};
  const heldByOther = (ds) => { const c = hc[ds]; return !!(c && c.surgeonId && id && c.surgeonId !== id); };
  const dc = slotKey === "dayCall" || slotKey === "dc";
  return days.filter(ds => !heldByOther(ds) && !(dc && ov[ds] != null && ov[ds] !== "" && ov[ds] !== id));
}
// sfConflictDay(primarySet, days) -> the first day in `days` that is a Silvis
// primary day, or null.
function sfConflictDay(primarySet, days) {
  if (!primarySet || !primarySet.size) return null;
  for (const d of days || []) if (primarySet.has(d)) return d;
  return null;
}
// sfConflict(primarySet, mondayStr, slotKey) -> conflicting day | null
function sfConflict(primarySet, mondayStr, slotKey) {
  return sfConflictDay(primarySet, sfSlotDays(mondayStr, slotKey));
}
// sfBackupNote(backupSet, mondayStr, slotKey) -> first Silvis BACKUP day the
// slot touches, or null. Soft: informational only, never blocks.
function sfBackupNote(backupSet, mondayStr, slotKey) {
  return sfConflictDay(backupSet, sfSlotDays(mondayStr, slotKey));
}

// sfOverlaps(schedule, primarySet, davenportId) -> [{ day, mondayStr, slot, label }]
//   Every EXISTING overlap in a published schedule (for the Schedule Warnings
//   list): each (week, slot) FAK holds whose window touches a Silvis primary
//   day. Honors dayCallOverrides (an override of a service day to someone
//   else removes that day; an override TO FAK adds it) and holidayCoverage
//   (a holiday held by someone else on D means D is theirs, not FAK's; one
//   held by FAK is an overlap on D). Precedence: holiday > override > dayCall.
function sfOverlaps(schedule, primarySet, davenportId) {
  const out = [];
  if (!primarySet || !primarySet.size || !davenportId) return out;
  Object.keys(schedule || {}).sort().forEach(mStr => {
    const wk = schedule[mStr];
    if (!wk || !sfIsDateStr(mStr)) return;
    const n = wk.nights || {}, ov = wk.dayCallOverrides || {}, hc = wk.holidayCoverage || {};
    const heldByOther = (ds) => { const c = hc[ds]; return !!(c && c.surgeonId && c.surgeonId !== davenportId); };
    const push = (ds, slot, label) => { if (primarySet.has(ds)) out.push({ day: ds, mondayStr: mStr, slot, label }); };
    // service week: the days he EFFECTIVELY holds — dayCall minus days
    // overridden away, plus days overridden TO him — minus holidays held by
    // someone else (same precedence as sfHeldDays; overrides TO him are the
    // one case sfHeldDays cannot express, hence the explicit walk here)
    sfSlotDays(mStr, "dayCall").forEach(ds => {
      if (heldByOther(ds)) return;
      const overridden = ov[ds] != null && ov[ds] !== "";
      if (overridden ? ov[ds] === davenportId : wk.dayCall === davenportId) push(ds, "dayCall", "service");
    });
    ["mon", "tue", "wed", "thu"].forEach(k => { if (n[k] === davenportId) sfHeldDays(wk, mStr, k, davenportId).forEach(ds => push(ds, k, "night")); });
    if (n.wknd === davenportId) sfHeldDays(wk, mStr, "wknd", davenportId).forEach(ds => push(ds, "wknd", "weekend"));
    Object.keys(hc).forEach(ds => { if (hc[ds] && hc[ds].surgeonId === davenportId && sfIsDateStr(ds)) push(ds, "holiday", "holiday 24h"); });
  });
  return out;
}

// sfStatus(fetchedAt, nowMs) -> { fetchedAt, ageHours, stale }
//   stale = older than 36h (the feed refreshes on every app load; a day and a
//   half without one means nobody has opened the app, or every refresh
//   failed — either way, say so).
const SF_STALE_HOURS = 36;
function sfStatus(fetchedAt, nowMs) {
  if (!fetchedAt) return { fetchedAt: null, ageHours: null, stale: true };
  const age = ((nowMs || Date.now()) - Date.parse(fetchedAt)) / 36e5;
  if (!Number.isFinite(age)) return { fetchedAt, ageHours: null, stale: true }; // an unreadable timestamp fails toward STALE, never fresh
  return { fetchedAt, ageHours: Math.round(age * 10) / 10, stale: age > SF_STALE_HOURS };
}

// ---- browser I/O (this project only; the Silvis project is never touched
//      from the client — the edge function does that with its own read) ----
// sfLoadFeed(supabaseUrl, headers) -> rows. Throws on non-2xx / non-array.
async function sfLoadFeed(supabaseUrl, headers) {
  const f = (typeof globalThis !== "undefined" && globalThis.fetch) ? globalThis.fetch : null;
  if (!f) throw new Error("silvis-feed: fetch is not available in this runtime");
  const res = await f(supabaseUrl + "/rest/v1/silvis_feed?select=day,primary_code,backup_code,fetched_at&order=day.asc", { headers });
  if (!res.ok) throw new Error("silvis-feed: load failed: HTTP " + res.status);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error("silvis-feed: load returned a non-array body");
  return rows;
}
// sfRefreshFeed(supabaseUrl, authHeaders, force) -> the function's JSON.
// Throws on non-2xx (401 = not signed in; 502 = Silvis fetch failed, cache
// untouched). Without `force` the function answers { ok, skipped:true } from
// a cache younger than 15 min (idempotent across 7 users on app load); the
// Refresh button passes force=true (header x-force-refresh: 1) so a person
// asking for a re-pull always gets one.
async function sfRefreshFeed(supabaseUrl, authHeaders, force) {
  const f = (typeof globalThis !== "undefined" && globalThis.fetch) ? globalThis.fetch : null;
  if (!f) throw new Error("silvis-feed: fetch is not available in this runtime");
  const headers = force ? Object.assign({}, authHeaders, { "x-force-refresh": "1" }) : authHeaders;
  const res = await f(supabaseUrl + "/functions/v1/silvis-feed", { method: "POST", headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("silvis-feed: refresh failed: HTTP " + res.status + (body && body.error ? " — " + body.error : ""));
  return body;
}

// Node export for the harness; a no-op in the browser (classic script).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { SF_RULE_DEFAULT, sfRule, sfRuleActive, sfDaysFromRows, sfBusyRanges, sfSlotDays, sfHeldDays, sfConflictDay, sfConflict, sfBackupNote, sfOverlaps, sfStatus, sfLoadFeed, sfRefreshFeed, SF_STALE_HOURS };
}
