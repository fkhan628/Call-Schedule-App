// SE. Sync engine v2 — the REAL createSchedSync, extracted from
// index-source.html by its anchors and run in a FRESH vm context (no
// config.js globals, so a free identifier fails instead of resolving to a
// real object), driven against an emulated PostgREST schedule_weeks table
// (test/fake-weeks-table.js: versioned rows, jsonb key reordering, timestamptz
// "+00:00", RLS that hides rows from anon writes, failure injection before
// AND after commit, thrown requests, pausable requests, expired tokens).
//
// Each scenario cites what it pins: R1–R37 are the confirmed findings of the
// three reviews of #68/#69 (private docs/sync-v2/MAP), I1–I6 the design's
// invariants, D-n the design review of rev 1. Every scenario also asserts the
// engine reported no internal error. Called from test/sync-guards.js (CI runs
// that file); also runnable alone:  node test/sync-engine-se.js
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
// A fresh context with only what a browser page gives the engine.
const compile = (code) => vm.runInContext(`${code}; createSchedSync`, vm.createContext({ AbortController, setTimeout, clearTimeout }), { filename: "createSchedSync.js" });

module.exports = async function runSE({ src, check }) {
  console.log("\nSE. sync engine v2 (the real createSchedSync on an emulated schedule_weeks)");
  const engSrc = extractEngine(src);
  check("SE0 createSchedSync is extractable by its anchors (exactly one definition)", !!engSrc);
  if (!engSrc) return;
  let createSchedSync;
  try { createSchedSync = compile(engSrc); }
  catch (ex) { check("SE0 createSchedSync compiles standalone", false, String(ex)); return; }
  await scenarios(createSchedSync, check);

  // ── SE-M. Mutant battery ──
  // Each mutant re-breaks one thing the reviews found (or one guarantee); the
  // scenarios must turn red for every one. A mutant whose anchor is gone fails
  // too, so a refactor can't quietly retire one.
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
  { id: "M1", what: "PATCH without any CAS filter (blind overwrite, R14/R28)",
    from: "else if (kn) { url = `${base()}?week_monday=eq.${k}&${cas(kn)}`;", to: "else if (kn) { url = `${base()}?week_monday=eq.${k}`;" },
  { id: "M1b", what: "CAS on version alone (clear + regenerate restarts at v1; old builds keep the version — D)",
    from: 'const cas = (kn) => `version=${kn.version === null ? "is.null" : "eq." + kn.version}&updated_at=${kn.updated_at === null ? "is.null" : "eq." + encodeURIComponent(kn.updated_at)}`;',
    to: "const cas = (kn) => `version=eq.${kn.version}`;" },
  { id: "M2", what: "no read-back: an unknown outcome is guessed as someone else's (R8, R12, R23, R24)",
    from: '      const how = classify(k, rb.row);\n      if (how === "mirror") { confirm(k, rb.row); return { k, outcome: "saved" }; }', to: '      const how = "theirs";\n      if (how === "mirror") { confirm(k, rb.row); return { k, outcome: "saved" }; }' },
  { id: "M2b", what: "the sent-ledger is ignored: our own lost-response write reads as someone else's (D: own writes)",
    from: '    if (sent[k] && sent[k].includes(c)) return "ours";\n', to: "" },
  { id: "M3", what: "plain JSON equality (jsonb key order reads as an edit)",
    from: 'const canon = (x) => x === undefined ? "∅" : JSON.stringify(x, (k, v) => (v && typeof v === "object" && !Array.isArray(v)) ? Object.keys(v).sort().reduce((o, kk) => (o[kk] = v[kk], o), {}) : v);',
    to: 'const canon = (x) => x === undefined ? "∅" : JSON.stringify(x);' },
  { id: "M4", what: "pull adopts over an unsaved local edit (R21)",
    from: "      if (dirty) return; // an unsaved", to: "      if (false) return; // an unsaved" },
  { id: "M5", what: "the wipe guard counts deletes that already passed it (R7, R9)",
    from: "const newDeletes = deletes.filter(k => !approvedDeletes.has(k));", to: "const newDeletes = deletes;" },
  { id: "M6", what: "reset() doesn't fence jobs in flight (sign-out boundary)",
    from: "      gen++; known = {};", to: "      known = {};" },
  { id: "M7", what: "keepalive PATCH without CAS (R1)",
    from: 'return { url: `${base()}?week_monday=eq.${k}&${cas(kn)}`, init: { method: "PATCH", keepalive: true',
    to: 'return { url: `${base()}?week_monday=eq.${k}`, init: { method: "PATCH", keepalive: true' },
  { id: "M8", what: "a push queued before a clear doesn't defer to it (R10 false wipe block)",
    from: 'if (job.mode !== "force" && authoritativeQueued > 0) return', to: 'if (false) return' },
  { id: "M9", what: "writes without a live token (anon / expired)",
    from: '    if (authState() !== "ok") {\n      const p = pendingKeys();', to: '    if (false) {\n      const p = pendingKeys();' },
  { id: "M10", what: "a 401 is treated as a refusal (adopts the server copy, drops the edit)",
    from: 'if (r.status === 401 || /^PGRST30[123]$/.test(code) || /JWT expired/i.test(msg)) return "auth";', to: 'if (r.status === 401 || /^PGRST30[123]$/.test(code) || /JWT expired/i.test(msg)) return "refused";' },
  { id: "M11", what: "the change token ignores updated_at (R18)",
    from: " || known[x.week_monday].updated_at !== (x.updated_at || null)", to: "" },
  { id: "M12", what: "unconfirmed weeks are not re-read before writing",
    from: "    for (const k of Object.keys(sent).filter(unconfirmed)) {", to: "    for (const k of []) {" },
  { id: "M13", what: "a wipe-shaped removal is adopted on ONE read (R20)",
    from: "if (wipeShaped && sig !== removalSig) {", to: "if (false) {" },
  { id: "M14", what: "pull adopts the empty RLS/anon list (R20)",
    from: "    if (!list.length && Object.keys(known).length) {", to: "    if (false) {" },
  { id: "M15", what: "pushes don't coalesce (R3)",
    from: "      if (queuedPush) return queuedPush;\n", to: "" },
  { id: "M16", what: "the toast cap never expires (R36)",
    from: " && d.nowMs() - lastFail.at <= 5 * 60 * 1000) return;", to: ") return;" },
  { id: "M17", what: "a new week is a merge-duplicates upsert (overwrites a row someone inserted)",
    from: 'else { url = base(); init = { method: "POST", headers: wh({ Prefer: "return=representation" })',
    to: 'else { url = base() + "?on_conflict=week_monday"; init = { method: "POST", headers: wh({ Prefer: "resolution=merge-duplicates,return=representation" })' },
  { id: "M18", what: "clear/restore act on the last-known weeks instead of re-reading the table (I6)",
    from: "        known = {}; rows.forEach(x => { known[x.week_monday] = fromRow(x); });\n", to: "" },
  { id: "M19", what: "clear/restore write even when the table can't be read (I6 fail closed)",
    from: '        if (!rows) return { ok: false, wrote: false, error: "Couldn\'t read the saved schedule — nothing was changed." };\n',
    to: '        if (!rows) return Object.assign({ wrote: true }, await runPush({ target, grant, mode: "force" }));\n' },
  { id: "M20", what: "adoption rebuilds the whole schedule from the server copy (R15: reverts other unsaved edits)",
    from: "    const next = Object.assign({}, cur);\n    const changed = [], taken = [];", to: "    const next = Object.keys(known).reduce((o, k) => (o[k] = clone(known[k].data), o), {});\n    const changed = [], taken = [];" },
  { id: "M21", what: "no request timeout (one hung request wedges every job — D)",
    from: "if (ctl && ms) { timer = setTimeout(", to: "if (false) { timer = setTimeout(" },
  { id: "M22", what: "the keepalive's bodies are not recorded (a landed keepalive reads as someone else's)",
    from: "      addSent(k, canon(target[k]));\n      return { url:", to: "      return { url:" },
  { id: "M23", what: "Undo is not all-or-nothing across a week someone else changed (R15)",
    from: "blocked: touched.filter(k => (adoptEpoch[k] || 0) > snapEpoch)", to: "blocked: []" },
  // (M24 — "an adoption that changes nothing bumps the epoch" — is equivalent:
  // classify() answers "mirror" for identical data before adoptInto is reached.
  // SE44's third case pins the behaviour instead.)
  { id: "M25", what: "a wipe-blocked push holds back every other week's save too (D)",
    from: "      sendDeletes = deletes.filter(k => approvedDeletes.has(k));", to: "      sendDeletes = []; sendable.length = 0;" },
  { id: "M26", what: "a body the server rejected (400) is re-sent every minute forever",
    from: "const sendable = changed.filter(k => !(rejected[k] && rejected[k].canon === canon(target[k])));", to: "const sendable = changed;" },
  { id: "M27", what: "a 400 is treated as a refusal (adopts the server copy, discarding the edit — D)",
    from: 'return code ? "rejected" : "unknown";', to: 'return code ? "refused" : "unknown";' },
  { id: "M28", what: "approvedDeletes are never pruned (a re-created week's old approval exempts a later wipe — A12)",
    from: "    [...approvedDeletes.keys()].forEach(k => { if (!deletes.includes(k) || !known[k] || approvedDeletes.get(k) !== known[k].version) approvedDeletes.delete(k); });\n", to: "" },
  { id: "M30", what: "a gateway's HTML 403 is taken as a permission refusal (adopts the server copy, drops the edit — A4)",
    from: 'if (r.status === 403) return code === "42501" ? "refused" : "unknown";', to: 'if (r.status === 403) return "refused";' },
  { id: "M31", what: "a push walks every week into a timeout instead of stopping at the first dead request (A5)",
    from: "      const x = await writeWeek(k, clone(target[k]), job.mode, by);\n      results.push(x);\n      if (x.outcome === \"auth\" || x.thrown) stop = true;",
    to: "      const x = await writeWeek(k, clone(target[k]), job.mode, by);\n      results.push(x);\n      if (x.outcome === \"auth\") stop = true;" },
  { id: "M32", what: "a pull running when a clear/restore is requested still adopts (A11)",
    from: "    if (authoritativeQueued > 0) return { ok: false, skipped: \"authoritative-queued\" };\n    const cur0", to: "    const cur0" },
  { id: "M33", what: "adoption ignores an edit made while the request was out (A3)",
    from: "      if (expect && k in expect && expect[k] !== shown) return;\n", to: "" },
  { id: "M34", what: "a clear/restore re-commits weeks whose write FAILED (they'd stop being retried — R7)",
    from: "Object.keys(startShown).filter(k => saved.has(k)).forEach(k => {", to: "Object.keys(startShown).forEach(k => {" },
  { id: "M35", what: "a re-send after recognising our own earlier body ignores that the screen moved on (re-sends an undone edit — A3)",
    from: "if (mode !== \"force\" && canon((d.getState() || {})[k]) !== c) return { k, outcome: \"superseded\" }; ", to: "" },
];

