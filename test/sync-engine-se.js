// SE. Sync engine v2 — the REAL createSchedSync, extracted from
// index-source.html by its anchors, driven against an emulated PostgREST
// schedule_weeks table (test/fake-weeks-table.js: versioned rows, jsonb key
// reordering, RLS that hides rows from anon writes, failure injection before
// AND after commit, thrown requests, pausable requests, expired tokens).
//
// Each scenario cites the requirement it pins: R1–R37 are the confirmed
// findings of the three reviews of #68/#69 (private docs/sync-v2/MAP), I1–I6
// the design's invariants. Called from test/sync-guards.js (CI runs that
// file); also runnable alone:  node test/sync-engine-se.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createFakeWeeksTable } = require("./fake-weeks-table.js");

const BASE = "https://x.supabase.co";
const W = ["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07", "2026-12-14"];
// Generator-shaped week (generator.js builds keys in this order; jsonb hands
// them back reordered).
const wk = (dc, extra) => Object.assign({ dayCall: dc, nights: { mon: "s2", tue: "s3", wed: "s4", thu: "s5", wknd: "s6" }, off: "s7", isBackup: false, isFierceBackup: false, holidayCoverage: {} }, extra || {});
const clone = (x) => JSON.parse(JSON.stringify(x));

function extractEngine(src) {
  const nsrc = src.replace(/\r\n/g, "\n");
  const START = "function createSchedSync(deps) {";
  const END = "// ═══ END SYNC ENGINE v2 ═══";
  const s = nsrc.indexOf(START), e = nsrc.indexOf(END);
  if (s === -1 || e === -1 || nsrc.indexOf(START, s + 1) !== -1) return null;
  return nsrc.slice(s, e);
}

module.exports = async function runSE({ src, check }) {
  console.log("\nSE. sync engine v2 (the real createSchedSync on an emulated schedule_weeks)");
  const engSrc = extractEngine(src);
  check("SE0 createSchedSync is extractable by its anchors (exactly one definition)", !!engSrc);
  if (!engSrc) return;
  const compile = (code) => vm.runInContext(`${code}; createSchedSync`, vm.createContext({}), { filename: "createSchedSync.js" });
  let createSchedSync;
  try { createSchedSync = compile(engSrc); }
  catch (ex) { check("SE0 createSchedSync compiles standalone", false, String(ex)); return; }
  await scenarios(createSchedSync, check);

  // ── SE-M. Mutant battery ──
  // Each mutant re-breaks one thing the reviews found (or one guarantee); the
  // scenarios above must turn red for every one of them. A mutant whose anchor
  // is gone fails too, so a refactor can't quietly retire one.
  console.log("\nSE-M. mutant battery (each must turn at least one SE check red)");
  for (const m of MUTANTS) {
    const n = engSrc.split(m.from).length - 1;
    if (n !== 1) { check(`SE-M ${m.id} anchor present exactly once (${m.what})`, false, `found ${n}`); continue; }
    let red = 0, mutant;
    try { mutant = compile(engSrc.replace(m.from, m.to)); } catch (ex) { check(`SE-M ${m.id} compiles`, false, String(ex)); continue; }
    const quiet = (name, cond) => { if (!cond) red++; };
    const log = console.log; console.log = () => {};
    try { await scenarios(mutant, quiet); } finally { console.log = log; }
    check(`SE-M ${m.id} killed: ${m.what}`, red > 0, "every SE check still passes with this bug in place");
  }
};

const MUTANTS = [
  { id: "M1", what: "PATCH without the version filter (blind overwrite, R14/R28)",
    from: '? req(`${base()}?week_monday=eq.${k}&version=eq.${kn.version}`, { method: "PATCH", headers: wh({ Prefer: "return=representation" })',
    to: '? req(`${base()}?week_monday=eq.${k}`, { method: "PATCH", headers: wh({ Prefer: "return=representation" })' },
  { id: "M2", what: "no read-back: an unknown outcome is guessed as a conflict (R8, R12, R23, R24)",
    from: "      const res = await resolve(k, data);\n", to: "      const res = { conflict: null };\n" },
  { id: "M3", what: "plain JSON equality (jsonb key order reads as an edit)",
    from: "const canon = (x) => JSON.stringify(sortDeep(x === undefined ? null : x));", to: "const canon = (x) => JSON.stringify(x === undefined ? null : x);" },
  { id: "M4", what: "pull adopts over an unsaved local edit (R21)",
    from: "        if (dirty) return;", to: "        if (false) return;" },
  { id: "M5", what: "the wipe guard counts deletes that already passed it (R7, R9)",
    from: "const newDeletes = deletes.filter(k => !approvedDeletes.has(k));", to: "const newDeletes = deletes;" },
  { id: "M6", what: "reset() doesn't fence jobs in flight (sign-out boundary)",
    from: "reset() { gen++; ", to: "reset() { " },
  { id: "M7", what: "keepalive PATCH without CAS (R1)",
    from: '? { url: `${base()}?week_monday=eq.${k}&version=eq.${kn.version}`, init: { method: "PATCH", keepalive: true',
    to: '? { url: `${base()}?week_monday=eq.${k}`, init: { method: "PATCH", keepalive: true' },
  { id: "M8", what: "a push queued before a clear doesn't defer to it (R10 false wipe block)",
    from: 'if (job.mode !== "force" && authoritativeQueued > 0) return', to: 'if (false) return' },
  { id: "M9", what: "writes without a live token (anon / expired)",
    from: '    if (tok !== "ok") {', to: '    if (false) {' },
  { id: "M10", what: "a 401 is treated as a refusal (adopts the server copy, drops the edit)",
    from: 'r.status === 401 ? "auth" :', to: 'r.status === 401 ? "refused" :' },
  { id: "M11", what: "the change token ignores updated_at (R18)",
    from: " || known[x.week_monday].updated_at !== (x.updated_at || null)", to: "" },
  { id: "M12", what: "uncertain weeks are not re-read before writing",
    from: "    for (const k of [...uncertain]) {", to: "    for (const k of []) {" },
  { id: "M13", what: "pull adopts a wipe-shaped removal (R20)",
    from: "const wipeShaped = removed.length >= 4 &&", to: "const wipeShaped = false &&" },
  { id: "M14", what: "pull adopts the empty RLS/anon list (R20)",
    from: "    if (!list.length && Object.keys(known).length) {", to: "    if (false) {" },
  { id: "M15", what: "pushes don't coalesce (R3)",
    from: "      if (queuedPush) return queuedPush;\n", to: "" },
  { id: "M16", what: "the toast cap never expires (R36)",
    from: " || d.nowMs() - lastFail.at > 5 * 60 * 1000", to: "" },
  { id: "M17", what: "a new week is a merge-duplicates upsert (overwrites a row someone inserted)",
    from: ': req(base(), { method: "POST", headers: wh({ Prefer: "return=representation" })',
    to: ': req(base() + "?on_conflict=week_monday", { method: "POST", headers: wh({ Prefer: "resolution=merge-duplicates,return=representation" })' },
  { id: "M18", what: "clear/restore act on the last-known versions instead of re-reading the table (I6)",
    from: "    known = {}; rows.forEach(x => { known[x.week_monday] = fromRow(x); });\n    seeded = true; uncertain.clear();\n", to: "" },
  { id: "M19", what: "clear/restore write even when the table can't be read (I6 fail closed)",
    from: '    if (!rows) { report(); return { ok: false, error: "Couldn\'t read the saved schedule — nothing was changed." }; }\n    known = {};',
    to: '    if (!rows) return runPush({ target, grant, mode: "force" });\n    known = {};' },
  { id: "M20", what: "adoption rebuilds the whole schedule from the server copy (R15: reverts other unsaved edits)",
    from: "    const next = Object.assign({}, d.getState() || {});\n    keys.forEach(k => {",
    to: "    const next = Object.keys(known).reduce((o, k) => (o[k] = clone(known[k].data), o), {});\n    keys.forEach(k => {" },
];