async function scenarios(createSchedSync, check) {
  // ── fixtures ──
  let ms = Date.UTC(2026, 9, 12, 12, 0, 0);
  const clockIso = () => new Date(ms += 1000).toISOString();
  const mkTable = (rows) => createFakeWeeksTable({ baseUrl: BASE, anonKey: "ANON", users: { TOK_A: "user-a", TOK_B: "user-b", TOK_M: "member" }, rows: rows || [], clock: clockIso });
  const seedRows = (n, v) => W.slice(0, n).map((k, i) => ({ week_monday: k, data: wk("s" + (i % 6 + 1)), version: v || 3, updated_by: "user-a", updated_at: "2026-10-01T08:00:00.000Z" }));
  const internal = [];
  const mkSession = (table, o) => {
    o = o || {};
    const s = { mirror: {}, toasts: [], statuses: [], wipeBlocked: [], commits: 0, readAsAnon: false,
      token: o.token === undefined ? "TOK_A" : o.token, canWrite: o.canWrite !== false, user: o.user || "user-a" };
    const hdr = (tok) => tok ? { apikey: "ANON", Authorization: "Bearer " + tok } : { apikey: "ANON", Authorization: "Bearer ANON" };
    s.engine = createSchedSync({
      getState: () => s.mirror,
      commit: (next) => { s.mirror = next; s.commits++; },
      fetch: (u, i) => table.fetch(u, i),
      url: BASE,
      writeHeaders: () => hdr(s.token),
      readHeaders: () => hdr(s.readAsAnon ? null : s.token),   // the app's dbReadHeaders falls back to anon for a stale token
      canWrite: () => s.canWrite,
      token: () => s.token,
      userId: () => { if (s.userThrows) throw new Error("boom"); return s.user; },
      now: clockIso,
      nowMs: () => ms,
      onStatus: (st) => s.statuses.push(st),
      onToast: (m) => s.toasts.push(String(m)),
      onWipeBlocked: (i) => s.wipeBlocked.push(i),
      onInternalError: (e) => { internal.push(String(e && e.message || e)); s.internal = (s.internal || 0) + 1; },
      log: () => {},
      timeouts: o.timeouts,
    });
    s.edit = (k, fn) => { s.mirror = Object.assign({}, s.mirror, { [k]: fn(clone(s.mirror[k] || {})) }); };
    s.drop = (k) => { const n = Object.assign({}, s.mirror); delete n[k]; s.mirror = n; };
    s.st = () => s.engine.status();
    return s;
  };
  const writes = (t, from) => t.log.slice(from || 0).filter(e => e.method !== "GET");
  const sortDeep = (x) => Array.isArray(x) ? x.map(sortDeep) : (x && typeof x === "object") ? Object.keys(x).sort().reduce((o, k) => (o[k] = sortDeep(x[k]), o), {}) : x;
  const sameData = (a, b) => JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
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
      r.ok && sameData(A.mirror, tableSched(t)) && A.st().pending === 0 && A.st().seeded && writes(t).length === 0, JSON.stringify({ r, st: A.st() }));
    A.mirror = Object.assign({}, A.mirror, { [W[0]]: wk("s1") });
    check("SE2 jsonb key order: the same week in generator key order is NOT pending (canonical equality)",
      Object.keys(t.get(W[0]).data)[0] !== "dayCall" && A.engine.pending().length === 0, JSON.stringify(Object.keys(t.get(W[0]).data)));
    await A.engine.push();
    check("SE2 …and a push of it sends nothing", writes(t).length === 0);
    check("SE2 canon follows JSON: an undefined member equals an absent one; nested key order is ignored; arrays keep order",
      A.engine.canon({ a: undefined, b: { y: 1, x: 2 } }) === A.engine.canon({ b: { x: 2, y: 1 } }) && A.engine.canon([1, 2]) !== A.engine.canon([2, 1]));
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
    const CAS = /week_monday=eq\.2026-10-1[29]&version=eq\.3&updated_at=eq\.2026-10-01T08%3A00%3A00%2B00%3A00/;
    check("SE3 edit → PATCH filtered on (version, updated_at) with the '+' encoded, Prefer return=representation, body version V+1, updated_by set",
      !!patch && CAS.test(patch.url) && /return=representation/.test(patch.headers.prefer || "")
        && patch.body.version === 4 && patch.body.updated_by === "user-a" && t.get(W[0]).version === 4 && t.get(W[0]).data.dayCall === "s9",
      JSON.stringify(patch && { url: patch.url, prefer: patch.headers.prefer, body: patch.body }));
    check("SE4 new week → plain POST insert (no on_conflict, no merge-duplicates), version 1",
      !!post && !/on_conflict/.test(post.url) && !/merge-duplicates/.test(post.headers.prefer || "") && post.body.version === 1 && t.get(W[5]).version === 1,
      JSON.stringify(post && { url: post.url, prefer: post.headers.prefer }));
    check("SE5 removed week → DELETE with the same (version, updated_at) filter and return=representation (R28: never an unversioned delete)",
      !!del && /week_monday=eq\.2026-10-26&version=eq\.3&updated_at=eq\./.test(del.url) && /return=representation/.test(del.headers.prefer || "") && t.get(W[2]) === null,
      JSON.stringify(del && del.url));
    check("SE3 all three saved: ok, nothing pending, no toast", r.ok && A.st().pending === 0 && A.toasts.length === 0, JSON.stringify({ r: r.results, t: A.toasts }));
  });

  // SE6 — a 5xx before commit: read back, still pending, retried (R5, R26).
  await run("SE6", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "PATCH", week: W[0], kind: "5xx-before" });
    A.edit(W[0], w => (w.dayCall = "s9", w));
    check("SE6 before the push the week is 'saving', not 'failing' (no red flash for a normal save)", A.st().saving === 1 && A.st().failing === 0);
    const r1 = await A.engine.push();
    check("SE6 503 before commit → read back (row unchanged) → still pending and now FAILING, one toast",
      !r1.ok && A.st().pending === 1 && A.st().failing === 1 && A.toasts.length === 1 && /retrying/.test(A.toasts[0]) && t.get(W[0]).data.dayCall !== "s9",
      JSON.stringify({ st: A.st(), toasts: A.toasts }));
    const r2 = await A.engine.push();
    check("SE6 …the next push lands it (the retry is the push itself)", r2.ok && t.get(W[0]).data.dayCall === "s9" && A.st().pending === 0 && A.st().failing === 0);
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
    A.mirror = Object.assign({}, A.mirror, { [W[0]]: old });
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
    const c = await A.engine.authoritative({}, true, "clear");
    check("SE8 R23: the clear then deletes it too — no ghost week", c.ok && t.rows().length === 0, JSON.stringify(t.rows().map(x => x.week_monday)));
  });

  // SE9/SE10 — offline: a thrown write is read back; if the read-back throws
  // too the week stays unconfirmed and is re-read before its next write (R29).
  await run("SE9", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ week: W[0], kind: "throw", count: 2 }); // the PATCH and its read-back
    A.edit(W[0], w => (w.dayCall = "s9", w));
    await A.engine.push();
    check("SE9 thrown write + thrown read-back → pending + failing, nothing written",
      A.st().failing === 1 && A.st().pending === 1 && t.get(W[0]).data.dayCall !== "s9", JSON.stringify(A.st()));
    const from = t.log.length;
    const r = await A.engine.push();
    const first = t.log[from];
    check("SE9 the next push RE-READS the unconfirmed week before writing it, then lands",
      r.ok && first && first.method === "GET" && /week_monday=eq\.2026-10-12/.test(first.url) && t.get(W[0]).data.dayCall === "s9" && A.st().pending === 0,
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

  // SE11 — a conflict adopts the server copy of THAT week only, with a toast,
  // a persistent conflict entry and an epoch bump; the session's other unsaved
  // edits are untouched and still save (R11, R12, R13, R15).
  await run("SE11", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    B.edit(W[0], w => (w.dayCall = "sB", w)); await B.engine.push();
    A.edit(W[0], w => (w.dayCall = "sA", w));
    A.edit(W[1], w => (w.dayCall = "sA2", w));
    const e0 = A.engine.epochOf(W[0]);
    const r = await A.engine.push();
    check("SE11 stale PATCH matches 0 rows → read-back shows B's week → conflict: A adopts B's W1, ONE toast names the week, a conflict entry stays",
      A.mirror[W[0]].dayCall === "sB" && t.get(W[0]).data.dayCall === "sB" && A.toasts.length === 1 && /changed by someone else/.test(A.toasts[0]) && A.engine.epochOf(W[0]) > e0
        && A.st().conflicts.length === 1 && A.st().conflicts[0].k === W[0],
      JSON.stringify({ mirror: A.mirror[W[0]].dayCall, toasts: A.toasts, results: r.results, c: A.st().conflicts }));
    check("SE11 R13: ONLY that week was adopted — A's other edit (W2) saved, nothing else reloaded",
      t.get(W[1]).data.dayCall === "sA2" && A.mirror[W[1]].dayCall === "sA2" && A.st().pending === 0, JSON.stringify(A.st()));
    A.engine.dismissConflicts();
    check("SE11 dismissConflicts clears the persistent entry", A.st().conflicts.length === 0);
  });

  // SE11b — several conflicts in one job: ONE toast naming them all (the toast slot holds one).
  await run("SE11b", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    [0, 1, 2].forEach(i => B.edit(W[i], w => (w.dayCall = "sB", w))); await B.engine.push();
    [0, 1, 2].forEach(i => A.edit(W[i], w => (w.dayCall = "sA", w)));
    await A.engine.push();
    check("SE11b three conflicts in one push → exactly one toast that names all three weeks, three conflict entries",
      A.toasts.length === 1 && /weeks of/.test(A.toasts[0]) && (A.toasts[0].match(/,/g) || []).length >= 2 && A.st().conflicts.length === 3, JSON.stringify(A.toasts));
  });

  // SE12 — 0 rows but the server already holds exactly our change → saved, no false conflict (R12).
  await run("SE12", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    B.edit(W[0], w => (w.dayCall = "same", w)); await B.engine.push();
    A.edit(W[0], w => (w.dayCall = "same", w));
    const r = await A.engine.push();
    check("SE12 the read-back finds our exact content → saved, no conflict toast, no conflict entry",
      r.ok && A.toasts.length === 0 && A.st().conflicts.length === 0 && A.engine.knownVersion(W[0]) === 4, JSON.stringify({ r: r.results, toasts: A.toasts }));
  });

  // SE13 — pull adopts other people's changes only for weeks this session
  // hasn't edited; an edited week is left alone and settles by read-back (R21, R32).
  await run("SE13", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    B.edit(W[0], w => (w.dayCall = "sB0", w)); B.edit(W[1], w => (w.dayCall = "sB1", w)); await B.engine.push();
    A.edit(W[1], w => (w.dayCall = "sA1", w));
    A.canWrite = false;
    await A.engine.pull();
    check("SE13 pull adopts B's W1 (A hadn't touched it) and leaves A's unsaved W2 edit in place",
      A.mirror[W[0]].dayCall === "sB0" && A.mirror[W[1]].dayCall === "sA1", JSON.stringify({ w0: A.mirror[W[0]].dayCall, w1: A.mirror[W[1]].dayCall }));
    check("SE13 R21: the unsaved edit is still pending (never silently dropped)", A.engine.pending().join() === W[1]);
    A.canWrite = true;
    const from = t.log.length;
    await A.engine.push();
    check("SE13 …its push settles it LOUDLY as a conflict (B got there first) — and the adopted W1 caused ZERO echo writes",
      A.mirror[W[1]].dayCall === "sB1" && A.toasts.some(m => /changed by someone else/.test(m)) && !writes(t, from).some(e => e.url.includes(W[0])));
  });

  // SE14/SE15 — the change token is (version, updated_at) (R18).
  await run("SE14", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    await t.fetch(`${BASE}/rest/v1/schedule_weeks?on_conflict=week_monday`, { method: "POST", headers: { apikey: "ANON", Authorization: "Bearer TOK_B", "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ week_monday: W[0], data: wk("old-build"), updated_by: "user-b", updated_at: "2026-10-12T13:00:00.000Z" }]) });
    check("SE14 (fixture) the old build's blind upsert kept version 3", t.get(W[0]).version === 3 && t.get(W[0]).data.dayCall === "old-build");
    await A.engine.pull();
    check("SE14 R18: pull notices the same-version change by updated_at and adopts it", A.mirror[W[0]].dayCall === "old-build", A.mirror[W[0]].dayCall);
    A.edit(W[0], w => (w.dayCall = "s9", w));
    const r = await A.engine.push();
    check("SE14 …and A's next CAS write still lands", r.ok && t.get(W[0]).data.dayCall === "s9");
  });
  await run("SE15", async () => {
    const t = mkTable(seedRows(2, 1));
    const A = mkSession(t); await A.engine.load();
    t.del(W[0]); t.put({ week_monday: W[0], data: wk("reborn"), version: 1, updated_by: "user-b", updated_at: "2026-10-12T14:00:00+00:00" });
    await A.engine.pull();
    check("SE15 R18: a delete + re-insert at v1 (same version number) is still seen as a change", A.mirror[W[0]].dayCall === "reborn", A.mirror[W[0]].dayCall);
  });

  // SE16 — removals: adopted when not edited here; a locally edited week is
  // kept; a wipe-shaped removal needs two pulls that agree; the RLS-empty
  // list is never adopted (R20).
  await run("SE16", async () => {
    const t = mkTable(seedRows(8));
    const A = mkSession(t); await A.engine.load();
    A.canWrite = false;
    t.del(W[0]);
    A.edit(W[1], w => (w.dayCall = "sA", w)); t.del(W[1]);
    await A.engine.pull();
    check("SE16 a week deleted elsewhere disappears here; a week A edited stays (A's edit wins locally)",
      !(W[0] in A.mirror) && A.mirror[W[1]].dayCall === "sA", JSON.stringify(Object.keys(A.mirror)));
    W.slice(2, 7).forEach(k => t.del(k));
    await A.engine.pull();
    const afterOne = Object.keys(A.mirror).length;
    await A.engine.pull();
    check("SE16 a wipe-shaped removal (6 of 7 known weeks gone, one left) is NOT adopted on one read — it IS when the next pull agrees (I5)",
      t.rows().length === 1 && afterOne === 7 && Object.keys(A.mirror).length === 2 && A.mirror[W[1]].dayCall === "sA", JSON.stringify({ afterOne, now: Object.keys(A.mirror) }));
    const t2 = mkTable(seedRows(3));
    const C = mkSession(t2); await C.engine.load(); C.canWrite = false;
    W.slice(0, 3).forEach(k => t2.del(k));
    const r = await C.engine.pull(); await C.engine.pull();
    check("SE16 R20: an EMPTY list while weeks are known (the anon/RLS shape) is ignored, even twice", r.suspicious === true && Object.keys(C.mirror).length === 3, JSON.stringify(r));
  });

  // SE17 — one job at a time: pushes requested during a slow push coalesce (R3, R14, R16).
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

  // SE18 — a pull and a push never interleave (R17).
  await run("SE18", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    const hold = t.control.pause({ method: "GET", count: 1 });
    const pl = A.engine.pull();
    await hold.arrived;
    B.edit(W[0], w => (w.dayCall = "late", w)); await B.engine.push();
    A.edit(W[1], w => (w.dayCall = "a", w));
    const pu = A.engine.push();
    hold.release();
    await Promise.all([pl, pu]);
    await A.engine.pull();
    check("SE18 R17: the slow pull's old list didn't revert anything; the next pull picks up B's later write; A's push landed",
      A.mirror[W[0]].dayCall === "late" && t.get(W[1]).data.dayCall === "a" && A.st().pending === 0, JSON.stringify({ w0: A.mirror[W[0]].dayCall, st: A.st() }));
  });

  // SE19 — the wipe guard (R10).
  await run("SE19", async () => {
    const t = mkTable(seedRows(6));
    const A = mkSession(t); await A.engine.load();
    A.mirror = {};
    const from = t.log.length;
    const r = await A.engine.push(); await A.engine.push();
    check("SE19 empty mirror vs 6 known weeks, no grant → BLOCKED: zero DELETEs, ONE onWipeBlocked (not one per retry), status counts 6",
      r.blocked === true && writes(t, from).length === 0 && A.wipeBlocked.length === 1 && t.rows().length === 6 && A.st().blockedDeletes === 6, JSON.stringify(r));
    const most = mkSession(t); await most.engine.load();
    W.slice(0, 3).forEach(k => most.drop(k));
    const r2 = await most.engine.push();
    check("SE19 dropping half of the weeks (3 of 6) without a grant is blocked too (wipingMost)", r2.blocked === true && t.rows().length === 6);
    const c = await A.engine.authoritative({}, true, "clear");
    check("SE19 the authoritative clear deletes all 6, no further wipe block, ok", c.ok && t.rows().length === 0 && A.wipeBlocked.length === 1, JSON.stringify(c));
  });

  // SE19b — R10: a push queued BEFORE a clear defers to it (no false "wipe blocked").
  await run("SE19b", async () => {
    const t = mkTable(seedRows(6));
    const A = mkSession(t); await A.engine.load();
    const hold = t.control.pause({ method: "PATCH", count: 1 });
    A.edit(W[0], w => (w.dayCall = "x", w));
    const p1 = A.engine.push(); await hold.arrived;
    A.edit(W[1], w => (w.dayCall = "y", w));
    const p2 = A.engine.push();
    const c = A.engine.authoritative({}, true, "clear");
    A.mirror = {};
    hold.release();
    const [, r2, rc] = await Promise.all([p1, p2, c]);
    await A.engine.idle();
    check("SE19b R10: the queued push defers to the queued clear — no false wipe block; the clear empties the table",
      A.wipeBlocked.length === 0 && r2.skipped === "authoritative-queued" && rc.ok && t.rows().length === 0, JSON.stringify({ r2, rc, blocked: A.wipeBlocked }));
  });

  // SE19c — the grant never lingers: after a clear and a regenerate, an
  // unexplained wipe-shaped push is blocked again (D: approvedDeletes lifecycle).
  await run("SE19c", async () => {
    const t = mkTable(seedRows(6));
    const A = mkSession(t); await A.engine.load();
    A.mirror = {};
    await A.engine.authoritative({}, true, "clear");
    seedRows(6).forEach(r => A.edit(r.week_monday, () => wk("regen")));
    await A.engine.push();
    check("SE19c (fixture) regenerated 6 weeks", t.rows().length === 6);
    A.mirror = {};
    const r = await A.engine.push();
    check("SE19c after clear + regenerate, a wipe of the re-created weeks is blocked again", r.blocked === true && t.rows().length === 6 && A.wipeBlocked.length === 1);
  });

  // SE19d — a wipe-blocked push still sends its other writes (D: one block mustn't hold every save).
  await run("SE19d", async () => {
    const t = mkTable(seedRows(6));
    const A = mkSession(t); await A.engine.load();
    W.slice(0, 4).forEach(k => A.drop(k));
    A.edit(W[4], w => (w.dayCall = "kept-edit", w));
    const r = await A.engine.push();
    check("SE19d the 4 wipe-shaped deletes are held, the edit to W5 is saved", r.blocked === true && t.rows().length === 6 && t.get(W[4]).data.dayCall === "kept-edit", JSON.stringify(r.results));
  });

  // SE19e — a clear whose deletes FAILED leaves them approved; if those weeks
  // are then re-created, the approval must go — a later partial wipe that
  // includes them is blocked again (D: approvedDeletes lifecycle).
  await run("SE19e", async () => {
    const t = mkTable(seedRows(6));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "DELETE", week: W[0], kind: "5xx-before" });
    t.control.fail({ method: "DELETE", week: W[1], kind: "5xx-before" });
    A.mirror = {};
    await A.engine.authoritative({}, true, "clear");
    t.control.fail({ method: "DELETE", kind: "5xx-before", count: 10 }); // keep the follow-up push from finishing the clear
    await A.engine.idle();
    t.control.clear();
    seedRows(6).forEach(r => A.edit(r.week_monday, () => wk("regen")));
    await A.engine.push();
    check("SE19e (fixture) the 6 weeks are re-created", t.rows().length === 6 && t.rows().every(r => r.data.dayCall === "regen"));
    [0, 1, 2].forEach(i => A.drop(W[i]));
    const r = await A.engine.push();
    check("SE19e dropping W1–W3 (two of them once approved for the clear) is blocked like any half-wipe", r.blocked === true && t.rows().length === 6, JSON.stringify(r));
  });

  // SE20 — an authorized clear whose DELETEs fail keeps them pending; later
  // ordinary pushes retry them WITHOUT a grant and without a wipe block (R7, R9).
  await run("SE20", async () => {
    const t = mkTable(seedRows(6));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "DELETE", week: W[0], kind: "5xx-before" });
    t.control.fail({ method: "DELETE", week: W[1], kind: "5xx-before" });
    A.mirror = {};
    const c = await A.engine.authoritative({}, true, "clear");
    check("SE20 the clear deleted 4, 2 failed and stay pending (not ok, but it wrote)", !c.ok && c.wrote && t.rows().length === 2 && A.engine.pending().length === 2, JSON.stringify(t.rows().map(r => r.week_monday)));
    await A.engine.idle();
    const r = await A.engine.push();
    check("SE20 R7/R9: the plain retry deletes the last 2 with no grant and no wipe block", t.rows().length === 0 && A.wipeBlocked.length === 0 && A.st().pending === 0, JSON.stringify({ r, blocked: A.wipeBlocked }));
  });

  // SE21 — R8: a CAS DELETE of a row someone else already deleted is SAVED.
  await run("SE21", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t); await A.engine.load();
    t.del(W[0]);
    A.drop(W[0]);
    const r = await A.engine.push();
    check("SE21 R8: DELETE matches 0 rows, read-back says the week is gone → saved, no toast, nothing pending",
      r.ok && A.toasts.length === 0 && A.st().pending === 0, JSON.stringify({ r: r.results, toasts: A.toasts }));
  });

  // SE22 — R35: a shrinking restore whose deletes fail never turns into false wipe blocks.
  await run("SE22", async () => {
    const t = mkTable(seedRows(10));
    const A = mkSession(t); await A.engine.load();
    const snap = clone(A.mirror); delete snap[W[8]]; delete snap[W[9]]; snap[W[0]] = wk("restored");
    t.control.fail({ method: "DELETE", kind: "5xx-before", count: 2 });
    A.mirror = clone(snap);
    const c = await A.engine.authoritative(snap, true, "restore");
    await A.engine.idle();
    await A.engine.push();
    check("SE22 R35: restore wrote W1, its 2 failed deletes go through on the following push (no wipe block), table = snapshot",
      !c.ok && A.wipeBlocked.length === 0 && sameData(tableSched(t), snap) && A.st().pending === 0, JSON.stringify({ c: c.results && c.results.map(x => x.outcome), blocked: A.wipeBlocked.length }));
  });

  // SE23 — I6: an authoritative job that can't read the table writes nothing.
  await run("SE23", async () => {
    const t = mkTable(seedRows(4));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "GET", kind: "5xx-before" });
    const from = t.log.length;
    const c = await A.engine.authoritative({}, true, "clear");
    check("SE23 I6: the whole-table read fails → the clear is refused with a reason, wrote:false, ZERO writes",
      !c.ok && c.wrote === false && /nothing was changed/.test(c.error || "") && writes(t, from).length === 0 && t.rows().length === 4, JSON.stringify(c));
    A.token = null;
    const c2 = await A.engine.authoritative({}, true, "clear");
    check("SE23 an expired sign-in refuses the clear up front (wrote:false, says sign in)", !c2.ok && c2.wrote === false && /sign in/i.test(c2.error || "") && t.rows().length === 4);
  });

  // SE24 — force mode: restore wins over a week changed after our last pull,
  // and deletes weeks this session never knew (whole-table read first).
  await run("SE24", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    const snap = clone(A.mirror); delete snap[W[2]];
    B.edit(W[0], w => (w.dayCall = "sB", w)); B.edit(W[2], w => (w.dayCall = "sB", w)); await B.engine.push();
    t.put({ week_monday: W[6], data: wk("unknown-to-A"), version: 1, updated_by: "user-b", updated_at: "2026-10-12T15:00:00+00:00" });
    A.mirror = clone(snap);
    const from = t.log.length;
    const c = await A.engine.authoritative(snap, true, "restore");
    const dels = writes(t, from).filter(e => e.method === "DELETE");
    check("SE24 force: the restore overwrites B's later W1 and deletes W3 + a week A never knew about; deletes carry no version",
      c.ok && sameData(tableSched(t), snap) && dels.length === 2 && dels.every(e => !/version=/.test(e.url)), JSON.stringify({ c: c.results, dels: dels.map(e => e.url) }));
  });

  // SE25/SE26 — auth (R27, I4).
  await run("SE25", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    t.control.expiredTokens.add("TOK_A");
    A.edit(W[0], w => (w.dayCall = "s9", w));
    const r = await A.engine.push();
    check("SE25 a write answered 401 → auth-needed for THAT token: status authNeeded, one 'sign-in has expired' toast pointing at 'Sign in again', the edit kept",
      !r.ok && A.st().authNeeded === true && A.engine.authBlocked() && A.toasts.length === 1 && /sign-in has expired/i.test(A.toasts[0]) && /Sign in again/.test(A.toasts[0]) && A.mirror[W[0]].dayCall === "s9", JSON.stringify({ r: r.results, toasts: A.toasts }));
    const from = t.log.length;
    await A.engine.push();
    check("SE25 the dead token is not sent again (no request until it changes)", t.log.length === from);
    A.readAsAnon = true; // the app reads with dbReadHeaders: anon once the token is stale
    B.edit(W[1], w => (w.dayCall = "sB", w)); await B.engine.push();
    await A.engine.pull();
    check("SE25 A7: while signed out of writes, the pull still works (anon read) and adopts B's change", A.mirror[W[1]].dayCall === "sB" && A.mirror[W[0]].dayCall === "s9");
    t.control.users.TOK_A2 = "user-a"; A.token = "TOK_A2"; A.readAsAnon = false; // "Sign in again" stored a new token
    const r2 = await A.engine.push();
    check("SE25 R27: after signing in again the pending week lands (no reload, no re-edit)", r2.ok && t.get(W[0]).data.dayCall === "s9" && A.st().authNeeded === false && !A.engine.authBlocked());
    A.token = null;
    check("SE25 no stored token at all → authBlocked, and nothing is written", A.engine.authBlocked());
  });
  await run("SE26", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t); await A.engine.load();
    t.control.expiredTokens.add("TOK_A");
    A.edit(W[0], w => (w.dayCall = "s9", w)); A.edit(W[1], w => (w.dayCall = "s8", w));
    const from = t.log.length;
    const r = await A.engine.push();
    check("SE26 a 401 mid-run → auth-needed: the run stops after the first week, both stay pending, nothing adopted or 'refused'",
      !r.ok && writes(t, from).length === 1 && A.engine.pending().length === 2 && A.st().conflicts.length === 0 && A.st().authNeeded && !A.toasts.some(m => /refused/.test(m)),
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

  // SE27b — a 400 is the server rejecting the content: keep the edit, don't
  // adopt, don't re-send it unchanged; a new edit is sent (D: status classes).
  await run("SE27b", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "PATCH", week: W[0], kind: "400" });
    A.edit(W[0], w => (w.dayCall = "bad", w));
    await A.engine.push();
    const from = t.log.length;
    await A.engine.push();
    const resent = writes(t, from).length;
    A.edit(W[0], w => (w.dayCall = "good", w));
    await A.engine.push();
    check("SE27b 400 → rejected: the edit stays on screen and pending, isn't re-sent unchanged, says so; a new edit is sent and lands",
      resent === 0 && A.toasts.some(m => /rejected/.test(m)) && t.get(W[0]).data.dayCall === "good" && A.st().pending === 0, JSON.stringify({ resent, toasts: A.toasts }));
  });

  // SE28 — RLS: a write filtered to 0 rows (row unchanged) is NOT a conflict.
  await run("SE28", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t, { token: "ANON" }); await A.engine.load(); // the anon key as the bearer (the server's anon role)
    A.edit(W[0], w => (w.dayCall = "s9", w));
    await A.engine.push();
    check("SE28 an RLS-filtered PATCH (0 rows, row unchanged) → pending + 'isn't allowed', never adopted as a conflict",
      A.mirror[W[0]].dayCall === "s9" && A.st().pending === 1 && A.st().noPermission.length === 1 && A.toasts.some(m => /isn't allowed/.test(m)) && A.st().conflicts.length === 0,
      JSON.stringify({ toasts: A.toasts, st: A.st() }));
  });

  // SE29 — the toast cap (R25, R36).
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

  // SE30 — keepalive (pagehide): CAS PATCHes for unsaved weeks the table has,
  // from the LATEST mirror; never an INSERT, never a delete (R1, R2, R6, R37, D).
  await run("SE30", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    B.edit(W[1], w => (w.dayCall = "sB", w)); await B.engine.push();
    A.edit(W[0], w => (w.dayCall = "a0", w));
    A.edit(W[1], w => (w.dayCall = "a1", w));
    A.edit(W[5], () => wk("new"));
    A.drop(W[2]);
    const reqs = A.engine.keepaliveRequests();
    check("SE30 keepalive: one CAS PATCH (version + updated_at) per edited known week, keepalive:true — NO insert, NO delete",
      reqs.length === 2 && reqs.every(x => x.init.keepalive === true && x.init.method === "PATCH" && /version=eq\.3&updated_at=eq\./.test(x.url) && !/merge-duplicates/.test(x.init.headers.Prefer || "")),
      JSON.stringify(reqs.map(x => x.init.method + " " + x.url.split("?")[1])));
    for (const x of reqs) await t.fetch(x.url, x.init);
    check("SE30 R1: fired, they save W1 but leave B's newer W2 alone (CAS 0 rows), and keep W3",
      t.get(W[0]).data.dayCall === "a0" && t.get(W[1]).data.dayCall === "sB" && !!t.get(W[2]), JSON.stringify(tableSched(t)[W[1]]));
    await A.engine.pull(); await A.engine.idle();
    check("SE30 the page survived: the landed keepalive reads as OURS (no conflict for W1); the stale W2 is the only conflict",
      A.st().conflicts.length === 1 && A.st().conflicts[0].k === W[1] && t.get(W[5]) && !t.get(W[2]), JSON.stringify(A.st().conflicts));
    A.token = null;
    check("SE30 no token → no keepalive requests", A.engine.keepaliveRequests().length === 0);
  });

  // SE30b — the keepalive's bodies are in the ledger: its PATCH lands, the
  // page survives, the user edits the week AGAIN before the next pull. The
  // server copy is the keepalive's (ours), not someone else's.
  await run("SE30b", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    A.edit(W[0], w => (w.dayCall = "k1", w));
    for (const x of A.engine.keepaliveRequests()) await t.fetch(x.url, x.init);
    A.edit(W[0], w => (w.dayCall = "k2", w));
    await A.engine.pull(); await A.engine.idle();
    check("SE30b the landed keepalive (k1) is OURS: no conflict, the newer edit k2 is sent at the new version and lands",
      t.get(W[0]).data.dayCall === "k2" && A.mirror[W[0]].dayCall === "k2" && A.st().conflicts.length === 0 && A.st().pending === 0,
      JSON.stringify({ table: t.get(W[0]).data.dayCall, mirror: A.mirror[W[0]].dayCall, c: A.st().conflicts }));
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
    check("SE31 R4: a week whose push failed is NOT skipped — the re-edit goes out on unload and lands", t.get(W[0]).data.dayCall === "second");
  });

  // SE32 — reset() (sign-out): fences jobs in flight and clears the mirror.
  await run("SE32", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    const B = mkSession(t, { token: "TOK_B", user: "user-b" }); await B.engine.load();
    B.edit(W[0], w => (w.dayCall = "sB", w)); await B.engine.push();
    const hold = t.control.pause({ method: "GET", count: 1, when: "after" });
    const pl = A.engine.pull(); await hold.arrived;
    t.control.fail({ method: "GET", kind: "5xx-before" }); // the reload reset() queues fails: the engine stays unloaded
    A.engine.reset();
    check("SE32 reset clears the mirror too (nothing of the old user stays on screen) and closes the load gate", JSON.stringify(A.mirror) === "{}" && !A.engine.isSeeded());
    const before = A.commits;
    hold.release(); await pl; await A.engine.idle();
    check("SE32 a pull in flight when the session resets adopts nothing, learns nothing, and the engine stays unloaded",
      A.commits === before && !A.engine.isSeeded() && A.engine.pending().length === 0 && A.engine.knownVersion(W[1]) === undefined && A.engine.knownVersion(W[0]) === undefined,
      JSON.stringify({ commits: A.commits - before, kv: [A.engine.knownVersion(W[0]), A.engine.knownVersion(W[1])] }));
    const t2 = mkTable(seedRows(2));
    const C = mkSession(t2), D = mkSession(t2, { token: "TOK_B", user: "user-b" });
    await C.engine.load(); await D.engine.load();
    D.edit(W[0], w => (w.dayCall = "sD", w)); await D.engine.push();
    const h2 = t2.control.pause({ method: "PATCH", count: 1, when: "after" });
    C.edit(W[0], w => (w.dayCall = "sC", w));
    const pu = C.engine.push(); await h2.arrived;
    t2.control.fail({ method: "GET", kind: "5xx-before" });
    C.engine.reset(); C.mirror = { next: "user" };
    const from = t2.log.length;
    h2.release(); await pu; await C.engine.idle();
    check("SE32 a push in flight across the reset sends nothing more and leaves the next user's mirror alone",
      JSON.stringify(C.mirror) === JSON.stringify({ next: "user" }) && C.toasts.length === 0 && writes(t2, from).length === 0, JSON.stringify({ mirror: C.mirror, toasts: C.toasts }));
    const from2 = t2.log.length;
    await C.engine.push();
    check("SE32 after a reset nothing is pushed until the next load (the old mirror can't be re-sent as the new user)", writes(t2, from2).length === 0 && C.engine.keepaliveRequests().length === 0);
    const t3 = mkTable(seedRows(3));
    const E = mkSession(t3); await E.engine.load();
    E.edit(W[0], w => (w.dayCall = "unsaved", w));
    await E.engine.reset();
    check("SE32 A8: reset() reads the table again (public / OR views refill) — the fresh table, not the old user's unsaved edit",
      E.engine.isSeeded() && sameData(E.mirror, tableSched(t3)) && E.engine.pending().length === 0);
  });

  // SE33 — not loaded: pushes are refused (load gate), a pull repairs it.
  await run("SE33", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t);
    t.control.fail({ method: "GET", kind: "5xx-before" });
    const l = await A.engine.load();
    check("SE33 a failed first read: not loaded, status says so (loadFailed)", !l.ok && !A.engine.isSeeded() && A.st().loadFailed === true);
    A.edit(W[0], () => wk("s9"));
    const from = t.log.length;
    const r = await A.engine.push();
    check("SE33 …and a push sends nothing (load gate)", r.skipped === "not-loaded" && t.log.length === from);
    A.mirror = {};
    await A.engine.pull();
    check("SE33 …the next pull repairs it with a whole-table read", A.engine.isSeeded() && sameData(A.mirror, tableSched(t)) && A.st().loadFailed === false);
  });

  // SE34 — load() when already loaded (sign in again) is a pull that then sends.
  await run("SE34", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    A.token = null;
    A.edit(W[0], w => (w.dayCall = "unsaved", w)); await A.engine.push();
    A.token = "TOK_A";
    const B = mkSession(t, { token: "TOK_B", user: "user-b" }); await B.engine.load();
    B.edit(W[1], w => (w.dayCall = "sB", w)); await B.engine.push();
    await A.engine.load();
    check("SE34 a second load is a pull, not a re-seed: the unsaved edit survives, B's change arrives, and the edit is then SENT",
      A.mirror[W[0]].dayCall === "unsaved" && A.mirror[W[1]].dayCall === "sB" && t.get(W[0]).data.dayCall === "unsaved" && A.engine.pending().length === 0,
      JSON.stringify({ w0: A.mirror[W[0]].dayCall, w1: A.mirror[W[1]].dayCall, table: t.get(W[0]).data.dayCall, pending: A.engine.pending() }));
    check("SE34 knownSchedule() is the table as last confirmed", sameData(A.engine.knownSchedule(), tableSched(t)));
  });

  // SE35 — read-only sessions (public / OR board) pull and never write.
  await run("SE35", async () => {
    const t = mkTable(seedRows(2));
    const P = mkSession(t, { canWrite: false, token: "TOK_A" }); await P.engine.load(); // a stored token on the device, but a public view
    P.edit(W[0], w => (w.dayCall = "x", w));
    const from = t.log.length;
    await P.engine.push(); await P.engine.pull();
    const c = await P.engine.authoritative({}, true, "clear");
    check("SE35 a read-only session sends no writes (push, pull, keepalive, even an authoritative job)", writes(t, from).length === 0 && P.engine.keepaliveRequests().length === 0 && !c.ok);
  });

  // SE36 — two writers converge.
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
    check("SE37 writes carry apikey + the user's bearer token + JSON content type", writes(t).length === 2 && writes(t).every(e => e.headers.apikey === "ANON" && e.headers.authorization === "Bearer TOK_A" && /application\/json/.test(e.headers["content-type"] || "")));
  });

  // SE38 — adoption builds from the LATEST mirror (an edit made while a pull
  // is in flight survives the pull's adoption of another week).
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

  // SE39 — own writes are recognised (D: the sent-ledger). A write commits
  // but both its response and its read-back are lost; the user then edits
  // again. The next push finds the EARLIER body on the server: that's ours,
  // not someone else's — no conflict, the newer edit is sent and lands.
  await run("SE39", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "PATCH", week: W[0], kind: "throw-after" });
    t.control.fail({ method: "GET", week: W[0], kind: "throw" });
    A.edit(W[0], w => (w.dayCall = "E1", w)); await A.engine.push();
    check("SE39 (fixture) E1 committed on the server, A doesn't know it", t.get(W[0]).data.dayCall === "E1" && A.st().pending === 1);
    A.edit(W[0], w => (w.dayCall = "E2", w));
    await A.engine.push();
    check("SE39 the read-back finds E1 = OUR earlier body → no conflict, no toast about someone else; E2 sent at the new version and lands",
      t.get(W[0]).data.dayCall === "E2" && A.mirror[W[0]].dayCall === "E2" && A.st().conflicts.length === 0 && !A.toasts.some(m => /someone else/.test(m)) && A.st().pending === 0,
      JSON.stringify({ table: t.get(W[0]).data.dayCall, toasts: A.toasts, c: A.st().conflicts }));
  });
  // SE40 — …and the Undo variant through a PULL: the minute pull must not
  // adopt our lost write over the Undo (it's ours AND unconfirmed).
  await run("SE40", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    const old = clone(A.mirror[W[0]]);
    t.control.fail({ method: "PATCH", week: W[0], kind: "5xx-after" });
    t.control.fail({ method: "GET", week: W[0], kind: "5xx-before" });
    A.edit(W[0], w => (w.dayCall = "EDIT", w)); await A.engine.push();
    A.mirror = Object.assign({}, A.mirror, { [W[0]]: old }); // Undo
    await A.engine.pull(); await A.engine.idle();
    check("SE40 the pull sees OUR lost EDIT on the server: keeps the Undo on screen and sends it — the table ends at the pre-edit week, no conflict",
      A.mirror[W[0]].dayCall === old.dayCall && t.get(W[0]).data.dayCall === old.dayCall && A.st().conflicts.length === 0 && A.st().pending === 0,
      JSON.stringify({ mirror: A.mirror[W[0]].dayCall, table: t.get(W[0]).data.dayCall, c: A.st().conflicts }));
  });

  // SE41 — the CAS pair (D): clear + regenerate re-inserts a week at v1. A
  // session still holding a pending edit at v1 must NOT overwrite it.
  await run("SE41", async () => {
    const t = mkTable(seedRows(2, 1));
    const A = mkSession(t), S = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await S.engine.load();
    t.control.fail({ method: "PATCH", week: W[0], kind: "5xx-before" });
    A.edit(W[0], w => (w.dayCall = "member-swap", w)); await A.engine.push(); // pending at v1
    S.mirror = {}; await S.engine.authoritative({}, true, "clear");
    seedRows(2).forEach(r => S.edit(r.week_monday, () => wk("regenerated"))); await S.engine.push();
    check("SE41 (fixture) the regenerated week is back at version 1", t.get(W[0]).version === 1 && t.get(W[0]).data.dayCall === "regenerated");
    A.canWrite = true;
    await A.engine.push();
    check("SE41 A's stale v1 edit does NOT land on the regenerated v1 row (updated_at differs) — it's a loud conflict",
      t.get(W[0]).data.dayCall === "regenerated" && A.mirror[W[0]].dayCall === "regenerated" && A.st().conflicts.length === 1, JSON.stringify({ table: t.get(W[0]).data.dayCall, c: A.st().conflicts }));
  });
  // SE42 — …and an old build's version-keeping upsert under a pending edit.
  await run("SE42", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "PATCH", week: W[0], kind: "5xx-before" });
    A.edit(W[0], w => (w.dayCall = "v2-edit", w)); await A.engine.push();
    await t.fetch(`${BASE}/rest/v1/schedule_weeks?on_conflict=week_monday`, { method: "POST", headers: { apikey: "ANON", Authorization: "Bearer TOK_B", "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ week_monday: W[0], data: wk("old-build-swap"), updated_by: "user-b", updated_at: "2026-10-12T16:00:00.000Z" }]) });
    await A.engine.push();
    check("SE42 2.11: an old build's blind upsert (same version) is NOT overwritten by A's pending edit — conflict, the old build's swap kept",
      t.get(W[0]).data.dayCall === "old-build-swap" && A.st().conflicts.length === 1, JSON.stringify(t.get(W[0]).data.dayCall));
  });

  // SE43 — a request that never settles times out; the chain keeps going (D).
  await run("SE43", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t, { timeouts: { read: 150, write: 150 } }); await A.engine.load();
    const hang = t.control.pause({ method: "PATCH", week: W[0], count: 1 }); // never released
    A.edit(W[0], w => (w.dayCall = "x", w));
    const p = A.engine.push();
    const pl = A.engine.pull();
    const r = await p;
    const pendingAfterTimeout = A.st().pending, failingAfterTimeout = A.st().failing;
    await pl;
    check("SE43 the hung PATCH times out → read back → still pending (failing), the chain is NOT wedged: the queued pull ran and its follow-up push landed the week",
      r && !r.ok && pendingAfterTimeout === 1 && failingAfterTimeout === 1 && t.log.some(e => e.method === "GET" && /select=week_monday,version,updated_at/.test(e.url))
        && t.get(W[0]).data.dayCall === "x" && A.st().pending === 0, JSON.stringify({ r: r && r.results, pendingAfterTimeout, failingAfterTimeout }));
    hang.release();
    // A5(b): a request started before the page was suspended (timers frozen)
    // is aborted on resume when it's older than its timeout.
    const t2 = mkTable(seedRows(2));
    const R = mkSession(t2, { timeouts: { read: 100000, write: 100000 } }); await R.engine.load();
    const hang2 = t2.control.pause({ method: "PATCH", week: W[0], count: 1 });
    R.edit(W[0], w => (w.dayCall = "y", w));
    const p2 = R.engine.push(); await hang2.arrived;
    ms += 200000; R.engine.onResume();
    const r2 = await p2;
    check("SE43 A5(b): onResume aborts a request older than its timeout — the job settles (pending), the chain moves on",
      r2 && !r2.ok && R.st().pending === 1, JSON.stringify(r2 && r2.results));
    hang2.release();
  });

  // SE44 — Undo is all-or-nothing (D): a snapshot that would revert a week
  // someone else changed since is refused whole; an unrelated adoption, or an
  // adoption that changed nothing, doesn't block it.
  await run("SE44", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    const snap = clone(A.mirror), snapEpoch = A.engine.epochNow();
    A.edit(W[0], w => (w.dayCall = "a", w)); A.edit(W[1], w => (w.dayCall = "a", w)); await A.engine.push(); // the action being undone
    B.edit(W[2], w => (w.dayCall = "b", w)); await B.engine.push();
    await A.engine.pull();
    let plan = A.engine.undoPlan(snap, snapEpoch);
    check("SE44 the undo would also revert W3, which someone else changed after the snapshot → blocked (all-or-nothing)",
      plan.touched.includes(W[2]) && plan.blocked.join() === W[2], JSON.stringify(plan));
    const snap2 = clone(A.mirror), e2 = A.engine.epochNow();
    A.edit(W[0], w => (w.dayCall = "a2", w)); await A.engine.push();
    await B.engine.pull(); B.edit(W[1], w => (w.dayCall = "b2", w)); await B.engine.push(); await A.engine.pull();
    plan = A.engine.undoPlan(snap2, e2);
    check("SE44 R15: undo of the W1 edit after B changed W2 → W2 is touched (would be reverted) → blocked, nothing applied",
      plan.blocked.join() === W[1] && plan.touched.includes(W[0]), JSON.stringify(plan));
    const snap3 = clone(A.mirror), e3 = A.engine.epochNow();
    A.edit(W[0], w => (w.dayCall = "a3", w)); await A.engine.push();
    B.edit(W[1], w => (w.dayCall = "b2", w)); // identical data, re-saved elsewhere: no change on screen
    t.put({ week_monday: W[1], data: clone(B.mirror[W[1]]), version: 9, updated_at: "2026-10-12T18:00:00+00:00" });
    await A.engine.pull();
    plan = A.engine.undoPlan(snap3, e3);
    check("SE44 an adoption that changed nothing on screen bumps no epoch → the undo of W1 is allowed", plan.blocked.length === 0 && plan.touched.join() === W[0], JSON.stringify(plan));
  });

  // SE45 — stale intents (D): changedSince names the weeks someone else
  // changed after a preview / suggestion / editor was made.
  await run("SE45", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    const stamp = A.engine.epochNow();
    B.edit(W[1], w => (w.dayCall = "b", w)); await B.engine.push(); await A.engine.pull();
    check("SE45 changedSince lists exactly the week adopted after the stamp", A.engine.changedSince([W[0], W[1], W[2]], stamp).join() === W[1]);
  });

  // SE46 — an internal error (a bug, not the network) is reported, stops the
  // job without changing state, and doesn't poison the chain (D).
  await run("SE46", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    A.userThrows = true;
    A.edit(W[0], w => (w.dayCall = "x", w));
    const r = await A.engine.push();
    A.userThrows = false;
    const r2 = await A.engine.push();
    check("SE46 a throwing dependency → onInternalError, the job returns internal, the next job runs and lands",
      r.internal && A.internal === 1 && r2.ok && t.get(W[0]).data.dayCall === "x", JSON.stringify({ r, r2 }));
    internal.length = 0; // expected here — not counted against SE-I
  });

  // SE47 — A4: classification on the BODY. A gateway's HTML 403, a 429 / 408 /
  // 413 are unknown (read back, kept, retried); a PostgREST 4xx with a code is
  // a rejection (kept, not re-sent unchanged); a 23505 duplicate on an insert
  // is read back (someone inserted it first → conflict). Only JSON 403 42501
  // adopts the server copy (SE27).
  await run("SE47", async () => {
    for (const kind of ["html-403", "429", "408", "413"]) {
      const t = mkTable(seedRows(2));
      const A = mkSession(t); await A.engine.load();
      t.control.fail({ method: "PATCH", week: W[0], kind });
      A.edit(W[0], w => (w.dayCall = "s9", w));
      await A.engine.push();
      const kept = A.mirror[W[0]].dayCall === "s9" && A.st().failing === 1 && A.st().conflicts.length === 0 && !A.toasts.some(m => /refused|rejected/.test(m));
      await A.engine.push();
      check(`SE47 ${kind} → unknown: read back, the edit kept and pending (never adopted, never 'refused'), and the retry lands`, kept && t.get(W[0]).data.dayCall === "s9" && A.st().pending === 0, JSON.stringify({ kind, toasts: A.toasts }));
    }
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "PATCH", week: W[0], kind: "400-schema" });
    A.edit(W[0], w => (w.dayCall = "s9", w));
    await A.engine.push();
    check("SE47 a PostgREST 400 PGRST204 (schema) → rejected: kept on screen, pending, the code named, never adopted",
      A.mirror[W[0]].dayCall === "s9" && A.st().rejected.join() === W[0] && A.toasts.some(m => /PGRST204/.test(m)) && A.st().conflicts.length === 0, JSON.stringify(A.toasts));
    const t2 = mkTable(seedRows(1));
    const P = mkSession(t2), Q = mkSession(t2, { token: "TOK_B", user: "user-b" });
    await P.engine.load(); await Q.engine.load();
    Q.edit(W[4], () => wk("theirs")); await Q.engine.push();
    P.edit(W[4], () => wk("mine")); await P.engine.push();
    check("SE47 a 409 duplicate on an insert (someone created the week first) → read back → a loud conflict, theirs shown", P.mirror[W[4]].dayCall === "theirs" && P.st().conflicts.length === 1);
  });

  // SE48 — A3: Undo while the read-back is in flight. The PATCH committed
  // behind a 504; during its read-back the user undoes. The read-back finds
  // OUR body: the Undo stays on screen, the week stays pending, and the next
  // write goes out at the NEW version — no re-send of the undone edit.
  await run("SE48", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    const old = clone(A.mirror[W[0]]);
    t.control.fail({ method: "PATCH", week: W[0], kind: "5xx-after" });
    const hold = t.control.pause({ method: "GET", week: W[0], count: 1 });
    A.edit(W[0], w => (w.dayCall = "E", w));
    const p = A.engine.push(); await hold.arrived;
    A.mirror = Object.assign({}, A.mirror, { [W[0]]: old }); // Undo
    hold.release(); await p;
    const patches = t.log.filter(e => e.method === "PATCH").length;
    check("SE48 the read-back's own body is recognised; the undone edit is NOT sent again; the Undo is still on screen and pending",
      patches === 1 && A.mirror[W[0]].dayCall === old.dayCall && A.engine.pending().join() === W[0] && A.st().conflicts.length === 0, JSON.stringify({ patches, pending: A.engine.pending() }));
    const from = t.log.length;
    await A.engine.push();
    const w = writes(t, from);
    check("SE48 …the next push writes the Undo at version 4 and the table ends at the pre-edit week", w.length === 1 && /version=eq\.4/.test(w[0].url) && t.get(W[0]).data.dayCall === old.dayCall);
  });

  // SE49 — A3: an edit made while a pull's week GET is in flight survives
  // the pull and later settles as a loud conflict.
  await run("SE49", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    B.edit(W[0], w => (w.dayCall = "sB", w)); await B.engine.push();
    A.canWrite = false;
    const hold = t.control.pause({ method: "GET", week: W[0], count: 1, when: "after" });
    const pl = A.engine.pull(); await hold.arrived;
    A.edit(W[0], w => (w.dayCall = "sA", w));
    hold.release(); await pl;
    check("SE49 the pull did NOT adopt over the edit made while it was out", A.mirror[W[0]].dayCall === "sA");
    A.canWrite = true; await A.engine.push();
    check("SE49 …and the push settles it loudly as a conflict (theirs shown, a toast, a conflict entry)", A.mirror[W[0]].dayCall === "sB" && A.toasts.some(m => /someone else/.test(m)) && A.st().conflicts.length === 1);
  });

  // SE50 — A11: a pull that is running when a restore is requested adopts
  // nothing (the restore owns the weeks); the table and the screen end at
  // the snapshot; no "changed by someone else" mid-restore; the follow-up
  // push writes nothing.
  await run("SE50", async () => {
    const t = mkTable(seedRows(4));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    const snap = clone(A.mirror); snap[W[0]] = wk("snap"); delete snap[W[3]];
    B.edit(W[1], w => (w.dayCall = "peer", w)); await B.engine.push();
    const hold = t.control.pause({ method: "GET", count: 1, when: "after" });
    const pl = A.engine.pull(); await hold.arrived;
    A.mirror = clone(snap);
    const rp = A.engine.authoritative(snap, true, "restore");
    hold.release(); await pl; const r = await rp; await A.engine.idle();
    const from = t.log.length; await A.engine.push();
    check("SE50 the running pull deferred; restore wins: table = screen = snapshot, no conflict toast, the next push writes nothing",
      r.ok && sameData(tableSched(t), snap) && sameData(A.mirror, snap) && A.st().conflicts.length === 0 && !A.toasts.some(m => /someone else/.test(m)) && writes(t, from).length === 0,
      JSON.stringify({ ok: r.ok, w1: A.mirror[W[1]] && A.mirror[W[1]].dayCall, toasts: A.toasts }));
  });

  // SE51 — A14: a phone that never adopted a full clear made elsewhere (the
  // empty list is never adopted) says so, and its Regenerate still works: the
  // publish job re-reads just the period's weeks and re-inserts them; weeks
  // outside the period (and their pending edits) are untouched.
  await run("SE51", async () => {
    const t = mkTable(seedRows(6));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    A.mirror = {}; await A.engine.authoritative({}, true, "clear");
    await B.engine.pull();
    check("SE51 B's pull sees an empty table while it knows 6 weeks: not adopted, and the status says the screen is out of date", B.st().staleRemovals === 6 && Object.keys(B.mirror).length === 6);
    t.control.fail({ method: "POST", week: W[8], kind: "5xx-before", count: 1 });
    B.edit(W[8], () => wk("outside")); await B.engine.push(); // a pending NEW week outside the period
    const period = [W[0], W[1], W[2]];
    const gen = {}; period.forEach(k => { gen[k] = wk("regen"); });
    B.mirror = Object.assign({}, B.mirror, gen);
    const r = await B.engine.authoritative(B.mirror, false, "publish", period);
    check("SE51 publish: the 3 period weeks are inserted (absent → re-inserted, not 'changed by someone else'), nothing else written or deleted",
      r.ok && period.every(k => t.get(k) && t.get(k).data.dayCall === "regen") && t.rows().length === 3 && B.st().conflicts.length === 0, JSON.stringify({ r: r.results, rows: t.rows().map(x => x.week_monday) }));
    check("SE51 the pending edit outside the period is still on screen and pending (not reverted by the publish)", B.mirror[W[8]] && B.mirror[W[8]].dayCall === "outside" && B.engine.pending().includes(W[8]));
  });

  // SE52 — A16: one push with 3 conflicts and 1 failing week → exactly ONE toast
  // naming the 3 weeks AND the failing count; 3 persistent conflict entries.
  await run("SE52", async () => {
    const t = mkTable(seedRows(4));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    [0, 1, 2].forEach(i => B.edit(W[i], w => (w.dayCall = "sB", w))); await B.engine.push();
    [0, 1, 2, 3].forEach(i => A.edit(W[i], w => (w.dayCall = "sA", w)));
    t.control.fail({ method: "PATCH", week: W[3], kind: "5xx-before" });
    await A.engine.push();
    check("SE52 exactly one toast: the 3 replaced weeks and the 1 not saved; 3 conflict entries",
      A.toasts.length === 1 && /weeks of/.test(A.toasts[0]) && /Couldn't save 1 week/.test(A.toasts[0]) && A.st().conflicts.length === 3, JSON.stringify(A.toasts));
  });

  // SE53 — A5: a push stops at the first request that never answered (the
  // network is likely gone) instead of walking every week into a timeout;
  // the next push sends them all.
  await run("SE53", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ week: W[0], kind: "throw", count: 2 }); // the PATCH and its read-back
    [0, 1, 2].forEach(i => A.edit(W[i], w => (w.dayCall = "x" + i, w)));
    await A.engine.push();
    const patches1 = t.log.filter(e => e.method === "PATCH").length;
    await A.engine.push();
    check("SE53 one dead request stops the job (1 PATCH, not 3); the next push lands all three",
      patches1 === 1 && [0, 1, 2].every(i => t.get(W[i]).data.dayCall === "x" + i) && A.st().pending === 0, JSON.stringify({ patches1 }));
  });

  // SE-I — no scenario above produced an internal error.
  check("SE-I no internal (non-network) error in any scenario", internal.length === 0, internal.slice(0, 3).join(" | "));
}

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