async function scenarios(createSchedSync, check) {
  // ── fixtures ──
  let ms = Date.UTC(2026, 9, 12, 12, 0, 0);
  const clockIso = () => new Date(ms += 1000).toISOString();
  const mkTable = (rows) => createFakeWeeksTable({ baseUrl: BASE, anonKey: "ANON", users: { TOK_A: "user-a", TOK_B: "user-b", TOK_M: "member" }, rows: rows || [], clock: clockIso });
  const seedRows = (n, v) => W.slice(0, n).map((k, i) => ({ week_monday: k, data: wk("s" + (i % 6 + 1)), version: v || 3, updated_by: "user-a", updated_at: "2026-10-01T08:00:00.000Z" }));
  const mkSession = (table, o) => {
    o = o || {};
    const s = { mirror: {}, toasts: [], statuses: [], adopted: [], wipeBlocked: [], commits: 0,
      token: o.token === undefined ? "TOK_A" : o.token, tokenState: o.tokenState || "ok", canWrite: o.canWrite !== false, user: o.user || "user-a" };
    const hdr = (tok) => tok ? { apikey: "ANON", Authorization: "Bearer " + tok } : { apikey: "ANON", Authorization: "Bearer ANON" };
    s.engine = createSchedSync({
      getState: () => s.mirror,
      commit: (next) => { s.mirror = next; s.commits++; },
      fetch: (u, i) => table.fetch(u, i),
      url: BASE,
      writeHeaders: () => hdr(s.token),
      readHeaders: () => hdr(s.tokenState === "ok" ? s.token : null),
      canWrite: () => s.canWrite,
      tokenState: () => s.tokenState,
      userId: () => s.user,
      now: clockIso,
      nowMs: () => ms,
      onStatus: (st) => s.statuses.push(st),
      onToast: (m, k) => s.toasts.push(String(m)),
      onWipeBlocked: (i) => s.wipeBlocked.push(i),
      onAdopted: (keys) => s.adopted.push(keys),
      log: () => {},
    });
    s.edit = (k, fn) => { s.mirror = Object.assign({}, s.mirror, { [k]: fn(clone(s.mirror[k] || {})) }); };
    s.drop = (k) => { const n = Object.assign({}, s.mirror); delete n[k]; s.mirror = n; };
    s.st = () => s.engine.status();
    return s;
  };
  const writes = (t, from) => t.log.slice(from || 0).filter(e => e.method !== "GET");
  const sameData = (a, b) => JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
  const sortDeep = (x) => Array.isArray(x) ? x.map(sortDeep) : (x && typeof x === "object") ? Object.keys(x).sort().reduce((o, k) => (o[k] = sortDeep(x[k]), o), {}) : x;
  const tableSched = (t) => t.rows().reduce((o, r) => (o[r.week_monday] = r.data, o), {});
  // A scenario that never settles must FAIL, not end the process quietly
  // (Node exits 0 when nothing is left on the event loop).
  const run = async (name, fn) => {
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timed out after 10 s (a request never settled)")), 10000); });
    try { await Promise.race([fn(), timeout]); }
    catch (ex) { check(name + " (scenario crashed)", false, String(ex && ex.stack || ex).split("\n").slice(0, 3).join(" | ")); }
    finally { clearTimeout(timer); }
  };

  // SE1/SE2 — load seeds the mirror from the table; jsonb key order never reads as an edit.
  await run("SE1", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t);
    const r = await A.engine.load();
    check("SE1 load: the mirror equals the table, nothing pending, zero writes",
      r.ok && sameData(A.mirror, tableSched(t)) && A.st().pending === 0 && writes(t).length === 0, JSON.stringify({ r, st: A.st() }));
    // jsonb returned the generator-shaped keys reordered: a local copy built in
    // generator order must still compare equal (critic: jsonb key order).
    A.mirror = Object.assign({}, A.mirror, { [W[0]]: wk("s1") });
    check("SE2 jsonb key order: the same week in generator key order is NOT pending (canonical equality)",
      Object.keys(t.get(W[0]).data)[0] !== "dayCall" && A.engine.pending().length === 0, JSON.stringify(Object.keys(t.get(W[0]).data)));
    await A.engine.push();
    check("SE2 …and a push of it sends nothing", writes(t).length === 0);
  });

  // SE3–SE5 — the three write shapes (R30, R34): CAS PATCH, plain INSERT, CAS DELETE.
  await run("SE3", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t); await A.engine.load();
    A.edit(W[0], w => (w.dayCall = "s9", w));
    A.edit(W[5], () => wk("s4"));
    A.drop(W[2]);
    const from = t.log.length;
    const r = await A.engine.push();
    const ws = writes(t, from);
    const patch = ws.find(e => e.method === "PATCH"), post = ws.find(e => e.method === "POST"), del = ws.find(e => e.method === "DELETE");
    check("SE3 edit → PATCH ?week_monday=eq.K&version=eq.V, Prefer return=representation, body version V+1, updated_by set",
      !!patch && /week_monday=eq\.2026-10-12&version=eq\.3/.test(patch.url) && /return=representation/.test(patch.headers.prefer || "")
        && patch.body.version === 4 && patch.body.updated_by === "user-a" && t.get(W[0]).version === 4 && t.get(W[0]).data.dayCall === "s9",
      JSON.stringify(patch && { url: patch.url, prefer: patch.headers.prefer, body: patch.body }));
    check("SE4 new week → plain POST insert (no on_conflict, no merge-duplicates), version 1",
      !!post && !/on_conflict/.test(post.url) && !/merge-duplicates/.test(post.headers.prefer || "") && post.body.version === 1 && t.get(W[5]).version === 1,
      JSON.stringify(post && { url: post.url, prefer: post.headers.prefer }));
    check("SE5 removed week → DELETE ?week_monday=eq.K&version=eq.V with return=representation (R28: never an unversioned delete)",
      !!del && /week_monday=eq\.2026-10-26&version=eq\.3/.test(del.url) && /return=representation/.test(del.headers.prefer || "") && t.get(W[2]) === null,
      JSON.stringify(del && del.url));
    check("SE3 all three saved: ok, nothing pending, no toast", r.ok && A.st().pending === 0 && A.toasts.length === 0, JSON.stringify({ r: r.results, t: A.toasts }));
  });

  // SE6 — a 5xx before commit: read back, still pending, retried (R5, R26).
  await run("SE6", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "PATCH", week: W[0], kind: "5xx-before" });
    A.edit(W[0], w => (w.dayCall = "s9", w));
    const r1 = await A.engine.push();
    check("SE6 503 before commit → read back (row unchanged) → still pending, status says net, one toast",
      !r1.ok && A.st().pending === 1 && A.st().lastError === "net" && A.toasts.length === 1 && /retrying/.test(A.toasts[0]) && t.get(W[0]).data.dayCall !== "s9",
      JSON.stringify({ st: A.st(), toasts: A.toasts }));
    const r2 = await A.engine.push();
    check("SE6 …the next push lands it (no edit needed — the retry is the push itself)", r2.ok && t.get(W[0]).data.dayCall === "s9" && A.st().pending === 0);
  });

  // SE7 — a PATCH that commits but answers 5xx is SAVED (read-back), and the
  // baseline moves to the new version, so undoing back to the old week sends a write (R24).
  await run("SE7", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    const old = clone(A.mirror[W[0]]);
    t.control.fail({ method: "PATCH", week: W[0], kind: "5xx-after" });
    A.edit(W[0], w => (w.dayCall = "s9", w));
    const r = await A.engine.push();
    check("SE7 504 AFTER commit → read back finds our data → saved quietly (no toast, nothing pending)",
      r.ok && A.st().pending === 0 && A.toasts.length === 0 && t.get(W[0]).version === 4, JSON.stringify({ r: r.results, toasts: A.toasts }));
    A.mirror = Object.assign({}, A.mirror, { [W[0]]: old }); // undo
    const from = t.log.length;
    await A.engine.push();
    check("SE7 R24: undo back to the pre-edit week SENDS a PATCH at v4 and lands", writes(t, from).length === 1 && /version=eq\.4/.test(writes(t, from)[0].url) && t.get(W[0]).data.dayCall === old.dayCall);
  });

  // SE8 — an INSERT that commits but answers 5xx stays known, so a later clear deletes it (R23).
  await run("SE8", async () => {
    const t = mkTable(seedRows(1));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "POST", week: W[4], kind: "5xx-after" });
    A.edit(W[4], () => wk("s2"));
    const r = await A.engine.push();
    check("SE8 POST committed + 504 → saved (read-back), known at v1", r.ok && A.engine.knownVersion(W[4]) === 1, JSON.stringify(r.results));
    A.mirror = {};
    const c = await A.engine.authoritative({}, true);
    check("SE8 R23: the clear then deletes it too — no ghost week", c.ok && t.rows().length === 0, JSON.stringify(t.rows().map(x => x.week_monday)));
  });

  // SE9/SE10 — offline: a thrown write is read back; if the read-back throws
  // too the week is UNCERTAIN and is re-read before its next write (R29).
  await run("SE9", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ week: W[0], kind: "throw", count: 2 }); // the PATCH and its read-back
    A.edit(W[0], w => (w.dayCall = "s9", w));
    await A.engine.push();
    check("SE9 thrown write + thrown read-back → uncertain + pending, nothing written",
      A.st().uncertain === 1 && A.st().pending === 1 && t.get(W[0]).data.dayCall !== "s9", JSON.stringify(A.st()));
    const from = t.log.length;
    const r = await A.engine.push();
    const first = t.log[from];
    check("SE9 the next push RE-READS the uncertain week before writing it, then lands",
      r.ok && first && first.method === "GET" && /week_monday=eq\.2026-10-12/.test(first.url) && t.get(W[0]).data.dayCall === "s9" && A.st().uncertain === 0,
      JSON.stringify(t.log.slice(from).map(e => e.method + " " + e.url.split("?")[1])));
  });
  await run("SE10", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "PATCH", week: W[0], kind: "throw-after" });
    A.edit(W[0], w => (w.dayCall = "s9", w));
    const r = await A.engine.push();
    check("SE10 committed but the response was lost (thrown after commit) → read-back → saved",
      r.ok && A.st().pending === 0 && A.engine.knownVersion(W[0]) === 4 && A.toasts.length === 0, JSON.stringify(r.results));
  });

  // SE11 — a conflict adopts the server copy of THAT week only, with a toast
  // and an epoch bump; the session's other unsaved edits are untouched and
  // still save (R11, R12, R13, R15).
  await run("SE11", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    B.edit(W[0], w => (w.dayCall = "sB", w)); await B.engine.push();
    A.edit(W[0], w => (w.dayCall = "sA", w));
    A.edit(W[1], w => (w.dayCall = "sA2", w));
    const e0 = A.engine.epochOf(W[0]);
    const r = await A.engine.push();
    check("SE11 stale PATCH matches 0 rows → read-back shows B's week → conflict: A adopts B's W1, toast names the week",
      A.mirror[W[0]].dayCall === "sB" && t.get(W[0]).data.dayCall === "sB" && A.toasts.length === 1 && /changed by someone else/.test(A.toasts[0]) && A.engine.epochOf(W[0]) > e0,
      JSON.stringify({ mirror: A.mirror[W[0]].dayCall, toasts: A.toasts, results: r.results }));
    check("SE11 R13: ONLY that week was adopted — A's other edit (W2) saved, nothing else reloaded",
      t.get(W[1]).data.dayCall === "sA2" && A.mirror[W[1]].dayCall === "sA2" && A.adopted.length === 1 && A.adopted[0].join() === W[0] && A.st().pending === 0,
      JSON.stringify({ adopted: A.adopted, st: A.st() }));
  });

  // SE12 — 0 rows but the server already holds exactly our change (someone
  // made the same edit, or our own earlier write) → saved, no false conflict (R12).
  await run("SE12", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    B.edit(W[0], w => (w.dayCall = "same", w)); await B.engine.push();
    A.edit(W[0], w => (w.dayCall = "same", w));
    const r = await A.engine.push();
    check("SE12 the read-back finds our exact content → saved, no conflict toast, no adoption",
      r.ok && A.toasts.length === 0 && A.adopted.length === 0 && A.engine.knownVersion(W[0]) === 4, JSON.stringify({ r: r.results, toasts: A.toasts }));
  });

  // SE13 — pull adopts other people's changes only for weeks this session
  // hasn't edited; an edited week is left alone and settles by read-back (R21, R32).
  await run("SE13", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    B.edit(W[0], w => (w.dayCall = "sB0", w)); B.edit(W[1], w => (w.dayCall = "sB1", w)); await B.engine.push();
    A.edit(W[1], w => (w.dayCall = "sA1", w)); // A's unsaved edit of W2
    A.canWrite = false;                         // isolate the pull (no follow-up push)
    await A.engine.pull();
    check("SE13 pull adopts B's W1 (A hadn't touched it) and leaves A's unsaved W2 edit in place",
      A.mirror[W[0]].dayCall === "sB0" && A.mirror[W[1]].dayCall === "sA1" && A.adopted.length === 1 && A.adopted[0].join() === W[0],
      JSON.stringify({ w0: A.mirror[W[0]].dayCall, w1: A.mirror[W[1]].dayCall, adopted: A.adopted }));
    check("SE13 R21: the unsaved edit is still pending (never silently dropped)", A.engine.pending().join() === W[1]);
    A.canWrite = true;
    await A.engine.push();
    check("SE13 …and its push settles it LOUDLY as a conflict (B got there first)", A.mirror[W[1]].dayCall === "sB1" && A.toasts.some(m => /changed by someone else/.test(m)));
  });

  // SE14/SE15 — the change token is (version, updated_at): an old build's
  // blind upsert keeps the version, and delete + re-insert restarts at v1 (R18).
  await run("SE14", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    // An old client's keepalive: POST ?on_conflict=week_monday, merge-duplicates, no version in the body.
    await t.fetch(`${BASE}/rest/v1/schedule_weeks?on_conflict=week_monday`, { method: "POST", headers: { apikey: "ANON", Authorization: "Bearer TOK_B", "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ week_monday: W[0], data: wk("old-build"), updated_by: "user-b", updated_at: "2026-10-12T13:00:00.000Z" }]) });
    check("SE14 (fixture) the blind upsert kept version 3", t.get(W[0]).version === 3 && t.get(W[0]).data.dayCall === "old-build");
    await A.engine.pull();
    check("SE14 R18: pull notices the same-version change by updated_at and adopts it", A.mirror[W[0]].dayCall === "old-build", A.mirror[W[0]].dayCall);
    A.edit(W[0], w => (w.dayCall = "s9", w));
    const r = await A.engine.push();
    check("SE14 …and A's next CAS write still lands (known updated_at/version refreshed)", r.ok && t.get(W[0]).data.dayCall === "s9");
  });
  await run("SE15", async () => {
    const t = mkTable(seedRows(2, 1));
    const A = mkSession(t); await A.engine.load();
    t.del(W[0]); t.put({ week_monday: W[0], data: wk("reborn"), version: 1, updated_by: "user-b", updated_at: "2026-10-12T14:00:00+00:00" });
    await A.engine.pull();
    check("SE15 R18: a delete + re-insert at v1 (same version number) is still seen as a change", A.mirror[W[0]].dayCall === "reborn", A.mirror[W[0]].dayCall);
  });

  // SE16 — removals: adopted when the week wasn't edited here; a locally
  // edited week is kept; wipe-shaped and RLS-empty shapes are never adopted (R20).
  await run("SE16", async () => {
    const t = mkTable(seedRows(8));
    const A = mkSession(t); await A.engine.load();
    A.canWrite = false;
    t.del(W[0]);
    A.edit(W[1], w => (w.dayCall = "sA", w)); t.del(W[1]);
    await A.engine.pull();
    check("SE16 a week deleted elsewhere disappears here; a week A edited stays (A's edit wins locally)",
      !(W[0] in A.mirror) && A.mirror[W[1]].dayCall === "sA", JSON.stringify(Object.keys(A.mirror)));
    W.slice(2, 7).forEach(k => t.del(k)); // W8 stays: the list is not empty, just wipe-shaped
    await A.engine.pull();
    check("SE16 a wipe-shaped removal (6 of 7 known weeks gone, one left) is NOT adopted", t.rows().length === 1 && Object.keys(A.mirror).length === 7, JSON.stringify(Object.keys(A.mirror)));
    const t2 = mkTable(seedRows(3));
    const C = mkSession(t2); await C.engine.load(); C.canWrite = false;
    W.slice(0, 3).forEach(k => t2.del(k));
    const r = await C.engine.pull();
    check("SE16 R20: an EMPTY list while weeks are known (the anon/RLS shape) is ignored and flagged", r.suspicious === true && Object.keys(C.mirror).length === 3, JSON.stringify(r));
  });

  // SE17 — one job at a time: pushes requested during a slow push coalesce
  // into ONE follow-up that reads the latest mirror (R3, R14, R16).
  await run("SE17", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t); await A.engine.load();
    const hold = t.control.pause({ method: "PATCH", week: W[0], count: 1 });
    A.edit(W[0], w => (w.dayCall = "a1", w));
    const p1 = A.engine.push();
    await hold.arrived;
    A.edit(W[1], w => (w.dayCall = "a2", w));
    const p2 = A.engine.push(), p3 = A.engine.push();
    A.edit(W[2], w => (w.dayCall = "a3", w));
    const inFlight = t.log.filter(e => e.method === "PATCH" && e.status === null).length;
    hold.release();
    await Promise.all([p1, p2, p3]);
    const patches = t.log.filter(e => e.method === "PATCH");
    check("SE17 never two writes in flight; the two queued pushes are ONE run; it sends the LATEST mirror (W2 and W3)",
      inFlight === 1 && p2 === p3 && patches.length === 3 && t.get(W[1]).data.dayCall === "a2" && t.get(W[2]).data.dayCall === "a3" && A.st().pending === 0,
      JSON.stringify({ inFlight, same: p2 === p3, patches: patches.map(e => e.url.split("?")[1]) }));
  });

  // SE18 — a pull and a push never interleave: a pull requested during a
  // slow push runs after it, so a stale read can't land over a newer write (R17).
  await run("SE18", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    const hold = t.control.pause({ method: "GET", count: 1 }); // the pull's version list
    const pl = A.engine.pull();
    await hold.arrived;
    B.edit(W[0], w => (w.dayCall = "late", w)); await B.engine.push(); // lands while A's list is in flight
    A.edit(W[1], w => (w.dayCall = "a", w));
    const pu = A.engine.push();
    hold.release();
    await Promise.all([pl, pu]);
    await A.engine.pull();
    check("SE18 R17: the slow pull's old list didn't revert anything; the next pull picks up B's later write; A's push landed",
      A.mirror[W[0]].dayCall === "late" && t.get(W[1]).data.dayCall === "a" && A.st().pending === 0, JSON.stringify({ w0: A.mirror[W[0]].dayCall, st: A.st() }));
  });

  // SE19 — the wipe guard: an emptied mirror without a grant deletes NOTHING;
  // the authoritative clear (grant on the request) deletes everything (R10).
  await run("SE19", async () => {
    const t = mkTable(seedRows(6));
    const A = mkSession(t); await A.engine.load();
    A.mirror = {};
    const from = t.log.length;
    const r = await A.engine.push();
    check("SE19 empty mirror vs 6 known weeks, no grant → BLOCKED: zero DELETEs, one onWipeBlocked",
      r.blocked === true && writes(t, from).length === 0 && A.wipeBlocked.length === 1 && t.rows().length === 6, JSON.stringify(r));
    const most = mkSession(t); await most.engine.load();
    W.slice(0, 3).forEach(k => most.drop(k));
    const r2 = await most.engine.push();
    check("SE19 dropping half of the weeks (3 of 6) without a grant is blocked too (wipingMost)", r2.blocked === true && t.rows().length === 6);
    const c = await A.engine.authoritative({}, true);
    check("SE19 the authoritative clear deletes all 6, no wipe block, ok", c.ok && t.rows().length === 0 && A.wipeBlocked.length === 1, JSON.stringify(c));
  });

  // SE19b — R10: a push queued BEFORE a clear defers to it (no false "wipe blocked").
  await run("SE19b", async () => {
    const t = mkTable(seedRows(6));
    const A = mkSession(t); await A.engine.load();
    const hold = t.control.pause({ method: "PATCH", count: 1 });
    A.edit(W[0], w => (w.dayCall = "x", w));
    const p1 = A.engine.push(); await hold.arrived;
    A.edit(W[1], w => (w.dayCall = "y", w));
    const p2 = A.engine.push();          // queued behind p1
    A.mirror = {};                       // the user clears
    const c = A.engine.authoritative({}, true);
    hold.release();
    const [, r2, rc] = await Promise.all([p1, p2, c]);
    check("SE19b R10: the queued push defers to the queued clear — no false wipe block; the clear empties the table",
      A.wipeBlocked.length === 0 && r2.skipped === "authoritative-queued" && rc.ok && t.rows().length === 0, JSON.stringify({ r2, rc, blocked: A.wipeBlocked }));
  });

  // SE20 — an authorized clear whose DELETEs fail keeps them pending; later
  // ordinary pushes retry them WITHOUT a grant and without a wipe block (R7, R9).
  await run("SE20", async () => {
    const t = mkTable(seedRows(6));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "DELETE", week: W[0], kind: "5xx-before" });
    t.control.fail({ method: "DELETE", week: W[1], kind: "5xx-before" });
    A.mirror = {};
    const c = await A.engine.authoritative({}, true);
    check("SE20 the clear deleted 4, 2 failed and stay pending (not ok)", !c.ok && t.rows().length === 2 && A.engine.pending().length === 2, JSON.stringify(t.rows().map(r => r.week_monday)));
    const r = await A.engine.push();
    check("SE20 R7/R9: the plain retry deletes the last 2 with no grant and no wipe block", r.ok && t.rows().length === 0 && A.wipeBlocked.length === 0, JSON.stringify({ r, blocked: A.wipeBlocked }));
  });

  // SE21 — R8: a CAS DELETE of a row someone else already deleted is SAVED, not a conflict.
  await run("SE21", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t); await A.engine.load();
    t.del(W[0]);
    A.drop(W[0]);
    const r = await A.engine.push();
    check("SE21 R8: DELETE matches 0 rows, read-back says the week is gone → saved, no toast, nothing pending",
      r.ok && A.toasts.length === 0 && A.st().pending === 0, JSON.stringify({ r: r.results, toasts: A.toasts }));
  });

  // SE22 — R35: a shrinking restore (10 → 8 weeks) whose deletes fail never
  // turns into false wipe blocks on the following autosaves.
  await run("SE22", async () => {
    const t = mkTable(seedRows(10));
    const A = mkSession(t); await A.engine.load();
    const snap = clone(A.mirror); delete snap[W[8]]; delete snap[W[9]]; snap[W[0]] = wk("restored");
    t.control.fail({ method: "DELETE", kind: "5xx-before", count: 2 });
    A.mirror = clone(snap);
    const c = await A.engine.authoritative(snap, true);
    const r1 = await A.engine.push(), r2 = await A.engine.push();
    check("SE22 R35: restore wrote W1, its 2 failed deletes retry on the next push (no wipe block), table = snapshot",
      !c.ok && A.wipeBlocked.length === 0 && r1.ok && sameData(tableSched(t), snap) && r2.ok, JSON.stringify({ c: c.results && c.results.map(x => x.outcome), blocked: A.wipeBlocked.length }));
  });

  // SE23 — I6: an authoritative job that can't read the table writes nothing.
  await run("SE23", async () => {
    const t = mkTable(seedRows(4));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "GET", kind: "5xx-before" });
    const from = t.log.length;
    const c = await A.engine.authoritative({}, true);
    check("SE23 I6: the whole-table read fails → the clear is refused with a reason and ZERO writes",
      !c.ok && /nothing was changed/.test(c.error || "") && writes(t, from).length === 0 && t.rows().length === 4, JSON.stringify(c));
  });

  // SE24 — force mode: restore wins over a week someone changed after our
  // last pull (it re-reads the table first), and deletes carry no version.
  await run("SE24", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    const snap = clone(A.mirror); delete snap[W[2]];
    B.edit(W[0], w => (w.dayCall = "sB", w)); B.edit(W[2], w => (w.dayCall = "sB", w)); await B.engine.push();
    t.put({ week_monday: W[6], data: wk("unknown-to-A"), version: 1, updated_by: "user-b", updated_at: "2026-10-12T15:00:00+00:00" });
    A.mirror = clone(snap);
    const from = t.log.length;
    const c = await A.engine.authoritative(snap, true);
    const dels = writes(t, from).filter(e => e.method === "DELETE");
    check("SE24 force: the restore overwrites B's later W1 and deletes W3 + a week A never knew about (whole-table read first)",
      c.ok && sameData(tableSched(t), snap) && dels.length === 2 && dels.every(e => !/version=/.test(e.url)), JSON.stringify({ c: c.results, dels: dels.map(e => e.url) }));
  });

  // SE25/SE26 — auth: no live token never sends; a 401 stops the run and is
  // "sign in again", never "refused"; once signed in the weeks land (R27, I4).
  await run("SE25", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t); await A.engine.load();
    A.tokenState = "expired";
    A.edit(W[0], w => (w.dayCall = "s9", w));
    const from = t.log.length;
    const r = await A.engine.push();
    check("SE25 expired token → no request at all; status auth=expired; one 'sign-in has expired' toast",
      r.skipped === "auth" && t.log.length === from && A.st().auth === "expired" && A.toasts.length === 1 && /sign-in has expired/i.test(A.toasts[0]), JSON.stringify({ r, toasts: A.toasts }));
    A.tokenState = "ok";
    const r2 = await A.engine.push();
    check("SE25 R27: after signing in again the pending week lands (no reload, no re-edit)", r2.ok && t.get(W[0]).data.dayCall === "s9" && A.st().auth === "ok");
  });
  await run("SE26", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t); await A.engine.load();
    t.control.expiredTokens.add("TOK_A");
    A.edit(W[0], w => (w.dayCall = "s9", w)); A.edit(W[1], w => (w.dayCall = "s8", w));
    const from = t.log.length;
    const r = await A.engine.push();
    check("SE26 a 401 mid-run → auth-needed: the run stops after the first week, both stay pending, nothing adopted or 'refused'",
      !r.ok && writes(t, from).length === 1 && A.engine.pending().length === 2 && A.adopted.length === 0 && A.st().auth === "expired" && !A.toasts.some(m => /refused/.test(m)),
      JSON.stringify({ results: r.results, toasts: A.toasts }));
  });

  // SE27 — a 403 with a live token is a refusal: adopt what's saved, say so.
  await run("SE27", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "PATCH", week: W[0], kind: "403" });
    A.edit(W[0], w => (w.dayCall = "s9", w));
    await A.engine.push();
    check("SE27 403 → refused: the server copy is adopted, toast says refused, nothing left pending",
      A.mirror[W[0]].dayCall !== "s9" && A.toasts.some(m => /refused/.test(m)) && A.st().pending === 0, JSON.stringify({ toasts: A.toasts, st: A.st() }));
  });

  // SE28 — RLS: a write that the policy filters to 0 rows (row unchanged) is
  // NOT a conflict: it stays pending and says "not allowed" (critic: anon 0-row).
  await run("SE28", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t, { token: null }); await A.engine.load(); // anon headers, but tokenState "ok" (a client bug)
    A.edit(W[0], w => (w.dayCall = "s9", w));
    await A.engine.push();
    check("SE28 an RLS-filtered PATCH (0 rows, row unchanged) → pending + 'isn't allowed', never adopted as a conflict",
      A.mirror[W[0]].dayCall === "s9" && A.st().pending === 1 && A.st().noPermission.length === 1 && A.toasts.some(m => /isn't allowed/.test(m)) && A.adopted.length === 0,
      JSON.stringify({ toasts: A.toasts, st: A.st() }));
  });

  // SE29 — toasts: a NEW failure always toasts; the same failing set re-toasts
  // only after 5 min; the cap resets once everything lands (R25, R36).
  await run("SE29", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "PATCH", kind: "5xx-before", count: 100 });
    A.edit(W[0], w => (w.dayCall = "x", w));
    await A.engine.push(); await A.engine.push();
    const n1 = A.toasts.length;
    A.edit(W[1], w => (w.dayCall = "y", w));
    await A.engine.push();
    const n2 = A.toasts.length;
    ms += 5 * 60 * 1000 + 1;
    await A.engine.push();
    const n3 = A.toasts.length;
    t.control.clear();
    await A.engine.push();
    t.control.fail({ method: "PATCH", kind: "5xx-before", count: 1 });
    A.edit(W[0], w => (w.dayCall = "z", w));
    await A.engine.push();
    check("SE29 same set within 5 min: 1 toast; a NEW failing week: toasts at once; after 5 min: again; after landing the cap resets",
      n1 === 1 && n2 === 2 && n3 === 3 && A.toasts.length === 4, JSON.stringify({ n1, n2, n3, n4: A.toasts.length }));
  });

  // SE30 — keepalive: CAS requests built from the LATEST mirror and known
  // versions; no deletes; uncertain weeks skipped; a conflicted week matches
  // 0 rows and changes nothing (R1, R2, R6, R37).
  await run("SE30", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    B.edit(W[1], w => (w.dayCall = "sB", w)); await B.engine.push();       // A's W2 is now stale
    A.edit(W[0], w => (w.dayCall = "a0", w));
    A.edit(W[1], w => (w.dayCall = "a1", w));
    A.edit(W[5], () => wk("new"));
    A.drop(W[2]);
    const reqs = A.engine.keepaliveRequests();
    check("SE30 keepalive: CAS PATCH per edited known week, POST for the new one, NO delete, every request keepalive:true",
      reqs.length === 3 && reqs.every(x => x.init.keepalive === true) && reqs.filter(x => x.init.method === "PATCH").every(x => /version=eq\.3/.test(x.url))
        && reqs.some(x => x.init.method === "POST") && !reqs.some(x => x.init.method === "DELETE") && reqs.every(x => !/merge-duplicates/.test(x.init.headers.Prefer || "")),
      JSON.stringify(reqs.map(x => x.init.method + " " + x.url.split("?")[1])));
    for (const x of reqs) await t.fetch(x.url, x.init);
    check("SE30 R1: fired, they save W1 + the new week but leave B's newer W2 alone (CAS 0 rows), and keep W3",
      t.get(W[0]).data.dayCall === "a0" && t.get(W[1]).data.dayCall === "sB" && !!t.get(W[5]) && !!t.get(W[2]), JSON.stringify(tableSched(t)[W[1]]));
    A.tokenState = "expired";
    check("SE30 no live token → no keepalive requests (an expired token would only 401)", A.engine.keepaliveRequests().length === 0);
  });

  // SE31 — R4: after a failed push, a re-edit is still in the keepalive.
  await run("SE31", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "PATCH", week: W[0], kind: "5xx-before" });
    A.edit(W[0], w => (w.dayCall = "first", w)); await A.engine.push();
    A.edit(W[0], w => (w.dayCall = "second", w));
    const reqs = A.engine.keepaliveRequests();
    for (const x of reqs) await t.fetch(x.url, x.init);
    check("SE31 R4: a week whose push failed is NOT skipped — the re-edit goes out on hide and lands", t.get(W[0]).data.dayCall === "second");
  });

  // SE32 — reset() (sign-out): an in-flight job lands nothing afterwards.
  await run("SE32", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    const B = mkSession(t, { token: "TOK_B", user: "user-b" }); await B.engine.load();
    B.edit(W[0], w => (w.dayCall = "sB", w)); await B.engine.push();
    const hold = t.control.pause({ method: "GET", count: 1, when: "after" });
    const pl = A.engine.pull(); await hold.arrived;
    A.engine.reset();
    const before = A.commits;
    hold.release(); await pl;
    check("SE32 a pull in flight when the session resets adopts nothing, learns nothing, and the engine stays unloaded",
      A.commits === before && !A.engine.isSeeded() && A.engine.pending().length === 0 && A.engine.knownVersion(W[1]) === undefined && A.engine.knownVersion(W[0]) === undefined,
      JSON.stringify({ commits: A.commits - before, kv: [A.engine.knownVersion(W[0]), A.engine.knownVersion(W[1])] }));
    // …and a push in flight across the reset must not adopt into the next user's mirror.
    const t2 = mkTable(seedRows(2));
    const C = mkSession(t2), D = mkSession(t2, { token: "TOK_B", user: "user-b" });
    await C.engine.load(); await D.engine.load();
    D.edit(W[0], w => (w.dayCall = "sD", w)); await D.engine.push();
    const h2 = t2.control.pause({ method: "PATCH", count: 1, when: "after" });
    C.edit(W[0], w => (w.dayCall = "sC", w));
    const pu = C.engine.push(); await h2.arrived;
    C.engine.reset(); C.mirror = { next: "user" };
    h2.release(); await pu;
    check("SE32 a push in flight across the reset leaves the next user's mirror alone (no conflict adoption into it)",
      JSON.stringify(C.mirror) === JSON.stringify({ next: "user" }) && C.toasts.length === 0, JSON.stringify({ mirror: C.mirror, toasts: C.toasts }));
  });

  // SE33 — not loaded: pushes are refused (load gate), a pull repairs it.
  await run("SE33", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t);
    t.control.fail({ method: "GET", kind: "5xx-before" });
    const l = await A.engine.load();
    A.edit(W[0], () => wk("s9"));
    const from = t.log.length;
    const r = await A.engine.push();
    check("SE33 a failed first read: not loaded, and a push sends nothing (load gate)", !l.ok && !A.engine.isSeeded() && r.skipped === "not-loaded" && t.log.length === from);
    A.mirror = {};
    await A.engine.pull();
    check("SE33 …the next pull repairs it with a whole-table read", A.engine.isSeeded() && sameData(A.mirror, tableSched(t)));
  });

  // SE34 — load() when already loaded (sign in again) is a pull: unsaved edits survive.
  await run("SE34", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    A.tokenState = "expired";
    A.edit(W[0], w => (w.dayCall = "unsaved", w)); await A.engine.push();
    A.tokenState = "ok";
    await A.engine.load();                       // the reloadTrigger pass after signing in
    check("SE34 a second load keeps the unsaved edit (it's a pull, not a re-seed)", A.mirror[W[0]].dayCall === "unsaved" && A.engine.pending().join() === W[0]);
    await A.engine.push();
    check("SE34 …which then lands", t.get(W[0]).data.dayCall === "unsaved");
  });

  // SE35 — read-only sessions (public / OR board) pull and never write.
  await run("SE35", async () => {
    const t = mkTable(seedRows(2));
    const P = mkSession(t, { canWrite: false, token: null }); await P.engine.load();
    P.edit(W[0], w => (w.dayCall = "x", w));
    const from = t.log.length;
    await P.engine.push(); await P.engine.pull();
    check("SE35 a read-only session sends no writes and its keepalive is empty", writes(t, from).length === 0 && P.engine.keepaliveRequests().length === 0);
  });

  // SE36 — two writers converge: interleaved edits to different weeks, each
  // side pulling and pushing, end with both mirrors equal to the table.
  await run("SE36", async () => {
    const t = mkTable(seedRows(4));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    for (let i = 0; i < 6; i++) {
      A.edit(W[i % 4], w => (w.dayCall = "a" + i, w));
      B.edit(W[(i + 2) % 4], w => (w.dayCall = "b" + i, w));
      await Promise.all([A.engine.push(), B.engine.push()]);
      await Promise.all([A.engine.pull(), B.engine.pull()]);
    }
    await A.engine.pull(); await B.engine.pull();
    check("SE36 two writers converge: A's mirror = B's mirror = the table, nothing pending",
      sameData(A.mirror, tableSched(t)) && sameData(B.mirror, tableSched(t)) && A.engine.pending().length === 0 && B.engine.pending().length === 0,
      JSON.stringify({ A: A.engine.pending(), B: B.engine.pending() }));
  });

  // SE37 — every write carries the session's token and the apikey (never anon).
  await run("SE37", async () => {
    const t = mkTable(seedRows(1));
    const A = mkSession(t); await A.engine.load();
    A.edit(W[0], w => (w.dayCall = "x", w)); A.edit(W[3], () => wk("y")); await A.engine.push();
    check("SE37 writes carry apikey + the user's bearer token + JSON content type", writes(t).every(e => e.headers.apikey === "ANON" && e.headers.authorization === "Bearer TOK_A" && /application\/json/.test(e.headers["content-type"] || "")));
  });

  // SE38 — the mirror is never written while a job is between its decision
  // and its commit: adoption builds from the LATEST mirror (an edit made while
  // a pull is in flight survives the pull's adoption of another week).
  await run("SE38", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    B.edit(W[0], w => (w.dayCall = "sB", w)); await B.engine.push();
    A.canWrite = false;
    const hold = t.control.pause({ method: "GET", week: W[0], count: 1, when: "after" });
    const pl = A.engine.pull(); await hold.arrived;
    A.edit(W[2], w => (w.dayCall = "edited-meanwhile", w));
    hold.release(); await pl;
    check("SE38 the pull adopted B's W1 without reverting A's edit to W3 made while it was in flight",
      A.mirror[W[0]].dayCall === "sB" && A.mirror[W[2]].dayCall === "edited-meanwhile", JSON.stringify({ w0: A.mirror[W[0]].dayCall, w2: A.mirror[W[2]].dayCall }));
  });
};

// Standalone: node test/sync-engine-se.js
if (require.main === module) {
  const src = fs.readFileSync(path.join(__dirname, "..", "index-source.html"), "utf8");
  let n = 0; const fails = [];
  const check = (name, cond, detail) => { n++; if (cond) console.log("  ✓ " + name); else { fails.push(name); console.log("  ✗ " + name + (detail ? " — " + detail : "")); } };
  let done = false;
  process.on("exit", () => { if (!done) { console.error("FAIL — SE ended without a verdict (a hung await)"); process.exitCode = 1; } });
  module.exports({ src, check }).then(() => {
    done = true;
    console.log(`\n${n} checks, ${fails.length} failure(s)`);
    process.exit(fails.length ? 1 : 0);
  }, (e) => { console.error("crashed:", e); process.exit(1); });
}
