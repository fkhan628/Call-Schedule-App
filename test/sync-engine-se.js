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
// invariants, D-n the design review of rev 1, A-n the design review's
// amendments. The harness rule (A17(c)): every session records its toasts,
// the engine's internal errors and its CAUGHT callback errors, and the engine's
// context has a recording console; SE-I fails on any of them unexpected.
// SE-X runs the app's code around the engine (the real component slices) the
// same way. Called from test/sync-guards.js (CI runs that file); also runnable
// alone:  node test/sync-engine-se.js
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
// 16/n (E5): a publish refused for the sign-in — its weeks stay, pending, and are sent once signed in again.
const PUB_AUTH = "Your sign-in has expired — the new weeks stay on this screen and will be saved once you sign in again (tap \"Sign in again\" at the top). Nobody was notified.";

function extractEngine(src) {
  const nsrc = src.replace(/\r\n/g, "\n");
  const START = "function createSchedSync(deps) {";
  const END = "// ═══ END SYNC ENGINE v2 ═══";
  const s = nsrc.indexOf(START), e = nsrc.indexOf(END);
  if (s === -1 || e === -1 || nsrc.indexOf(START, s + 1) !== -1) return null;
  return nsrc.slice(s, e);
}
// A fresh context with only what a browser page gives the engine — and a
// console that RECORDS (A17(c)): the engine reports through deps (log,
// onInternalError), never the console, so any console call from it is
// unexpected and fails SE-I.
const engineConsole = [];
const recConsole = (into) => { const f = (lvl) => (...a) => into.push(lvl + ": " + a.map(x => (x && x.stack ? String(x.message) : String(x))).join(" ")); return { error: f("error"), warn: f("warn"), log: f("log"), info: f("info") }; };
// The engine's `log` dep, recording a CAUGHT error: a callback of the app's
// that threw ("onToast threw", "onAdopted threw", …). (Its other lines are the
// network's — a failed pull's reason, a suppressed removal — not errors.)
const caughtLog = (into) => (...a) => { if (/ threw$/.test(String(a[0]))) into.push(a.map(x => (x && x.stack ? String(x.message) : String(x))).join(" ")); };
const compile = (code) => vm.runInContext(`${code}; createSchedSync`, vm.createContext({ AbortController, setTimeout, clearTimeout, console: recConsole(engineConsole) }), { filename: "createSchedSync.js" });
const compileMerge = (code) => vm.runInContext(`${code}; mergeEditorEdits`, vm.createContext({}), { filename: "mergeEditorEdits.js" });
// The header's ONE line (A16) — the module-scope schedSyncLine, outside the
// engine's anchors (so an engine mutant never touches it): the scenarios read
// it off the onStatus REPORTS, as the header does (16/n, review r1 app-2).
function extractLine(src) {
  const nsrc = src.replace(/\r\n/g, "\n"), START = "function schedSyncLine(st, o) {";
  const a = nsrc.indexOf(START);
  if (a === -1 || nsrc.indexOf(START, a + 1) !== -1) return null;
  const b = nsrc.indexOf("\n}\n", a);
  if (b === -1) return null;
  try { return vm.runInContext(`(${nsrc.slice(a, b + 2)})`, vm.createContext({}), { filename: "schedSyncLine.js" }); } catch (ex) { return null; }
}

module.exports = async function runSE({ src, check }) {
  console.log("\nSE. sync engine v2 (the real createSchedSync on an emulated schedule_weeks)");
  const engSrc = extractEngine(src);
  check("SE0 createSchedSync is extractable by its anchors (exactly one definition)", !!engSrc);
  if (!engSrc) return;
  let createSchedSync, merge;
  try { createSchedSync = compile(engSrc); merge = compileMerge(engSrc); }
  catch (ex) { check("SE0 createSchedSync compiles standalone", false, String(ex)); return; }
  const line = extractLine(src);
  check("SE0 schedSyncLine (the header's one line) is extractable by its anchor and compiles standalone", typeof line === "function");
  if (typeof line !== "function") return;
  await scenarios(createSchedSync, check, line);
  console.log("\nSE-X. the app's code around the engine — the REAL component slices on the real engine and the emulated table");
  await appScenarios(src, createSchedSync, merge, check);

  // ── SE-M. Mutant battery ──
  // Each mutant re-breaks one thing the reviews found (or one guarantee); the
  // scenarios must turn red for every one. A mutant whose anchor is gone fails
  // too, so a refactor can't quietly retire one. An engine mutant (the default)
  // edits the engine's anchors (createSchedSync + mergeEditorEdits): it runs the
  // engine scenarios, then — only if those all stay green — the SE-X app
  // scenarios on the mutated engine. An `app` mutant edits the component code
  // outside the anchors: it runs the SE-X app scenarios on that source. `edits`
  // lists several [from, to] pairs for one bug.
  console.log("\nSE-M. mutant battery (each must turn at least one SE check red)");
  for (const m of MUTANTS) {
    const edits = m.edits || [[m.from, m.to]];
    const hay = m.app ? src.replace(/\r\n/g, "\n") : engSrc;
    const counts = edits.map(([f]) => hay.split(f).length - 1);
    if (counts.some(n => n !== 1)) { check(`SE-M ${m.id} anchor present exactly once (${m.what})`, false, `found ${counts.join(" / ")}`); continue; }
    const mutated = edits.reduce((s, [f, t]) => s.replace(f, () => t), hay);
    let red = 0, mutant = createSchedSync, mMerge = merge;
    if (!m.app) { try { mutant = compile(mutated); mMerge = compileMerge(mutated); } catch (ex) { check(`SE-M ${m.id} compiles`, false, String(ex)); continue; } }
    const quiet = (name, cond) => { if (!cond) red++; };
    const log = console.log; console.log = () => {};
    try {
      if (!m.app) await scenarios(mutant, quiet, line);
      if (red === 0) await appScenarios(m.app ? mutated : src, mutant, mMerge, quiet);
    } finally { console.log = log; }
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
    // (re-pinned 21/n: the call now passes the 0-row body — H1; the same mutation)
    from: '      const how = classify(k, rb.row, kind === "ok" && Array.isArray(r.body) && r.body.length === 0 ? c : undefined); // (0 rows: this body did not land — H1)\n      if (how === "mirror") { confirm(k, rb.row); return { k, outcome: "saved" }; }', to: '      const how = "theirs";\n      if (how === "mirror") { confirm(k, rb.row); return { k, outcome: "saved" }; }' },
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
    from: " && d.nowMs() - lastFail.at <= 5 * 60 * 1000) return null;", to: ") return null;" },
  { id: "M17", what: "a new week is a merge-duplicates upsert (overwrites a row someone inserted)",
    from: 'else { url = base(); init = { method: "POST", headers: wh({ Prefer: "return=representation" })',
    to: 'else { url = base() + "?on_conflict=week_monday"; init = { method: "POST", headers: wh({ Prefer: "resolution=merge-duplicates,return=representation" })' },
  { id: "M18", what: "clear/restore act on the last-known weeks instead of re-reading the table (I6)",
    from: "        known = {}; rows.forEach(x => { known[x.week_monday] = fromRow(x); });\n", to: "" },
  { id: "M19", what: "clear/restore write even when the table can't be read (I6 fail closed)",
    from: '        if (!rows) return refuse({ ok: false, wrote: false, error: "Couldn\'t read the saved schedule — nothing was changed." });\n',
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
  { id: "M26", what: "a body the server rejected (400) is re-sent on every push, its backoff ignored",
    from: "const sendable = changed.filter(k => !heldBack(k, target[k]));", to: "const sendable = changed;" },
  { id: "M27", what: "a 400 is treated as a refusal (adopts the server copy, discarding the edit — D)",
    from: 'return code ? "rejected" : "unknown";', to: 'return code ? "refused" : "unknown";' },
  { id: "M28", what: "approvedDeletes are never pruned (a re-created week's old approval exempts a later wipe — A12)",
    from: "    [...approvedDeletes.keys()].forEach(k => { if (!deletes.includes(k) || !known[k] || approvedDeletes.get(k) !== known[k].version) approvedDeletes.delete(k); });\n", to: "" },
  { id: "M30", what: "a gateway's HTML 403 is taken as a permission refusal (adopts the server copy, drops the edit — A4)",
    from: 'if (r.status === 403) return code === "42501" ? "refused" : "unknown";', to: 'if (r.status === 403) return "refused";' },
  { id: "M31", what: "a push walks every week into a timeout instead of stopping at the first dead request (A5)",
    from: "      const x = await writeWeek(k, clone(target[k]), job.mode, by, g);\n      results.push(x);\n      if (x.outcome === \"auth\" || x.thrown) stop = true;",
    to: "      const x = await writeWeek(k, clone(target[k]), job.mode, by, g);\n      results.push(x);\n      if (x.outcome === \"auth\") stop = true;" },
  { id: "M32", what: "a pull running when a clear/restore is requested still adopts (A11)",
    from: "    if (authoritativeQueued > 0) return { ok: false, skipped: \"authoritative-queued\" };\n    const cur0", to: "    const cur0" },
  { id: "M33", what: "adoption ignores an edit made while the request was out (A3)",
    from: "      if (expect && k in expect && expect[k] !== shown) return;\n", to: "" },
  { id: "M34", what: "a clear/restore re-commits weeks whose write FAILED (they'd stop being retried — R7)",
    from: "showKnown(startShown, saved);", to: "showKnown(startShown);" },
  { id: "M35", what: "a re-send after recognising our own earlier body ignores that the screen moved on (re-sends an undone edit — A3)",
    from: "if (mode !== \"force\" && canon((d.getState() || {})[k]) !== c) return { k, outcome: \"superseded\" }; ", to: "" },
  { id: "M36", what: "the stale-removal status is never cleared by a later pull (the header says 'reload to resync' forever — A14)",
    from: '    else { removalSig = ""; staleRemovals = 0; }\n', to: '    else { removalSig = ""; }\n' },
  { id: "M37", what: "an empty list sets the stale-removal status without reporting it (the header, fed by onStatus, never shows it — A14)",
    from: "staleRemovals = Object.keys(known).length; report();", to: "staleRemovals = Object.keys(known).length;" },
  { id: "M38", what: "the weeks a queued / running clear, restore or publish is writing are reported as pending ('not saved' mid-clear — A11(4))",
    from: "    const p = pendingKeys().filter(k => !ownedKey(k));\n", to: "    const p = pendingKeys();\n" },
  { id: "M39", what: "a clear / restore / publish hands its weeks back only after its last report (a week it couldn't write isn't shown pending — A11(4))",
    from: "    finally { release(); busy = null; report(); }", to: "    finally { busy = null; report(); }" },
  { id: "M40", what: "no stall watchdog (a stuck chain never says so — A5(g))",
    from: "if (running && !stalled) { stalled = true; report(); }", to: "" },
  { id: "M41", what: "progress doesn't clear a reported stall ('Sync stalled' forever — A5(g))",
    from: "    if (stalled) { stalled = false; report(); }\n", to: "" },
  { id: "M42", what: "a clear not started by its deadline isn't cancelled (it runs later, after the caller was told nothing changed — A5(f))",
    from: "if (!owner.state.started) { owner.state.cancelled = true; owner.release();", to: "if (!owner.state.started) { owner.release();" },
  { id: "M43", what: "no deadline: a caller waits as long as the chain is stuck (A5(f))",
    from: "    const timer = setTimeout(() => { if (!done) { done = true; resolve(late()); } }, T.deadline);\n", to: "    const timer = null;\n" },
  { id: "M44", what: "a job already writing at its deadline is reported as cancelled ('nothing was changed' while it writes — A5(f))",
    from: "        if (!owner.state.started) { owner.state.cancelled = true;", to: "        if (true) { owner.state.cancelled = true;" },
  { id: "M45", what: "the outcome of a job that ran past its deadline is never told (A5(f))",
    from: "        p.then(r => tellLate(owner.what, r, late));\n", to: "" },
  { id: "M46", what: "a sign-out doesn't cancel a clear still waiting for its turn (it runs under the next account — A8)",
    from: "      [...owners].forEach(o => { if (!o.state.started) { o.state.cancelled = true; o.release(); } });", to: "" },
  { id: "M47", what: "onAdopted is never called (an open week editor only finds out at Save — A13)",
    from: "    if (changed.length && d.onAdopted) { try { d.onAdopted(changed.slice()); } catch (e) { log(\"onAdopted threw\", e); } }\n", to: "" },
  { id: "M48", what: "onAdopted is called before the adoption is on screen (A13)",
    from: "    if (changed.length) d.commit(next);\n    if (why === \"conflict\"", to: "    if (changed.length && d.onAdopted) d.onAdopted(changed.slice());\n    if (changed.length) d.commit(next);\n    if (why === \"conflict\"" },
  { id: "M49", what: "reads keep sending the token the server refused (a skewed clock calls it fresh: every pull 401s — A7 / I5)",
    from: 'const rh = () => Object.assign({}, authState() === "expired" ? d.anonHeaders() : d.readHeaders());', to: "const rh = () => Object.assign({}, d.readHeaders());" },
  { id: "M50", what: "a publish takes someone else's copy of ANY unconfirmed week as known (the follow-up push overwrites it — the §7b I2 hole)",
    from: 'else if (how === "theirs" && (job.mode !== "force" || (job.keys && !job.keys.has(k)))) {', to: 'else if (how === "theirs" && job.mode !== "force") {' },
  { id: "M51", what: "a conflict on a week outside a publish's period makes the publish 'not landed' (no Regenerated!, no broadcast)",
    from: "const ok = results.filter(x => !job.keys || job.keys.has(x.k)).every(", to: "const ok = results.every(" },
  { id: "M52", what: "a rejected body is never retried until it changes (A4: retry with backoff)",
    from: "return !!x && x.canon === canon(body) && d.nowMs() - x.at < Math.min(T.retry * Math.pow(2, x.tries - 1), T.retryMax);", to: "return !!x && x.canon === canon(body);" },
  { id: "M53", what: "the retry backoff never grows (A4)",
    from: "Math.min(T.retry * Math.pow(2, x.tries - 1), T.retryMax)", to: "Math.min(T.retry, T.retryMax)" },
  { id: "M54", what: "every rejection is toasted, not once per new code (A4)",
    from: "rej.forEach(x => { if (!toldCodes.has(x.code))", to: "rej.forEach(x => { if (true)" },
  { id: "M55", what: "the rejection toast's reason isn't writeFailReason's (A4)",
    from: "reason: writeFailReason(r.body), at:", to: "reason: \"it was not saved\", at:" },
  { id: "M56", what: "the status carries no rejection codes (the header can't name them — A4)",
    from: "rejectCodes: [...new Set(rej.map(k => rejected[k].code))].sort(),", to: "rejectCodes: []," },
  { id: "M57", what: "a told code is never forgotten (a rejection that comes back after landing says nothing — A4)",
    from: "    [...toldCodes].forEach(c => { if (!stillRejected.has(c)) toldCodes.delete(c); });\n", to: "" },
  { id: "M58", what: "a rejected DELETE is re-sent on every push, its backoff ignored (A4)",
    from: "      if (heldBack(k, undefined)) { heldDeletes++; continue; }\n", to: "" },
  { id: "M59", what: "editing a replaced week again leaves its conflicts entry (A16)",
    from: "    if (job.mode !== \"force\") dropEditedConflicts();\n", to: "" },
  { id: "M60", what: "a clear / restore / publish drops the conflicts entries too (A16: the item must outlive it)",
    from: "    if (job.mode !== \"force\") dropEditedConflicts();\n", to: "    dropEditedConflicts();\n" },
  // 14/n — a clear / reset / restore / publish is quiet: its caller's ONE message carries the job's notice (SE66)
  { id: "M61", what: "a quiet job toasts anyway (two messages compete for the one toast slot)",
    from: 'const tell = (m) => { if (!quiet) say(m, "error"); return m; };', to: 'const tell = (m) => { say(m, "error"); return m; };' },
  { id: "M62", what: "an authoritative job hands back no notice (its caller can't say which weeks, or why)",
    from: "    if (job.quiet) out.notice = notice || null; // what this job would have toasted: its caller's one message carries it\n", to: "" },
  { id: "M63", what: "authoritative jobs aren't quiet (the engine's toast and the caller's compete)",
    from: "keys, quiet: true }); // its caller tells the outcome", to: "keys }); // its caller tells the outcome" },
  { id: "M64", what: "a deletion that didn't land is called 'not saved' (a clear's message reads wrong)",
    from: "del = n > 0 && failing.every(k => !(k in shown))", to: "del = false" },
  { id: "M65", what: "a quiet job doesn't start the cap (the follow-up push repeats the caller's message)",
    from: "    lastFail.keys = keys; lastFail.kind = kind; lastFail.at = d.nowMs();\n    return tell(failMsg);", to: "    if (!quiet) { lastFail.keys = keys; lastFail.kind = kind; lastFail.at = d.nowMs(); }\n    return tell(failMsg);" },
  { id: "M66", what: "a quiet job's notice is capped (a second clear within 5 min says nothing of the week)",
    from: "if (!quiet && keys === lastFail.keys", to: "if (keys === lastFail.keys" },
  { id: "M67", what: "a job ending after its caller stopped waiting drops its notice from the late toast",
    from: 'const extra = r && r.notice ? " " + r.notice : "";', to: 'const extra = "";' },
  // 14/n — a clear / reset / restore that writes nothing puts the screen back IN the job (SE67)
  { id: "M68", what: "a refused clear / restore leaves its target on screen (the follow-up push sends a refused restore; a refused clear trips the wipe guard)",
    from: "const refuse = (out) => { if (!keys && gen === g && !handOver(owner)) tellTheirs(out, showKnown(startShown, null, before, knownAt)); return out; };", to: "const refuse = (out) => out;" },
  { id: "M69", what: "putting the screen back overwrites a week edited after the tap",
    from: "      if (shownNow !== (k in startShown ? startShown[k] : DEL)) return;\n      const has = before ? k in before", to: "      const has = before ? k in before" },
  { id: "M70", what: "a clear cancelled at its deadline leaves its target on screen",
    from: "          if (!keys && !handOver(owner)) tellTheirs(out, showKnown(owner.startShown, null, owner.before, owner.knownAt));\n          report(); return out;", to: "          report(); return out;" },
  { id: "M71", what: "a refused publish takes its generated weeks off screen (they'd never be retried — A14)",
    from: "const refuse = (out) => { if (!keys && gen === g && !handOver(owner)) tellTheirs(out, showKnown(startShown, null, before, knownAt)); return out; };", to: "const refuse = (out) => { if (gen === g && !handOver(owner)) tellTheirs(out, showKnown(startShown, null, before, knownAt)); return out; };" },
  // 15/n — A17(f): the list's missing ones, and the new emulator capabilities' (A17(d))
  { id: "M72", what: "no ledger at all: nothing sent is remembered (our own lost-response writes read as someone else's — A1)",
    from: "const addSent = (k, c) => { (sent[k] = sent[k] || []).push(c); if (sent[k].length > 20) sent[k].shift(); };", to: "const addSent = (k, c) => {};" },
  { id: "M73", what: "no epoch filter for intents: changedSince never names an adopted week (a preview / publish overwrites someone else's change — A13)",
    from: "changedSince: (keys, sinceEpoch) => (keys || []).filter(k => (adoptEpoch[k] || 0) > sinceEpoch),", to: "changedSince: (keys, sinceEpoch) => []," },
  { id: "M74", what: "no epoch filter for the editor: epochOf never moves (a save over someone else's change to an edited slot isn't refused — §2.6)",
    from: "epochOf: (k) => adoptEpoch[k] || 0,", to: "epochOf: (k) => 0," },
  { id: "M75", what: "mergeEditorEdits ignores the adoption epoch (the editor writes its slot over someone else's — §2.6, A17(a))",
    from: "  if ((adoptEpochOfWeek || 0) > (openEpoch || 0)) {", to: "  if (false) {" },
  { id: "M76", what: "the keepalive is sent as a POST (A9)",
    from: 'init: { method: "PATCH", keepalive: true', to: 'init: { method: "POST", keepalive: true' },
  { id: "M77", what: "the keepalive INSERTS new weeks (a stalled one resurrects a week deleted later — A9)",
    edits: [["return diff(target).changed.filter(k => known[k] && !inFlight.has(k)", "return diff(target).changed.filter(k => !inFlight.has(k)"],
      ["      const kn = known[k];\n      addSent(k, canon(target[k]));\n      return { url:", '      const kn = known[k];\n      addSent(k, canon(target[k]));\n      if (!kn) return { url: base(), init: { method: "POST", keepalive: true, headers: wh({ Prefer: "return=minimal" }), body: JSON.stringify({ week_monday: k, data: target[k], version: 1, updated_by: by, updated_at: ts }) } };\n      return { url:']] },
  { id: "M78", what: "known.updated_at taken from the body this client sent, not the server's row (A2: wrong CAS against a server that renders it)",
    from: "        confirm(k, row, true);\n        // The server stored something other", to: "        confirm(k, row && Object.assign({}, row, { updated_at: ts }), true);\n        // The server stored something other" },
  { id: "M79", what: "the keepalive's CAS on the version alone (a stalled one lands on a week re-created at v1 — A2/A9)",
    from: 'return { url: `${base()}?week_monday=eq.${k}&${cas(kn)}`, init: { method: "PATCH", keepalive: true', to: 'return { url: `${base()}?week_monday=eq.${k}&version=eq.${kn.version}`, init: { method: "PATCH", keepalive: true' },
  { id: "M80", what: "a 404 PGRST205 is a client error (no read-back; 'reload/update the app' — A4: unknown)",
    from: "if ([404, 408, 413, 429].includes(r.status)", to: "if ([408, 413, 429].includes(r.status)" },
  { id: "M81", what: "the same data under a new token is someone else's (an old build's unchanged re-send costs the edit — A2)",
    // (re-pinned 21/n: "refreshed" now has H1's condition; the same mutation — its return removed)
    from: '      if (!out.length || ((row.version === undefined ? null : row.version) === kn.version && kn.version !== 1)) return "refreshed";\n', to: "" },
  // 16/n — review round 1, the engine items (E1–E5) and the test gaps (T1–T3: the reviewer's T24b, T2, N37)
  { id: "M82", what: "E1: a push already in its re-read when a clear / restore is requested doesn't re-check for an owner (it sends the job's target: a false wipe block, a refused restore's writes landing — A11)",
    from: '    if (job.mode !== "force" && authoritativeQueued > 0) { if (results.length) toasts(results); report(); return { ok: false, skipped: "authoritative-queued", results }; }\n', to: "" },
  { id: "M83", what: "E2: a read the server refuses for the stored token never marks it dead (a session with nothing pending: no authNeeded, no sign-in line — I5)",
    from: "    deadToken = tok; report();\n", to: "    report();\n" },
  { id: "M84", what: "E2: a read refused for the stored token isn't retried as anon (the pull adopts nothing for as long as the clock calls the token fresh — I5)",
    from: '    deadToken = tok; report();\n    return req(url, { method: "GET", headers: Object.assign({}, d.anonHeaders()) }, T.read);\n', to: "    deadToken = tok; report();\n    return r;\n" },
  { id: "M85", what: "E2: a read refused for the token is reported only when its job ends (the sign-in line waits for the anon retry's answer)",
    from: "    deadToken = tok; report();\n", to: "    deadToken = tok;\n" },
  { id: "M86", what: "E2: a 42501 permission error on a read counts as a dead token (RLS refusing the role is not the sign-in)",
    from: 'kindOf(r) !== "auth" || perm || canon(h)', to: 'kindOf(r) !== "auth" || canon(h)' },
  { id: "M87", what: "E2: a read that already went out as ANON marks the stored token dead when it's refused (not the token's answer)",
    from: " || canon(h) === canon(Object.assign({}, d.anonHeaders()))) return r;", to: ") return r;" },
  { id: "M88", what: "E2: the pull's version list bypasses the shared read (its refused token is never marked dead)",
    from: "const r = await readReq(`${base()}?select=week_monday,version,updated_at&order=week_monday.asc&limit=5000`);",
    to: 'const r = await req(`${base()}?select=week_monday,version,updated_at&order=week_monday.asc&limit=5000`, { method: "GET", headers: rh() }, T.read);' },
  { id: "M89", what: "E2: readAll (the load, a clear / restore) bypasses the shared read",
    from: "const r = await readReq(`${base()}?select=week_monday,data,version,updated_at&order=week_monday.asc&limit=5000`);",
    to: 'const r = await req(`${base()}?select=week_monday,data,version,updated_at&order=week_monday.asc&limit=5000`, { method: "GET", headers: rh() }, T.read);' },
  { id: "M90", what: "E2: readSome (the pull's week fetch, a publish) bypasses the shared read",
    from: "const r = await readReq(`${base()}?week_monday=in.(${chunk.join(\",\")})&select=week_monday,data,version,updated_at`);",
    to: 'const r = await req(`${base()}?week_monday=in.(${chunk.join(",")})&select=week_monday,data,version,updated_at`, { method: "GET", headers: rh() }, T.read);' },
  { id: "M91", what: "E2: a write's read-back bypasses the shared read",
    from: "const r = await readReq(`${base()}?week_monday=eq.${k}&select=week_monday,data,version,updated_at`);",
    to: 'const r = await req(`${base()}?week_monday=eq.${k}&select=week_monday,data,version,updated_at`, { method: "GET", headers: rh() }, T.read);' },
  { id: "M92", what: "E2 × E4: a clear whose own read found the token refused takes the table's rows as known before refusing (a pending edit put back slips under someone else's newer row — I2)",
    from: '        if (authState() !== "ok") return refuse({ ok: false, wrote: false, error: signIn });\n        if (!rows) return refuse(', to: "        if (!rows) return refuse(" },
  { id: "M93", what: "E3: a push request isn't reported until the push runs (the header keeps an earlier 'Synced' over the edit — A16)",
    from: "    push() {\n      report();\n      if (queuedPush)", to: "    push() {\n      if (queuedPush)" },
  { id: "M94", what: "E3: a push doesn't report as it starts (after a pull that failed early, 'Synced' stays over a week being saved — A16)",
    from: '    report();\n    if (!seeded) { report(); return { ok: false, skipped: "not-loaded" }; }', to: '    if (!seeded) { report(); return { ok: false, skipped: "not-loaded" }; }' },
  { id: "M95", what: "E4: a refused clear / restore puts back what the table holds, not the screen as it was (edits pending from before the tap are lost — I6)",
    from: "const refuse = (out) => { if (!keys && gen === g && !handOver(owner)) tellTheirs(out, showKnown(startShown, null, before, knownAt)); return out; };", to: "const refuse = (out) => { if (!keys && gen === g && !handOver(owner)) showKnown(startShown); return out; };" },
  { id: "M96", what: "E4: a clear cancelled at its deadline puts back what the table holds (a slow save's landed edit is then reverted by the follow-up push)",
    from: "if (!keys && !handOver(owner)) tellTheirs(out, showKnown(owner.startShown, null, owner.before, owner.knownAt));", to: "if (!keys && !handOver(owner)) showKnown(owner.startShown);" },
  { id: "M97", what: "E4: the weeks only the screen-as-it-was holds (new local weeks) are left out of what is put back",
    from: "...(keysArr || []), ...Object.keys(before || {})])]);", to: "...(keysArr || [])])]);" },
  { id: "M98", what: "E5: a publish whose re-read fails says 'nothing was published' (its weeks are then saved anyway — A14)",
    from: '"Couldn\'t read the saved weeks first — the new weeks stay on this screen and will be saved automatically. Nobody was notified."', to: '"Couldn\'t read the saved weeks — nothing was published."' },
  { id: "M99", what: "E5: a publish refused for the sign-in says 'Nothing was changed' (its weeks are saved once signed in again)",
    from: "const signIn = keys ? PUB_AUTH : ", to: "const signIn = " },
  { id: "M100", what: "E5: a publish before the first load says 'nothing was changed' without saying the weeks aren't saved and why",
    from: '"The schedule hasn\'t loaded yet, so the new weeks weren\'t saved — loading it will replace them. Publish again once it has loaded. Nobody was notified."', to: '"The schedule hasn\'t loaded yet — nothing was changed."' },
  { id: "M101", what: "E5: a publish cancelled at its deadline says 'nothing was changed' (its weeks stay pending and are saved)",
    from: 'error: keys ? "The sync is stuck behind an earlier save — the new weeks stay', to: 'error: false ? "The sync is stuck behind an earlier save — the new weeks stay' },
  { id: "T24b", what: "T1: the pull never fetches / adopts a week created elsewhere (known weeks only)",
    from: "const moved = list.filter(x => !known[x.week_monday] || known[x.week_monday].version !== (x.version === undefined ? null : x.version) || known[x.week_monday].updated_at !== (x.updated_at || null))",
    to: "const moved = list.filter(x => !!known[x.week_monday] && (known[x.week_monday].version !== (x.version === undefined ? null : x.version) || known[x.week_monday].updated_at !== (x.updated_at || null)))" },
  { id: "T2", what: "T2: pending ignores the ledger (a sent but unconfirmed body reads as saved after an Undo)",
    from: "return [...new Set([...changed, ...deletes, ...Object.keys(sent).filter(unconfirmed)])].sort();", to: "return [...new Set([...changed, ...deletes])].sort();" },
  { id: "N37", what: "T3: the pull adopts someone else's NEW week over this session's unsent new week (no dirty test for never-known weeks)",
    from: "(known[k] ? (!(k in cur0) || canon(cur0[k]) !== known[k].canon) : (k in cur0));", to: "(known[k] ? (!(k in cur0) || canon(cur0[k]) !== known[k].canon) : false);" },
  // 18/n — review round 2, the engine items (E6–E8; killed in SE81–SE83), each with
  // anchor-keeping variants (the bug again, the literal mutant's anchor left in place),
  // and the test gaps' variants from r2-verify-tests/variants.cjs (V18, V5, V3, V2;
  // killed in SE67b, SE76c, SE74b, SE73b) — every one killed by behaviour, not an anchor.
  { id: "M102", what: "E6: a clear / restore requested while another is queued or running trusts its `before` (the first's target, put back, goes out as an ordinary push: a saved week deleted, a refused restore's copy written)",
    from: "const stacked = !keys && [...owners].some(o => o.withKnown);", to: "const stacked = false;" },
  { id: "M102b", what: "E6 (variant): only a RUNNING clear / restore counts — one still queued behind a slow save doesn't",
    from: "const stacked = !keys && [...owners].some(o => o.withKnown);", to: "const stacked = !keys && [...owners].some(o => o.withKnown && o.state.started);" },
  { id: "M102c", what: "E6 (variant, the `stacked` line kept): `before` is taken without looking at it",
    from: "const before = !keys && !stacked && opts && opts.before ? clone(opts.before) : null;", to: "const before = !keys && opts && opts.before ? clone(opts.before) : null;" },
  { id: "M102d", what: "E6 (variant): a PUBLISH queued ahead counts too (a clear requested behind it drops the edits pending from before its tap)",
    from: "const stacked = !keys && [...owners].some(o => o.withKnown);", to: "const stacked = !keys && owners.size > 0;" },
  { id: "M102e", what: "E6: the fallback puts back only the weeks known or shown at the request (a week a restore queued ahead created stays off screen, and the follow-up push deletes it)",
    from: "    const weeks = only ? Object.keys(startShown) : [...new Set([...Object.keys(startShown), ...Object.keys(known)])];", to: "    const weeks = Object.keys(startShown);" },
  { id: "M103", what: "E6: jobPending() says nothing is pending while a job is queued (the app's one-job-at-a-time gate never closes)",
    from: "    jobPending: () => headOwner(),", to: "    jobPending: () => null," },
  { id: "M104", what: "E7: a refusal puts back `before` even where the saved copy moved to someone else's change (a week a peer deleted is re-inserted, unseen)",
    from: "      if (before && knownAt && savedMoved(k, has ? canon(data) : DEL, knownAt)) theirs.push(k);\n", to: "" },
  { id: "M104b", what: "E7 (variant, the check kept): every confirmed copy counts as ours — the read-back that merely agreed with the cleared screen too",
    from: "owners.forEach(o => { if (o.knownAt) { if (ours) o.knownAt.landed[k] = tokOf(known[k]); else delete o.knownAt.landed[k]; } });", to: "owners.forEach(o => { if (o.knownAt) o.knownAt.landed[k] = tokOf(known[k]); });" },
  { id: "M105", what: "E7: a refusal's conflict isn't told in its message (the caller's one toast says nothing of the week someone else changed)",
    from: "    if (m) out.error = out.error ? `${out.error} ${m}` : m;\n", to: "" },
  { id: "M105b", what: "E7 (variant): the conflict's text goes to `notice`, which no refusal's caller shows",
    from: "    if (m) out.error = out.error ? `${out.error} ${m}` : m;\n", to: "    if (m) out.notice = m;\n" },
  { id: "M106", what: "E7: our own earlier body, confirmed while the job waits, is taken for someone else's change (the later edit lost, a false conflict)",
    from: " && knownAt.landed[k] !== tok;", to: ";" },
  { id: "M107", what: "E7: the data known at the request under a new token (an old build's unchanged re-send — A2's 'refreshed') is taken for someone else's change",
    // (re-pinned 21/n: that exemption is now `stillKnown`, with H1's condition; the same mutation — the exemption dropped)
    from: " && !stillKnown", to: "" },
  { id: "M108", what: "E7: a saved copy that now holds exactly what is put back is taken for someone else's change",
    from: " && now !== back", to: "" },
  { id: "M109", what: "E7: our own write's answer counts as ours only when it repeats the body sent (a server-normalised copy reads as someone else's)",
    from: "        confirm(k, row, true);\n", to: "        confirm(k, row);\n" },
  { id: "M110", what: "E8: a job refused after its deadline ignores the caller's late() (a factory reset's late refusal says 'nothing was changed')",
    from: "        p.then(r => tellLate(owner.what, r, late));\n", to: "        p.then(r => lateOutcome(owner.what, r));\n" },
  { id: "M111", what: "E8: late()'s text is toasted AND the engine's own (two messages for one outcome)",
    from: "{ say(m, r && r.ok && !r.notice ? \"success\" : \"error\"); return; }", to: "{ say(m, r && r.ok && !r.notice ? \"success\" : \"error\"); }" },
  { id: "M112", what: "E8: a late() that throws or returns no text silences the job's outcome (no fallback to the engine's own)",
    from: "      if (typeof m === \"string\" && m) { say(", to: "      if (true) { if (typeof m === \"string\" && m) say(" },
  { id: "M113", what: "E8: late() is called for a job fenced by a sign-out (the old session's outcome told on the next one's screen)",
    from: "if (late && !(r && (r.skipped === \"reset\" || r.skipped === \"cancelled\"))) {", to: "if (late) {" },
  { id: "V18", what: "r2-tests-2: a week in `before` is put back even if edited after the tap (a line ahead of the check — M69's anchor kept)",
    from: "      const shownNow = k in cur ? canon(cur[k]) : DEL;\n", to: "      const shownNow = k in cur ? canon(cur[k]) : DEL;\n      if (before && k in before) { if (shownNow !== canon(before[k])) { changed = true; next[k] = clone(before[k]); } return; }\n" },
  { id: "V5", what: "r2-tests-3: a week absent from `before` falls back to what the table holds (a local delete pending from before the tap comes back — M69's anchor kept)",
    from: "const has = before ? k in before : !!known[k], data = before ? before[k] : has ? known[k].data : undefined;", to: "const has = before ? k in before || !!known[k] : !!known[k], data = before && k in before ? before[k] : has ? known[k].data : undefined;" },
  { id: "V3", what: "r2-tests-6: the token blamed for a refused read is the one stored when it ANSWERS (a new token stored meanwhile is marked dead — M83–M85's anchors kept)",
    from: "    const g = gen, tok = tokenNow(), h = rh();\n    const r = await req(url, { method: \"GET\", headers: h }, T.read);\n", to: "    const g = gen, h = rh();\n    const r = await req(url, { method: \"GET\", headers: h }, T.read);\n    const tok = tokenNow();\n" },
  { id: "V2", what: "r2-tests-7: the conflict a push's re-read adopted isn't toasted when the push stops for a job requested meanwhile (results emptied — M82's anchor kept)",
    from: "    if (job.mode !== \"force\" && authoritativeQueued > 0) { if (results.length) toasts(results); report(); return { ok: false, skipped: \"authoritative-queued\", results }; }\n",
    to: "    if (job.mode !== \"force\" && authoritativeQueued > 0) results.length = 0;\n    if (job.mode !== \"force\" && authoritativeQueued > 0) { if (results.length) toasts(results); report(); return { ok: false, skipped: \"authoritative-queued\", results }; }\n" },
  // 20/n — review round 3, the engine items (G1, G6) and the test gaps (G4 = r3-tests-2, G5 = r3-tests-3; killed in
  // SE84, SE85, SE82 (h), SE-X15 (e)), with their anchor-keeping variants — each killed by behaviour. (G1 "testing only
  // gen" isn't one: reset() is the only thing that cancels a job not yet started besides this very callback, and it
  // moves gen too — the two tests are equivalent.)
  { id: "G1", what: "G1: a job reset() fenced while still queued isn't fenced at its deadline (the cancel path runs: the old screen put back into the next session's, every week a false 'changed by someone else', the old session's outcome told on the next screen)",
    from: "        if (owner.state.cancelled || gen !== g0) return owner.state.started ? { ok: false, wrote: false, skipped: \"reset\" } : { ok: false, wrote: false, skipped: \"cancelled\", error: \"It was cancelled before its turn came — nothing was changed.\" };\n", to: "" },
  { id: "G1b", what: "G1 (variant): the fence answers only AFTER the cancel path has put the old screen back (showKnown — and E7's false conflicts)",
    edits: [["        if (owner.state.cancelled || gen !== g0) return owner.state.started ? { ok: false, wrote: false, skipped: \"reset\" } : { ok: false, wrote: false, skipped: \"cancelled\", error: \"It was cancelled before its turn came — nothing was changed.\" };\n", ""],
      ["          report(); return out;\n        }\n        p.then(r => tellLate(owner.what, r, late));", "          report(); if (gen !== g0) return { ok: false, wrote: false, skipped: \"cancelled\", error: \"It was cancelled before its turn came — nothing was changed.\" }; return out;\n        }\n        if (gen !== g0) return { ok: false, wrote: false, skipped: \"reset\" };\n        p.then(r => tellLate(owner.what, r, late));"]] },
  { id: "G1c", what: "G1 (variant): only a job reset() cancelled while queued is fenced — one RUNNING across the sign-out still answers 'still running' (its caller says 'taking longer than expected' on the next screen)",
    from: "        if (owner.state.cancelled || gen !== g0) return owner.state.started", to: "        if (owner.state.cancelled) return owner.state.started" },
  { id: "G6", what: "G6: a refused / cancelled clear puts the screen back though a later clear / reset / restore is queued (a restore landing behind it has its deletions re-inserted by the follow-up push — PROBE-MIX1)",
    from: "    if (!heir) return false;\n", to: "    return false;\n" },
  { id: "G6b", what: "G6 (variant, the take-over kept): the later job owns the screen but isn't handed the put-back (both refused: the edits pending from before the first tap lost)",
    from: "    if (!heir.before && owner && owner.before) {\n", to: "    if (false) {\n" },
  { id: "G6c", what: "G6 (variant): a PUBLISH queued later takes the screen over too (the refused clear ahead of it puts nothing back: the screen left cleared)",
    from: "if (o !== owner && o.withKnown && !o.state.started && !o.state.cancelled) { heir = o; break; }", to: "if (o !== owner && !o.state.started && !o.state.cancelled) { heir = o; break; }" },
  { id: "R3M01", what: "r3-tests-2 (G4): confirm() counts a copy as ours only from our write's own ANSWER — a read-back holding a body we sent (its answer lost) isn't: E7 takes it for someone else's change (a false conflict, the later edit lost)",
    from: "    const ours = !!mine || (!!sent[k] && sent[k].includes(row ? canon(row.data) : DEL));\n", to: "    const ours = !!mine;\n" },
  { id: "R3M09", what: "r3-tests-3 (G5): jobPending() (headOwner) skips a publish that hasn't started yet — a clear tapped while it waits is let through and stacked behind it (P7)",
    from: "  const headOwner = () => { for (const o of owners) return o.what; return null; };", to: "  const headOwner = () => { for (const o of owners) { if (o.withKnown || o.state.started) return o.what; } return null; };" },
  // App mutants (A17(b)/(f)): the component code around the engine, killed by SE-X.
  { id: "X1", app: true, what: "Undo ignores the engine's blocked list (reverts a week someone else changed since — R15)",
    from: "    if (plan.blocked.length) {\n      showToast(`Can't undo", to: "    if (false) {\n      showToast(`Can't undo" },
  { id: "X2", app: true, what: "the keepalive fires on visibilitychange (a side-write that can land after a later save — A9)",
    from: '        if (source === "visibilitychange") { schedSyncRef.current.push(); return; }\n', to: "" },
  { id: "X3", app: true, what: "a two-way swap without the holder check (writes over a changed slot — A13)",
    from: '      if (holder(targetMon, targetShift) !== (targetOldId || "") || (returnMon && returnShift && holder(returnMon, returnShift) !== (candId || ""))) {', to: "      if (false) {" },
  { id: "X4", app: true, what: "a one-way swap from suggestions without the expected-holder check (A13)",
    from: '    if (expectOldId !== undefined && (oldId || "") !== (expectOldId || "")) {', to: "    if (false) {" },
  { id: "X5", app: true, what: "a trade accepted without the holder check before its status PATCH (A13)",
    from: "      if (!tradeHolds(cur, cascades)) {", to: "      if (false) {" },
  { id: "X6", app: true, what: "a trade applied without the re-check at commit (a change adopted during the PATCH is overwritten — A13)",
    from: "      if (!tradeHolds(curNow, cascades) || cascadeSig(cascadesNow) !== cascadeSig(cascades)) {", to: "      if (false) {" },
  { id: "X7", app: true, what: "the editor's save passes no adoption epoch (never refused — §2.6)",
    from: "scheduleRef.current[mondayStr], editWeekModal.openEpoch || 0, schedSyncRef.current.epochOf(mondayStr),", to: "scheduleRef.current[mondayStr], editWeekModal.openEpoch || 0, 0," },
  { id: "X8", app: true, what: "Accept & Publish without the preview's epoch checks (publishes over someone else's change — A13)",
    edits: [["const moved = schedSyncRef.current.changedSince(Object.keys(previewSchedule), previewEpochRef.current);", "const moved = [];"],
      ["const moved2 = schedSyncRef.current.changedSince(Object.keys(weeks), previewEpochRef.current);", "const moved2 = [];"]] },
  { id: "X9", app: true, what: "the edit gate without the load gate (edits before the first read — §2.5.7)",
    from: "    if (!schedSyncRef.current.isSeeded()) {\n      showToast(\"The schedule hasn't loaded yet", to: "    if (false) {\n      showToast(\"The schedule hasn't loaded yet" },
  { id: "X10", app: true, what: "the load effect doesn't wait for the engine's first read (loaded before the schedule is — A6)",
    from: "        const sr = await schedSyncRef.current.load();", to: "        const sr = { ok: false }; schedSyncRef.current.load();" },
  // 17/n (review r1, the app items) — killed in SE-X9 … SE-X14.
  { id: "P1", app: true, what: "P1: commitSchedule doesn't ask the engine to report (the header reads Synced through an edit's debounce — A16)",
    from: " Promise.resolve().then(() => { if (schedSyncRef.current) schedSyncRef.current.report(); });", to: "" },
  { id: "P2a", app: true, what: "P2: Clear hands the engine no `before` (a refused clear drops the edits pending from before the tap)",
    from: 'runAuthoritativeSchedule({}, "clear", undoStep, before)', to: 'runAuthoritativeSchedule({}, "clear", undoStep)' },
  { id: "P2b", app: true, what: "P2: Restore's schedule leg hands the engine no `before`",
    from: 'runAuthoritativeSchedule(sched, "restore", undoStep, before, weeksNotRestored)', to: 'runAuthoritativeSchedule(sched, "restore", undoStep, undefined, weeksNotRestored)' },
  { id: "P2c", app: true, what: "P2: Factory reset hands the engine no `before`",
    from: 'runAuthoritativeSchedule({}, "reset", null, before, weeksNotCleared)', to: 'runAuthoritativeSchedule({}, "reset", null, undefined, weeksNotCleared)' },
  { id: "P2d", app: true, what: "P2: runAuthoritativeSchedule doesn't pass `before` on to the engine",
    from: "schedSyncRef.current.authoritative(target, true, what, null, { before, late })", to: "schedSyncRef.current.authoritative(target, true, what, null, { late })" },
  { id: "P3a", app: true, what: "P3: a refused factory reset says 'the schedule was NOT cleared — … nothing was changed' (the setup, APP shifts and time off were reset)",
    from: 'return why ? `Factory reset: the setup, APP shifts and time off were reset, but the schedule weeks were NOT cleared: ${why} Run the reset again, or restore the "Before factory reset" snapshot.`',
    to: 'return why ? "Factory reset: the schedule was NOT cleared — " + r.error' },
  { id: "P3b", app: true, what: "P3: 'Reset complete' whatever the weeks job did",
    from: '      if (r.running) { showToast(r.error, "info"); return; }\n      if (r.ok) { setSaveStatus("Reset complete");', to: '      setSaveStatus("Reset complete");\n      if (r.running) { showToast(r.error, "info"); return; }\n      if (r.ok) { setSaveStatus("Reset complete");' },
  { id: "P4a", app: true, what: "P4: the session boundary leaves the scheduler flag on (the next account gets the scheduler's controls and blob writes — app-5)",
    from: "    setIsScheduler(false); setupReadRef.current = false; lastSyncRef.current = null;", to: "    setupReadRef.current = false; lastSyncRef.current = null;" },
  { id: "P4b", app: true, what: "P4: the setup autosave schedules a write from a render made before this account's setup was read (it fires after the read, before the adoption)",
    from: "    if (!setupReadRef.current) return;\n    // Capture the payload", to: "    // Capture the payload" },
  { id: "P4b2", app: true, what: "P4: the setup autosave's timer writes across the boundary or without a session (signed out in another tab, or during its debounce — an anon upsert, a false 'no permission')",
    from: "      if (!setupReadRef.current) return;\n      // …and never without a session (signed out during the debounce — in\n      // another tab, perhaps): said, and kept pending, as above — a changed\n      // setup; an unchanged one has nothing to keep (review r3).\n      if (!auth.getSession()) { if (setupChanged) signedOut(); else pendingSaveRef.current = null; return; }\n      // ── Empty-save guard ──",
    to: "      // ── Empty-save guard ──" },
  { id: "P4c", app: true, what: "P4: the session boundary doesn't disarm the setup autosave (the previous session's setup written as the next account)",
    from: "    setIsScheduler(false); setupReadRef.current = false; lastSyncRef.current = null;", to: "    setIsScheduler(false); lastSyncRef.current = null;" },
  { id: "P4d", app: true, what: "P4: the load's setup read doesn't arm the autosave (after a boundary it never writes again — silently)",
    from: "        setupReadRef.current = true; // .single() throws on failure", to: "        // .single() throws on failure" },
  { id: "P4e", app: true, what: "P4: the poll's setup read doesn't arm the autosave (a failed load after a boundary leaves it dead)",
    from: "        setupReadRef.current = true; // adopted just below, in the same render (after a session boundary", to: "        // adopted just below, in the same render (after a session boundary" },
  { id: "P4f", app: true, what: "P4: the session boundary keeps this session's blob row (the next read of it isn't adopted, so it never arms)",
    from: "    setIsScheduler(false); setupReadRef.current = false; lastSyncRef.current = null;", to: "    setIsScheduler(false); setupReadRef.current = false;" },
  { id: "P4g", app: true, what: "P4: the edge-URL save runs across the boundary (this page's URL echoed as the next account when its role arrives)",
    from: "    if (!setupReadRef.current) return;\n    const timer = setTimeout(async () => {", to: "    const timer = setTimeout(async () => {" },
  { id: "P5a", app: true, what: "P5: the clear's setup save after its job is built from the tap's render (a setting changed / adopted meanwhile is reverted)",
    from: "stateBundleRef.current({ schedule: {}, _intentionalClear: true })", to: "buildStateBundle({ schedule: {}, _intentionalClear: true })" },
  { id: "P5b", app: true, what: "P4/P5: the clear's setup save is made across the session boundary (signed out during the job: an anon upsert)",
    from: "        if (!setupReadRef.current || !auth.getSession()) return;\n        const ts = new Date().toISOString();", to: "        const ts = new Date().toISOString();" },
  { id: "P6a", app: true, what: "P6: Clear shows its own 'Clearing…' beside the engine's busy line",
    from: '    const cr = await runAuthoritativeSchedule({}, "clear", undoStep, before);', to: '    setSaveStatus("Clearing… keep the app open");\n    const cr = await runAuthoritativeSchedule({}, "clear", undoStep, before);' },
  { id: "P6b", app: true, what: "P6: Accept & Publish shows its own 'Publishing…' beside the engine's busy line",
    from: '        setView("calendar");\n        setSaveStatus(""); // the snapshot\'s status ends', to: '        setView("calendar");\n        setSaveStatus("Publishing…"); // the snapshot\'s status ends' },
  { id: "P6c", app: true, what: "P6: Generate & Publish shows its own 'Publishing…' beside the engine's busy line",
    from: '        setPreviewSchedule(null); setShowPreview(false);\n        setSaveStatus(""); // the snapshot\'s status ends', to: '        setPreviewSchedule(null); setShowPreview(false);\n        setSaveStatus("Publishing…"); // the snapshot\'s status ends' },
  { id: "P6d", app: true, what: "P6: Restore leaves 'Restoring snapshot…' showing beside the engine's busy line",
    from: "        commitSchedule(sched);\n        setSaveStatus(\"\");\n", to: "        commitSchedule(sched);\n" },
  { id: "P6e", app: true, what: "P6: the setup autosave's '☁ Saved' renders beside a red schedule line",
    from: 'const saveStatusShown = !!saveStatus && !(saveStatus === "Saved" && !saveError && (SCHED_LINE_RED.includes(schedLineKind) || schedLineKind === "busy"));', to: "const saveStatusShown = !!saveStatus;" },
  // 19/n (review r2, the app items P7–P10 and the app test gaps r2-tests-1, -4, -5) — killed in SE-X10 … SE-X17, each by
  // behaviour; the anchor-keeping variants (the bug again, written so no anchor of another entry moves) beside them.
  // P7: one clear / reset / restore / publish at a time from the UI (SE-X15)
  { id: "P7a", app: true, what: "P7: the job gate never looks at the engine's jobs (a second clear / restore stacked behind the first — R2V-1: a saved week deleted, a refused restore's copy written)",
    from: "    if (job) {\n      const busy = schedSyncRef.current.jobPending();", to: "    if (false) {\n      const busy = schedSyncRef.current.jobPending();" },
  { id: "P7a2", app: true, what: "P7 (variant, the gate kept): a PUBLISH queued or running doesn't count (a clear stacked behind it deletes the weeks it just published)",
    from: "      const busy = schedSyncRef.current.jobPending();\n      if (busy) {", to: "      const busy = schedSyncRef.current.jobPending();\n      if (busy && busy !== \"publish\") {" },
  { id: "P7a3", app: true, what: "P7: the refusal doesn't name the job (one generic toast)",
    from: "showToast(`${schedSyncRef.current.jobLabel(busy)} is still running", to: "showToast(`Another job is still running" },
  { id: "P7b", app: true, what: "P7: Clear's tap skips the job gate (asked and snapshotted while a restore is queued — then stacked, or refused only after its snapshot)",
    from: 'if (!schedEditable("job")) return; // the edit gate first', to: 'if (!schedEditable()) return; // the edit gate first' },
  { id: "P7c", app: true, what: "P7: Clear's re-check after its snapshot skips the job gate (a publish requested meanwhile — the clear stacked behind it deletes its weeks)",
    from: 'if (!schedEditable("job")) return; // …and again after the snapshot', to: 'if (!schedEditable()) return; // …and again after the snapshot' },
  { id: "P7d", app: true, what: "P7: Restore's tap skips the job gate (R2V-1: the restore stacked behind a queued clear)",
    from: 'if (!schedEditable("job")) return; // the edit gate, before anything is read', to: 'if (!schedEditable()) return; // the edit gate, before anything is read' },
  { id: "P7e", app: true, what: "P7: Restore's re-check once the snapshot is read skips the job gate (a clear requested during the read — the restore asked, written, stacked)",
    from: '          if (!schedEditable("job")) return false;', to: '          if (!schedEditable()) return false;' },
  { id: "P7f", app: true, what: "P7: Restore's check right before its commit is gone (a clear requested while its blob was written — the restore stacked behind it)",
    from: "        if (busyJob) { setSaveStatus(\"\"); weeksR =", to: "        if (false) { setSaveStatus(\"\"); weeksR =" },
  { id: "P7f2", app: true, what: "P7 (variant, the check kept): it runs AFTER the restore committed its target (the snapshot's weeks left on screen — the follow-up push writes them)",
    from: "        const busyJob = schedSyncRef.current.jobPending();\n        if (busyJob) { setSaveStatus(\"\"); weeksR =", to: "        commitSchedule(sched);\n        const busyJob = schedSyncRef.current.jobPending();\n        if (busyJob) { setSaveStatus(\"\"); weeksR =" },
  { id: "P7g", app: true, what: "P7: Factory reset's tap skips the job gate (its typed confirmation asked, its snapshot taken during a clear)",
    from: '    if (!schedEditable("job")) return;\n    // Typed confirmation', to: '    if (!schedEditable()) return;\n    // Typed confirmation' },
  { id: "P7h", app: true, what: "P7: Factory reset's re-check after its snapshot skips the job gate (the stored setup cleared while a clear requested meanwhile runs)",
    from: '    if (!schedEditable("job")) {\n      setSaveStatus("Reset cancelled");', to: '    if (!schedEditable()) {\n      setSaveStatus("Reset cancelled");' },
  { id: "P7i", app: true, what: "P7: Factory reset's check right before its commit is gone (a weeks job stacked behind one requested during its stored-data clears)",
    from: "    if (busyJob) tellWeeks(", to: "    if (false) tellWeeks(" },
  { id: "P7j", app: true, what: "P7: Accept & Publish's tap skips the job gate (a publish stacked behind a running clear)",
    from: 'if (!schedEditable("job")) return; // (and no other clear', to: 'if (!schedEditable()) return; // (and no other clear' },
  { id: "P7k", app: true, what: "P7: Accept & Publish's re-check after its snapshot skips the job gate",
    from: 'if (!schedEditable("job") || previewSchedRef.current !== weeks)', to: 'if (!schedEditable() || previewSchedRef.current !== weeks)' },
  { id: "P7l", app: true, what: "P7: Generate & Publish, its search done, skips the job gate",
    from: 'if (!schedEditable("job")) return "refused"; // the search can outlast', to: 'if (!schedEditable()) return "refused"; // the search can outlast' },
  { id: "P7m", app: true, what: "P7: Generate & Publish's re-check after its snapshot skips the job gate",
    from: 'if (!schedEditable("job")) { setSaveStatus(""); return "refused"; }', to: 'if (!schedEditable()) { setSaveStatus(""); return "refused"; }' },
  { id: "P7n", app: true, what: "P7: Generate & Publish's tap skips the job gate (a whole search run, to be refused at its end)",
    from: 'if (!schedEditable(preview ? null : "job")) return "refused";', to: 'if (!schedEditable()) return "refused";' },
  { id: "P7o", app: true, what: "P7 (over-reach): a Generate PREVIEW is held back by a job too (it publishes nothing)",
    from: 'if (!schedEditable(preview ? null : "job")) return "refused";', to: 'if (!schedEditable("job")) return "refused";' },
  // P8: late outcomes and refusals of reset / restore say what really happened (SE-X16, SE-X10, SE-X15)
  { id: "P8a", app: true, what: "P8: Factory reset hands the engine no late() (refused after its deadline: 'Clearing the schedule stopped — … nothing was changed' after the setup was reset)",
    from: 'runAuthoritativeSchedule({}, "reset", null, before, weeksNotCleared)', to: 'runAuthoritativeSchedule({}, "reset", null, before)' },
  { id: "P8b", app: true, what: "P8: Restore hands the engine no late() (refused after its deadline: 'Restoring the snapshot stopped — … nothing was changed' after the setup was restored)",
    from: 'runAuthoritativeSchedule(sched, "restore", undoStep, before, weeksNotRestored)', to: 'runAuthoritativeSchedule(sched, "restore", undoStep, before)' },
  { id: "P8c", app: true, what: "P8: runAuthoritativeSchedule doesn't pass late() on to the engine",
    from: "schedSyncRef.current.authoritative(target, true, what, null, { before, late })", to: "schedSyncRef.current.authoritative(target, true, what, null, { before })" },
  { id: "P8d", app: true, what: "P8: a restore whose weeks job was refused says 'Restore failed' and doesn't adopt the setup it wrote (the next autosave writes the pre-restore setup over it)",
    from: "    if (!r.ok && !r.running && !r.blobRestored) {", to: "    if (!r.ok && !r.running) {" },
  { id: "P8d2", app: true, what: "P8 (variant, the new message kept): a refused restore says the setup was restored — but doesn't adopt it",
    from: "    const d = r.blob || {};\n", to: "    if (!r.ok && !r.running) { setSaveStatus(\"\"); showToast(weeksNotRestored(weeksR || { ok: false, error: r.error }), \"error\"); return; }\n    const d = r.blob || {};\n" },
  { id: "P8e", app: true, what: "P8: a restore refused for the sign-in keeps the engine's ' Nothing was changed.' (after the setup was restored)",
    from: 'const whyNot = ar.error && String(ar.error).replace(/ — nothing was changed\\./, ".").replace(/ Nothing was changed\\./, "");', to: 'const whyNot = ar.error && String(ar.error).replace(/ — nothing was changed\\./, ".");' },
  { id: "P8f", app: true, what: "P8: a restore whose weeks job partly failed says 'Restore failed' (its setup and most weeks restored)",
    from: ": `Restore: the roster and setup were restored, but not every schedule week is saved yet: ${", to: ": `Restore failed: ${" },
  { id: "R13", app: true, what: "r2-tests-5: a factory reset refused for the sign-in keeps the engine's ' Nothing was changed.' (only the ' — nothing was changed.' clause stripped)",
    from: 'const why = r.error && String(r.error).replace(/ — nothing was changed\\./, ".").replace(/ Nothing was changed\\./, "");', to: 'const why = r.error && String(r.error).replace(/ — nothing was changed\\./, ".");' },
  // P9: with no session, a setup change is never dropped silently (SE-X11)
  { id: "P9a", app: true, what: "P9: with no session the setup autosave returns silently again (a setting change kept only in memory, the header 'Synced' — review r2 regress-2)",
    from: "    if (!auth.getSession()) { if (setupChanged) signedOut(); return; }\n    // Arm the guard", to: "    if (!auth.getSession()) return;\n    // Arm the guard" },
  { id: "P9b", app: true, what: "P9: the autosave's timer returns silently when the session went during its debounce",
    from: "      if (!auth.getSession()) { if (setupChanged) signedOut(); else pendingSaveRef.current = null; return; }\n      // ── Empty-save guard ──", to: "      if (!auth.getSession()) return;\n      // ── Empty-save guard ──" },
  { id: "P9c", app: true, what: "P9: 'Not saved — you're signed out' without the red 'Sign in again' banner",
    from: "setSaveStatus(\"⚠ Not saved — you're signed out. Sign in again\"); setReauthNeeded(true); } };", to: "setSaveStatus(\"⚠ Not saved — you're signed out. Sign in again\"); } };" },
  { id: "P9d", app: true, what: "P9: 'Sign in again' on the same account doesn't send the setup change kept pending (the autosave's deps don't change on a sign-in)",
    from: "      if (pendingSaveRef.current) setSetupSaveNudge(n => n + 1);", to: "" },
  { id: "P9e", app: true, what: "P9 (variant, the nudge kept): the setup autosave doesn't depend on it (the bump re-runs nothing)",
    from: "schedule, setupSaveNudge, priorCounts", to: "schedule, priorCounts" },
  { id: "P9f", app: true, what: "P9 (variant): the pending save isn't recorded while signed out (the change is said, but the sign-in sends nothing)",
    edits: [["    if (setupChanged || auth.getSession()) pendingSaveRef.current = payload;\n", ""],
      ["    if (!auth.getSession()) { if (setupChanged) signedOut(); return; }\n    // Arm the guard", "    if (!auth.getSession()) { if (setupChanged) signedOut(); return; }\n    pendingSaveRef.current = payload;\n    // Arm the guard"]] },
  { id: "P9g", app: true, what: "P9 (over-reach): a MEMBER with no session is told 'Not saved — you're signed out' (a member never writes the setup)",
    from: "const signedOut = () => { if (canWriteBlob) { setSaveError(true);", to: "const signedOut = () => { if (true) { setSaveError(true);" },
  // P10: the small message and status fixes (SE-X13, SE-X17)
  { id: "P10a", app: true, what: "P10: '☁ Saved' renders beside a job's busy line ('☁ Saved  Clearing… keep the app open' — review r2 fixes-2)",
    from: '(SCHED_LINE_RED.includes(schedLineKind) || schedLineKind === "busy")', to: "SCHED_LINE_RED.includes(schedLineKind)" },
  { id: "P10a2", app: true, what: "P10 (variant): beside the busy line every status is hidden — the autosave's errors too",
    from: 'const saveStatusShown = !!saveStatus && !(saveStatus === "Saved" && !saveError && (SCHED_LINE_RED.includes(schedLineKind) || schedLineKind === "busy"));',
    to: 'const saveStatusShown = !!saveStatus && schedLineKind !== "busy" && !(saveStatus === "Saved" && !saveError && SCHED_LINE_RED.includes(schedLineKind));' },
  { id: "P10b", what: "P10: a clear / reset / restore cancelled at its deadline says 'Reload the app, then try again' (edits waiting to save are back on screen — a phone's reload loses them)",
    from: '"The sync is stuck behind an earlier save — nothing was changed. The schedule on screen is as it was; try again in a minute."', to: '"The sync is stuck behind an earlier save — nothing was changed. Reload the app, then try again."' },
  // (20/n: each of these callers now also checks the session's identity after the job's await — G2's second layer —
  // so P10c–f take both layers out: the job fenced by the engine AND the session moved on, as a sign-out does.)
  { id: "P10c", app: true, what: "P10: a clear fenced by a sign-out toasts on the sign-in screen ('The schedule wasn't fully cleared. 0 week(s)…')",
    edits: [["    if (sessionEpochRef.current !== ep) return; // another session now (a job still running", "    // another session now (a job still running"], ['    if (cr.skipped === "reset" || cr.skipped === "cancelled") return; // fenced', '    // fenced']] },
  { id: "P10c2", app: true, what: "P10 (variant): only a RUNNING job counts as fenced — a clear still queued at the sign-out (cancelled) is told",
    edits: [["    if (sessionEpochRef.current !== ep) return; // another session now (a job still running", "    // another session now (a job still running"], ['if (cr.skipped === "reset" || cr.skipped === "cancelled") return;', 'if (cr.skipped === "reset") return;']] },
  { id: "P10d", app: true, what: "P10: a factory reset fenced by a sign-out toasts on the sign-in screen",
    edits: [["      if (sessionEpochRef.current !== ep) return; // another session now (review r3 regress-3): nothing is said on its screen\n", ""], ['      if (r.skipped === "reset" || r.skipped === "cancelled") return; // fenced by a sign-out: another session now', '      // fenced by a sign-out: another session now']] },
  { id: "P10e", app: true, what: "P10: a restore fenced by a sign-out adopts its setup and toasts on the sign-in screen",
    edits: [["    if (sessionEpochRef.current !== ep) { setSaveStatus(\"\"); return; }\n    if (r.cancelled)", "    if (r.cancelled)"], ['    if (weeksR && (weeksR.skipped === "reset" || weeksR.skipped === "cancelled")) { setSaveStatus(""); return; }\n', ""]] },
  { id: "P10f", app: true, what: "P10: a publish fenced by a sign-out toasts 'Published on this screen…' on the sign-in screen",
    edits: [["        if (sessionEpochRef.current !== ep) return; // another session now: nothing said on its screen\n        if (pr && pr.ok)", "        if (pr && pr.ok)"], ['    if (pr && (pr.skipped === "reset" || pr.skipped === "cancelled")) return; // fenced', '    // fenced']] },
  // The app test gaps (their R-forms): r2-tests-1 (R7d, SE-X11 e), r2-tests-4 (R8, SE-X11 f; R9, SE-X12)
  { id: "R7d", app: true, what: "r2-tests-1: the load arms the setup autosave BEFORE its blob read answers (disarmed again if it throws; P4d's line kept): a render meanwhile writes this page's setup as the next account",
    edits: [['      try {\n        const { data: row } = await supabase\n          .from("call_schedule_data")', '      try {\n        setupReadRef.current = true;\n        const { data: row } = await supabase\n          .from("call_schedule_data")'],
      ["        loadFailedRef.current = true; // read threw — suppress autosave until a read succeeds\n", "        loadFailedRef.current = true; // read threw — suppress autosave until a read succeeds\n        setupReadRef.current = false;\n"]] },
  { id: "R8", app: true, what: "r2-tests-4: the autosave's timer checks only the session, not that this account's setup was read (a timer pending across the boundary into another signed-in account writes)",
    from: "      if (!setupReadRef.current) return;\n      // …and never without a session", to: "      // …and never without a session" },
  // (R9 — the clear's setup save checking only the session — is retired in 20/n: its line can no longer be reached
  // across a boundary. setupReadRef goes false only at sessionBoundary, which also moves the session's identity the
  // clear checks right after its job (G2), and the job itself is answered as fenced first (G1); so dropping that half
  // of the check changes nothing any session can do. P5b — both halves dropped — is killed by SE-X12's no-boundary case.)
  // 20/n — review round 3, the app items (G2, G3, G7; killed in SE-X18, SE-X19, SE-X11 (g)), each by behaviour.
  // G2: the session's identity, checked after each await of each caller, and taken at the tap.
  { id: "G2a", app: true, what: "G2: Clear goes on after its snapshot though the session changed meanwhile (A's clear run as the next account — RR-A7 / RR-A9)",
    from: "    const clearSnap = await snapshots.capture(\"clear_schedule\", { minWeeks: Object.keys(schedSyncRef.current.knownSchedule()).length ? 1 : 0 });\n    if (sessionEpochRef.current !== ep) return;\n",
    to: "    const clearSnap = await snapshots.capture(\"clear_schedule\", { minWeeks: Object.keys(schedSyncRef.current.knownSchedule()).length ? 1 : 0 });\n" },
  { id: "G2a2", app: true, what: "G2 (variant): Clear takes the session's identity after its snapshot's await (the check compares the next session with itself)",
    edits: [["    const ep = sessionEpochRef.current;\n    if (!schedEditable(\"job\")) return; // the edit gate first", "    let ep = sessionEpochRef.current;\n    if (!schedEditable(\"job\")) return; // the edit gate first"],
      ["    const clearSnap = await snapshots.capture(\"clear_schedule\", { minWeeks: Object.keys(schedSyncRef.current.knownSchedule()).length ? 1 : 0 });\n    if (sessionEpochRef.current !== ep) return;\n", "    const clearSnap = await snapshots.capture(\"clear_schedule\", { minWeeks: Object.keys(schedSyncRef.current.knownSchedule()).length ? 1 : 0 });\n    ep = sessionEpochRef.current;\n    if (sessionEpochRef.current !== ep) return;\n"]] },
  { id: "G2a3", app: true, what: "G2: Clear's own setup save, failing after a session change during it, is told on the next session's screen",
    from: "if (sessionEpochRef.current === ep) showToast(\"Couldn't save the cleared state — check your connection.\", \"error\");", to: "showToast(\"Couldn't save the cleared state — check your connection.\", \"error\");" },
  { id: "G2b", app: true, what: "G2: Factory reset goes on after its snapshot though the session changed (its stored-data clears and weeks job run as the next account — RR-A6)",
    from: "    const resetSnap = await snapshots.capture(\"reset_all_data\", { minWeeks: Object.keys(schedSyncRef.current.knownSchedule()).length ? 1 : 0 });\n    if (sessionEpochRef.current !== ep) return;\n",
    to: "    const resetSnap = await snapshots.capture(\"reset_all_data\", { minWeeks: Object.keys(schedSyncRef.current.knownSchedule()).length ? 1 : 0 });\n" },
  { id: "G2b2", app: true, what: "G2: Factory reset goes on after its setup clear though the session changed (the APP shifts cleared as the next account)",
    from: "    if (sessionEpochRef.current !== ep) { unarm(); return; } // another session now: the APP shifts", to: "    // another session now: the APP shifts" },
  { id: "G2b3", app: true, what: "G2: Factory reset goes on after its APP-shifts clear though the session changed (its weeks job run as the next account)",
    from: "    if (sessionEpochRef.current !== ep) { unarm(); return; } // …nor anything after it", to: "    // …nor anything after it" },
  { id: "G2b4", app: true, what: "G2 (variant): Factory reset takes the session's identity after its snapshot's await",
    edits: [["    const ep = sessionEpochRef.current;\n    // Gate: scheduler or the admin account only.", "    let ep = sessionEpochRef.current;\n    // Gate: scheduler or the admin account only."],
      ["    const resetSnap = await snapshots.capture(\"reset_all_data\", { minWeeks: Object.keys(schedSyncRef.current.knownSchedule()).length ? 1 : 0 });\n    if (sessionEpochRef.current !== ep) return;\n", "    const resetSnap = await snapshots.capture(\"reset_all_data\", { minWeeks: Object.keys(schedSyncRef.current.knownSchedule()).length ? 1 : 0 });\n    ep = sessionEpochRef.current;\n    if (sessionEpochRef.current !== ep) return;\n"]] },
  { id: "G2c", app: true, what: "G2: Restore's question is asked after its snapshot was read across a session change (on the next session's screen — and its blob then written)",
    from: "          if (sessionEpochRef.current !== ep) return false; // the snapshot was read", to: "          // the snapshot was read" },
  { id: "G2c2", app: true, what: "G2: Restore's weeks job runs though the session changed while its blob was written (as the next account — RR-A5)",
    from: "        if (sessionEpochRef.current !== ep) return { ok: false, error: \"the session changed\" };", to: "        if (false) return { ok: false, error: \"the session changed\" };" },
  { id: "G2c3", app: true, what: "G2: Restore adopts its blob though the session changed (A's restored setup on the next account's screen, then written by its autosave)",
    from: "    if (sessionEpochRef.current !== ep) { setSaveStatus(\"\"); return; }\n    if (r.cancelled)", to: "    if (r.cancelled)" },
  { id: "G2c4", app: true, what: "G2: Restore doesn't hand config.js its proceed() check (its blob written as the next account after a session change during its before_restore snapshot)",
    from: "        proceed: () => sessionEpochRef.current === ep,\n", to: "" },
  { id: "G2c5", app: true, what: "G2 (variant): Restore takes the session's identity once its snapshot has been read (in its question)",
    edits: [["    const ep = sessionEpochRef.current;\n    const when = new Date(snap.created_at)", "    let ep = sessionEpochRef.current;\n    const when = new Date(snap.created_at)"],
      ["          if (sessionEpochRef.current !== ep) return false; // the snapshot was read", "          ep = sessionEpochRef.current;\n          if (sessionEpochRef.current !== ep) return false; // the snapshot was read"]] },
  { id: "G2d", app: true, what: "G2: Generate & Publish goes on after its snapshot though the session changed (published as the next account — RR-A8)",
    from: "        if (sessionEpochRef.current !== ep) { setSaveStatus(\"\"); return \"refused\"; } // a sign-out / another account during the snapshot", to: "        // a sign-out / another account during the snapshot" },
  { id: "G2d2", app: true, what: "G2 (variant): Generate & Publish takes the session's identity after its snapshot's await",
    edits: [["    const ep = sessionEpochRef.current;\n    // The outcome is the publish's (A14)", "    let ep = sessionEpochRef.current;\n    // The outcome is the publish's (A14)"],
      ["        if (sessionEpochRef.current !== ep) { setSaveStatus(\"\"); return \"refused\"; } // a sign-out", "        ep = sessionEpochRef.current;\n        if (sessionEpochRef.current !== ep) { setSaveStatus(\"\"); return \"refused\"; } // a sign-out"]] },
  { id: "G2e", app: true, what: "G2: Generate & Publish's own setup save, failing after a session change during it, is told on the next session's screen",
    from: "if (sessionEpochRef.current === ep) showToast(\"Couldn't save the regenerated schedule — check your connection.\", \"error\");", to: "showToast(\"Couldn't save the regenerated schedule — check your connection.\", \"error\");" },
  { id: "G2f", app: true, what: "G2: Generate & Publish's e-mail goes out after a session change while its notice was written (sent from the next session)",
    // (re-pinned 21/n: the call now passes the tap's session — review r4 fixes-3; the same mutation)
    from: "      \"A new call schedule has been generated. Check the Schedule or Calendar tab.\", {}, null, ep);\n    if (sessionEpochRef.current !== ep) return;\n", to: "      \"A new call schedule has been generated. Check the Schedule or Calendar tab.\", {}, null, ep);\n" },
  { id: "G2g", app: true, what: "G2: Accept & Publish goes on after its snapshot though the session changed (published as the next account)",
    from: "        if (sessionEpochRef.current !== ep) { setSaveStatus(\"\"); return; } // nothing published as the next session", to: "        // nothing published as the next session" },
  { id: "G2g2", app: true, what: "G2 (variant): Accept & Publish takes the session's identity after its snapshot's await",
    edits: [["      const ep = sessionEpochRef.current;\n      try {", "      let ep = sessionEpochRef.current;\n      try {"],
      ["        if (sessionEpochRef.current !== ep) { setSaveStatus(\"\"); return; } // nothing published", "        ep = sessionEpochRef.current;\n        if (sessionEpochRef.current !== ep) { setSaveStatus(\"\"); return; } // nothing published"]] },
  { id: "G2h", app: true, what: "G2: the session boundary doesn't move the session's identity (every job of the previous session goes on as the next)",
    from: "    sessionEpochRef.current++; searchRef.current = null;", to: "    searchRef.current = null;" },
  // G3: a factory reset's stored-data clears, one at a time, and what a half-landed one says and shows.
  { id: "G3a", app: true, what: "G3: the APP-shifts clear is sent even when the setup clear failed (the APP shifts wiped while it says 'Nothing was changed' — p-reset-partial2)",
    from: "    const appClear = blobClear.ok ? await clearRow(\"app_shifts_data\", {}) : null;", to: "    const appClear = await clearRow(\"app_shifts_data\", {});" },
  { id: "G3b", app: true, what: "G3: a half-landed reset (the setup cleared, the APP shifts not) says 'Nothing was changed' (p-reset-partial)",
    from: "      if (blobClear.ok) {\n", to: "      if (false) {\n" },
  { id: "G3c", app: true, what: "G3 (variant, the message kept): a half-landed reset leaves the old setup on this screen (its next autosave writes it back over the cleared one)",
    from: "        resetSetupHere();\n        showToast(\"Factory reset: the setup was reset, but clearing", to: "        showToast(\"Factory reset: the setup was reset, but clearing" },
  { id: "G3d", app: true, what: "G3: a setup clear that got no answer (it may have landed) says 'Nothing was changed'",
    from: "      showToast(blobClear.unanswered\n", to: "      showToast(false\n" },
  // G7: with no session, only a setup that differs from the one last written or read is "not saved".
  { id: "G7a", app: true, what: "G7: with no session every autosave run is 'Not saved' (a peer's week adopted — the setup unchanged — said, kept and sent at sign-in)",
    from: "    const setupChanged = payloadSig !== setupBaseRef.current.sig;", to: "    const setupChanged = true;" },
  { id: "G7b", app: true, what: "G7: a READ doesn't move the setup's baseline (a peer's setup change read while signed out is 'Not saved')",
    from: "    if (!setupBaseRef.current || setupBaseRef.current.at !== lastSyncRef.current) setupBaseRef.current", to: "    if (!setupBaseRef.current) setupBaseRef.current" },
  { id: "G7c", app: true, what: "G7: the autosave's WRITE doesn't move the baseline (a change after it, signed out, is taken for the read and dropped silently)",
    from: "        setupBaseRef.current = { at: ts, sig: payloadSig }; // …and it is the setup as last written (review r3)\n", to: "" },
  { id: "G7d", app: true, what: "G7: the autosave's timer says 'Not saved' for an UNCHANGED setup when the session goes during its debounce",
    from: "      if (!auth.getSession()) { if (setupChanged) signedOut(); else pendingSaveRef.current = null; return; }", to: "      if (!auth.getSession()) { signedOut(); return; }" },
  { id: "G7e", app: true, what: "G7: the clear's own setup save is taken for a read (a setting change after it, signed out, not said)",
    from: "        if (setupBaseRef.current) setupBaseRef.current = { at: ts, sig: setupBaseRef.current.sig };\n", to: "" },
  // T4 (review r1 tests-5): the engine's token() as the app wires it — killed in SE-X14.
  { id: "N19", app: true, what: "T4: the engine's token() is a constant, not the stored session's (writes stay blocked after 'Sign in again')",
    from: "    token: () => auth.getSession()?.access_token || null,", to: "    token: () => \"T\"," },
  { id: "N19b", app: true, what: "T4: the engine's token() is the one stored at creation (captured once)",
    from: "    token: () => auth.getSession()?.access_token || null,", to: "    token: ((t0) => () => t0)(auth.getSession()?.access_token || null)," },
  // 21/n — review round 4. H1 (CRITICAL, branch-1): a lost-answer save never re-sent over another device's revert —
  // killed in SE86 (a)–(h) by behaviour.
  { id: "H1a", what: "H1: the data we knew under a new token is 'refreshed' even while a body of ours that may have landed is out (the 20/n line: a revert of our lost write overwritten silently — p1 / p2a / p4)",
    from: '      if (!out.length || ((row.version === undefined ? null : row.version) === kn.version && kn.version !== 1)) return "refreshed";\n', to: '      return "refreshed";\n' },
  { id: "H1b", what: "H1 (anchor-keeping variant): …'refreshed' while out only when updated_at is unchanged, not the version (an old build's version-keeping re-send under our lost edit that never landed: a false conflict)",
    from: '      if (!out.length || ((row.version === undefined ? null : row.version) === kn.version && kn.version !== 1)) return "refreshed";\n', to: '      if (!out.length || ((row.updated_at || null) === kn.updated_at && kn.version !== 1)) return "refreshed";\n' },
  { id: "H1c", what: "H1 (variant): the version rule without its v1 exception (a week known at v1, deleted and re-inserted as it was elsewhere — v1 again — taken for 'refreshed': our lost write re-sent over it)",
    from: '      if (!out.length || ((row.version === undefined ? null : row.version) === kn.version && kn.version !== 1)) return "refreshed";\n', to: '      if (!out.length || (row.version === undefined ? null : row.version) === kn.version) return "refreshed";\n' },
  { id: "H1d", what: "H1 (variant, over-strict): never 'refreshed' while a body of ours is out (an old build's unchanged re-send under our lost edit that never landed costs the edit)",
    from: '      if (!out.length || ((row.version === undefined ? null : row.version) === kn.version && kn.version !== 1)) return "refreshed";\n', to: '      if (!out.length) return "refreshed";\n' },
  { id: "H1e", what: "H1: a body answered with 0 rows still counts as out (SE71 at v1: an old build's unchanged re-send under an unsaved edit is a false conflict)",
    from: "      const out = (sent[k] || []).filter((x, i, a) => !(missed !== undefined && x === missed && i === a.lastIndexOf(x)));", to: "      const out = (sent[k] || []);" },
  { id: "H1f", what: "H1: E7's savedMoved keeps the 20/n exemption (the data known at the tap under a new token is never someone else's — a refused restore puts our lost write back over a revert)",
    from: "    const stillKnown = !!was && now === was.canon && (!was.out || (!!kn && kn.version === was.v && was.v !== 1));", to: "    const stillKnown = !!was && now === was.canon;" },
  // H3 (branch-3, a decision): a lost INSERT re-sent after a deletion elsewhere is never silent — SE86 (e), (i)–(k).
  { id: "H3a", what: "H3: a re-read that finds no row for a lost INSERT doesn't mark it (re-sent silently over a clear / restore elsewhere)",
    from: "      if (!rb.row && !known[k] && lostIns.has(k)) resend.add(k);\n", to: "" },
  { id: "H3b", what: "H3 (variant): every new week's INSERT that lands is told 'saved again' (the ordinary first insert too)",
    from: "      const again = resend.has(k);", to: "      const again = !known[k];" },
  { id: "H3c", what: "H3: a re-read that simply FAILS marks the week as re-sent (and it is sent: 'saved again' though nothing was seen)",
    from: "      if (!rb.ok) { if (lostIns.has(k) && !known[k]) unread.add(k); continue; }", to: "      if (!rb.ok) { if (lostIns.has(k) && !known[k]) resend.add(k); continue; }" },
  { id: "H3d", what: "H3: a lost INSERT whose re-read fails is re-sent blindly (re-inserted after a deletion elsewhere, nothing told)",
    from: "      if (!rb.ok) { if (lostIns.has(k) && !known[k]) unread.add(k); continue; }", to: "      if (!rb.ok) continue;" },
  { id: "H3e", what: "H3: an INSERT whose read-back failed isn't remembered as lost (the p4 / p2b re-insert silent again)",
    from: "      if (!rb.ok) { failed.add(k); if (!del && !kn) lostIns.add(k); return", to: "      if (!rb.ok) { failed.add(k); return" },
  { id: "H3f", what: "H3: an answered INSERT whose read-back found NO row is taken as lost too (its retry says 'saved again' though it never landed)",
    from: "      const how = classify(k, rb.row, kind === \"ok\"", to: "      if (!del && !kn) lostIns.add(k);\n      const how = classify(k, rb.row, kind === \"ok\"" },
  // H8 (fixes-4): a job stacked behind a RUNNING clear / reset / restore, cancelled at its deadline — SE85 (d).
  { id: "H8a", what: "H8: a stacked job cancelled while an earlier one RUNS puts its own put-back on screen (the table's weeks back where the clear was deleting them: the follow-up push re-inserts every one — R4-E2)",
    from: "      if (!runner) return false;\n", to: "      return false;\n" },
  { id: "H8b", what: "H8 (variant, R4M2): …the running job takes the screen over but the cancelled job's target is left on it (the cancelled restore's weeks written by the follow-up push)",
    from: "      if (changed) d.commit(next);\n      return true;\n", to: "      return true;\n" },
  // H2 (branch-2): a trade's accept / decline never acts in the next session — SE-X20 (a)–(f), (i).
  { id: "H2a", app: true, what: "H2: the accept doesn't check the session after its status PATCH (A's trade applied in B's session, pushed as B, its notices from B — R4-TRADE)",
    from: "      if (!live()) return abandon(acceptRows);\n", to: "" },
  { id: "H2b", app: true, what: "H2 (variant): …it stops after a session change but never sets the trade back (left accepted with no swap)",
    from: "      if (!Array.isArray(rows) || rows.length === 0) return; // this tap accepted nothing: nothing to set back", to: "      return; // this tap accepted nothing: nothing to set back" },
  { id: "H2c", app: true, what: "H2 (variant): the set-back is sent with the headers of NOW (the next account's token, or anon), not the tap's",
    from: "          headers: { ...tapH, \"Content-Type\": \"application/json\", Prefer: \"return=representation\" },\n          body: JSON.stringify({ status: \"pending\", reviewed_at: null }),", to: "          headers: { ...dbAuthHeaders(), \"Content-Type\": \"application/json\", Prefer: \"return=representation\" },\n          body: JSON.stringify({ status: \"pending\", reviewed_at: null })," },
  { id: "H2d", app: true, what: "H2: a failed set-back's audit line is written under the next session's token (not as the account that tapped)",
    from: "{ request_id: req.id, reverted: false }, tapH);", to: "{ request_id: req.id, reverted: false });" },
  { id: "H2e", app: true, what: "H2: the accept goes on after its first notice though the session changed (the cascade notices and every e-mail from the next session)",
    from: "      if (!live()) return; // another session now: no more notices or e-mails from it\n", to: "" },
  { id: "H2f", app: true, what: "H2: the accept's cascade loop doesn't check the session after each notice (the next cascade's notice and its e-mail from the next session)",
    from: "        if (!live()) return; // another session now\n        sendEmailNotif(\"schedule_changed\"", to: "        sendEmailNotif(\"schedule_changed\"" },
  { id: "H2g", app: true, what: "H2: a trade not holding at commit, its set-back crossing a session change: 'This trade was not applied…' told on the next screen",
    from: "        if (!here) return; // another session now: nothing said on its screen\n", to: "" },
  { id: "H2h", app: true, what: "H2: the decline goes on after its status PATCH though the session changed (the list, the notice and the e-mail in the next session)",
    from: "      const declineRows = await declineRes.json().catch(() => []);\n      if (!live()) return; // another session now\n", to: "      const declineRows = await declineRes.json().catch(() => []);\n" },
  { id: "H2i", app: true, what: "H2: the decline's e-mail goes out after its notice though the session changed",
    from: "      if (!live()) return; // another session now: no e-mail from it\n", to: "" },
  // H7 (fixes-3): the notice paths fenced inside them — SE-X20 (g), (h).
  { id: "H7a", app: true, what: "H7: addNotification doesn't check the session after its insert (Generate & Publish's / a swap's device push from the next session — R4-N1)",
    from: "      if (sessionEpochRef.current !== ep) { if (insertErr) console.error(\"Notification insert failed:\", insertErr); return; } // another session now\n", to: "" },
  { id: "H7b", app: true, what: "H7: sendPushNotif's failure is told on the next session's screen",
    from: "if (sessionEpochRef.current === ep) showToast(\"Couldn't send the push notification — check your connection.\", \"error\");", to: "showToast(\"Couldn't send the push notification — check your connection.\", \"error\");" },
  { id: "H7c", app: true, what: "H7: sendEmailNotif's failure is told on the next session's screen",
    from: "        if (sessionEpochRef.current === ep) showToast(\"Some notification emails didn't send.\", \"error\");", to: "        showToast(\"Some notification emails didn't send.\", \"error\");" },
  // H4 (branch-4): the tab bound to its account (the app's side: binding, the storage listener) — SE-X22. (config.js's
  // side — the sub check itself — is mutated in sync-guards' config battery, CB.)
  { id: "H4a", app: true, what: "H4: 'Sign in again' landing on another account doesn't bind the tab to it (the renewed account's own writes go out as anon)",
    from: "    auth.bindUser(user.id); // this tab is the new account's now", to: "    // this tab is the new account's now" },
  { id: "H4b", app: true, what: "H4: the storage listener doesn't make the engine report (the stale tab says 'Sign in again' only at its next pull)",
    from: "      schedSyncRef.current.report();\n      if (!auth.getSession()) setReauthNeeded(true);", to: "      if (!auth.getSession()) setReauthNeeded(true);" },
  { id: "H4c", app: true, what: "H4: the storage listener doesn't raise the banner (nothing said in the stale tab until it tries to write)",
    from: "      if (!auth.getSession()) setReauthNeeded(true);\n    };", to: "    };" },
  { id: "H4d", app: true, what: "H4: the password sign-in doesn't bind the tab (another tab's later sign-in is used here as if it were this account's)",
    from: "        auth.bindUser(user && user.id); // (review r4 branch-4: the sign-in's own request ran unbound", to: "        // (review r4 branch-4: the sign-in's own request ran unbound" },
  { id: "H4e", app: true, what: "H4: the Face ID unlock doesn't bind the tab",
    from: "        auth.bindUser(user.id); // (review r4 branch-4)\n", to: "" },
  { id: "H4f", app: true, what: "H4: the sign-out unbinds BEFORE signing out (another account's stored session is then logged out on the server as that account, and cleared)",
    from: "    await auth.signOut(); // (this tab's session only — another account's, stored by another tab, is left alone: review r4 branch-4)\n    auth.bindUser(null);  // …and unbound: the sign-in form's requests run as nobody's\n",
    to: "    auth.bindUser(null);\n    await auth.signOut();\n" },
  // H6 (fixes-2): the factory reset's time-off clear, an awaited, checked step — SE-X21 (a)–(e); r4-fix-5 — SE-X21 (f).
  { id: "H6a", app: true, what: "H6: the time-off clear isn't awaited or checked (R4-T1: 'Reset complete' though the time_off DELETE failed, the weeks deleted anyway)",
    from: "    const toClear = await toClearAll(undefined, { quiet: true });\n", to: "    const toClear = (toClearAll(undefined, { quiet: true }), { ok: true });\n" },
  { id: "H6b", app: true, what: "H6 (variant): the time-off clear is awaited but its failure not checked (the weeks job runs, 'Reset complete')",
    from: "    if (!toClear || !toClear.ok) {\n", to: "    if (false) {\n" },
  { id: "H6c", app: true, what: "H6: the reset's time-off clear isn't quiet (deleteTimeOff's generic toast beside the reset's one message)",
    from: "    const toClear = await toClearAll(undefined, { quiet: true });\n", to: "    const toClear = await toClearAll(undefined);\n" },
  { id: "H6d", app: true, what: "H6: deleteTimeOff's failure toast isn't fenced by the session (said on the next session's screen)",
    from: "if (!quiet && sessionEpochRef.current === ep) showToast(", to: "if (!quiet) showToast(" },
  { id: "H6e", app: true, what: "H6: the reset goes on after its time-off clear though the session changed (its weeks job as the next account, its message on the next screen)",
    from: "    if (sessionEpochRef.current !== ep) { unarm(); return; } // another session now: no weeks job as the next account, nothing said\n", to: "" },
  { id: "H6f", app: true, what: "H6: toClearAll clears the screen before the DELETE has landed (a failed one leaves the vacations off screen though the server keeps them)",
    from: "    if (!USE_TIME_OFF) { clearHere(); return { ok: true }; }\n    const r = await deleteTimeOff(", to: "    clearHere();\n    if (!USE_TIME_OFF) { return { ok: true }; }\n    const r = await deleteTimeOff(" },
  { id: "H6g", app: true, what: "H6: a time-off clear that got no answer is said to have failed ('left as they are' — though it may have landed)",
    from: "      showToast(toClear && toClear.unanswered\n", to: "      showToast(false\n" },
  { id: "H6h", app: true, what: "H6: once the setup and APP-shifts clears landed, this screen keeps its old APP shifts (a time-off failure stops the reset with them still shown)",
    from: "    resetSetupHere(); setAppShifts({});\n", to: "    resetSetupHere();\n" },
  { id: "R4M6", app: true, what: "r4-fix-5 (G3 refactor): the factory reset no longer resets the counts (resetSetupHere without setPriorCounts / setYear1Counts)",
    from: "setFierceBackupSet(new Set()); setPriorCounts({}); setYear1Counts({}); setStartMonth(4);", to: "setFierceBackupSet(new Set()); setStartMonth(4);" },
  // r4-fix-9: setupSig leaves the time off out — SE-X11 (r4-fix-9).
  { id: "R4M4", app: true, what: "r4-fix-9 (G7): vacations / no-call stay in setupSig (time off reloaded while signed out reads as an unsaved setup change: a false 'Not saved' and banner — R4-D4)",
    from: "const b = Object.assign({}, p); [\"schedule\", \"vacations\", \"noCallDays\", \"_intentionalClear\"].forEach", to: "const b = Object.assign({}, p); [\"schedule\", \"_intentionalClear\"].forEach" },
  // r4-fix-6: a snapshot capture that FAILS across a session change, each caller — SE-X18 (k).
  { id: "R4M7", app: true, what: "r4-fix-6 (G2): Generate & Publish tells a FAILED snapshot before checking the session (on the next session's screen — R4-D7)",
    from: "        const snap = await snapshots.capture(\"regenerate\", { minWeeks: Object.keys(schedSyncRef.current.knownSchedule()).length ? 1 : 0 });\n        if (sessionEpochRef.current !== ep) { setSaveStatus(\"\"); return \"refused\"; }",
    to: "        const snap = await snapshots.capture(\"regenerate\", { minWeeks: Object.keys(schedSyncRef.current.knownSchedule()).length ? 1 : 0 });\n        if (!snap.ok) { showToast(\"Couldn't save a backup snapshot — regenerate cancelled. Schedule unchanged.\", \"error\"); setSaveStatus(\"\"); return \"no-snapshot\"; }\n        if (sessionEpochRef.current !== ep) { setSaveStatus(\"\"); return \"refused\"; }" },
  { id: "R4M7b", app: true, what: "r4-fix-6 (variant V7, the line kept): Generate & Publish's session check moved below its snapshot-failure branch",
    from: "        if (sessionEpochRef.current !== ep) { setSaveStatus(\"\"); return \"refused\"; } // a sign-out / another account during the snapshot: nothing published as the next session, nothing said on its screen\n        if (!snap.ok) {\n          showToast(\"Couldn't save a backup snapshot — regenerate cancelled. Schedule unchanged.\", \"error\");\n          setSaveStatus(\"\");\n          return \"no-snapshot\";\n        }\n",
    to: "        if (!snap.ok) {\n          showToast(\"Couldn't save a backup snapshot — regenerate cancelled. Schedule unchanged.\", \"error\");\n          setSaveStatus(\"\");\n          return \"no-snapshot\";\n        }\n        if (sessionEpochRef.current !== ep) { setSaveStatus(\"\"); return \"refused\"; } // a sign-out / another account during the snapshot: nothing published as the next session, nothing said on its screen\n" },
  { id: "R4M7c", app: true, what: "r4-fix-6 (variant): Clear's session check moved below its snapshot-failure branch ('Couldn't save a backup snapshot — clear cancelled' on the sign-in screen)",
    from: "    if (sessionEpochRef.current !== ep) return;\n    if (!clearSnap.ok) {\n      showToast(\"Couldn't save a backup snapshot — clear cancelled. Schedule unchanged.\", \"error\");\n      return;\n    }\n",
    to: "    if (!clearSnap.ok) {\n      showToast(\"Couldn't save a backup snapshot — clear cancelled. Schedule unchanged.\", \"error\");\n      return;\n    }\n    if (sessionEpochRef.current !== ep) return;\n" },
  { id: "R4M7d", app: true, what: "r4-fix-6 (variant): the factory reset's session check moved below its snapshot-failure branch (its message and 'Reset cancelled' on the next screen)",
    from: "    if (sessionEpochRef.current !== ep) return;\n    if (!resetSnap.ok) {\n      showToast(\"Couldn't save a backup snapshot — reset cancelled. Nothing was deleted.\", \"error\");\n      setSaveStatus(\"Reset cancelled\");\n      setTimeout(() => setSaveStatus(\"\"), 2000);\n      return;\n    }\n",
    to: "    if (!resetSnap.ok) {\n      showToast(\"Couldn't save a backup snapshot — reset cancelled. Nothing was deleted.\", \"error\");\n      setSaveStatus(\"Reset cancelled\");\n      setTimeout(() => setSaveStatus(\"\"), 2000);\n      return;\n    }\n    if (sessionEpochRef.current !== ep) return;\n" },
  { id: "R4M7e", app: true, what: "r4-fix-6 (variant): Accept & Publish's session check moved below its snapshot-failure branch",
    from: "        if (sessionEpochRef.current !== ep) { setSaveStatus(\"\"); return; } // nothing published as the next session, nothing said on its screen\n        if (!snap.ok) { showToast(\"Couldn't save a backup snapshot — nothing was published.\", \"error\"); setSaveStatus(\"\"); return; }\n",
    to: "        if (!snap.ok) { showToast(\"Couldn't save a backup snapshot — nothing was published.\", \"error\"); setSaveStatus(\"\"); return; }\n        if (sessionEpochRef.current !== ep) { setSaveStatus(\"\"); return; } // nothing published as the next session, nothing said on its screen\n" },
  // r4-fix-8: G6's hand-over details, each by behaviour — SE85 (e), (f).
  { id: "R4M5", what: "r4-fix-8 (G6): the heir is handed `before` but not `knownAt` (E7 skipped on its put-back: B's deletion overwritten by the follow-up push, no conflict — R4-E5)",
    from: "      heir.before = owner.before; heir.knownAt = owner.knownAt;\n", to: "      heir.before = owner.before;\n" },
  { id: "R4M3", what: "r4-fix-8 (G6): the heir's weeks aren't extended with the handed-over put-back's (a new local week pending from before the first tap lost when both are refused — R4-E3)",
    from: "      Object.keys(owner.before).forEach(k => { if (!(k in heir.startShown)) heir.startShown[k] = DEL; });", to: "      Object.keys(owner.before).forEach(k => { if (!(k in heir.startShown)) void 0; });" },
];

async function scenarios(createSchedSync, check, line) {
  const VIEW = { loaded: true, readOnly: false, blobStatus: false }; // a scheduler's header, no blob status showing
  // ── fixtures ──
  let ms = Date.UTC(2026, 9, 12, 12, 0, 0);
  const clockIso = () => new Date(ms += 1000).toISOString();
  const mkTable = (rows) => createFakeWeeksTable({ baseUrl: BASE, anonKey: "ANON", users: { TOK_A: "user-a", TOK_B: "user-b", TOK_M: "member" }, rows: rows || [], clock: clockIso });
  const seedRows = (n, v) => W.slice(0, n).map((k, i) => ({ week_monday: k, data: wk("s" + (i % 6 + 1)), version: v || 3, updated_by: "user-a", updated_at: "2026-10-01T08:00:00.000Z" }));
  const internal = [];
  // A17(c): a callback error the engine CAUGHT and logged ("onToast threw", …)
  // is recorded too, and so is anything the engine writes to the console;
  // SE-I fails on either (SE60's one deliberate throw is accounted for there).
  const caught = [];
  engineConsole.length = 0;
  const mkSession = (table, o) => {
    o = o || {};
    const s = { mirror: {}, toasts: [], statuses: [], wipeBlocked: [], commits: 0, readAsAnon: false, adopted: [],
      token: o.token === undefined ? "TOK_A" : o.token, canWrite: o.canWrite !== false, user: o.user || "user-a" };
    const hdr = (tok) => tok ? { apikey: "ANON", Authorization: "Bearer " + tok } : { apikey: "ANON", Authorization: "Bearer ANON" };
    s.engine = createSchedSync({
      getState: () => s.mirror,
      commit: (next) => { s.mirror = next; s.commits++; },
      fetch: (u, i) => (s.fetchHook ? s.fetchHook(u, i) : table.fetch(u, i)), // fetchHook: a scenario answers / holds one request itself
      url: BASE,
      writeHeaders: () => hdr(s.token),
      readHeaders: () => hdr(s.readAsAnon ? null : s.token),   // the app's dbReadHeaders falls back to anon for a stale token
      anonHeaders: () => hdr(null),                             // the app's dbHeaders
      canWrite: () => s.canWrite,
      token: () => s.token,
      userId: () => { if (s.userThrows) throw new Error("boom"); return s.user; },
      now: clockIso,
      nowMs: () => ms,
      onStatus: (st) => s.statuses.push(st),
      onToast: (m) => s.toasts.push(String(m)),
      onWipeBlocked: (i) => s.wipeBlocked.push(i),
      onInternalError: (e) => { internal.push(String(e && e.message || e)); s.internal = (s.internal || 0) + 1; },
      // what each call names, and what the screen showed for those weeks at that moment
      onAdopted: (ks) => { if (s.adoptThrows) throw new Error("an app bug in onAdopted"); s.adopted.push({ weeks: ks.slice().sort(), seen: ks.slice().sort().map(k => s.mirror[k] ? s.mirror[k].dayCall : null) }); },
      log: caughtLog(caught),
      timeouts: o.timeouts,
    });
    s.edit = (k, fn) => { s.mirror = Object.assign({}, s.mirror, { [k]: fn(clone(s.mirror[k] || {})) }); };
    s.drop = (k) => { const n = Object.assign({}, s.mirror); delete n[k]; s.mirror = n; };
    s.st = () => s.engine.status();
    s.last = () => s.statuses[s.statuses.length - 1] || {};   // the last onStatus REPORT — what the header shows
    s.line = () => line(s.last(), VIEW);
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
    await t.oldBuild("TOK_B", "user-b").upsert({ [W[0]]: wk("old-build") }, "2026-10-12T13:00:00.000Z"); // the emulator's old build: a version-preserving merge-duplicates upsert
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
    await t.recreate("TOK_B", W[0], wk("reborn"), { by: "user-b", at: "2026-10-12T14:00:00+00:00" }); // through the API: DELETE, then INSERT at v1
    await A.engine.pull();
    check("SE15 R18: a delete + re-insert at v1 (same version number) is still seen as a change", t.get(W[0]).version === 1 && A.mirror[W[0]].dayCall === "reborn", A.mirror[W[0]].dayCall);
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
  // adopt, don't re-send it unchanged right away (only after its backoff —
  // SE64); a new edit is sent at once (D: status classes).
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
    check("SE27b 400 → rejected: the edit stays on screen and pending, isn't re-sent unchanged by the next push, says so; a new edit is sent and lands",
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
    await t.oldBuild("TOK_B", "user-b").upsert({ [W[0]]: wk("old-build-swap") }, "2026-10-12T16:00:00.000Z");
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
  // a rejection (kept; re-sent unchanged only after its backoff, SE64); a
  // 23505 duplicate on an insert is read back (someone inserted it first →
  // conflict). Only JSON 403 42501 adopts the server copy (SE27).
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

  // SE54 — A12 (M28): an approval is pruned at the START of every push that no
  // longer deletes the week — not only when a later write confirms it. Clear
  // with two DELETEs failing (approved at v3), regenerate the 6 weeks with the
  // two re-create PATCHes ALSO failing (nothing confirms them, so only the
  // push-start prune can drop their approvals), then drop W1–W3: a half-wipe
  // that must be blocked like any other (zero DELETEs).
  await run("SE54", async () => {
    const t = mkTable(seedRows(6));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "DELETE", week: W[0], kind: "5xx-before" });
    t.control.fail({ method: "DELETE", week: W[1], kind: "5xx-before" });
    A.mirror = {};
    await A.engine.authoritative({}, true, "clear");
    t.control.fail({ method: "DELETE", kind: "5xx-before", count: 10 }); // keep the follow-up push from finishing the clear
    await A.engine.idle();
    t.control.clear();
    t.control.fail({ method: "PATCH", week: W[0], kind: "5xx-before" });
    t.control.fail({ method: "PATCH", week: W[1], kind: "5xx-before" });
    seedRows(6).forEach(r => A.edit(r.week_monday, () => wk("regen")));
    await A.engine.push();
    check("SE54 (fixture) 4 weeks re-created; the 2 re-create PATCHes failed (still the cleared-but-undeleted v3 rows, pending)",
      t.rows().length === 6 && t.get(W[0]).version === 3 && t.get(W[1]).version === 3 && t.get(W[2]).data.dayCall === "regen" && A.engine.pending().length === 2,
      JSON.stringify({ rows: t.rows().map(r => r.week_monday + "@" + r.version), pending: A.engine.pending() }));
    t.control.clear();
    [0, 1, 2].forEach(i => A.drop(W[i]));
    const from = t.log.length;
    const r = await A.engine.push();
    check("SE54 A12: dropping W1–W3 after a re-create whose write FAILED is a fresh half-wipe → blocked, zero DELETEs",
      r.blocked === true && writes(t, from).filter(e => e.method === "DELETE").length === 0 && t.rows().length === 6 && A.wipeBlocked.length === 1,
      JSON.stringify({ r: r.results, blocked: A.wipeBlocked, rows: t.rows().length }));
  });

  // SE55 — A3 (M33): a conflict found early in a multi-week push is adopted at
  // the END of the job — and only if the screen still shows what was sent. An
  // edit to that week made while a later week's request is out survives; the
  // conflict surfaces (loudly) on the next push instead.
  await run("SE55", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    B.edit(W[0], w => (w.dayCall = "sB", w)); await B.engine.push();
    A.edit(W[0], w => (w.dayCall = "sA", w));
    A.edit(W[1], w => (w.dayCall = "sA2", w));
    const hold = t.control.pause({ method: "PATCH", week: W[1], count: 1 });
    const p = A.engine.push(); await hold.arrived;   // W1's PATCH already met B's row (conflict, not yet adopted)
    A.edit(W[0], w => (w.dayCall = "sA-again", w));  // the user edits W1 again mid-job
    hold.release(); await p;
    check("SE55 A3: the end-of-job conflict adoption skips the week edited mid-job — the new edit stays on screen and pending, no toast yet",
      A.mirror[W[0]].dayCall === "sA-again" && A.engine.pending().join() === W[0] && t.get(W[1]).data.dayCall === "sA2" && A.st().conflicts.length === 0 && A.toasts.length === 0,
      JSON.stringify({ w0: A.mirror[W[0]].dayCall, pending: A.engine.pending(), toasts: A.toasts }));
    await A.engine.push();
    check("SE55 …the next push settles it loudly: B's copy shown, one conflict toast + entry, and B's row was never overwritten",
      A.mirror[W[0]].dayCall === "sB" && t.get(W[0]).data.dayCall === "sB" && A.toasts.length === 1 && /someone else/.test(A.toasts[0]) && A.st().conflicts.length === 1,
      JSON.stringify({ w0: A.mirror[W[0]].dayCall, toasts: A.toasts }));
  });

  // SE56 — A14.3: a publish (regenerate / accept-preview) with one week
  // answering 503 is NOT ok — the caller must not say "Regenerated!" or
  // broadcast; the failed week stays on screen, pending, and the follow-up
  // push lands it.
  await run("SE56", async () => {
    const t = mkTable(seedRows(4));
    const A = mkSession(t); await A.engine.load();
    const period = [W[0], W[1], W[2]];
    const gen = {}; period.forEach(k => { gen[k] = wk("regen"); });
    A.mirror = Object.assign({}, A.mirror, gen);
    t.control.fail({ method: "PATCH", week: W[1], kind: "5xx-before" });
    const r = await A.engine.authoritative(gen, false, "publish", period);
    check("SE56 one period week 503s → the publish outcome is NOT ok (no Regenerated!, no broadcast); the other weeks landed; W2 still shows the generated week and is pending",
      r.ok === false && t.get(W[0]).data.dayCall === "regen" && t.get(W[2]).data.dayCall === "regen" && t.get(W[1]).data.dayCall !== "regen"
        && A.mirror[W[1]].dayCall === "regen" && A.engine.pending().join() === W[1], JSON.stringify({ r: r.results, pending: A.engine.pending() }));
    await A.engine.idle(); await A.engine.push();
    check("SE56 …the follow-up push lands it", t.get(W[1]).data.dayCall === "regen" && A.engine.pending().length === 0);
  });

  // SE57 — A14(1): the stale-removal status as the HEADER sees it — through
  // onStatus (the app renders the last report, never status() directly). An
  // empty list while weeks are known reports it; a later pull that isn't
  // suppressed clears it; a wipe-shaped removal reports it until the second
  // pull agrees and adopts; a reset (sign-out) settles it.
  await run("SE57", async () => {
    const last = (s) => s.statuses[s.statuses.length - 1] || {};
    const t = mkTable(seedRows(6));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    const before = last(B).staleRemovals;
    A.mirror = {}; await A.engine.authoritative({}, true, "clear");
    await B.engine.pull();
    const onEmpty = last(B).staleRemovals;
    A.mirror = {}; W.slice(0, 6).forEach(k => { A.mirror[k] = wk("regen"); }); await A.engine.push();
    await B.engine.pull();
    check("SE57 A14(1) through onStatus: 0 after the load → 6 when the pull sees the cleared table (not adopted) → 0 once a later pull sees the weeks again (and adopts them)",
      before === 0 && onEmpty === 6 && last(B).staleRemovals === 0 && Object.keys(B.mirror).length === 6 && W.slice(0, 6).every(k => B.mirror[k].dayCall === "regen"),
      JSON.stringify({ before, onEmpty, after: last(B).staleRemovals }));
    // wipe-shaped: 4 of the 6 weeks deleted elsewhere
    A.mirror = {}; W.slice(4, 6).forEach(k => { A.mirror[k] = wk("regen"); }); await A.engine.authoritative(A.mirror, true, "restore");
    await B.engine.pull();
    const firstWipe = last(B).staleRemovals, keptOnScreen = Object.keys(B.mirror).length;
    await B.engine.pull();
    check("SE57 …a wipe-shaped removal: reported (4) and not adopted on the first pull; the second pull agrees, adopts it and clears the status",
      firstWipe === 4 && keptOnScreen === 6 && last(B).staleRemovals === 0 && Object.keys(B.mirror).join() === W.slice(4, 6).join(), JSON.stringify({ firstWipe, keptOnScreen, after: last(B).staleRemovals }));
    A.mirror = {}; await A.engine.authoritative({}, true, "clear");
    await B.engine.pull();
    const setAgain = last(B).staleRemovals;
    await B.engine.reset();
    check("SE57 …and a reset (sign-out) settles it: the reload of the empty table reports 0", setAgain === 2 && last(B).staleRemovals === 0 && Object.keys(B.mirror).length === 0, JSON.stringify({ setAgain, after: last(B).staleRemovals }));
  });

  // SE58 — A11(4): the weeks a queued or running clear / restore / publish
  // will write are not reported as pending — the header says Clearing… /
  // Restoring…, never "not saved" — while a week it won't write still is,
  // and the guards' pending() still counts them all (reloading would cut the
  // job short). When the job ends they're handed back in its last report: a
  // week it couldn't write is pending again.
  await run("SE58", async () => {
    const last = (s) => s.statuses[s.statuses.length - 1] || {};
    const t = mkTable(seedRows(6));
    const A = mkSession(t); await A.engine.load();
    A.edit(W[0], w => (w.dayCall = "e", w));
    const hold = t.control.pause({ method: "PATCH", week: W[0], count: 1 });
    const pp = A.engine.push(); await hold.arrived;       // a push on the wire: the clear queues behind it
    A.mirror = {};
    const from0 = A.statuses.length;
    const rc = A.engine.authoritative({}, true, "clear");
    const queued = { st: A.st(), rep: last(A), raw: A.engine.pending().length };
    const holdDel = t.control.pause({ method: "DELETE", week: W[3], count: 1 });
    hold.release(); await pp; await holdDel.arrived;     // the clear is running, three weeks deleted
    const mid = { st: A.st(), rep: last(A), raw: A.engine.pending().length };
    holdDel.release(); const r = await rc; await A.engine.idle();
    const reps = A.statuses.slice(from0);
    check("SE58 A11(4) a clear queued behind a push: from the click its weeks are not pending (0, busy 'clear' — 'Clearing…', not 'not saved'), reported at once; the guards' pending() still counts all 6",
      queued.st.pending === 0 && queued.st.busy === "clear" && queued.rep.pending === 0 && queued.rep.busy === "clear" && queued.raw === 6, JSON.stringify(queued));
    check("SE58 …running: still 0 and 'clear' with 3 weeks left to delete (pending() says 3); no report during the whole clear said a week was pending or failing; it ends empty, mirror = known, busy cleared",
      mid.st.pending === 0 && mid.st.busy === "clear" && mid.rep.busy === "clear" && mid.raw === 3 && reps.length > 2 && reps.every(s => s.pending === 0 && s.failing === 0)
        && r.ok && t.rows().length === 0 && A.engine.pending().length === 0 && last(A).pending === 0 && last(A).busy === null,
      JSON.stringify({ mid, reps: reps.map(s => [s.pending, s.failing, s.busy]), r: r.ok }));
    // A publish owns its period's weeks only.
    const t2 = mkTable(seedRows(6));
    const P = mkSession(t2); await P.engine.load();
    const period = [W[0], W[1], W[2]];
    const gen = {}; period.forEach(k => { gen[k] = wk("regen"); });
    P.edit(W[4], w => (w.dayCall = "outside", w));        // an edit outside the period
    P.mirror = Object.assign({}, P.mirror, gen);
    t2.control.fail({ method: "PATCH", week: W[1], kind: "5xx-before" });
    const holdP = t2.control.pause({ method: "PATCH", week: W[2], count: 1 });
    const from1 = P.statuses.length;
    const rp = P.engine.authoritative(gen, false, "publish", period); await holdP.arrived;
    const midP = { st: P.st(), raw: P.engine.pending() };
    const rel = P.statuses.length;
    holdP.release(); const r2 = await rp;
    // (16/n: the follow-up push's request reports at once now (E3), so "the
    // report after the last 'publish' one" could be ITS report; the job's own
    // end report is the one right after its push's end report — the first
    // report since the held PATCH was released.)
    const reps2 = P.statuses.slice(from1), afterRel = P.statuses.slice(rel), endRep = afterRel[1] || {};
    check("SE58 …a publish: mid-job only the edit OUTSIDE its period is pending (the period's weeks — one failed, one on the wire — are its own), pending() still names all three",
      midP.st.pendingKeys.join() === W[4] && midP.st.busy === "publish" && midP.raw.join() === [W[1], W[2], W[4]].join(), JSON.stringify(midP));
    check("SE58 …and the report it makes as it ends hands them back: its push's end report still says 'publish'; the very next — the job's own end report — has busy cleared, the week it couldn't write pending (and failing) again beside the outside edit",
      r2.ok === false && (afterRel[0] || {}).busy === "publish" && endRep.busy === null && (endRep.pendingKeys || []).join() === [W[1], W[4]].join() && endRep.failing === 1,
      JSON.stringify({ afterRel: afterRel.map(s => [s.busy, (s.pendingKeys || []).join("|"), s.failing]), reps2: reps2.length }));
    // A restore owns its snapshot's weeks and every week the table holds — not a brand-new local week it won't write.
    const t3 = mkTable(seedRows(4));
    const R = mkSession(t3); await R.engine.load();
    const snap = clone(R.mirror); snap[W[0]] = wk("snap"); delete snap[W[3]];
    R.mirror = clone(snap);
    const holdR = t3.control.pause({ method: "PATCH", week: W[0], count: 1 });
    const rr = R.engine.authoritative(snap, true, "restore"); await holdR.arrived;
    R.edit(W[7], () => wk("new-local"));
    const midR = R.st();
    holdR.release(); const r3 = await rr; await R.engine.idle();
    check("SE58 …a restore: mid-job the week it rewrites and the week it deletes are its own, a brand-new local week it won't write is still reported (busy 'restore'); afterwards it lands through the follow-up push",
      midR.pendingKeys.join() === W[7] && midR.busy === "restore" && r3.ok && sameData(tableSched(t3), Object.assign({}, snap, { [W[7]]: wk("new-local") })) && R.engine.pending().length === 0,
      JSON.stringify({ midR: midR.pendingKeys, busy: midR.busy, r3: r3.ok }));
  });

  // SE59 — A5(g) the stall watchdog and A5(f) the caller deadline, on
  // requests that never answer (paused; the request timeouts out of reach),
  // with a 15-ms stall bound and a 60-ms deadline (real timers: each fires
  // in due order, so the samples below are deterministic).
  await run("SE59", async () => {
    const last = (s) => s.statuses[s.statuses.length - 1] || {};
    const sleep = (n) => new Promise(res => setTimeout(res, n));
    const quick = { read: 60000, write: 60000, stall: 15, deadline: 60 };
    const t = mkTable(seedRows(4));
    const A = mkSession(t, { timeouts: quick }); await A.engine.load();
    check("SE59 (control) a load that makes progress is never stalled", A.st().stalled === false && A.statuses.length > 0 && A.statuses.every(s => s.stalled === false));
    const hang = t.control.pause({ method: "GET", count: 1 });  // the pull's version list never answers
    const pl = A.engine.pull(); await hang.arrived;
    const before = A.st().stalled;
    A.mirror = {};
    const rc = A.engine.authoritative({}, true, "clear");      // queued behind the stuck pull
    const rl = A.engine.load();                                  // and a sign-in's load
    await sleep(35);
    const stalledRep = last(A).stalled, busyRep = last(A).busy, stalledNow = A.st().stalled;
    const r = await Promise.race([rc, sleep(600).then(() => "no answer")]);
    const lr = await Promise.race([rl, sleep(600).then(() => "no answer")]);
    check("SE59 A5(g) no progress for the bound → stalled, REPORTED (the header reads onStatus): false before it, true after; the queued clear says 'Clearing…' meanwhile",
      before === false && stalledRep === true && stalledNow === true && busyRep === "clear", JSON.stringify({ before, stalledRep, stalledNow, busyRep }));
    check("SE59 A5(f) a clear queued behind the stuck job is answered at its deadline — ok:false, nothing written, reason timeout — and is no longer reported as owning the weeks",
      r !== "no answer" && r.ok === false && r.wrote === false && r.reason === "timeout" && !r.running && /nothing was changed/.test(r.error || "") && last(A).busy === null, JSON.stringify(r));
    check("SE59 A5(f) …the queued load is answered at its deadline too (ok:false, timeout)", lr !== "no answer" && lr.ok === false && lr.reason === "timeout", JSON.stringify(lr));
    // (14/n: the ENGINE puts the screen back when it cancels the clear — the app used to, after the answer)
    const putBack = Object.keys(A.mirror).length === 4 && sameData(A.mirror, A.engine.knownSchedule());
    const from = t.log.length;
    hang.release(); await pl; await A.engine.idle(); await A.engine.idle();
    check("SE59 …the cancelled clear put the screen back at its deadline (the 4 weeks); once the stuck request answers, the stall is cleared (reported), the cancelled clear NEVER runs (zero DELETEs, the 4 weeks still there), and the load ran in its turn",
      putBack && last(A).stalled === false && A.st().stalled === false && writes(t, from).length === 0 && t.rows().length === 4 && t.log.slice(from).some(e => e.method === "GET"),
      JSON.stringify({ st: last(A).stalled, w: writes(t, from).map(e => e.method + " " + e.url) }));
    // A job already writing at its deadline: "still running", never cut short; its outcome is toasted when it ends.
    const t2 = mkTable(seedRows(4));
    const B = mkSession(t2, { timeouts: quick }); await B.engine.load();
    const snap = clone(B.mirror); snap[W[0]] = wk("snap");
    B.mirror = clone(snap);
    const holdB = t2.control.pause({ method: "PATCH", week: W[0], count: 1 });
    const rr = B.engine.authoritative(snap, true, "restore"); await holdB.arrived;
    const r2 = await Promise.race([rr, sleep(600).then(() => "no answer")]);
    const toastsAtDeadline = B.toasts.length, stalledMid = last(B).stalled;
    holdB.release(); await B.engine.idle(); await sleep(5);
    check("SE59 A5(f) a restore already writing at its deadline → ok:false, running:true (not 'nothing was changed'); it keeps going and lands",
      r2 !== "no answer" && r2.ok === false && r2.running === true && r2.reason === "timeout" && /still running/.test(r2.error || "") && sameData(tableSched(t2), snap) && stalledMid === true,
      JSON.stringify({ r2, table: t2.get(W[0]).data.dayCall }));
    check("SE59 …and its outcome is told once, when it ends: exactly one toast, 'finished — every week is saved'",
      toastsAtDeadline === 0 && B.toasts.length === 1 && /Restoring the snapshot has finished — every week is saved/.test(B.toasts[0]) && last(B).stalled === false, JSON.stringify(B.toasts));
    // A8: a clear still waiting for its turn at a sign-out never runs under the next account.
    const t3 = mkTable(seedRows(4));
    const C = mkSession(t3); await C.engine.load();
    const hang3 = t3.control.pause({ method: "GET", count: 1 });
    const pl3 = C.engine.pull(); await hang3.arrived;
    C.mirror = {};
    const rc3 = C.engine.authoritative({}, true, "clear");
    C.engine.reset();                                // sign-out while the clear waits
    C.token = "TOK_B"; C.user = "user-b";            // someone else signs in
    const from3 = t3.log.length;
    hang3.release(); await pl3; const r3 = await rc3; await C.engine.idle(); await C.engine.idle();
    check("SE59 A8 a clear queued before a sign-out is cancelled by it: it never runs under the next account (zero writes, the 4 weeks kept), and says nothing was changed",
      r3.ok === false && r3.wrote === false && r3.skipped === "cancelled" && writes(t3, from3).length === 0 && t3.rows().length === 4 && Object.keys(C.mirror).length === 4,
      JSON.stringify({ r3, w: writes(t3, from3).map(e => e.method + " " + e.url) }));
  });

  // SE60 — A13 onAdopted(weeks): called once per adoption that changes what's
  // on screen (a pull, a conflict), AFTER the commit, naming exactly those
  // weeks; never for this session's own saved write, the seed (load), a
  // clear / restore re-commit, or a pulled change already on screen. A
  // callback that throws doesn't break the job.
  await run("SE60", async () => {
    const t = mkTable(seedRows(4));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    A.edit(W[0], w => (w.dayCall = "mine", w)); await A.engine.push();
    const quiet1 = A.adopted.length;
    B.edit(W[1], w => (w.dayCall = "peer1", w)); B.edit(W[3], w => (w.dayCall = "peer3", w)); await B.engine.push();
    await A.engine.pull();
    check("SE60 A13 a pull that adopts two peer weeks → ONE onAdopted naming exactly those two, called after the commit (the screen already showed both); none for the load or our own saved write",
      quiet1 === 0 && A.adopted.length === 1 && A.adopted[0].weeks.join() === [W[1], W[3]].join() && A.adopted[0].seen.join() === "peer1,peer3", JSON.stringify(A.adopted));
    B.edit(W[2], w => (w.dayCall = "peer2", w)); await B.engine.push();
    A.edit(W[2], w => (w.dayCall = "mine2", w)); await A.engine.push();
    check("SE60 …a conflict adoption (our push meets the peer's copy) → onAdopted for that week, the peer's copy already on screen",
      A.adopted.length === 2 && A.adopted[1].weeks.join() === W[2] && A.adopted[1].seen.join() === "peer2" && A.st().conflicts.length === 1, JSON.stringify(A.adopted));
    t.put({ week_monday: W[1], data: clone(A.mirror[W[1]]), version: 9, updated_at: "2026-10-12T19:00:00+00:00" }); // re-saved elsewhere, same data
    await A.engine.pull();
    const snap = clone(A.mirror); snap[W[0]] = wk("snap");
    A.mirror = clone(snap); await A.engine.authoritative(snap, true, "restore");
    check("SE60 …none for a pulled change already on screen, or a restore's re-commit", A.adopted.length === 2 && t.get(W[0]).data.dayCall === "snap", JSON.stringify(A.adopted));
    A.adoptThrows = true;
    const caught0 = caught.length;
    B.edit(W[3], w => (w.dayCall = "peer3b", w)); await B.engine.push();
    const r = await A.engine.pull();
    const thrown = caught.slice(caught0);
    check("SE60 …an onAdopted that throws doesn't break the job: the pull still adopted the week and answered ok, the engine reported no internal error — and it CAUGHT and logged the throw (once: the harness's recorder sees it)",
      r.ok && A.mirror[W[3]].dayCall === "peer3b" && !A.internal && thrown.length === 1 && /^onAdopted threw an app bug in onAdopted$/.test(thrown[0]), JSON.stringify({ r, thrown }));
    caught.splice(caught0, thrown.length); // expected here — not counted against SE-I
  });

  // SE61 — the publish I2 hole (§7b of the engine read): a publish (a force
  // job over its period's weeks) re-reads every unconfirmed week first. One
  // OUTSIDE its period that someone else changed is a conflict exactly as in
  // a normal push — their copy shown and told — never silently taken as
  // known, which let the follow-up push overwrite it under a CAS taken from
  // their row (0 conflicts, their change gone).
  await run("SE61", async () => {
    const t = mkTable(seedRows(4));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    t.control.fail({ method: "PATCH", week: W[3], kind: "5xx-before" });
    A.edit(W[3], w => (w.dayCall = "A-edit", w)); await A.engine.push();   // not written: A's body stays unconfirmed in the ledger
    B.edit(W[3], w => (w.dayCall = "B-edit", w)); await B.engine.push();   // B's change lands (v4)
    check("SE61 (setup) A's edit to W4 is unsaved (pending, unconfirmed); B's change to it is on the table", A.engine.pending().join() === W[3] && t.get(W[3]).data.dayCall === "B-edit" && t.get(W[3]).version === 4);
    const period = [W[0], W[1]];
    const gen = {}; period.forEach(k => { gen[k] = wk("regen"); });
    A.mirror = Object.assign({}, A.mirror, gen);
    const toasts0 = A.toasts.length, adopted0 = A.adopted.length;
    const r = await A.engine.authoritative(clone(A.mirror), false, "publish", period);
    await A.engine.idle(); await A.engine.idle();   // the follow-up push it requests
    const aW3 = t.log.filter(e => e.method === "PATCH" && e.url.includes(W[3]) && e.headers.authorization === "Bearer TOK_A");
    // (14/n: a publish is quiet — its caller's one message tells it, from r.notice; SE66)
    check("SE61 §7b B's change to a week OUTSIDE the period survives the publish and its follow-up push: A shows it, ONE conflict entry, onAdopted, told once — in the publish's notice (its caller's one message; the engine toasts nothing beside it); nothing left pending",
      t.get(W[3]).data.dayCall === "B-edit" && A.mirror[W[3]].dayCall === "B-edit" && A.st().conflicts.map(c => c.k).join() === W[3] && A.adopted.slice(adopted0).some(x => x.weeks.join() === W[3])
        && /changed by someone else/.test(r.notice || "") && A.toasts.slice(toasts0).length === 0 && A.engine.pending().length === 0,
      JSON.stringify({ table: t.get(W[3]).data.dayCall, shown: A.mirror[W[3]].dayCall, conflicts: A.st().conflicts, notice: r.notice, toasts: A.toasts.slice(toasts0) }));
    check("SE61 …and the publish itself landed and answers ok (another week's conflict doesn't withhold 'Regenerated!' or the broadcast); A's only W4 PATCH was the first, failed one",
      r.ok === true && period.every(k => t.get(k).data.dayCall === "regen") && aW3.length === 1, JSON.stringify({ ok: r.ok, results: r.results, aW3: aW3.length }));
  });

  // SE62 — A7 / I5: the SERVER refuses a token this device's clock calls
  // fresh (clock skew), so the read headers keep carrying it. Once a 401 has
  // been answered for it, every read goes out as anon: the pull still adopts
  // other people's changes; writes stay refused (auth-needed); a new token
  // is read and written with again.
  await run("SE62", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    const loadedWithToken = t.log.filter(e => e.method === "GET" && e.headers.authorization === "Bearer TOK_A").length;
    t.control.expiredTokens.add("TOK_A");   // the server: expired. A.readAsAnon stays false — the device clock calls it fresh.
    A.edit(W[0], w => (w.dayCall = "mine", w));
    await A.engine.push();
    check("SE62 (setup) the write is answered 401 → auth-needed for that token; the edit kept and pending; before it, this session read WITH its token",
      A.engine.authBlocked() && A.st().authNeeded && A.engine.pending().join() === W[0] && A.mirror[W[0]].dayCall === "mine" && loadedWithToken >= 1);
    B.edit(W[1], w => (w.dayCall = "peer", w)); await B.engine.push();
    const from = t.log.length;
    const r = await A.engine.pull();
    const reqs = t.log.slice(from);
    check("SE62 A7 the pull after the server's 401 reads as ANON — every request a GET without the dead token, none answered 401 — and adopts B's change; the unsaved edit stays",
      r.ok === true && reqs.length >= 2 && reqs.every(e => e.method === "GET" && e.headers.authorization === "Bearer ANON" && e.status === 200) && A.mirror[W[1]].dayCall === "peer" && A.mirror[W[0]].dayCall === "mine" && A.engine.pending().join() === W[0],
      JSON.stringify({ r, reqs: reqs.map(e => [e.method, e.headers.authorization, e.status]) }));
    check("SE62 …and writes stay refused: the pull's follow-up push sent nothing, still auth-needed", reqs.every(e => e.method === "GET") && A.engine.authBlocked() && A.st().authNeeded);
    t.control.users.TOK_A2 = "user-a"; A.token = "TOK_A2";   // "Sign in again" stored a new token
    const from2 = t.log.length;
    await A.engine.pull();
    const reqs2 = t.log.slice(from2);
    check("SE62 …a new token is read with again (never anon), and the pending week lands under it by CAS",
      reqs2.some(e => e.method === "GET" && e.headers.authorization === "Bearer TOK_A2") && !reqs2.some(e => e.headers.authorization === "Bearer ANON")
        && reqs2.some(e => e.method === "PATCH" && e.headers.authorization === "Bearer TOK_A2" && e.status === 200) && t.get(W[0]).data.dayCall === "mine" && !A.st().authNeeded && A.engine.pending().length === 0,
      JSON.stringify(reqs2.map(e => [e.method, e.headers.authorization, e.status])));
  });

  // SE63 — A4's failure-injection list, one uniform check: a 429, 408, 413,
  // a gateway's HTML 403, a 400 PGRST204, a 400 22P02 and a 409 23505 each
  // keep the week pending with the local edit and NEVER adopt (no onAdopted,
  // no conflict, no commit of the screen); only a JSON 403 / 42501 adopts the
  // server copy. Each then lands once the server answers (a rejection after
  // its backoff).
  await run("SE63", async () => {
    const CASES = [["429", "PATCH"], ["408", "PATCH"], ["413", "PATCH"], ["html-403", "PATCH"], ["400-schema", "PATCH"], ["400-22P02", "PATCH"], ["409", "POST"]];
    for (const [kind, method] of CASES) {
      const t = mkTable(seedRows(2));
      const A = mkSession(t); await A.engine.load();
      const K = method === "POST" ? W[5] : W[0];
      t.control.fail({ method, week: K, kind });
      A.edit(K, w => method === "POST" ? wk("new") : (w.dayCall = "mine", w));
      const want = clone(A.mirror[K]), commits = A.commits;
      const r = await A.engine.push();
      const injected = t.log.some(e => e.method === method && e.injected === kind);
      const kept = injected && !r.ok && sameData(A.mirror[K], want) && A.commits === commits && A.adopted.length === 0 && A.st().conflicts.length === 0 && A.engine.pending().join() === K
        && (method === "POST" ? !t.get(K) : t.get(K).data.dayCall !== "mine");
      ms += 61000;
      await A.engine.push();
      check(`SE63 A4 ${kind} on a ${method} → kept pending with the local edit, never adopted (no onAdopted, conflict or commit); it lands once the server answers`,
        kept && !!t.get(K) && sameData(t.get(K).data, want) && A.engine.pending().length === 0, JSON.stringify({ kind, injected, kept, st: A.st(), toasts: A.toasts }));
    }
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "PATCH", week: W[0], kind: "403" });
    A.edit(W[0], w => (w.dayCall = "mine", w));
    await A.engine.push();
    check("SE63 A4 …only a JSON 403 / 42501 adopts: the server copy is shown (onAdopted), nothing pending, the toast says refused",
      A.mirror[W[0]].dayCall !== "mine" && sameData(A.mirror[W[0]], t.get(W[0]).data) && A.adopted.length === 1 && A.adopted[0].weeks.join() === W[0] && A.engine.pending().length === 0 && A.toasts.some(m => /refused/.test(m)),
      JSON.stringify({ shown: A.mirror[W[0]].dayCall, adopted: A.adopted, toasts: A.toasts }));
  });

  // SE64 — A4, the client / schema error class: a rejected body is kept and
  // pending (pending() — what the reload guard counts — names it), re-sent
  // unchanged at the poll cadence with backoff (1 min, then 2, …), toasted
  // ONCE per new code with writeFailReason's reason, and reported for the
  // header's sticky line (rejected + rejectCodes). A changed body goes out
  // at once; a code is told again only once nothing was rejected with it.
  await run("SE64", async () => {
    const last = (s) => s.statuses[s.statuses.length - 1] || {};
    const t = mkTable(seedRows(3));
    const A = mkSession(t); await A.engine.load();
    const patches = () => t.log.filter(e => e.method === "PATCH").length;
    t.control.fail({ method: "PATCH", week: W[0], kind: "400-schema", count: 3 });
    A.edit(W[0], w => (w.dayCall = "mine", w));
    await A.engine.push(); const t0 = ms;
    const p1 = patches(), toast1 = A.toasts.slice(), rep1 = last(A);
    await A.engine.push();
    ms = t0 + 30000; await A.engine.push();
    const p2 = patches();
    ms = t0 + 61000; await A.engine.push(); const t1 = ms;   // due after 1 min: re-sent, rejected again (same code)
    const p3 = patches(), toasts3 = A.toasts.length;
    ms = t1 + 61000; await A.engine.push();                   // the backoff doubled: not due 1 min later
    const p4 = patches();
    ms = t1 + 121000; await A.engine.push();                  // due after 2 min: re-sent, rejected again
    const p5 = patches();
    check("SE64 A4 a rejected body stays on screen and pending (pending() — the reload guard's count — names it), never adopted",
      A.mirror[W[0]].dayCall === "mine" && A.engine.pending().join() === W[0] && A.adopted.length === 0 && A.st().conflicts.length === 0 && t.get(W[0]).data.dayCall !== "mine");
    check("SE64 A4 retried at the poll cadence with backoff: not re-sent at once or after 30 s; re-sent after 1 min; then not 1 min later, but after 2 (the backoff doubles)",
      p1 === 1 && p2 === 1 && p3 === 2 && p4 === 2 && p5 === 3, JSON.stringify({ p1, p2, p3, p4, p5 }));
    check("SE64 A4 toasted ONCE for the code, naming the week, the code and writeFailReason's reason — not again when a retry is rejected with the same code",
      toast1.length === 1 && /^The week of .+ couldn't be saved \(PGRST204\): the server rejected it — this app may be out of date \(reload or update it\)\. It stays on this screen and is retried\.$/.test(toast1[0]) && toasts3 === 1 && A.toasts.length === 1,
      JSON.stringify(A.toasts));
    check("SE64 A4 the header's report (onStatus): rejected names the week, rejectCodes the code — from the first rejection and across the retries; failing counts it",
      (rep1.rejected || []).join() === W[0] && (rep1.rejectCodes || []).join() === "PGRST204" && (last(A).rejected || []).join() === W[0] && (last(A).rejectCodes || []).join() === "PGRST204" && last(A).failing === 1,
      JSON.stringify({ rep1: [rep1.rejected, rep1.rejectCodes], last: [last(A).rejected, last(A).rejectCodes, last(A).failing] }));
    t.control.clear(); t.control.fail({ method: "PATCH", week: W[0], kind: "400-22P02" });
    ms += 241000; await A.engine.push();                       // the next retry (after 4 min) meets a NEW code
    const newCode = A.toasts.length === 2 && /couldn't be saved \(22P02\)/.test(A.toasts[1]) && (last(A).rejectCodes || []).join() === "22P02";
    const from = t.log.length;
    A.edit(W[0], w => (w.dayCall = "mine2", w)); await A.engine.push();   // a CHANGED body goes out at once, backoff or not
    check("SE64 A4 …a NEW code on a retry is toasted (once) and is the code reported; a changed body is sent at once and lands — nothing rejected in the report after",
      newCode && writes(t, from).length === 1 && t.get(W[0]).data.dayCall === "mine2" && A.engine.pending().length === 0 && (last(A).rejected || []).length === 0 && (last(A).rejectCodes || []).length === 0,
      JSON.stringify({ toasts: A.toasts, w: writes(t, from).map(e => e.method) }));
    t.control.fail({ method: "PATCH", week: W[1], kind: "400-schema" });
    A.edit(W[1], w => (w.dayCall = "again", w)); await A.engine.push();
    check("SE64 A4 …once nothing is rejected with a code it is forgotten: a later PGRST204 is told again",
      A.toasts.length === 3 && /The week of .+ couldn't be saved \(PGRST204\)/.test(A.toasts[2]), JSON.stringify(A.toasts));
    // A rejected DELETE waits out its backoff too.
    t.control.clear(); t.control.fail({ method: "DELETE", week: W[2], kind: "400-22P02" });
    ms += 61000; A.drop(W[2]); await A.engine.push();
    const d1 = t.log.filter(e => e.method === "DELETE").length;
    await A.engine.push();
    const d2 = t.log.filter(e => e.method === "DELETE").length;
    ms += 61000; await A.engine.push();
    check("SE64 A4 a rejected DELETE is kept pending and waits out its backoff too (not re-sent by the next push), then goes through",
      d1 === 1 && d2 === 1 && t.log.filter(e => e.method === "DELETE").length === 2 && !t.get(W[2]) && !A.engine.pending().includes(W[2]), JSON.stringify({ d1, d2, pending: A.engine.pending() }));
  });

  // SE65 — A16: a conflicts entry ("replaced by someone else's change")
  // stays until it's dismissed, the session resets, or the user edits THAT
  // week again. An edit to another week, a later pull, or a restore that
  // rewrites the week (it isn't the user editing it again) leaves it.
  await run("SE65", async () => {
    const last = (s) => s.statuses[s.statuses.length - 1] || {};
    const ks = (s) => (last(s).conflicts || []).map(c => c.k).join();
    const t = mkTable(seedRows(4));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    [0, 1].forEach(i => B.edit(W[i], w => (w.dayCall = "peer", w))); await B.engine.push();
    [0, 1].forEach(i => A.edit(W[i], w => (w.dayCall = "mine", w))); await A.engine.push();
    const two = ks(A);
    A.edit(W[2], w => (w.dayCall = "other", w)); await A.engine.push();
    B.edit(W[3], w => (w.dayCall = "peer3", w)); await B.engine.push(); await A.engine.pull();
    const kept = ks(A);
    A.edit(W[0], w => (w.dayCall = "reapplied", w)); await A.engine.push();
    check("SE65 A16 two conflicts → two entries; an edit to ANOTHER week and a later pull keep both; editing one of THOSE weeks again drops just its entry (reported), and the re-applied edit lands",
      two === [W[0], W[1]].join() && kept === two && ks(A) === W[1] && A.st().conflicts.map(c => c.k).join() === W[1] && t.get(W[0]).data.dayCall === "reapplied" && t.get(W[2]).data.dayCall === "other",
      JSON.stringify({ two, kept, now: ks(A) }));
    // A restore queued (behind a pull on the wire) that rewrites W2: not the user editing it again.
    const snap = clone(A.mirror); snap[W[1]] = wk("snap"); snap[W[2]] = wk("snap");
    const hold = t.control.pause({ method: "GET", count: 1 });
    const pl = A.engine.pull(); await hold.arrived;
    A.mirror = clone(snap);
    const rr = A.engine.authoritative(snap, true, "restore");
    hold.release(); await pl; const r = await rr; await A.engine.idle(); await A.engine.idle();
    check("SE65 A16 …a restore queued behind a job and rewriting that week leaves the entry: still listed after the restore succeeds and its follow-up push",
      r.ok && t.get(W[1]).data.dayCall === "snap" && A.mirror[W[1]].dayCall === "snap" && ks(A) === W[1] && A.st().conflicts.length === 1, JSON.stringify({ r: r.ok, now: ks(A) }));
    A.engine.dismissConflicts();
    const dismissed = ks(A) === "" && A.st().conflicts.length === 0;
    await B.engine.pull(); B.edit(W[2], w => (w.dayCall = "peer2", w)); await B.engine.push();
    A.edit(W[2], w => (w.dayCall = "mine2", w)); await A.engine.push();
    const again = ks(A) === W[2];
    await A.engine.reset();
    check("SE65 A16 …dismissing clears it (reported), and a reset (sign-out) clears a new one", dismissed && again && ks(A) === "" && A.st().conflicts.length === 0, JSON.stringify({ dismissed, again, now: ks(A) }));
  });

  // SE66 — 14/n: a clear / reset / restore / publish is QUIET. Its caller
  // tells the outcome in ONE toast; the engine hands its own detail back as
  // the result's `notice` (which weeks, and why) — uncapped, since a caller
  // always tells its outcome — and toasts nothing beside it. The cap still
  // starts, so the follow-up push doesn't repeat it. A job that ends after its
  // caller stopped waiting puts the notice in its one late toast.
  await run("SE66", async () => {
    const DEL1 = "Couldn't delete 1 week yet — retrying every minute while the app is open.";
    const t = mkTable(seedRows(4));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "DELETE", week: W[1], kind: "5xx-before", count: 3 });
    A.mirror = {};
    const r = await A.engine.authoritative({}, true, "clear");
    const toastsAfterJob = A.toasts.length;
    await A.engine.idle(); await A.engine.idle(); // the follow-up push it requests: W2's DELETE fails again
    check("SE66 a partly failed clear: ok:false, wrote; its notice names the week not DELETED ('delete', not 'save'); the engine toasted nothing — in the job, or in the follow-up push for the same week",
      r.ok === false && r.wrote === true && r.notice === DEL1 && toastsAfterJob === 0 && A.toasts.length === 0 && t.rows().length === 1 && A.engine.pending().join() === W[1],
      JSON.stringify({ r: { ok: r.ok, wrote: r.wrote, notice: r.notice }, toasts: A.toasts, rows: t.rows().map(x => x.week_monday) }));
    const r2 = await A.engine.authoritative({}, true, "clear");
    await A.engine.idle(); await A.engine.idle();
    check("SE66 …a second clear within the 5-min cap, the same week failing: its notice is still there (a caller always tells its outcome), still no engine toast; the follow-up push then lands it",
      r2.ok === false && r2.notice === DEL1 && A.toasts.length === 0 && t.rows().length === 0 && A.engine.pending().length === 0, JSON.stringify({ notice: r2.notice, toasts: A.toasts, rows: t.rows().length }));
    const ok = await A.engine.authoritative({}, true, "clear");
    check("SE66 …a clear that lands has no notice", ok.ok === true && ok.notice === null && A.toasts.length === 0, JSON.stringify(ok));
    // control: the same failure in an ORDINARY push is toasted — once, saying "delete"
    const t2 = mkTable(seedRows(4));
    const B = mkSession(t2); await B.engine.load();
    t2.control.fail({ method: "DELETE", week: W[2], kind: "5xx-before", count: 1 });
    B.drop(W[2]); const rb = await B.engine.push();
    check("SE66 control: an ordinary push whose one deletion fails IS toasted (once, 'Couldn't delete 1 week'), and an ordinary push carries no notice",
      B.toasts.length === 1 && B.toasts[0] === DEL1 && rb.ok === false && !("notice" in rb), JSON.stringify({ toasts: B.toasts, rb }));
    // a restore still writing at its caller's deadline, ending with a week not saved: ONE late toast, the notice in it
    const sleep = (n) => new Promise(res => setTimeout(res, n));
    const t3 = mkTable(seedRows(4));
    const C = mkSession(t3, { timeouts: { read: 60000, write: 60000, stall: 15, deadline: 60 } }); await C.engine.load();
    const snap = clone(C.mirror); snap[W[0]] = wk("snap0"); snap[W[1]] = wk("snap1");
    C.mirror = clone(snap);
    const hold = t3.control.pause({ method: "PATCH", week: W[0], count: 1 });
    t3.control.fail({ method: "PATCH", week: W[1], kind: "5xx-before", count: 5 });
    const rr = C.engine.authoritative(snap, true, "restore"); await hold.arrived;
    const r3 = await Promise.race([rr, sleep(600).then(() => "no answer")]);
    const atDeadline = C.toasts.length;
    hold.release(); await C.engine.idle(); await sleep(5); await C.engine.idle(); await C.engine.idle();
    check("SE66 a restore still running at its deadline that ends with a week not saved: answered 'running', then ONE toast when it ends — 'finished, but not every week is saved' with the job's notice in it; the follow-up push adds none",
      r3 !== "no answer" && r3.running === true && atDeadline === 0 && C.toasts.length === 1
        && C.toasts[0] === "Restoring the snapshot has finished, but not every week is saved. Couldn't save 1 week yet — retrying every minute while the app is open." && t3.get(W[0]).data.dayCall === "snap0",
      JSON.stringify({ r3, toasts: C.toasts }));
  });

  // SE67 — 14/n: a clear / reset / restore that writes NOTHING (refused: the
  // table unreadable, signed out) puts the screen back to what the table
  // holds IN the job, before its follow-up push reads the mirror. Left to the
  // caller (after the answer), that push ran first: a refused restore's weeks
  // went out as an ordinary push, a refused clear tripped the wipe guard. A
  // week edited after the tap keeps its edit (and is pushed); a refused
  // PUBLISH keeps its weeks on screen, pending (A14).
  await run("SE67", async () => {
    const t = mkTable(seedRows(4));
    const A = mkSession(t); await A.engine.load();
    const snap = clone(A.mirror); snap[W[0]] = wk("snapA"); delete snap[W[3]];
    A.mirror = clone(snap);
    t.control.fail({ method: "GET", kind: "5xx-before", count: 1 });
    const from = t.log.length;
    const r = await A.engine.authoritative(snap, true, "restore"); await A.engine.idle(); await A.engine.idle();
    check("SE67 a restore refused (the table couldn't be re-read): the screen is back to what the table holds, and its follow-up push sent NOTHING — the refused snapshot never goes out as an ordinary push",
      r.ok === false && r.wrote === false && /nothing was changed/.test(r.error || "") && writes(t, from).length === 0 && sameData(A.mirror, tableSched(t)) && A.engine.pending().length === 0 && A.wipeBlocked.length === 0,
      JSON.stringify({ r, w: writes(t, from).map(e => e.method + " " + e.url), shown: Object.keys(A.mirror) }));
    A.mirror = {}; t.control.fail({ method: "GET", kind: "5xx-before", count: 1 });
    const c = await A.engine.authoritative({}, true, "clear"); await A.engine.idle(); await A.engine.idle();
    check("SE67 …a clear refused the same way: the 4 weeks back on screen, zero writes, and no wipe-guard trip (the follow-up push has nothing to delete)",
      c.wrote === false && Object.keys(A.mirror).length === 4 && writes(t, from).length === 0 && A.wipeBlocked.length === 0 && A.st().blockedDeletes === 0, JSON.stringify({ c, wb: A.wipeBlocked }));
    A.mirror = {}; t.control.fail({ method: "GET", kind: "5xx-before", count: 1 }); const hold = t.control.pause({ method: "GET", count: 1 });
    const c2p = A.engine.authoritative({}, true, "clear"); await hold.arrived;
    A.mirror = Object.assign({}, A.mirror, { [W[1]]: wk("after-tap") }); // edited while the clear waits on its read
    hold.release(); const c2 = await c2p; await A.engine.idle(); await A.engine.idle();
    check("SE67 …a week edited AFTER the tap keeps the edit — and it's pushed (one PATCH); the other weeks come back; no wipe-guard trip",
      c2.wrote === false && A.mirror[W[1]].dayCall === "after-tap" && t.get(W[1]).data.dayCall === "after-tap" && Object.keys(A.mirror).length === 4 && t.rows().length === 4
        && writes(t, from).length === 1 && writes(t, from)[0].method === "PATCH" && A.wipeBlocked.length === 0, JSON.stringify({ shown: Object.keys(A.mirror), w: writes(t, from).map(e => e.method) }));
    A.token = null; A.mirror = {};
    const c3 = await A.engine.authoritative({}, true, "clear");
    check("SE67 …signed out: refused before any read, and the screen is back as well", c3.wrote === false && /sign in/i.test(c3.error || "") && Object.keys(A.mirror).length === 4, JSON.stringify(c3));
    A.token = "TOK_A";
    const gen = { [W[0]]: wk("gen0"), [W[2]]: wk("gen2") };
    A.mirror = Object.assign({}, A.mirror, gen);
    t.control.fail({ method: "GET", kind: "5xx-before", count: 1 });
    const from2 = t.log.length;
    const p = await A.engine.authoritative(clone(A.mirror), false, "publish", [W[0], W[2]]);
    const keptShown = A.mirror[W[0]].dayCall === "gen0" && A.mirror[W[2]].dayCall === "gen2";
    await A.engine.idle(); await A.engine.idle();
    check("SE67 …a PUBLISH refused the same way keeps its weeks on screen, pending — and its follow-up push lands them (A14: retried, never dropped)",
      p.ok === false && p.wrote === false && keptShown && t.get(W[0]).data.dayCall === "gen0" && t.get(W[2]).data.dayCall === "gen2" && writes(t, from2).length === 2, JSON.stringify({ p, keptShown }));
  });

  // SE68 — A5 on the emulator's never-settling requests (A17(d)): a PATCH that
  // COMMITS and then never answers ('hang-after') is aborted at its timeout
  // and read back — our own body: saved, quietly. A pull whose version list
  // never answers ('hang', nothing applied) fails as a read (no adoption, no
  // removal), and the next pull runs.
  await run("SE68", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t, { timeouts: { read: 150, write: 150 } }), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    t.control.fail({ method: "PATCH", week: W[0], kind: "hang-after", count: 1 });
    A.edit(W[0], w => (w.dayCall = "x", w));
    const r = await A.engine.push();
    const p = t.log.find(e => e.method === "PATCH");
    check("SE68 A5 a PATCH that commits and then NEVER answers: aborted at its timeout, read back, found to hold what's on screen → saved (no conflict, no toast, nothing pending)",
      r.ok && !!p && p.injected === "hang-after" && p.applied === true && p.error === "AbortError" && t.get(W[0]).data.dayCall === "x" && A.engine.knownVersion(W[0]) === 4
        && A.st().pending === 0 && A.st().conflicts.length === 0 && A.toasts.length === 0, JSON.stringify({ r: r.results, p: p && [p.applied, p.error], toasts: A.toasts }));
    B.edit(W[1], w => (w.dayCall = "peer", w)); await B.engine.push();
    t.control.fail({ method: "GET", kind: "hang", count: 1 });
    const shown = clone(A.mirror);
    const p1 = await A.engine.pull();
    const after1 = sameData(A.mirror, shown);
    const p2 = await A.engine.pull();
    const hung = t.log.find(e => e.injected === "hang");
    check("SE68 A5 a pull whose GET never answers (nothing applied): aborted at its timeout, a FAILED read — nothing adopted or removed; the next pull runs and adopts the peer's week",
      p1.ok === false && after1 && !!hung && hung.error === "AbortError" && hung.applied === false && p2.ok === true && A.mirror[W[1]].dayCall === "peer" && Object.keys(A.mirror).length === 3,
      JSON.stringify({ p1, p2, w1: A.mirror[W[1]].dayCall }));
  });

  // SE69 — A4: a 404 PGRST205 (the TABLE missing from PostgREST's schema
  // cache — a deploy mid-migration) is UNKNOWN, not a client error: read back
  // (which 404s too), the edit kept pending and failing — never "rejected"
  // (no backoff, no "reload/update the app"), never adopted — and the next
  // push lands it.
  await run("SE69", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ week: W[0], kind: "404-PGRST205", count: 2 }); // the PATCH and its read-back
    A.edit(W[0], w => (w.dayCall = "s9", w));
    const r = await A.engine.push();
    const hits = t.log.filter(e => e.injected === "404-PGRST205").map(e => e.method).join();
    const kept = !r.ok && A.mirror[W[0]].dayCall === "s9" && A.st().pending === 1 && A.st().failing === 1 && A.st().rejected.length === 0 && A.st().conflicts.length === 0 && A.adopted.length === 0
      && A.toasts.length === 1 && /^Couldn't save 1 week yet/.test(A.toasts[0]) && !/PGRST205|rejected/.test(A.toasts[0]);
    await A.engine.push();
    check("SE69 A4 a 404 PGRST205 on a PATCH → unknown: read back (404 too), kept pending + failing with the edit — not rejected, not adopted, told as 'couldn't save … retrying'; the next push lands it",
      hits === "PATCH,GET" && kept && t.get(W[0]).data.dayCall === "s9" && A.st().pending === 0, JSON.stringify({ hits, st: A.st(), toasts: A.toasts }));
  });

  // SE70 — A2: a server that RENDERS updated_at itself (the emulator's
  // stampUpdatedAt: a trigger, its own clock). The engine's CAS must come from
  // what the server returned — a response or a read — never the updated_at it
  // put in the body: repeated edits land, a 504-after-commit is read back as
  // ours, the keepalive's CAS matches, a pull after our own writes is quiet,
  // and a third party's change is still a conflict.
  await run("SE70", async () => {
    let srv = Date.UTC(2026, 9, 12, 9, 0, 0);
    const t = createFakeWeeksTable({ baseUrl: BASE, anonKey: "ANON", users: { TOK_A: "user-a", TOK_B: "user-b" }, rows: seedRows(3), clock: () => new Date(srv += 7).toISOString(), stampUpdatedAt: true });
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    const rs = [], patches = [];
    const pc = () => t.log.filter(e => e.method === "PATCH" && e.headers.authorization === "Bearer TOK_A").length;
    A.edit(W[0], w => (w.dayCall = "e1", w)); rs.push(await A.engine.push()); patches.push(pc());
    A.edit(W[0], w => (w.dayCall = "e2", w)); rs.push(await A.engine.push()); patches.push(pc());
    t.control.fail({ method: "PATCH", week: W[0], kind: "5xx-after" });
    A.edit(W[0], w => (w.dayCall = "e3", w)); rs.push(await A.engine.push()); patches.push(pc());
    const stamped = /^2026-10-12T09:/.test(t.get(W[0]).updated_at) && Date.parse(t.get(W[0]).updated_at) !== Date.parse(t.log.filter(e => e.method === "PATCH").pop().body.updated_at); // the server's clock, not the body's
    A.edit(W[0], w => (w.dayCall = "e4", w));
    const ka = A.engine.keepaliveRequests();
    for (const x of ka) await t.fetch(x.url, x.init);
    const kaLanded = t.get(W[0]).data.dayCall === "e4";
    const from = t.log.length;
    await A.engine.pull(); await A.engine.idle();
    const quiet = writes(t, from).length === 0 && A.toasts.length === 0 && A.st().conflicts.length === 0 && A.engine.pending().length === 0;
    check("SE70 A2 against a server that stamps updated_at itself: three edits in a row land by CAS, ONE PATCH each (the 504-after-commit one read back as ours), the keepalive's CAS matches (v7), and the next pull settles it quietly — no false conflict, no write, nothing pending",
      stamped && rs.every(x => x.ok) && patches.join() === "1,2,3" && ka.length === 1 && kaLanded && t.get(W[0]).version === 7 && quiet,
      JSON.stringify({ stamped, patches, rs: rs.map(x => x.results && x.results.map(y => y.outcome)), kaLanded, v: t.get(W[0]).version, toasts: A.toasts, c: A.st().conflicts }));
    B.edit(W[1], w => (w.dayCall = "peer", w)); await B.engine.push();
    A.edit(W[1], w => (w.dayCall = "mine", w)); await A.engine.push();
    check("SE70 …and someone else's change is still a conflict (shown, told once)", A.mirror[W[1]].dayCall === "peer" && t.get(W[1]).data.dayCall === "peer" && A.st().conflicts.length === 1 && A.toasts.length === 1);
  });

  // SE71 — A2 / 2.11, the emulator's old build (t.oldBuild): its keepalive
  // re-sends a week UNCHANGED under an edit here (version kept, updated_at
  // moved) — the data this edit was made on, so not a conflict: one 0-row
  // PATCH, a read-back, the new token, and the edit lands. (SE42: different
  // data → a conflict.) Its unversioned DELETE of a week edited here is
  // someone else's change: shown, told, never re-inserted.
  await run("SE71", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    A.edit(W[0], w => (w.dayCall = "mine", w));
    await t.oldBuild("TOK_B", "user-b").upsert({ [W[0]]: clone(t.get(W[0]).data) });
    const moved = t.get(W[0]).version === 3 && t.get(W[0]).updated_at !== "2026-10-01T08:00:00+00:00";
    const from = t.log.length;
    const r = await A.engine.push();
    const ws = writes(t, from);
    check("SE71 A2 an old build re-sends a week UNCHANGED under an unsaved edit → not a conflict: a 0-row CAS PATCH, a read-back, the token refreshed, the edit lands at v4 — no toast, no conflict entry, nothing adopted",
      moved && r.ok && ws.length === 2 && ws.every(e => e.method === "PATCH") && ws[0].applied === false && ws[1].applied === true && t.get(W[0]).data.dayCall === "mine" && t.get(W[0]).version === 4
        && A.toasts.length === 0 && A.st().conflicts.length === 0 && A.adopted.length === 0 && A.engine.pending().length === 0, JSON.stringify({ moved, r: r.results, ws: ws.map(e => [e.method, e.applied]), toasts: A.toasts }));
    const t2 = mkTable(seedRows(3));
    const C = mkSession(t2); await C.engine.load();
    C.edit(W[1], w => (w.dayCall = "mine", w));
    await t2.oldBuild("TOK_B", "user-b").remove(W[1]);
    const from2 = t2.log.length;
    await C.engine.push(); await C.engine.push();
    check("SE71 2.11 an old build's unversioned DELETE of a week edited here → someone else's change: the deletion is shown (one toast, a conflict entry), and the week is never re-inserted",
      !(W[1] in C.mirror) && !t2.get(W[1]) && C.toasts.length === 1 && /changed by someone else/.test(C.toasts[0]) && C.st().conflicts.length === 1 && writes(t2, from2).every(e => e.method !== "POST") && C.engine.pending().length === 0,
      JSON.stringify({ shown: Object.keys(C.mirror), toasts: C.toasts, w: writes(t2, from2).map(e => e.method) }));
  });

  // SE72 — A9 / A2, the keepalive against a delete + re-insert (the
  // emulator's t.recreate). (i) A keepalive PATCH at v1 that stalls and is
  // released after the week was deleted and re-created AT v1 elsewhere matches
  // 0 rows (its updated_at tells the rows apart). (ii) A keepalive built while
  // a brand-new week was unsaved, arriving late — after the chain's POST 201
  // and its DELETE version=eq.1 — must not resurrect it: there is no keepalive
  // for a week the table doesn't have (never an insert).
  await run("SE72", async () => {
    const t = mkTable(seedRows(2, 1));
    const A = mkSession(t); await A.engine.load();
    A.edit(W[0], w => (w.dayCall = "unload-edit", w));
    const reqs = A.engine.keepaliveRequests();
    const hold = t.control.pause({ method: "PATCH", week: W[0], count: 1 });
    const pk = Promise.all(reqs.map(x => t.fetch(x.url, x.init)));
    await Promise.race([hold.arrived, pk]); // (a keepalive that isn't a PATCH isn't held — it answers at once)
    await t.recreate("TOK_B", W[0], wk("regenerated"), { by: "user-b" });
    hold.release(); await pk;
    const ka = t.log.find(e => e.method === "PATCH" && e.headers.authorization === "Bearer TOK_A");
    check("SE72 A2/A9 a stalled keepalive PATCH at v1, released after the week was deleted and re-created AT v1 elsewhere → 0 rows: the re-created week stands",
      reqs.length === 1 && /version=eq\.1&updated_at=eq\./.test(reqs[0].url) && !!ka && ka.applied === false && t.get(W[0]).version === 1 && t.get(W[0]).data.dayCall === "regenerated",
      JSON.stringify({ reqs: reqs.map(x => x.url.split("?")[1]), applied: ka && ka.applied, row: t.get(W[0]) }));
    await A.engine.pull(); await A.engine.idle();
    check("SE72 …and when the page survives, the next pull + push settle it as someone else's change (the re-created week shown, one conflict) — the keepalive's body isn't taken for theirs or ours",
      A.mirror[W[0]].dayCall === "regenerated" && A.st().conflicts.length === 1 && A.engine.pending().length === 0, JSON.stringify({ shown: A.mirror[W[0]].dayCall, c: A.st().conflicts }));
    const t2 = mkTable(seedRows(1));
    const B = mkSession(t2); await B.engine.load();
    B.edit(W[4], () => wk("brand-new"));
    const late = B.engine.keepaliveRequests();          // pagehide while the new week is still unsaved: the radio holds whatever it sends
    await B.engine.push();                                // the page survived: the chain's POST 201
    B.drop(W[4]); await B.engine.push();                  // …and the user deletes it again: DELETE version=eq.1
    const del = t2.log.find(e => e.method === "DELETE");
    for (const x of late) await t2.fetch(x.url, x.init); // the stalled keepalive arrives now
    await B.engine.pull();
    check("SE72 A9 a brand-new week: no keepalive is built for it (never an insert), so nothing arriving late can resurrect it after the chain's POST 201 and DELETE version=eq.1 — the table and the screen stay without it",
      late.length === 0 && !!del && /version=eq\.1&updated_at=eq\./.test(del.url) && del.applied === true && !t2.get(W[4]) && !(W[4] in B.mirror),
      JSON.stringify({ late: late.map(x => x.init.method + " " + x.url.split("?")[1]), row: t2.get(W[4]) }));
  });

  // ── 16/n: review round 1 — the engine items E1–E5 and the test gaps T1–T3 ──
  const sleep = (n) => new Promise(res => setTimeout(res, n));
  const kindOfLine = (st) => { const l = line(st, VIEW); return l ? l.kind : null; };
  // W1 left UNCONFIRMED: its PATCH throws and so does the read-back (a flaky network).
  const unconfirmedW0 = async (t, S) => {
    t.control.fail({ method: "PATCH", week: W[0], kind: "throw" });
    t.control.fail({ method: "GET", week: W[0], kind: "throw" });
    S.edit(W[0], w => (w.dayCall = "mine", w)); await S.engine.push();
    return S.engine.pending().join() === W[0] && S.st().failing === 1;
  };

  // SE73 — E1 (review r1 engine-1, A11): a push already IN its re-read of an
  // unconfirmed week when a clear / restore is requested (the app's order:
  // the target committed, then authoritative()) checks for an owner again
  // after that await, and stops — it never reads the job's target as its own:
  // no false wipe block during a clear (no onWipeBlocked, no 'deletions
  // blocked' report); no restore writes before the restore's own whole-table
  // read refuses it.
  await run("SE73", async () => {
    const t = mkTable(seedRows(5));
    const A = mkSession(t); await A.engine.load();
    const setup = await unconfirmedW0(t, A);
    const hold = t.control.pause({ method: "GET", week: W[0], count: 1 });
    const P = A.engine.push(); await hold.arrived;               // P is in its re-read of W1
    const n0 = A.statuses.length;
    const before = clone(A.mirror);
    A.mirror = {};                                                // clearSchedule: commitSchedule({})
    const C = A.engine.authoritative({}, true, "clear", undefined, { before });
    hold.release();
    const pr = await P, cr = await C; await A.engine.idle(); await A.engine.idle();
    const reps = A.statuses.slice(n0), lines = reps.map(kindOfLine);
    check("SE73 E1 a push paused in its re-read when a clear is requested stops after that await (skipped — it never reads the clear's target as its own): no onWipeBlocked, no report with blocked deletions, no 'blocked' header line; the clear empties the table",
      setup && pr.skipped === "authoritative-queued" && A.wipeBlocked.length === 0 && reps.every(s => !s.blockedDeletes) && !lines.includes("blocked") && cr.ok === true && t.rows().length === 0 && A.engine.pending().length === 0,
      JSON.stringify({ setup, pr: { ok: pr.ok, skipped: pr.skipped, blocked: pr.blocked }, wb: A.wipeBlocked, lines, cr: { ok: cr.ok, error: cr.error }, rows: t.rows().length }));
    const t2 = mkTable(seedRows(6));
    const B = mkSession(t2); await B.engine.load();
    const setup2 = await unconfirmedW0(t2, B);
    const others = () => JSON.stringify(t2.rows().filter(r => r.week_monday !== W[0]));  // (W1's pending edit is the user's own: the follow-up push sends it)
    const tableBefore = others();
    const hold2 = t2.control.pause({ method: "GET", week: W[0], count: 1 });
    const P2 = B.engine.push(); await hold2.arrived;
    const snap = tableSched(t2); [1, 2, 3].forEach(i => { snap[W[i]] = wk("restored"); }); delete snap[W[5]];
    const before2 = clone(B.mirror);
    B.mirror = clone(snap);                                       // restoreSnapshot: commitSchedule(sched)
    const R = B.engine.authoritative(snap, true, "restore", undefined, { before: before2 });
    t2.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before" }); // ONLY the restore's whole-table read fails
    const from2 = t2.log.length;
    hold2.release();
    const pr2 = await P2;
    const w2 = writes(t2, from2).map(e => e.method + " " + e.url.split("?")[1]);   // everything written while P2 ran
    const rr = await R, atAnswer = others();
    const snapWrites = writes(t2, from2).filter(e => e.method === "DELETE" || (e.body && e.body.data && e.body.data.dayCall === "restored"));
    await B.engine.idle(); await B.engine.idle();
    check("SE73 E1 …a restore requested while the push is in its re-read, whose own whole-table read then fails: the paused push writes NOTHING (not one PATCH or DELETE), nothing of the snapshot's is ever written, the restore is refused with nothing written, and the snapshot's weeks are exactly as they were when the caller is answered",
      setup2 && pr2.skipped === "authoritative-queued" && (pr2.results || []).length === 0 && w2.length === 0 && snapWrites.length === 0 && rr.ok === false && rr.wrote === false && /nothing was changed/.test(rr.error || "") && atAnswer === tableBefore,
      JSON.stringify({ pr2: { ok: pr2.ok, skipped: pr2.skipped, results: (pr2.results || []).map(x => x.k + ":" + x.outcome) }, w2, snapWrites: snapWrites.map(e => e.method + " " + e.url.split("?")[1]), rr }));
    check("SE73 …and the screen is back as it was before the tap, the pending edit to W1 included, which the follow-up push then saves: the table holds that edit and nothing of the snapshot",
      sameData(B.mirror, before2) && t2.get(W[0]).data.dayCall === "mine" && [1, 2, 3].every(i => t2.get(W[i]).data.dayCall !== "restored") && !!t2.get(W[5]) && B.engine.pending().length === 0,
      JSON.stringify({ shown: Object.keys(B.mirror).map(k => k + "=" + B.mirror[k].dayCall), rows: t2.rows().map(r => r.week_monday + "=" + r.data.dayCall), pending: B.engine.pending() }));
  });

  // SE74 — E2 (review r1 engine-2 / tests-1, I5 / A7): a READ the server
  // refuses for the stored token marks it dead too, not only a write's 401.
  // A session with NOTHING pending (a member who only views), whose device
  // clock still calls the token fresh: its next pull's refused read is
  // reported at once (authNeeded — the edit gate and the sign-in line, with
  // no week counted) and sent once more as anon, so it keeps adopting other
  // people's changes. One shared read: the load, the pull's week fetch and a
  // write's read-back do the same. A read that went out as anon already, or
  // a 42501 permission error, is not the token's.
  await run("SE74", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    t.control.expiredTokens.add("TOK_A");   // the server: expired. A.readAsAnon stays false — the device clock calls it fresh.
    B.edit(W[1], w => (w.dayCall = "peer", w)); await B.engine.push();
    const from = t.log.length;
    const r = await A.engine.pull();
    const reqs = t.log.slice(from).map(e => [e.method, e.headers.authorization, e.status].join(" ")), rep = A.last();
    check("SE74 E2 nothing pending, the stored token refused for a READ (the pull's version list, 401): marked dead and sent ONCE more as anon — B's change adopted; the REPORT says authNeeded (auth 'expired', 0 pending) and the header's line is the sign-in one with no week counted; no toast, nothing written",
      r.ok === true && reqs.join() === ["GET Bearer TOK_A 401", "GET Bearer ANON 200", "GET Bearer ANON 200"].join() && A.mirror[W[1]].dayCall === "peer" && A.engine.authBlocked()
        && rep.authNeeded === true && rep.auth === "expired" && rep.pending === 0 && JSON.stringify(line(rep, VIEW)) === JSON.stringify({ kind: "auth", n: 0 }) && A.toasts.length === 0 && writes(t, from).length === 0,
      JSON.stringify({ r, reqs, rep: { authNeeded: rep.authNeeded, auth: rep.auth, pending: rep.pending }, line: line(rep, VIEW), toasts: A.toasts }));
    B.edit(W[2], w => (w.dayCall = "peer2", w)); await B.engine.push();
    const from2 = t.log.length; await A.engine.pull();
    const reqs2 = t.log.slice(from2);
    t.control.users.TOK_A2 = "user-a"; A.token = "TOK_A2"; A.engine.report();   // "Sign in again" stored a new token
    const from3 = t.log.length; await A.engine.pull();
    const reqs3 = t.log.slice(from3);
    check("SE74 E2 …every later read goes out as anon (the refused token never re-sent) and keeps adopting; a new token is read with again, and the sign-in line goes",
      reqs2.length >= 2 && reqs2.every(e => e.method === "GET" && e.headers.authorization === "Bearer ANON" && e.status === 200) && A.mirror[W[2]].dayCall === "peer2"
        && reqs3.length >= 1 && reqs3.every(e => e.headers.authorization === "Bearer TOK_A2" && e.status === 200) && A.last().authNeeded === false && !A.engine.authBlocked(),
      JSON.stringify({ reqs2: reqs2.map(e => [e.method, e.headers.authorization, e.status]), reqs3: reqs3.map(e => [e.method, e.headers.authorization, e.status]) }));
    // the LOAD (readAll): a fresh tab whose stored token the server refuses
    const C = mkSession(t), fromC = t.log.length;
    const lr = await C.engine.load();
    const reqsC = t.log.slice(fromC).map(e => [e.method, e.headers.authorization, e.status].join(" "));
    check("SE74 E2 …the LOAD's whole-table read the same: refused with the token → dead, re-read as anon → seeded with the table; the report says authNeeded",
      lr.ok === true && C.engine.isSeeded() && sameData(C.mirror, tableSched(t)) && reqsC.join() === ["GET Bearer TOK_A 401", "GET Bearer ANON 200"].join() && C.last().authNeeded === true && C.last().seeded === true,
      JSON.stringify({ lr, reqsC }));
    // the pull's week fetch (readSome)
    const t2 = mkTable(seedRows(3));
    const D = mkSession(t2), E = mkSession(t2, { token: "TOK_B", user: "user-b" });
    await D.engine.load(); await E.engine.load();
    E.edit(W[0], w => (w.dayCall = "peer", w)); await E.engine.push();
    t2.control.fail({ method: "GET", week: "in.(", kind: "401" });   // the week fetch answered 401 / PGRST303 for D's token
    const fromD = t2.log.length;
    const rd = await D.engine.pull();
    const reqsD = t2.log.slice(fromD).map(e => [e.method, e.headers.authorization, e.status].join(" "));
    check("SE74 E2 …the pull's WEEK FETCH (readSome) the same: refused with the token → dead, re-sent as anon → adopted; the report says authNeeded",
      rd.ok === true && D.mirror[W[0]].dayCall === "peer" && reqsD.join() === ["GET Bearer TOK_A 200", "GET Bearer TOK_A 401", "GET Bearer ANON 200"].join() && D.engine.authBlocked() && D.last().authNeeded === true,
      JSON.stringify({ rd, reqsD }));
    // a write's READ-BACK
    const t3 = mkTable(seedRows(2));
    const F = mkSession(t3); await F.engine.load();
    t3.control.fail({ method: "PATCH", week: W[0], kind: "5xx-before" });
    t3.control.fail({ method: "GET", week: W[0], kind: "401" });
    F.edit(W[0], w => (w.dayCall = "mine", w));
    const fromF = t3.log.length;
    await F.engine.push();
    const reqsF = t3.log.slice(fromF).map(e => [e.method, e.headers.authorization, e.status].join(" "));
    check("SE74 E2 …a write's READ-BACK the same: the PATCH answered 503 (unknown), its read-back refused with the token → dead, re-read as anon (the row unchanged: still pending, the edit kept); authNeeded reported, and the one toast is the sign-in one",
      reqsF.join() === ["PATCH Bearer TOK_A 503", "GET Bearer TOK_A 401", "GET Bearer ANON 200"].join() && F.engine.authBlocked() && F.last().authNeeded === true && F.engine.pending().join() === W[0] && F.mirror[W[0]].dayCall === "mine"
        && F.toasts.length === 1 && /sign-in has expired/i.test(F.toasts[0]), JSON.stringify({ reqsF, toasts: F.toasts }));
    // not the token's: a read already sent as anon, and a 42501
    const t4 = mkTable(seedRows(2));
    const G = mkSession(t4); await G.engine.load();
    G.readAsAnon = true;                     // the device clock calls the token stale: reads go out as anon
    t4.control.fail({ method: "GET", kind: "401" });
    const fromG = t4.log.length;
    const rg = await G.engine.pull();
    const anonRefused = rg.ok === false && t4.log.length - fromG === 1 && !G.engine.authBlocked() && G.st().authNeeded === false;
    G.readAsAnon = false;
    let hookCalls = 0;
    G.fetchHook = () => { hookCalls++; G.fetchHook = null; return Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve(JSON.stringify({ code: "42501", details: null, hint: null, message: "permission denied for table schedule_weeks" })) }); };
    const fromG2 = t4.log.length;
    const rg2 = await G.engine.pull();
    check("SE74 E2 …not the token's: a read already sent as ANON and answered 401 isn't marked dead or retried (one request); nor is a 42501 permission error (RLS refusing the role) answered to a read WITH the token",
      anonRefused && rg2.ok === false && hookCalls === 1 && t4.log.length === fromG2 && !G.engine.authBlocked() && G.st().authNeeded === false,
      JSON.stringify({ anonRefused, rg, rg2, hookCalls, logged: t4.log.length - fromG2 }));
    // reported AT ONCE — while the anon retry is still out
    const t5 = mkTable(seedRows(2));
    const H = mkSession(t5); await H.engine.load();
    t5.control.expiredTokens.add("TOK_A");
    let release5 = null, arrived5 = null;
    const gate5 = new Promise(res => { release5 = res; }), arr5 = new Promise(res => { arrived5 = res; });
    H.fetchHook = (u, i) => { if (i && i.headers && i.headers.Authorization === "Bearer ANON") { H.fetchHook = null; arrived5(); return gate5.then(() => t5.fetch(u, i)); } return t5.fetch(u, i); };
    const p5 = H.engine.pull();
    const retried = await Promise.race([arr5.then(() => true), p5.then(() => false)]);   // (no retry at all: the pull just ends)
    const mid5 = H.last();
    release5(); await p5;
    check("SE74 E2 …and it is REPORTED at once: while the anon retry is still out, the last report already says authNeeded (auth 'expired')",
      retried && mid5.authNeeded === true && mid5.auth === "expired" && H.last().authNeeded === true, JSON.stringify({ retried, mid: { authNeeded: mid5.authNeeded, auth: mid5.auth } }));
    // E2 × E4: a clear whose OWN read finds the token refused (then goes on as anon) is refused before the table's rows become what the engine knows
    const t6 = mkTable(seedRows(3));
    const J = mkSession(t6), K = mkSession(t6, { token: "TOK_B", user: "user-b" });
    await J.engine.load(); await K.engine.load();
    K.edit(W[2], w => (w.dayCall = "peer", w)); await K.engine.push();     // J hasn't pulled it
    J.edit(W[2], w => (w.dayCall = "mine", w));                            // J's unsent edit, made on the old copy
    t6.control.expiredTokens.add("TOK_A");
    const beforeJ = clone(J.mirror);
    J.mirror = {};
    const fromJ = t6.log.length;
    const cj = await J.engine.authoritative({}, true, "clear", undefined, { before: beforeJ });
    const refusedJ = cj.ok === false && cj.wrote === false && /sign-in has expired/i.test(cj.error || "") && /Nothing was changed/.test(cj.error || "") && sameData(J.mirror, beforeJ) && writes(t6, fromJ).length === 0;
    await J.engine.idle(); await J.engine.idle();
    t6.control.users.TOK_A2 = "user-a"; J.token = "TOK_A2";
    await J.engine.pull(); await J.engine.idle();
    check("SE74 E2×E4 a clear whose own whole-table read finds the token refused (it goes on as anon) is refused BEFORE the table's rows become what the engine knows: the screen is back as before the tap (the unsent edit included), nothing written; once signed in again that edit meets its CAS — someone else's newer change to the week stands, shown and told as a conflict, never overwritten",
      refusedJ && t6.get(W[2]).data.dayCall === "peer" && J.mirror[W[2]].dayCall === "peer" && J.st().conflicts.map(c => c.k).join() === W[2] && J.toasts.some(m => /changed by someone else/.test(m)) && J.engine.pending().length === 0,
      JSON.stringify({ cj, refusedJ, table: t6.get(W[2]).data.dayCall, shown: J.mirror[W[2]] && J.mirror[W[2]].dayCall, toasts: J.toasts }));
  });

  // SE75 — E3 (review r1 app-2, A16): the header reads the onStatus REPORTS,
  // never engine.status(). A push request reports at once, so between the
  // commit + push request and the PATCH's answer the last report counts the
  // week (pending > 0) and schedSyncLine says "saving" — never a stale
  // "synced" — and "synced" once it answers. A push that runs after a pull
  // failed early (which reports nothing) reports as it starts.
  await run("SE75", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t); await A.engine.load();
    const k0 = A.line() && A.line().kind;
    const hold = t.control.pause({ method: "PATCH", week: W[0], count: 1 });
    A.edit(W[0], w => (w.dayCall = "x", w));
    const n0 = A.statuses.length;
    const p = A.engine.push();
    const atRequest = A.statuses.length > n0 ? { pending: A.last().pending, kind: kindOfLine(A.last()) } : null;
    await hold.arrived;
    const inFlight = { pending: A.last().pending, saving: A.last().saving, kind: kindOfLine(A.last()) };
    hold.release(); await p;
    const after = { pending: A.last().pending, kind: kindOfLine(A.last()) };
    check("SE75 E3 the REPORTS during a save: 'synced' before; the push REQUEST reports synchronously — pending 1, 'saving'; still 'saving' while its PATCH is out; 'synced' once it answers",
      k0 === "synced" && !!atRequest && atRequest.pending === 1 && atRequest.kind === "saving" && inFlight.pending === 1 && inFlight.saving === 1 && inFlight.kind === "saving"
        && after.pending === 0 && after.kind === "synced" && t.get(W[0]).data.dayCall === "x", JSON.stringify({ k0, atRequest, inFlight, after }));
    A.edit(W[1], w => (w.dayCall = "y", w));
    t.control.fail({ method: "GET", kind: "5xx-before" });                // the pull's version list: 503 (it returns without a report)
    const hold2 = t.control.pause({ method: "PATCH", week: W[1], count: 1 });
    const pl = A.engine.pull(); await hold2.arrived;
    const mid = { pending: A.last().pending, kind: kindOfLine(A.last()) };
    hold2.release(); await pl;
    check("SE75 E3 …a pull whose version list fails returns without a report, and then pushes the edit: that push reports as it starts — 'saving' while its PATCH is out, 'synced' after",
      mid.pending === 1 && mid.kind === "saving" && kindOfLine(A.last()) === "synced" && t.get(W[1]).data.dayCall === "y", JSON.stringify({ mid, after: kindOfLine(A.last()) }));
  });

  // SE76 — E4 (review r1 app-1, I6): a clear / restore refused or cancelled
  // with nothing written puts back the screen AS IT WAS before the caller
  // committed the target (opts.before) — not what the table holds. (a) An
  // edited week and a new local week pending from before the tap (the edit's
  // PATCH threw, and its read-back; the new week was never sent), then a
  // clear whose whole-table read fails: both shown again, still pending, and
  // the follow-up push lands them. (b) An edit whose PATCH lands but answers
  // slowly, then a clear cancelled at its deadline: the edit is put back, so
  // when the slow answer comes nothing reverts it — the table keeps MY-EDIT.
  await run("SE76", async () => {
    const t = mkTable(seedRows(4));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "PATCH", week: W[1], kind: "throw" });
    t.control.fail({ method: "GET", week: W[1], kind: "throw" });
    A.edit(W[1], w => (w.dayCall = "my-edit", w)); A.edit(W[6], () => wk("new-week"));
    await A.engine.push();       // W2's PATCH throws (its read-back too): the push stops there, the new week isn't sent
    const setup = A.engine.pending().join() === [W[1], W[6]].join() && t.get(W[1]).data.dayCall !== "my-edit" && !t.get(W[6]);
    const before = clone(A.mirror);
    A.mirror = {};
    t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before" });
    const hold = t.control.pause({ method: "GET", week: W[1], count: 1 });   // the follow-up push's re-read of W2: the state in between can be seen
    const from = t.log.length;
    const c = await A.engine.authoritative({}, true, "clear", undefined, { before });
    await hold.arrived;
    const between = { shown: sameData(A.mirror, before), pending: A.engine.pending().join(), w: writes(t, from).length };
    hold.release(); await A.engine.idle(); await A.engine.idle();
    check("SE76 E4 (a) a clear refused (its whole-table read failed) with an edited week and a NEW local week pending from before the tap: the screen is back as it was before the tap — both shown, still pending, nothing written — and the follow-up push lands them",
      setup && c.ok === false && c.wrote === false && between.shown && between.pending === [W[1], W[6]].join() && between.w === 0
        && t.get(W[1]).data.dayCall === "my-edit" && !!t.get(W[6]) && t.get(W[6]).data.dayCall === "new-week" && t.rows().length === 5 && A.engine.pending().length === 0,
      JSON.stringify({ setup, c, between, rows: t.rows().map(r => r.week_monday + "=" + r.data.dayCall), pending: A.engine.pending() }));
    const t2 = mkTable(seedRows(4));
    const B = mkSession(t2, { timeouts: { read: 60000, write: 60000, stall: 15, deadline: 60 } }); await B.engine.load();
    const slow = t2.control.pause({ method: "PATCH", week: W[1], count: 1, when: "after" });   // it LANDS; its answer is slow
    B.edit(W[1], w => (w.dayCall = "MY-EDIT", w));
    const pp = B.engine.push(); await slow.arrived;
    const landed = t2.get(W[1]).data.dayCall === "MY-EDIT";
    const before2 = clone(B.mirror);
    B.mirror = {};
    const cc = B.engine.authoritative({}, true, "clear", undefined, { before: before2 });
    const r2 = await Promise.race([cc, sleep(600).then(() => "no answer")]);   // queued behind the slow save: cancelled at its deadline
    const shownAtCancel = B.mirror[W[1]] ? B.mirror[W[1]].dayCall : null;
    slow.release(); await pp; await B.engine.idle(); await B.engine.idle(); await sleep(5); await B.engine.idle();
    check("SE76 E4 (b) a save whose PATCH lands but answers slowly, then a clear cancelled at its deadline: the screen as it was before the tap is put back (MY-EDIT, not the table's old copy), and once the slow answer comes the table KEEPS MY-EDIT — one PATCH in all, nothing reverts it, nothing pending",
      landed && r2 !== "no answer" && r2.reason === "timeout" && r2.wrote === false && shownAtCancel === "MY-EDIT" && t2.get(W[1]).data.dayCall === "MY-EDIT" && B.mirror[W[1]].dayCall === "MY-EDIT"
        && Object.keys(B.mirror).length === 4 && writes(t2).length === 1 && B.engine.pending().length === 0 && t2.rows().length === 4,
      JSON.stringify({ landed, r2, shownAtCancel, table: t2.get(W[1]).data.dayCall, w: writes(t2).map(e => e.method + " " + e.url.split("?")[1]), pending: B.engine.pending() }));
  });

  // SE77 — E5 (review r1 app-3, A14): a refused publish keeps its weeks on
  // screen and pending, and the follow-up push writes them — so no publish
  // refusal says "nothing was published" (or "nothing was changed"): each
  // says what happens to the new weeks and, once, that nobody was notified.
  // And each claim is checked against what then happens.
  await run("SE77", async () => {
    const once = (s) => (String(s || "").match(/Nobody was notified\./g) || []).length === 1;
    const claimsNothing = (s) => /nothing was (published|changed)/i.test(String(s || ""));
    const gen = { [W[0]]: wk("gen0"), [W[1]]: wk("gen1") }, period = [W[0], W[1]];
    // its re-read of the period's weeks fails
    const t = mkTable(seedRows(4));
    const A = mkSession(t); await A.engine.load();
    A.mirror = Object.assign({}, A.mirror, clone(gen));
    t.control.fail({ method: "GET", week: "in.(", kind: "5xx-before" });
    const r1 = await A.engine.authoritative(clone(A.mirror), false, "publish", period);
    const kept1 = A.mirror[W[0]].dayCall === "gen0" && A.engine.pending().join() === period.join();
    await A.engine.idle(); await A.engine.idle();
    check("SE77 E5 a publish whose re-read of its weeks fails says they stay on this screen and will be saved automatically, and (once) that nobody was notified — never 'nothing was published'; and so it is: pending, and the follow-up push writes them",
      r1.ok === false && r1.wrote === false && r1.error === "Couldn't read the saved weeks first — the new weeks stay on this screen and will be saved automatically. Nobody was notified." && once(r1.error) && !claimsNothing(r1.error)
        && kept1 && t.get(W[0]).data.dayCall === "gen0" && t.get(W[1]).data.dayCall === "gen1" && A.engine.pending().length === 0, JSON.stringify({ r1, kept1 }));
    // the sign-in: the server refuses the token at the publish's own read (I5: dead, the read goes on as anon) — its push is skipped for the sign-in
    const t2 = mkTable(seedRows(4));
    const B = mkSession(t2); await B.engine.load();
    B.mirror = Object.assign({}, B.mirror, clone(gen));
    t2.control.expiredTokens.add("TOK_A");
    const r2 = await B.engine.authoritative(clone(B.mirror), false, "publish", period);
    await B.engine.idle(); await B.engine.idle();
    const waited = !t2.log.some(e => e.method !== "GET") && B.engine.pending().join() === period.join() && B.mirror[W[0]].dayCall === "gen0";
    t2.control.users.TOK_A2 = "user-a"; B.token = "TOK_A2"; await B.engine.pull(); await B.engine.idle();
    check("SE77 E5 …refused for the sign-in (the token refused at the publish's own read): says they stay on this screen and are saved once signed in again, nobody notified (once) — not 'Nothing was changed'; they wait, pending, and land after 'Sign in again'",
      r2.ok === false && r2.wrote === false && r2.error === PUB_AUTH && once(r2.error) && !claimsNothing(r2.error) && waited && t2.get(W[0]).data.dayCall === "gen0" && t2.get(W[1]).data.dayCall === "gen1" && B.engine.pending().length === 0,
      JSON.stringify({ r2, waited }));
    // not loaded yet: the first load REPLACES the screen — not saved, and it says so
    const t3 = mkTable(seedRows(4));
    const C = mkSession(t3);
    C.mirror = clone(gen);
    const r3 = await C.engine.authoritative(clone(C.mirror), false, "publish", period);
    await C.engine.idle(); await C.engine.load();
    check("SE77 E5 …before the first load: says the new weeks weren't saved and why (the load replaces them), nobody notified (once) — and so it is: nothing written, and the load shows the table instead",
      r3.ok === false && r3.error === "The schedule hasn't loaded yet, so the new weeks weren't saved — loading it will replace them. Publish again once it has loaded. Nobody was notified." && once(r3.error) && !claimsNothing(r3.error)
        && writes(t3).length === 0 && sameData(C.mirror, tableSched(t3)) && C.mirror[W[0]].dayCall !== "gen0", JSON.stringify({ r3, shown: C.mirror[W[0]] && C.mirror[W[0]].dayCall }));
    // cancelled at its deadline (stuck behind a pull that never answers): still pending, saved once the chain moves
    const t4 = mkTable(seedRows(4));
    const D = mkSession(t4, { timeouts: { read: 60000, write: 60000, stall: 15, deadline: 60 } }); await D.engine.load();
    const hang = t4.control.pause({ method: "GET", count: 1 });
    const pl = D.engine.pull(); await hang.arrived;
    D.mirror = Object.assign({}, D.mirror, clone(gen));
    const r4 = await Promise.race([D.engine.authoritative(clone(D.mirror), false, "publish", period), sleep(600).then(() => "no answer")]);
    const kept4 = D.mirror[W[0]].dayCall === "gen0" && D.engine.pending().join() === period.join();
    hang.release(); await pl; await D.engine.idle(); await D.engine.idle(); await sleep(5); await D.engine.idle();
    check("SE77 E5 …cancelled at its deadline (stuck behind an earlier job): says they stay on this screen and will be saved once it gets through, nobody notified (once) — and the chain, once moving, writes them",
      r4 !== "no answer" && r4.reason === "timeout" && r4.error === "The sync is stuck behind an earlier save — the new weeks stay on this screen and will be saved automatically once it gets through; keep the app open. Nobody was notified." && once(r4.error) && !claimsNothing(r4.error)
        && kept4 && t4.get(W[0]).data.dayCall === "gen0" && t4.get(W[1]).data.dayCall === "gen1" && D.engine.pending().length === 0, JSON.stringify({ r4, kept4 }));
  });

  // SE78 — T1 (review r1 tests-2): a pull adopts a week CREATED on another
  // device (a scheduler's publish, as every other open session sees it):
  // shown, known at its row's version, onAdopted names it, no toast, nothing
  // pending — the report too.
  await run("SE78", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    B.edit(W[5], () => wk("created-by-B")); await B.engine.push();
    const r = await A.engine.pull();
    check("SE78 T1 a week created on another device is adopted by the next pull: on screen, known at v1, onAdopted names it; no toast, no conflict, nothing pending (in the report too)",
      !!t.get(W[5]) && r.ok === true && (r.adopted || []).includes(W[5]) && !!A.mirror[W[5]] && A.mirror[W[5]].dayCall === "created-by-B" && A.engine.knownVersion(W[5]) === 1 && A.adopted.some(x => x.weeks.includes(W[5]))
        && A.toasts.length === 0 && A.st().conflicts.length === 0 && A.engine.pending().length === 0 && A.last().pending === 0,
      JSON.stringify({ r, shown: A.mirror[W[5]] && A.mirror[W[5]].dayCall, v: A.engine.knownVersion(W[5]), toasts: A.toasts }));
  });

  // SE79 — T2 (review r1 tests-3, I1 / I4): a body SENT but not confirmed
  // keeps its week pending. The PATCH lands but its answer is lost, the
  // read-back can't get out, then Undo puts the screen back to what this
  // session last confirmed — the table still holds the edit, so pending(),
  // failing and the header's line ('not saved', off the report) stay set
  // until a read-back settles it; then the Undo itself is sent.
  await run("SE79", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t); await A.engine.load();
    const orig = clone(A.mirror[W[0]]);
    t.control.fail({ method: "PATCH", week: W[0], kind: "throw-after" });   // it lands; the answer is lost
    t.control.fail({ method: "GET", week: W[0], kind: "throw" });           // …and the read-back can't get out
    A.edit(W[0], w => (w.dayCall = "edit", w)); await A.engine.push();
    const landed = t.get(W[0]).data.dayCall === "edit";
    A.mirror = Object.assign({}, A.mirror, { [W[0]]: clone(orig) });       // Undo: the screen equals what this session last confirmed
    A.engine.report();                                                       // (the app reports on every mirror change)
    const rep = A.last();
    const held = A.engine.pending().join() === W[0] && A.st().failing === 1 && rep.pending === 1 && rep.failing === 1 && kindOfLine(rep) === "notSaved";
    await A.engine.push();
    check("SE79 T2 a sent-but-unconfirmed body keeps the week pending through a failed read-back and an Undo — pending(), failing and the header's line ('not saved', from the report) stay set; the next push's re-read settles it (ours) and sends the Undo: the table back to the original, nothing pending",
      landed && held && sameData(t.get(W[0]).data, orig) && A.engine.pending().length === 0 && A.last().pending === 0,
      JSON.stringify({ landed, held, rep: { pending: rep.pending, failing: rep.failing, line: kindOfLine(rep) }, table: t.get(W[0]).data.dayCall }));
  });

  // SE80 — T3 (review r1 tests-4, R21): a pull never silently adopts a week
  // this session CREATED and hasn't sent yet (inside the debounce) over
  // someone else's insert of it: the pull leaves it (a never-known week shown
  // here is dirty), and its follow-up push's INSERT meets the duplicate and
  // makes it a LOUD conflict — their copy shown, told once, a conflicts entry.
  await run("SE80", async () => {
    const t = mkTable(seedRows(2));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    A.edit(W[4], () => wk("mine-new"));                                    // not sent yet
    B.edit(W[4], () => wk("theirs-new")); await B.engine.push();
    const r = await A.engine.pull();
    check("SE80 T3 an unsent new week here + someone else's insert of it + a pull: the pull doesn't take it (not among its adoptions); its follow-up push's INSERT meets theirs → a conflict: their copy shown, ONE toast 'changed by someone else', one conflicts entry; nothing pending",
      r.ok === true && !(r.adopted || []).includes(W[4]) && t.get(W[4]).data.dayCall === "theirs-new" && A.mirror[W[4]].dayCall === "theirs-new" && A.toasts.length === 1 && /changed by someone else/.test(A.toasts[0])
        && A.st().conflicts.map(c => c.k).join() === W[4] && A.engine.pending().length === 0, JSON.stringify({ r, shown: A.mirror[W[4]] && A.mirror[W[4]].dayCall, toasts: A.toasts, c: A.st().conflicts }));
  });

  // ── 18/n: review round 2 — the engine items E6–E8 and the test gaps (r2-tests-2, -3, -6, -7) ──
  const READ_FAIL = "Couldn't read the saved schedule — nothing was changed.";
  const theirsTold = (msgs) => msgs.filter(m => /changed by someone else/.test(String(m || ""))).length;
  const jobOf = (S) => (typeof S.engine.jobPending === "function" ? S.engine.jobPending() : "no jobPending()");
  const twoSessions = async (n, o) => {
    const t = mkTable(seedRows(n || 4));
    const A = mkSession(t, o), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    return { t, A, B };
  };
  const shortT = { read: 60000, write: 60000, stall: 15, deadline: 60 };
  const fastT = { read: 60000, write: 60000, stall: 10, deadline: 25 };   // (the battery re-runs these: kept quick)

  // SE81 — E6 (review r2 regress-1, A11): a clear / reset / restore requested
  // while ANOTHER clear / reset / restore is still queued or running never
  // trusts its `before` — the screen it was taken from shows that job's
  // unapplied target — and falls back to what the table holds. Clear →
  // restore and restore → clear, both queued behind an ordinary save: (i)
  // both refused (their whole-table reads fail), (ii) both cancelled at their
  // deadlines (nothing fails). Before E6 the second job's refusal put the
  // first's target back on screen and the follow-up push sent it: a saved
  // week deleted, or a refused restore's copy written. jobPending() names the
  // first job from its request to its end (the app's one-job-at-a-time gate,
  // P7). A PUBLISH queued ahead isn't one of them. And the fallback covers
  // the weeks the table holds by the refusal: a week a restore queued ahead
  // created (it lands; the clear behind it is refused) isn't deleted.
  await run("SE81", async () => {
    const stack = async (order, mode) => {
      const t = mkTable(seedRows(6));
      const A = mkSession(t, { timeouts: mode === "cancelled" ? fastT : undefined }); await A.engine.load();
      // an ordinary edit whose PATCH holds the chain (cancelled: it lands, its answer is slow)
      const hold = t.control.pause({ method: "PATCH", week: W[3], count: 1, when: mode === "cancelled" ? "after" : "before" });
      A.edit(W[3], w => (w.nights.mon = "zz", w));
      const pp = A.engine.push(); await hold.arrived;
      const expectTable = Object.assign(clone(tableSched(t)), { [W[3]]: clone(A.mirror[W[3]]) });
      const SNAP = { [W[0]]: wk("snap0"), [W[1]]: wk("snap1") };
      const jobs = order === "clear-then-restore" ? [["clear", {}], ["restore", SNAP]] : [["restore", SNAP], ["clear", {}]];
      const pend = [jobOf(A)], ps = [];
      for (const [what, target] of jobs) {
        const before = clone(A.mirror); A.mirror = clone(target);       // the caller: before, commitSchedule(target), authoritative()
        ps.push(A.engine.authoritative(clone(target), true, what, undefined, { before }));
        pend.push(jobOf(A));
      }
      if (mode === "refused") { t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before", count: 2 }); hold.release(); }
      const rs = [];
      for (const p of ps) rs.push(await p);
      if (mode === "cancelled") hold.release();
      await pp; for (let i = 0; i < 3; i++) await A.engine.idle(); await sleep(5); await A.engine.idle();
      pend.push(jobOf(A));
      const ws = writes(t).map(e => e.method + " " + e.url.replace(/^.*schedule_weeks\?/, "").split("&")[0]);
      return { A, t, rs, pend, ws, expectTable, first: jobs[0][0] };
    };
    for (const mode of ["refused", "cancelled"]) for (const order of ["clear-then-restore", "restore-then-clear"]) {
      const x = await stack(order, mode);
      check(`SE81 E6 ${order}, both ${mode === "refused" ? "refused (their whole-table reads fail)" : "cancelled at their deadlines (nothing fails)"}: the table is unchanged — the ordinary save is its only write (no DELETE, no snapshot copy written) — the screen equals it, nothing pending, no wipe-guard trip; both answer wrote:false`,
        sameData(tableSched(x.t), x.expectTable) && x.ws.join() === "PATCH week_monday=eq." + W[3] && sameData(x.A.mirror, x.expectTable) && x.A.engine.pending().length === 0
          && x.rs.every(r => r.ok === false && r.wrote === false) && x.A.wipeBlocked.length === 0,
        JSON.stringify({ ws: x.ws, rs: x.rs.map(r => r.error), table: Object.keys(tableSched(x.t)).map(k => k + "=" + tableSched(x.t)[k].dayCall), shown: Object.keys(x.A.mirror).map(k => k + "=" + x.A.mirror[k].dayCall), pending: x.A.engine.pending() }));
      check(`SE81 E6 …jobPending() (${order}, ${mode}): null before, the FIRST job's name from its request on (the second queued behind it), null once both have ended`,
        JSON.stringify(x.pend) === JSON.stringify([null, x.first, x.first, null]), JSON.stringify(x.pend));
    }
    const t5 = mkTable(seedRows(4));
    const P = mkSession(t5); await P.engine.load();
    t5.control.fail({ method: "PATCH", week: W[2], kind: "throw" }); t5.control.fail({ method: "GET", week: W[2], kind: "throw" });
    P.edit(W[2], w => (w.dayCall = "pending-edit", w)); await P.engine.push();   // W3's edit pending from before the tap (its PATCH threw, and its read-back)
    const holdP = t5.control.pause({ method: "GET", week: "in.(", count: 1 });  // the publish's re-read of its week holds the chain
    P.mirror = Object.assign({}, P.mirror, { [W[5]]: wk("gen5") });
    const pubP = P.engine.authoritative(clone(P.mirror), false, "publish", [W[5]]); await holdP.arrived;
    const beforeP = clone(P.mirror); P.mirror = {};
    t5.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before" });
    const clrP = P.engine.authoritative({}, true, "clear", undefined, { before: beforeP });
    const pendP = jobOf(P);
    holdP.release(); const rp = await pubP, rc = await clrP; await P.engine.idle(); await P.engine.idle();
    check("SE81 E6 …a PUBLISH queued ahead isn't a clear / reset / restore: the clear requested behind it (then refused) still puts back the screen as it was before its tap — the pending edit included, which the follow-up push saves — beside the published week; jobPending() names the publish",
      pendP === "publish" && rp.ok === true && rc.ok === false && rc.wrote === false && t5.get(W[2]).data.dayCall === "pending-edit" && P.mirror[W[2]].dayCall === "pending-edit"
        && !!t5.get(W[5]) && t5.get(W[5]).data.dayCall === "gen5" && !!P.mirror[W[5]] && P.mirror[W[5]].dayCall === "gen5" && Object.keys(P.mirror).length === 5 && P.engine.pending().length === 0,
      JSON.stringify({ pendP, rp: rp.ok, rc, shown: Object.keys(P.mirror).map(k => k + "=" + P.mirror[k].dayCall), rows: t5.rows().map(r => r.week_monday + "=" + r.data.dayCall), pending: P.engine.pending() }));
    // The fallback covers the weeks the table holds by the refusal, not only those known at the request:
    // a restore queued ahead LANDS — with a week the table didn't have — and the clear behind it is refused.
    const t6 = mkTable(seedRows(6));
    const R = mkSession(t6); await R.engine.load();
    const hold6 = t6.control.pause({ method: "PATCH", week: W[3], count: 1 });
    R.edit(W[3], w => (w.nights.mon = "zz", w));
    const pp6 = R.engine.push(); await hold6.arrived;
    const SNAP6 = Object.assign(clone(tableSched(t6)), { [W[0]]: wk("snap0"), [W[8]]: wk("new8") });
    const bR = clone(R.mirror); R.mirror = clone(SNAP6); const pR = R.engine.authoritative(clone(SNAP6), true, "restore", undefined, { before: bR });
    const bC = clone(R.mirror); R.mirror = {}; const pC = R.engine.authoritative({}, true, "clear", undefined, { before: bC });
    let whole = 0;   // the restore's whole-table read answers; the clear's (the second) fails
    R.fetchHook = (u, i) => (/limit=5000/.test(u) && /select=week_monday,data/.test(u) && ++whole === 2) ? Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve("upstream connect error") }) : t6.fetch(u, i);
    hold6.release();
    const rR = await pR, rC = await pC; await pp6; for (let i = 0; i < 3; i++) await R.engine.idle(); R.fetchHook = null;
    check("SE81 E6 …the fallback covers the weeks the table holds by then: a restore queued ahead LANDS — with a week the table didn't have — and the clear behind it is refused: the restored weeks stay, the new one on screen and in the table; the follow-up push deletes nothing",
      rR.ok === true && rC.ok === false && rC.wrote === false && whole === 2 && !!t6.get(W[8]) && t6.get(W[8]).data.dayCall === "new8" && !!R.mirror[W[8]] && R.mirror[W[8]].dayCall === "new8"
        && t6.get(W[0]).data.dayCall === "snap0" && sameData(R.mirror, tableSched(t6)) && !writes(t6).some(e => e.method === "DELETE") && R.engine.pending().length === 0,
      JSON.stringify({ rR: rR.ok, rC, whole, rows: t6.rows().map(r => r.week_monday + "=" + r.data.dayCall), shown: Object.keys(R.mirror).sort(), w: writes(t6).map(e => e.method + " " + e.url.replace(/^.*schedule_weeks\??/, "").split("&")[0]) }));
  });

  // SE82 — E7 (review r2 regress-3, I2): a refused or cancelled clear puts
  // back `before[k]` only where the SAVED copy hasn't moved, since the job
  // was requested, to someone else's change. (a) A's edit of W3 is on the
  // wire, B deletes W3, A taps Clear and the clear's whole-table read fails:
  // A's PATCH matches 0 rows and its read-back (no row) agrees with the
  // cleared screen, so the engine forgets W3. Putting A's edit back let the
  // follow-up push INSERT it — B's delete undone, nobody told. The refusal
  // shows the deletion and tells it as a conflict: in its own message (the
  // caller's one toast) and the header's conflicts. (a') The same at a
  // deadline cancel. (b) B EDITS W3 instead: one loud conflict. (c) A's own
  // PATCH lands before the refusal: MY-EDIT stays, no conflict. Not someone
  // else's change either: (d) A's EARLIER body landing under a later edit —
  // the later edit is put back and saved; (e) an old build re-sending the
  // week unchanged (a new token, the same data — A2); (f) the saved copy now
  // holding just what is put back (a publish queued ahead re-read it); (g)
  // our own write's answer, though the server normalised what it stored.
  await run("SE82", async () => {
    {
      const { t, A, B } = await twoSessions();
      const hold = t.control.pause({ method: "PATCH", week: W[2], count: 1 });
      A.edit(W[2], w => (w.dayCall = "a-edit", w));
      const pp = A.engine.push(); await hold.arrived;                   // A's PATCH of W3 is on the wire
      B.drop(W[2]); await B.engine.push();                              // B deletes W3: it lands
      const before = clone(A.mirror); A.mirror = {};                    // A taps Clear
      t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before" });
      const from = t.log.length, adopted0 = A.adopted.length;
      const cp = A.engine.authoritative({}, true, "clear", undefined, { before });
      hold.release();
      const r = await cp; await pp; await A.engine.idle(); await A.engine.idle();
      check("SE82 E7 (a) A's edit on the wire + B's delete of that week + A's clear refused (its read failed): the deletion stands — never re-inserted, not on A's screen — and it is told ONCE, as a conflict, in the refusal's own message (after the reason) with a conflicts entry and onAdopted; the other weeks back, nothing pending",
        r.ok === false && r.wrote === false && String(r.error || "").startsWith(READ_FAIL + " ") && /The week of .+ was changed by someone else — showing the latest\./.test(r.error || "") && theirsTold([r.error].concat(A.toasts)) === 1
          && !t.get(W[2]) && !(W[2] in A.mirror) && Object.keys(A.mirror).length === 3 && !writes(t, from).some(e => e.method === "POST") && A.st().conflicts.map(c => c.k).join() === W[2]
          && A.adopted.slice(adopted0).some(x => x.weeks.includes(W[2])) && A.engine.pending().length === 0,
        JSON.stringify({ r, toasts: A.toasts, tableHas: !!t.get(W[2]), shown: Object.keys(A.mirror), w: writes(t, from).map(e => e.method + " " + e.url.split("?")[1]), c: A.st().conflicts }));
    }
    {
      const { t, A, B } = await twoSessions(4, { timeouts: shortT });
      const hold = t.control.pause({ method: "PATCH", week: W[2], count: 1 }), hold2 = t.control.pause({ method: "DELETE", week: W[3], count: 1 });
      A.edit(W[2], w => (w.dayCall = "a-edit", w)); A.drop(W[3]);       // an edit of W3 and a delete of W4, in one push
      const pp = A.engine.push(); await hold.arrived;
      B.drop(W[2]); await B.engine.push();
      const before = clone(A.mirror); A.mirror = {};
      const from = t.log.length;
      const cp = A.engine.authoritative({}, true, "clear", undefined, { before });
      hold.release(); await hold2.arrived;           // W3's PATCH answered (0 rows; read back: no row) and W4's DELETE holds the chain past the deadline
      const r = await Promise.race([cp, sleep(600).then(() => "no answer")]);
      const atCancel = Object.keys(A.mirror).sort();
      hold2.release(); await pp; await A.engine.idle(); await A.engine.idle(); await sleep(5); await A.engine.idle();
      check("SE82 E7 (a') …the same at a DEADLINE cancel (the clear still queued behind that save): B's deletion is shown and told once in the cancel's message, never re-inserted; A's own pending delete (W4) stays off the screen and lands",
        r !== "no answer" && r.reason === "timeout" && r.wrote === false && /changed by someone else/.test(r.error || "") && theirsTold([r.error].concat(A.toasts)) === 1 && atCancel.join() === [W[0], W[1]].join()
          && !t.get(W[2]) && !t.get(W[3]) && Object.keys(A.mirror).sort().join() === [W[0], W[1]].join() && !writes(t, from).some(e => e.method === "POST") && A.st().conflicts.map(c => c.k).join() === W[2] && A.engine.pending().length === 0,
        JSON.stringify({ r, atCancel, toasts: A.toasts, rows: t.rows().map(x => x.week_monday), w: writes(t, from).map(e => e.method + " " + e.url.split("?")[1]) }));
    }
    {
      const { t, A, B } = await twoSessions();
      const hold = t.control.pause({ method: "PATCH", week: W[2], count: 1 });
      A.edit(W[2], w => (w.dayCall = "a-edit", w));
      const pp = A.engine.push(); await hold.arrived;
      B.edit(W[2], w => (w.dayCall = "b-edit", w)); await B.engine.push(); // B EDITS W3 meanwhile: it lands
      const before = clone(A.mirror); A.mirror = {};
      t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before" });
      const cp = A.engine.authoritative({}, true, "clear", undefined, { before });
      hold.release();
      const r = await cp; await pp; await A.engine.idle(); await A.engine.idle();
      check("SE82 E7 (b) …B EDITS the week instead: B's change is never overwritten — B's copy shown and kept — and told ONCE as a conflict (a conflicts entry); nothing pending",
        r.ok === false && r.wrote === false && t.get(W[2]).data.dayCall === "b-edit" && A.mirror[W[2]].dayCall === "b-edit" && theirsTold([r.error].concat(A.toasts)) === 1
          && A.st().conflicts.map(c => c.k).join() === W[2] && Object.keys(A.mirror).length === 4 && A.engine.pending().length === 0,
        JSON.stringify({ r, toasts: A.toasts, table: t.get(W[2]).data.dayCall, shown: A.mirror[W[2]] && A.mirror[W[2]].dayCall, c: A.st().conflicts }));
    }
    {
      const t = mkTable(seedRows(4)); const A = mkSession(t); await A.engine.load();
      const slow = t.control.pause({ method: "PATCH", week: W[1], count: 1, when: "after" });   // it LANDS; its answer comes before the job runs
      A.edit(W[1], w => (w.dayCall = "MY-EDIT", w));
      const pp = A.engine.push(); await slow.arrived;
      const before = clone(A.mirror); A.mirror = {};
      t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before" });
      const cp = A.engine.authoritative({}, true, "clear", undefined, { before });
      slow.release();
      const r = await cp; await pp; await A.engine.idle(); await A.engine.idle();
      check("SE82 E7 (c) (control, app-1 b) A's OWN PATCH lands (answered before the job runs), then the clear is refused: MY-EDIT stays on screen and in the table, one PATCH in all, no conflict told or recorded, nothing pending",
        r.ok === false && r.wrote === false && r.error === READ_FAIL && A.mirror[W[1]].dayCall === "MY-EDIT" && t.get(W[1]).data.dayCall === "MY-EDIT" && writes(t).length === 1
          && theirsTold([r.error].concat(A.toasts)) === 0 && A.st().conflicts.length === 0 && Object.keys(A.mirror).length === 4 && A.engine.pending().length === 0,
        JSON.stringify({ r, toasts: A.toasts, shown: A.mirror[W[1]] && A.mirror[W[1]].dayCall, w: writes(t).length, c: A.st().conflicts }));
    }
    {
      const t = mkTable(seedRows(4)); const A = mkSession(t); await A.engine.load();
      const slow = t.control.pause({ method: "PATCH", week: W[1], count: 1, when: "after" });   // e1 lands; its answer is slow
      A.edit(W[1], w => (w.dayCall = "e1", w));
      const pp = A.engine.push(); await slow.arrived;
      A.edit(W[1], w => (w.dayCall = "e2", w)); A.engine.push();        // edited again (its push queues)
      const before = clone(A.mirror); A.mirror = {};
      t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before" });
      const cp = A.engine.authoritative({}, true, "clear", undefined, { before });
      slow.release();
      const r = await cp; await pp; await A.engine.idle(); await A.engine.idle();
      const patches = writes(t).filter(e => e.method === "PATCH").map(e => e.body.data.dayCall);
      check("SE82 E7 (d) …A's EARLIER body (e1) landing under a later edit (e2) while the clear waits isn't someone else's change: e2 is put back (pending), no conflict told or recorded, and the follow-up push saves it at e1's token",
        r.ok === false && r.error === READ_FAIL && theirsTold([r.error].concat(A.toasts)) === 0 && A.st().conflicts.length === 0 && A.mirror[W[1]].dayCall === "e2" && t.get(W[1]).data.dayCall === "e2"
          && patches.join() === "e1,e2" && A.engine.pending().length === 0,
        JSON.stringify({ r, toasts: A.toasts, shown: A.mirror[W[1]] && A.mirror[W[1]].dayCall, table: t.get(W[1]).data.dayCall, patches, c: A.st().conflicts }));
    }
    {
      const t = mkTable(seedRows(4)); const A = mkSession(t); await A.engine.load();
      const hold = t.control.pause({ method: "PATCH", week: W[1], count: 1 });
      A.edit(W[1], w => (w.dayCall = "mine", w));
      const pp = A.engine.push(); await hold.arrived;
      await t.oldBuild("TOK_B", "user-b").upsert({ [W[1]]: clone(t.get(W[1]).data) });   // an old build re-sends W2 UNCHANGED: version kept, updated_at moved (A2)
      const moved = t.get(W[1]).version === 3 && t.get(W[1]).updated_at !== "2026-10-01T08:00:00+00:00";
      const before = clone(A.mirror); A.mirror = {};
      t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before" });
      const cp = A.engine.authoritative({}, true, "clear", undefined, { before });
      hold.release();
      const r = await cp; await pp; await A.engine.idle(); await A.engine.idle();
      check("SE82 E7 (e) …nor an old build re-sending the week UNCHANGED meanwhile (a new token, the data known at the tap — A2's 'refreshed'): A's edit is put back, no conflict told or recorded, and the follow-up push saves it at the new token",
        moved && r.ok === false && r.error === READ_FAIL && theirsTold([r.error].concat(A.toasts)) === 0 && A.st().conflicts.length === 0 && A.mirror[W[1]].dayCall === "mine" && t.get(W[1]).data.dayCall === "mine"
          && t.get(W[1]).version === 4 && A.engine.pending().length === 0,
        JSON.stringify({ moved, r, toasts: A.toasts, shown: A.mirror[W[1]] && A.mirror[W[1]].dayCall, row: t.get(W[1]), c: A.st().conflicts }));
    }
    {
      const { t, A, B } = await twoSessions();
      B.edit(W[5], () => wk("gen5")); await B.engine.push();             // B published W6 (A hasn't pulled it)…
      const holdR = t.control.pause({ method: "GET", week: "in.(", count: 1 });   // …A's publish of the very same week re-reads it: held
      A.mirror = Object.assign({}, A.mirror, { [W[5]]: wk("gen5") });
      const pub = A.engine.authoritative(clone(A.mirror), false, "publish", [W[5]]); await holdR.arrived;
      const before = clone(A.mirror); A.mirror = {};
      t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before" });
      const cp = A.engine.authoritative({}, true, "clear", undefined, { before });
      holdR.release();
      const rp = await pub, r = await cp; await A.engine.idle(); await A.engine.idle();
      check("SE82 E7 (f) …nor a saved copy that now holds exactly what is put back (the publish ahead re-read B's identical week): it's shown, no conflict told or recorded, nothing pending",
        rp.ok === true && r.ok === false && r.error === READ_FAIL && theirsTold([r.error].concat(A.toasts)) === 0 && A.st().conflicts.length === 0 && !!A.mirror[W[5]] && A.mirror[W[5]].dayCall === "gen5"
          && Object.keys(A.mirror).length === 5 && A.engine.pending().length === 0,
        JSON.stringify({ rp: rp.ok, r, toasts: A.toasts, shown: Object.keys(A.mirror), c: A.st().conflicts, pending: A.engine.pending() }));
    }
    {
      const t = mkTable(seedRows(4)); const A = mkSession(t); await A.engine.load();
      const slow = t.control.pause({ method: "PATCH", week: W[1], count: 1, when: "after" });   // it lands; its answer comes before the job runs…
      let normalise = true;                                             // …and says the server stored a normalised copy (a trigger added a field)
      A.fetchHook = async (u, i) => {
        const res = await t.fetch(u, i);
        if (!normalise || !i || i.method !== "PATCH") return res;
        normalise = false;
        const body = JSON.parse(await res.text());
        if (Array.isArray(body) && body[0]) body[0].data = Object.assign({}, body[0].data, { normalised: true });
        return { ok: res.ok, status: res.status, text: () => Promise.resolve(JSON.stringify(body)) };
      };
      A.edit(W[1], w => (w.dayCall = "MY-EDIT", w));
      const pp = A.engine.push(); await slow.arrived;
      const before = clone(A.mirror); A.mirror = {};
      t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before" });
      const cp = A.engine.authoritative({}, true, "clear", undefined, { before });
      slow.release();
      const r = await cp; await pp; A.fetchHook = null; await A.engine.idle(); await A.engine.idle();
      check("SE82 E7 (g) …nor our own write's ANSWER, though the server normalised what it stored (not a body we sent): MY-EDIT is put back, no conflict told or recorded, nothing pending",
        r.ok === false && r.error === READ_FAIL && theirsTold([r.error].concat(A.toasts)) === 0 && A.st().conflicts.length === 0 && A.mirror[W[1]].dayCall === "MY-EDIT" && A.engine.pending().length === 0,
        JSON.stringify({ r, toasts: A.toasts, shown: A.mirror[W[1]], c: A.st().conflicts, pending: A.engine.pending() }));
    }
    {
      // (h) review r3 tests-2 (G4, R3M01): …nor our own body confirmed by a READ-BACK — e1's PATCH landed but its
      // answer was lost (thrown after the commit), so the engine read it back while the clear waited: ours by the
      // ledger (sent[k]), not by our write's own answer — under a later edit (e2) made before the tap.
      const t = mkTable(seedRows(4)); const A = mkSession(t); await A.engine.load();
      const hold = t.control.pause({ method: "PATCH", week: W[1], count: 1 });
      t.control.fail({ method: "PATCH", week: W[1], kind: "throw-after", count: 1 });
      A.edit(W[1], w => (w.dayCall = "e1", w));
      const pp = A.engine.push(); await hold.arrived;                   // e1's PATCH on the wire: it lands, its answer is lost
      A.edit(W[1], w => (w.dayCall = "e2", w)); A.engine.push();        // edited again before the tap (its push queues)
      const before = clone(A.mirror); A.mirror = {};
      t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before" });
      const cp = A.engine.authoritative({}, true, "clear", undefined, { before });
      hold.release();
      const r = await cp; await pp; await A.engine.idle(); await A.engine.idle();
      const patches = writes(t).filter(e => e.method === "PATCH").map(e => e.body.data.dayCall);
      check("SE82 E7 (h) (review r3 tests-2) …nor our own body confirmed by a READ-BACK (e1's PATCH landed, its answer lost: read back while the clear waited — ours by the ledger) under a later edit (e2): the clear refused, e2 is put back — no conflict told or recorded — and the follow-up push saves it at e1's token",
        r.ok === false && r.error === READ_FAIL && theirsTold([r.error].concat(A.toasts)) === 0 && A.st().conflicts.length === 0 && A.mirror[W[1]].dayCall === "e2" && t.get(W[1]).data.dayCall === "e2"
          && patches.join() === "e1,e2" && A.engine.pending().length === 0,
        JSON.stringify({ r, toasts: A.toasts, shown: A.mirror[W[1]] && A.mirror[W[1]].dayCall, table: t.get(W[1]).data.dayCall, patches, c: A.st().conflicts }));
    }
  });

  // SE83 — E8 (review r2 fixes-1, A5(f)): a job that ends after its caller
  // stopped waiting is told in the CALLER's words when it passes
  // opts.late(r): called once, with the job's result, and its text is the
  // only toast. A late() that is missing, throws or returns no text falls
  // back to the engine's own late toast; a job answered in time never calls
  // it (its caller tells it); a job fenced by a sign-out tells nothing.
  await run("SE83", async () => {
    const lateJob = async (late, o) => {
      o = o || {};
      const t = mkTable(seedRows(4));
      const A = mkSession(t, { timeouts: o.inTime ? undefined : fastT }); await A.engine.load();
      const before = clone(A.mirror); A.mirror = {};
      t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before" });
      const hold = t.control.pause({ method: "GET", week: "limit=5000", count: 1 });   // the job's own whole-table read: it has STARTED; it answers 503 once released
      const calls = [], opts = { before };
      if (late) opts.late = (r) => { calls.push(clone(r)); return late(r); };
      const cp = A.engine.authoritative({}, true, "clear", undefined, opts); await hold.arrived;
      let answer;
      if (o.inTime) { hold.release(); answer = await cp; }
      else {
        answer = await Promise.race([cp, sleep(600).then(() => "no answer")]);   // past the deadline: "still running"
        if (o.signOut) { A.engine.reset(); A.token = "TOK_B"; A.user = "user-b"; }
        hold.release();
      }
      await A.engine.idle(); await A.engine.idle(); await sleep(5); await A.engine.idle();
      return { A, t, answer, calls, toasts: A.toasts.slice() };
    };
    const LATE = (r) => `Factory reset: the weeks were NOT cleared — ${r.error}`;
    const x = await lateJob(LATE);
    check("SE83 E8 a clear that STARTED before its deadline (its whole-table read out) and is refused after it: its caller was told 'still running'; when it ends, late(r) is called ONCE with the job's result, and late's text is the ONLY toast (not the engine's own)",
      x.answer !== "no answer" && x.answer.running === true && x.calls.length === 1 && x.calls[0].ok === false && x.calls[0].wrote === false && x.calls[0].error === READ_FAIL
        && JSON.stringify(x.toasts) === JSON.stringify([LATE(x.calls[0])]) && Object.keys(x.A.mirror).length === 4 && writes(x.t).length === 0,
      JSON.stringify({ answer: x.answer, calls: x.calls, toasts: x.toasts }));
    const GENERIC = "Clearing the schedule stopped — " + READ_FAIL;
    const m = await lateJob(null);
    const caught0 = caught.length;
    const th = await lateJob(() => { throw new Error("an app bug in late"); });
    const thrown = caught.slice(caught0);
    caught.splice(caught0, thrown.length);   // expected here — not counted against SE-I
    const nu = await lateJob(() => null);
    check("SE83 E8 …late() missing, throwing (caught and logged once — the job and the chain unharmed) or returning no text: the engine's own late toast, once",
      [m, th, nu].every(y => y.answer.running === true && JSON.stringify(y.toasts) === JSON.stringify([GENERIC])) && th.calls.length === 1 && nu.calls.length === 1
        && thrown.length === 1 && /^opts\.late threw an app bug in late$/.test(thrown[0]) && !th.A.internal,
      JSON.stringify({ toasts: [m.toasts, th.toasts, nu.toasts], calls: [th.calls.length, nu.calls.length], thrown }));
    const it = await lateJob(LATE, { inTime: true }), so = await lateJob(LATE, { signOut: true });
    check("SE83 E8 …a job refused IN time never calls late() (its caller tells it) and the engine toasts nothing; a job fenced by a sign-out mid-job (skipped 'reset') calls nothing and tells nothing",
      it.answer.ok === false && it.answer.error === READ_FAIL && !it.answer.running && it.calls.length === 0 && it.toasts.length === 0
        && so.answer !== "no answer" && so.answer.running === true && so.calls.length === 0 && so.toasts.length === 0,
      JSON.stringify({ it: { answer: it.answer, calls: it.calls.length, toasts: it.toasts }, so: { answer: so.answer, calls: so.calls.length, toasts: so.toasts } }));
  });

  // SE84 — G1 (review r3 fixes-1 = regress-1 = regress-2 = tests-1): a job reset() already fenced is fenced at its
  // deadline too. (a) A clear / restore / publish QUEUED behind a slow save at a sign-out or a switch to another
  // account (reset(): cancelled and released), the save's request still out when the job's deadline passes: its
  // caller is told it was fenced — skipped 'cancelled' — and nothing of the old session lands in the next one: no
  // put-back of its screen (no commit after the reset), no "changed by someone else" for every week (E7 against
  // the next session's emptied `known`), no onAdopted, no toast, no late(), nothing written as the next account; and
  // after the next session's load, no conflicts in its header. (b) A clear RUNNING at the sign-out (its own read
  // out) whose deadline passes after it: skipped 'reset' — never "still running" (its caller said "taking longer
  // than expected" on the next session's screen: the 19/n open item) — and no late() or toast when it ends.
  await run("SE84", async () => {
    const lates = [];
    const fenced = async (what) => {
      const t = mkTable(seedRows(4));
      const A = mkSession(t, { timeouts: fastT }); await A.engine.load();
      const hold = t.control.pause({ method: "PATCH", week: W[3], count: 1 });   // a slow save holds the chain
      A.edit(W[3], w => (w.nights.mon = "zz", w));
      const pp = A.engine.push(); await hold.arrived;
      let cp;
      if (what === "publish") { A.mirror = Object.assign({}, A.mirror, { [W[6]]: wk("gen6") }); cp = A.engine.authoritative(clone(A.mirror), false, "publish", [W[6]], { late: (r) => { lates.push(r); return "LATE"; } }); }
      else {
        const target = what === "clear" ? {} : { [W[0]]: wk("snap0"), [W[1]]: wk("snap1") };
        const before = clone(A.mirror); A.mirror = clone(target);       // the caller: before, commitSchedule(target), authoritative()
        cp = A.engine.authoritative(clone(target), true, what, undefined, { before, late: (r) => { lates.push(r); return "LATE"; } });
      }
      await sleep(5);
      const queued = jobOf(A);
      A.engine.reset(); A.token = "TOK_B"; A.user = "user-b";           // the session boundary: the job fenced while still queued
      const commits0 = A.commits, adopted0 = A.adopted.length, toasts0 = A.toasts.length;
      const r = await Promise.race([cp, sleep(600).then(() => "no answer")]);   // its deadline passes; the slow save still out
      const at = { shown: Object.keys(A.mirror).length, commits: A.commits - commits0, conflicts: A.st().conflicts.length, adopted: A.adopted.length - adopted0, toasts: A.toasts.slice(toasts0) };
      const from = t.log.length;
      hold.release(); await pp; for (let i = 0; i < 4; i++) await A.engine.idle(); await sleep(5); await A.engine.idle();
      const ln = A.line();
      const after = { seeded: A.engine.isSeeded(), conflicts: A.st().conflicts.length, line: ln ? ln.kind : null, toasts: A.toasts.slice(toasts0), wB: writes(t, from).filter(e => e.headers.authorization === "Bearer TOK_B").length };
      return { what, queued, r, at, after };
    };
    const xs = [await fenced("clear"), await fenced("restore"), await fenced("publish")];
    check("SE84 G1 (a) a clear / restore / publish QUEUED at a sign-out (reset()) whose deadline passes with the slow save still out: told it was fenced — skipped 'cancelled', 'It was cancelled before its turn came — nothing was changed.' (no timeout) — and NOTHING of the old session lands in the next one: no commit after the reset (the screen stays empty), no conflict, no onAdopted, no toast, no late(); after the next session's load: seeded, no conflicts in its header, nothing written as the next account",
      xs.every(x => x.queued === x.what && x.r !== "no answer" && x.r.skipped === "cancelled" && x.r.ok === false && x.r.wrote === false && x.r.error === "It was cancelled before its turn came — nothing was changed." && !x.r.reason
        && x.at.shown === 0 && x.at.commits === 0 && x.at.conflicts === 0 && x.at.adopted === 0 && x.at.toasts.length === 0
        && x.after.seeded === true && x.after.conflicts === 0 && x.after.line !== "conflicts" && x.after.toasts.length === 0 && x.after.wB === 0) && lates.length === 0,
      JSON.stringify(xs.map(x => ({ what: x.what, queued: x.queued, r: x.r, at: x.at, after: x.after })).concat([{ lates: lates.length }])));
    {
      const t = mkTable(seedRows(4));
      const A = mkSession(t, { timeouts: fastT }); await A.engine.load();
      t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before", count: 1 });
      const hold = t.control.pause({ method: "GET", week: "limit=5000", count: 1 });   // the clear's own whole-table read: it has STARTED
      const before = clone(A.mirror); A.mirror = {};
      const calls = [];
      const cp = A.engine.authoritative({}, true, "clear", undefined, { before, late: (r) => { calls.push(r); return "LATE"; } }); await hold.arrived;
      A.engine.reset(); A.token = "TOK_B"; A.user = "user-b";           // signed out while it runs
      const r = await Promise.race([cp, sleep(600).then(() => "no answer")]);   // its deadline passes: the read still out
      hold.release(); for (let i = 0; i < 4; i++) await A.engine.idle(); await sleep(5); await A.engine.idle();
      check("SE84 G1 (b) …a clear RUNNING at the sign-out (its own read out), its deadline after the sign-out: skipped 'reset' — never 'still running' (its caller said 'taking longer than expected' on the next session's screen) — and when it ends: no late(), no toast; the next session's screen is the table's",
        r !== "no answer" && r.skipped === "reset" && r.ok === false && !r.running && !r.reason && calls.length === 0 && A.toasts.length === 0 && A.st().conflicts.length === 0 && sameData(A.mirror, tableSched(t)) && t.rows().length === 4,
        JSON.stringify({ r, calls: calls.length, toasts: A.toasts, shown: Object.keys(A.mirror).length }));
    }
  });

  // SE85 — G6 (review r3; 18/n open item 1): a clear / reset / restore that writes nothing while a LATER one is
  // queued puts nothing back — the later job owns the screen — and hands it what it would have put back. (a)
  // PROBE-MIX1: a clear then a restore stacked behind a slow save, the clear refused (its read fails), the restore
  // lands: the table and the screen end as the snapshot and stay so — the follow-up push re-inserts none of the
  // weeks the restore deleted. (b) Both refused, with an edit pending from before the clear's tap (its write
  // failed): the screen is back as it was before the CLEAR's tap — the pending edit included — and the follow-up
  // push saves it. (c) A PUBLISH queued behind a refused clear doesn't take the screen over: the clear puts it back.
  await run("SE85", async () => {
    const ws = (t) => writes(t).map(e => e.method + " " + e.url.replace(/^.*schedule_weeks\??/, "").split("&")[0]);
    {
      const t = mkTable(seedRows(6));
      const A = mkSession(t); await A.engine.load();
      const hold = t.control.pause({ method: "PATCH", week: W[3], count: 1 });
      A.edit(W[3], w => (w.nights.mon = "zz", w));
      const pp = A.engine.push(); await hold.arrived;
      const SNAP = { [W[0]]: wk("snap0"), [W[1]]: wk("snap1") };
      const b1 = clone(A.mirror); A.mirror = {}; const p1 = A.engine.authoritative({}, true, "clear", undefined, { before: b1 });
      const b2 = clone(A.mirror); A.mirror = clone(SNAP); const p2 = A.engine.authoritative(clone(SNAP), true, "restore", undefined, { before: b2 });
      t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before", count: 1 });   // only the clear's read
      hold.release();
      const r1 = await p1, r2 = await p2; await pp; for (let i = 0; i < 4; i++) await A.engine.idle(); await sleep(5); await A.engine.idle();
      const rows = t.rows().map(r => r.week_monday + "=" + r.data.dayCall);
      check("SE85 G6 (a) PROBE-MIX1: a clear then a restore stacked behind a slow save — the clear refused (its read fails), the restore lands: the table ends as the snapshot (2 weeks) and stays so — no week the restore deleted is re-inserted by the follow-up push (no POST) — the screen equals it, nothing pending",
        r1.ok === false && r1.wrote === false && r1.error === READ_FAIL && r2.ok === true && rows.join() === [W[0] + "=snap0", W[1] + "=snap1"].join() && sameData(A.mirror, SNAP)
          && !writes(t).some(e => e.method === "POST") && A.engine.pending().length === 0,
        JSON.stringify({ r1: r1.error, r2: r2.ok, rows, shown: Object.keys(A.mirror).sort(), w: ws(t) }));
    }
    {
      const t = mkTable(seedRows(6));
      const A = mkSession(t); await A.engine.load();
      t.control.fail({ method: "PATCH", week: W[5], kind: "throw" }); t.control.fail({ method: "GET", week: W[5], kind: "throw" });
      A.edit(W[5], w => (w.dayCall = "pending-edit", w)); await A.engine.push();   // an edit pending from before the tap (its PATCH threw, and its read-back)
      const setup = A.engine.pending().join() === W[5];
      const hold = t.control.pause({ method: "PATCH", week: W[3], count: 1 });
      A.edit(W[3], w => (w.nights.mon = "zz", w));
      const pp = A.engine.push(); await hold.arrived;
      const SNAP = { [W[0]]: wk("snap0"), [W[1]]: wk("snap1") };
      const b1 = clone(A.mirror); A.mirror = {}; const p1 = A.engine.authoritative({}, true, "clear", undefined, { before: b1 });
      const b2 = clone(A.mirror); A.mirror = clone(SNAP); const p2 = A.engine.authoritative(clone(SNAP), true, "restore", undefined, { before: b2 });
      t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before", count: 2 });   // both reads fail
      hold.release();
      const r1 = await p1, r2 = await p2; await pp; for (let i = 0; i < 4; i++) await A.engine.idle(); await sleep(5); await A.engine.idle();
      check("SE85 G6 (b) …both refused, with an edit pending from before the clear's tap (its write failed): the restore, which took the screen over, puts back the screen as it was before the CLEAR's tap — the pending edit included — and the follow-up push saves it; the table otherwise unchanged (the slow save landed), the screen equals it, nothing pending",
        setup && r1.ok === false && r2.ok === false && r1.wrote === false && r2.wrote === false && !!A.mirror[W[5]] && A.mirror[W[5]].dayCall === "pending-edit" && t.get(W[5]).data.dayCall === "pending-edit"
          && t.rows().length === 6 && t.get(W[3]).data.nights.mon === "zz" && t.get(W[0]).data.dayCall === "s1" && sameData(A.mirror, tableSched(t)) && A.engine.pending().length === 0,
        JSON.stringify({ setup, r1: r1.error, r2: r2.error, shown: Object.keys(A.mirror).sort().map(k => k + "=" + A.mirror[k].dayCall), rows: t.rows().map(r => r.week_monday + "=" + r.data.dayCall), pending: A.engine.pending(), w: ws(t) }));
    }
    {
      const t = mkTable(seedRows(4));
      const A = mkSession(t); await A.engine.load();
      t.control.fail({ method: "PATCH", week: W[2], kind: "throw" }); t.control.fail({ method: "GET", week: W[2], kind: "throw" });
      A.edit(W[2], w => (w.dayCall = "pending-edit", w)); await A.engine.push();
      const setup = A.engine.pending().join() === W[2];
      const hold = t.control.pause({ method: "PATCH", week: W[3], count: 1 });
      A.edit(W[3], w => (w.nights.mon = "zz", w));
      const pp = A.engine.push(); await hold.arrived;
      const b1 = clone(A.mirror); A.mirror = {}; const p1 = A.engine.authoritative({}, true, "clear", undefined, { before: b1 });
      A.mirror = Object.assign({}, A.mirror, { [W[6]]: wk("gen6") }); const p2 = A.engine.authoritative(clone(A.mirror), false, "publish", [W[6]]);
      t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before", count: 1 });   // the clear's read
      hold.release();
      const r1 = await p1, r2 = await p2; await pp; for (let i = 0; i < 4; i++) await A.engine.idle(); await sleep(5); await A.engine.idle();
      check("SE85 G6 (c) …a PUBLISH queued behind a refused clear doesn't take the screen over (it's no clear / reset / restore): the clear puts the screen back as it was — the pending edit included, saved by the follow-up push — beside the published week",
        setup && r1.ok === false && r2.ok === true && !!A.mirror[W[2]] && A.mirror[W[2]].dayCall === "pending-edit" && t.get(W[2]).data.dayCall === "pending-edit" && !!t.get(W[6]) && t.get(W[6]).data.dayCall === "gen6"
          && Object.keys(A.mirror).length === 5 && sameData(A.mirror, tableSched(t)) && A.engine.pending().length === 0 && A.wipeBlocked.length === 0,
        JSON.stringify({ setup, r1: r1.error, r2: r2.ok, shown: Object.keys(A.mirror).sort(), rows: t.rows().map(r => r.week_monday + "=" + r.data.dayCall), pending: A.engine.pending(), w: ws(t) }));
    }
    // (d) H8 (review r4 fixes-4, R4-E2): a clear RUNNING (its whole-table read held), a restore stacked behind it
    // (E6: no `before`) cancelled at its deadline first; then the clear lands. The cancelled restore puts nothing of
    // its own back — the running clear owns the screen: it shows the clear's again — and the clear's own commit
    // settles it: every week deleted and none re-inserted by the follow-up push, none of the restore's written.
    {
      const t = mkTable(seedRows(4));
      const A = mkSession(t, { timeouts: { read: 60000, write: 60000, stall: 15, deadline: 80 } }); await A.engine.load();
      const hold = t.control.pause({ method: "GET", week: "limit=5000", count: 1 });
      const b1 = clone(A.mirror); A.mirror = {}; const p1 = A.engine.authoritative({}, true, "clear", undefined, { before: b1 });
      await hold.arrived;                                                 // the clear RUNS: its read is out
      const SNAP = { [W[0]]: wk("snap0"), [W[5]]: wk("snap5") };
      const b2 = clone(A.mirror); A.mirror = clone(SNAP); const p2 = A.engine.authoritative(clone(SNAP), true, "restore", undefined, { before: b2 });
      const r2 = await p2;                                                // its deadline (80 ms) passes, the clear still running
      const atCancel = Object.keys(A.mirror).sort(), from = t.log.length;
      hold.release();
      const r1 = await p1; for (let i = 0; i < 4; i++) await A.engine.idle(); await sleep(5); await A.engine.idle();
      const res = { r1: r1.ok, r1run: r1.running, r2: r2.reason, r2e: r2.error, atCancel, shown: Object.keys(A.mirror).sort(), rows: t.rows().map(r => r.week_monday + "=" + r.data.dayCall), w: writes(t, from).map(e => e.method + " " + e.url.replace(/^.*schedule_weeks\??/, "").split("&")[0]), toasts: A.toasts, pending: A.engine.pending() };
      check("SE85 H8 (d) (R4-E2) a clear RUNNING, a restore stacked behind it cancelled at its deadline: the cancelled restore puts nothing of its own back — the screen shows the running clear's again (empty), not the table's weeks nor its own snapshot — and when the clear lands every week is deleted and NONE re-inserted (no POST), none of the restore's weeks written; the screen equals the table (empty), nothing pending; the clear's late outcome says it finished",
        r2.reason === "timeout" && atCancel.length === 0 && t.rows().length === 0 && !res.w.some(w => w.startsWith("POST") || w.startsWith("PATCH")) && res.w.filter(w => w.startsWith("DELETE")).length === 4
          && Object.keys(A.mirror).length === 0 && A.engine.pending().length === 0 && A.toasts.join("|") === "Clearing the schedule has finished — every week is saved.", JSON.stringify(res));
    }
    // (e) r4-fix-8 (R4-E5, R4M5): SE82 (a)'s shape with a restore stacked behind the clear, both refused — the put-back
    // handed over WITH its saved copies at the tap (knownAt): B's deletion of the week A's edit was out for stands,
    // told as a conflict — never re-inserted by the follow-up push.
    {
      const { t, A, B } = await twoSessions();
      const hold = t.control.pause({ method: "PATCH", week: W[2], count: 1 });
      A.edit(W[2], w => (w.dayCall = "a-edit", w));
      const pp = A.engine.push(); await hold.arrived;
      B.drop(W[2]); await B.engine.push();
      const SNAP = { [W[0]]: wk("snap0") };
      const b1 = clone(A.mirror); A.mirror = {}; const p1 = A.engine.authoritative({}, true, "clear", undefined, { before: b1 });
      const b2 = clone(A.mirror); A.mirror = clone(SNAP); const p2 = A.engine.authoritative(clone(SNAP), true, "restore", undefined, { before: b2 });
      t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before", count: 2 });
      const from = t.log.length;
      hold.release();
      const r1 = await p1, r2 = await p2; await pp; for (let i = 0; i < 4; i++) await A.engine.idle(); await sleep(5); await A.engine.idle();
      const res = { r1: r1.error, r2: r2.error, tableHasW3: !!t.get(W[2]), shown: Object.keys(A.mirror).sort(), posts: writes(t, from).filter(e => e.method === "POST").length, conflicts: A.st().conflicts.map(c => c.k), toasts: A.toasts };
      check("SE85 G6 (e) (r4-fix-8, R4-E5) both stacked jobs refused after B deleted the week A's edit was out for: the restore's put-back (handed over from the clear, with the saved copies at its tap — knownAt) keeps B's deletion — no re-insert, the week off A's screen, told as a conflict",
        r1.ok === false && r2.ok === false && !res.tableHasW3 && res.posts === 0 && !(W[2] in A.mirror) && res.conflicts.includes(W[2]) && theirsTold([r2.error]) === 1, JSON.stringify(res));
    }
    // (f) r4-fix-8 (R4-E3, R4M3): both refused, with a NEW local week pending from before the first tap (never saved):
    // the handed-over put-back covers it (the later job's weeks extended with it): back on screen, saved by the follow-up push.
    {
      const t = mkTable(seedRows(6));
      const A = mkSession(t); await A.engine.load();
      const NEW = W[8];
      t.control.fail({ method: "POST", week: NEW, kind: "throw" }); t.control.fail({ method: "GET", week: NEW, kind: "throw" });
      A.mirror = Object.assign({}, A.mirror, { [NEW]: wk("new-local") }); await A.engine.push();
      const setup = A.engine.pending().join() === NEW && !t.get(NEW);
      const hold = t.control.pause({ method: "PATCH", week: W[3], count: 1 });
      A.edit(W[3], w => (w.nights.mon = "zz", w));
      const pp = A.engine.push(); await hold.arrived;
      const SNAP = { [W[0]]: wk("snap0"), [W[1]]: wk("snap1") };
      const b1 = clone(A.mirror); A.mirror = {}; const p1 = A.engine.authoritative({}, true, "clear", undefined, { before: b1 });
      const b2 = clone(A.mirror); A.mirror = clone(SNAP); const p2 = A.engine.authoritative(clone(SNAP), true, "restore", undefined, { before: b2 });
      t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before", count: 2 });
      hold.release();
      const r1 = await p1, r2 = await p2; await pp; for (let i = 0; i < 4; i++) await A.engine.idle(); await sleep(5); await A.engine.idle();
      const res = { setup, r1: r1.error, r2: r2.error, shown: Object.keys(A.mirror).sort(), newOnScreen: !!A.mirror[NEW], newSaved: !!t.get(NEW), pending: A.engine.pending() };
      check("SE85 G6 (f) (r4-fix-8, R4-E3) both stacked jobs refused, a NEW local week pending from before the clear's tap (never saved): the handed-over put-back covers it — back on screen, and the follow-up push saves it; the screen equals the table, nothing pending",
        setup && r1.ok === false && r2.ok === false && res.newOnScreen && res.newSaved && t.get(NEW).data.dayCall === "new-local" && sameData(A.mirror, tableSched(t)) && A.engine.pending().length === 0, JSON.stringify(res));
    }
  });

  // SE86 — H1 (review r4 branch-1, CRITICAL): a save whose answer was lost is never re-sent over another device's
  // REVERT of it. A's write lands, its answer and its read-back are lost (A still has it pending); another device puts
  // the week back as it was. When A reconnects, its re-read finds the data A knew under a new token — "refreshed" used
  // to take that for an old build's unchanged re-send and re-send A's write over the revert, silently. Now: while a body
  // of ours that may have landed is out, "refreshed" only when the version is still the one known (an old build's
  // version-keeping re-send), never at v1 (a deletion + re-insert restarts there) — else theirs: a conflict, their copy
  // shown and told, nothing re-sent. (a) a peer reverts; (b) the same user's second device; (c) a DELETE, the week put
  // back as it was; (d) both at v1 (deleted and re-inserted as it was); (e) the recovery story (p4): a publish from a
  // phone half-lands, "Before regenerate" is restored on the desktop — W0 stays restored, the conflict told on the
  // phone. Controls: (f) an old build's unchanged re-send under a lost edit of ours that did NOT land (same version) is
  // still "refreshed" — the edit lands, no conflict; (g) SE71 at v1: a 0-row answer proves our body didn't land —
  // "refreshed", no false conflict. (h) E7's savedMoved, the same rule: a refused restore never puts our lost write
  // back over a revert its push re-read confirmed. (i–l) H3 (review r4 branch-3, a decision): a new week whose INSERT
  // went out with its outcome unknown, then a re-read finds NO row (a clear or a restore elsewhere deleted it — or it
  // never landed): it is sent again, the user's own intended week, and told ONCE: "The week of … was saved again — its
  // first save couldn't be confirmed. If it was removed on another device on purpose, remove it again." Never for an
  // ordinary insert, nor when the read-back simply failed, nor for one whose answered read-back already found no row.
  await run("SE86", async () => {
    const RESENT = (k) => `The week of ${new Date(...k.split("-").map((x, i) => i === 1 ? +x - 1 : +x)).toLocaleDateString(undefined, { month: "short", day: "numeric" })} was saved again — its first save couldn't be confirmed. If it was removed on another device on purpose, remove it again.`;
    const resentTold = (msgs, k) => msgs.filter(m => String(m).includes(RESENT(k))).length;
    const ws = (t, from) => writes(t, from).map(e => e.method + " " + e.url.replace(/^.*schedule_weeks\??/, "").split("&")[0] + " " + e.status + (e.applied ? "" : " (0 rows)"));
    // (a) / (b): A's PATCH lands, the answer and the read-back lost; the other device reverts it; A reconnects (its pull)
    const revert = async (other, v) => {
      const t = mkTable(seedRows(3, v)); t.control.users.TOK_A2 = "user-a";
      const A = mkSession(t), B = mkSession(t, other);
      await A.engine.load(); await B.engine.load();
      const x0 = t.get(W[0]).data.dayCall;
      t.control.fail({ method: "PATCH", week: W[0], kind: "throw-after" }); t.control.fail({ method: "GET", week: W[0], kind: "throw" });
      A.edit(W[0], w => (w.dayCall = "s9", w)); await A.engine.push();
      const setup = t.get(W[0]).data.dayCall === "s9" && A.engine.pending().join() === W[0];
      await B.engine.pull(); B.edit(W[0], w => (w.dayCall = x0, w)); const rb = await B.engine.push();   // B puts it back as it was
      const reverted = rb.ok && t.get(W[0]).data.dayCall === x0;
      const revV = t.get(W[0]).version, toasts0 = A.toasts.length, from = t.log.length;
      await A.engine.pull(); await A.engine.idle();
      await B.engine.pull();
      return { x0, setup: setup && reverted, revV, after: t.get(W[0]), ws: ws(t, from), aw: writes(t, from).filter(e => e.headers.authorization === "Bearer TOK_A").length,
        toasts: A.toasts.slice(toasts0), conflicts: A.st().conflicts.map(c => c.k), shown: A.mirror[W[0]].dayCall, pending: A.engine.pending(), bShown: B.mirror[W[0]].dayCall, bToasts: B.toasts.slice() };
    };
    const told = (x, k) => x.toasts.length === 1 && theirsTold(x.toasts) === 1 && x.toasts[0].startsWith("The week of " + new Date(2026, 9, 12).toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " was changed by someone else");
    const kept = (x) => x.setup && x.after.data.dayCall === x.x0 && x.after.version === x.revV && x.aw === 0 && told(x) && x.conflicts.join() === W[0] && x.shown === x.x0 && x.pending.length === 0 && x.bShown === x.x0 && x.bToasts.length === 0;
    const pa = await revert({ token: "TOK_B", user: "user-b" });
    check("SE86 H1 (a) (p1) A's PATCH LANDS, its answer and read-back lost; a PEER puts the week back as it was (v5); A reconnects: its re-read sees the data it knew under a new token — while A's own body may have landed that is NOT 'refreshed': a conflict, their copy shown and told once ('The week of … was changed by someone else …'), nothing re-sent (no write by A) — the table keeps the revert at its version; nothing pending; the peer still shows its revert, told nothing",
      kept(pa), JSON.stringify(pa));
    const pb = await revert({ token: "TOK_A2", user: "user-a" });
    check("SE86 H1 (b) (p1) …the same when the revert is the SAME user's second device (TOK_A2, user-a): the revert stands, A told the conflict, nothing re-sent",
      kept(pb), JSON.stringify(pb));
    // (c) A's DELETE lands, the answer lost; the other device puts the week back as it was (an INSERT at v1)
    const reins = async (v) => {
      const t = mkTable(seedRows(6, v));
      const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
      await A.engine.load(); await B.engine.load();
      const was = clone(t.get(W[2]).data);
      t.control.fail({ method: "DELETE", week: W[2], kind: "throw-after" }); t.control.fail({ method: "GET", week: W[2], kind: "throw" });
      A.drop(W[2]); await A.engine.push();
      const setup = t.get(W[2]) === null && A.engine.pending().join() === W[2];
      await B.engine.pull(); B.mirror = Object.assign({}, B.mirror, { [W[2]]: was }); await B.engine.push();   // B re-creates it as it was (v1)
      const back = !!t.get(W[2]) && t.get(W[2]).version === 1, toasts0 = A.toasts.length, from = t.log.length;
      await A.engine.pull(); await A.engine.idle();
      return { setup: setup && back, row: t.get(W[2]), ws: ws(t, from), dels: writes(t, from).filter(e => e.method === "DELETE").length, toasts: A.toasts.slice(toasts0), conflicts: A.st().conflicts.map(c => c.k), shown: !!A.mirror[W[2]] && sameData(A.mirror[W[2]], was), pending: A.engine.pending() };
    };
    const pc = await reins(3);
    check("SE86 H1 (c) (p2a) A's DELETE lands, its answer lost; another device puts the week back exactly as it was (re-inserted at v1); A reconnects: not 'refreshed' — a conflict: the week stays (no DELETE sent again), shown on A's screen, told once; nothing pending",
      pc.setup && !!pc.row && pc.dels === 0 && pc.shown && pc.conflicts.join() === W[2] && pc.toasts.length === 1 && theirsTold(pc.toasts) === 1 && pc.pending.length === 0, JSON.stringify(pc));
    // (d) at v1 (every published week sits there until edited): deleted + re-inserted as it was restarts the version at 1
    const recr = async () => {
      const t = mkTable(seedRows(3, 1));
      const A = mkSession(t); await A.engine.load();
      const x0 = clone(t.get(W[0]).data);
      t.control.fail({ method: "PATCH", week: W[0], kind: "throw-after" }); t.control.fail({ method: "GET", week: W[0], kind: "throw" });
      A.edit(W[0], w => (w.dayCall = "s9", w)); await A.engine.push();
      const setup = t.get(W[0]).data.dayCall === "s9" && t.get(W[0]).version === 2 && A.engine.pending().join() === W[0];
      await t.recreate("TOK_B", W[0], x0, { by: "user-b" });   // deleted, then re-inserted AS IT WAS (a clear + a restore of an older snapshot elsewhere): v1 again
      const re = t.get(W[0]).version === 1 && sameData(t.get(W[0]).data, x0), from = t.log.length;
      await A.engine.pull(); await A.engine.idle();
      return { setup: setup && re, row: t.get(W[0]), ws: ws(t, from), aw: writes(t, from).filter(e => e.headers.authorization === "Bearer TOK_A").length, toasts: A.toasts.slice(1), conflicts: A.st().conflicts.map(c => c.k), shown: A.mirror[W[0]].dayCall, pending: A.engine.pending() };
    };
    const pd = await recr(), pd2 = await reins(1);
    check("SE86 H1 (d) …at v1 (a published week not yet edited): A's PATCH lands (v2), its answer lost; elsewhere the week is deleted and re-inserted AS IT WAS — v1 again, the very token-version A knew: still a conflict (a v1 week is never 'refreshed' while a body of ours is out), the re-insert stands, nothing re-sent; and A's lost DELETE of a v1 week, the week put back as it was: kept, told",
      pd.setup && pd.row.data.dayCall === "s1" && pd.row.version === 1 && pd.aw === 0 && pd.conflicts.join() === W[0] && pd.shown === "s1" && theirsTold(pd.toasts) === 1 && pd.pending.length === 0
        && pd2.setup && !!pd2.row && pd2.dels === 0 && pd2.shown && pd2.conflicts.join() === W[2] && theirsTold(pd2.toasts) === 1 && pd2.pending.length === 0, JSON.stringify({ pd, pd2 }));
    // (e) the recovery story (p4): a publish from the phone half-lands — W0 (existing) PATCHed, W5 (new) INSERTed, both
    // committed, every answer and read-back lost — and the desktop restores "Before regenerate" (W0 back, W5 deleted)
    {
      const t = mkTable(seedRows(4));
      const phone = mkSession(t), desk = mkSession(t, { token: "TOK_A2", user: "user-a" });
      t.control.users.TOK_A2 = "user-a";
      await phone.engine.load(); await desk.engine.load();
      const snapshot = clone(phone.mirror);
      const pub = { [W[0]]: wk("p1"), [W[5]]: wk("p6") };
      phone.mirror = Object.assign({}, phone.mirror, pub);
      t.control.fail({ method: "PATCH", week: W[0], kind: "5xx-after" }); t.control.fail({ method: "POST", week: W[5], kind: "throw-after" });
      let offline = true;
      phone.fetchHook = (u, i) => (offline && (!i || !i.method || i.method === "GET") && /week_monday=eq./.test(u)) ? Promise.reject(new TypeError("Failed to fetch")) : t.fetch(u, i);
      const pr = await phone.engine.authoritative(clone(pub), false, "publish", Object.keys(pub));
      await phone.engine.idle(); await phone.engine.idle();
      const setup = t.get(W[0]).data.dayCall === "p1" && !!t.get(W[5]) && phone.engine.pending().join() === [W[0], W[5]].join();
      await desk.engine.pull();
      const before = clone(desk.mirror); desk.mirror = clone(snapshot);
      const rr = await desk.engine.authoritative(clone(snapshot), true, "restore", null, { before });
      const restored = rr.ok && t.get(W[0]).data.dayCall === snapshot[W[0]].dayCall && !t.get(W[5]);
      offline = false; const toasts0 = phone.toasts.length, from = t.log.length;
      await phone.engine.pull(); await phone.engine.idle(); await phone.engine.idle();
      const pt = phone.toasts.slice(toasts0);
      await desk.engine.pull();
      const res = { pr: pr.ok, setup, restored, w0: t.get(W[0]).data.dayCall, w5: t.get(W[5]) ? t.get(W[5]).data.dayCall : null, ws: ws(t, from), toasts: pt, conflicts: phone.st().conflicts.map(c => c.k), phoneW0: phone.mirror[W[0]].dayCall,
        pending: phone.engine.pending(), deskW0: desk.mirror[W[0]].dayCall, deskToasts: desk.toasts.slice() };
      check("SE86 H1 (e) (p4) the recovery story: a publish from the phone half-lands (W0's PATCH and W5's INSERT committed, every answer and read-back lost); the desktop restores 'Before regenerate'; the phone reconnects: W0 STAYS restored — the phone shows the restored copy, the conflict told — nothing PATCHed over it; the desktop shows the restored W0, told nothing",
        setup && restored && res.w0 === snapshot[W[0]].dayCall && !res.ws.some(w => w.startsWith("PATCH week_monday=eq." + W[0])) && res.conflicts.join() === W[0] && res.phoneW0 === snapshot[W[0]].dayCall
          && pt.length === 1 && theirsTold(pt) === 1 && res.pending.length === 0 && res.deskW0 === snapshot[W[0]].dayCall && res.deskToasts.length === 0, JSON.stringify(res));
      check("SE86 H3 (e) …and W5 — the publish's NEW week, its INSERT's outcome lost, deleted by the restore — is sent again (the user's own intended week) but no longer silently: in the phone's ONE message, once: '" + RESENT(W[5]) + "'",
        res.w5 === "p6" && res.ws.filter(w => w.startsWith("POST")).length === 1 && pt.length === 1 && resentTold(pt, W[5]) === 1, JSON.stringify(res));
    }
    // (f) control: an old build re-sends the week unchanged (version kept) under a lost edit of ours that did NOT land
    {
      const t = mkTable(seedRows(3));
      const A = mkSession(t); await A.engine.load();
      t.control.fail({ method: "PATCH", week: W[0], kind: "throw" }); t.control.fail({ method: "GET", week: W[0], kind: "throw" });   // never landed; its outcome unknown
      A.edit(W[0], w => (w.dayCall = "mine", w)); await A.engine.push();
      const setup = A.engine.pending().join() === W[0] && t.get(W[0]).data.dayCall === "s1";
      await t.oldBuild("TOK_B", "user-b").upsert({ [W[0]]: clone(t.get(W[0]).data) });   // version 3 kept, updated_at moved
      const moved = t.get(W[0]).version === 3 && t.get(W[0]).updated_at !== "2026-10-01T08:00:00+00:00", from = t.log.length;
      await A.engine.pull(); await A.engine.idle();
      check("SE86 H1 (f) control: an old build re-sends the week UNCHANGED (version kept, updated_at moved) under a lost edit of ours that did NOT land — the version is still the one known: 'refreshed', the edit lands at v4 (one PATCH, at the new token), no conflict, no toast",
        setup && moved && t.get(W[0]).data.dayCall === "mine" && t.get(W[0]).version === 4 && ws(t, from).join() === "PATCH week_monday=eq." + W[0] + " 200" && A.st().conflicts.length === 0 && A.toasts.length === 1 && A.engine.pending().length === 0,
        JSON.stringify({ setup, moved, ws: ws(t, from), toasts: A.toasts, c: A.st().conflicts, row: t.get(W[0]) }));
    }
    // (g) control: SE71 at v1 — the 0-row answer proves our body didn't land
    {
      const t = mkTable(seedRows(2, 1));
      const A = mkSession(t); await A.engine.load();
      A.edit(W[0], w => (w.dayCall = "mine", w));
      await t.oldBuild("TOK_B", "user-b").upsert({ [W[0]]: clone(t.get(W[0]).data) });
      const from = t.log.length;
      const r = await A.engine.push();
      const w = writes(t, from);
      check("SE86 H1 (g) control: SE71 on a week at v1 — an old build re-sends it unchanged under an unsaved edit: our CAS PATCH answers 0 rows (that body did NOT land), so it is 'refreshed' even at v1: the edit lands at v2, no conflict, no toast",
        r.ok && w.length === 2 && w[0].applied === false && w[1].applied === true && t.get(W[0]).data.dayCall === "mine" && t.get(W[0]).version === 2 && A.toasts.length === 0 && A.st().conflicts.length === 0,
        JSON.stringify({ r: r.results, w: w.map(e => [e.method, e.applied]), toasts: A.toasts, row: t.get(W[0]) }));
    }
    // (h) E7's savedMoved, the same rule: A's lost PATCH (landed), B's revert; A's push re-read (held) confirms the revert
    // as the screen's own copy ("mirror": the restore A tapped meanwhile shows that data); the restore is refused —
    // putting A's lost write back would send it over the revert
    {
      const { t, A, B } = await twoSessions();
      t.control.fail({ method: "PATCH", week: W[1], kind: "throw-after" }); t.control.fail({ method: "GET", week: W[1], kind: "throw" });
      A.edit(W[1], w => (w.dayCall = "a-edit", w)); await A.engine.push();
      const x1 = clone(t.get(W[1]).data);
      await B.engine.pull(); B.edit(W[1], w => (w.dayCall = "s2", w)); await B.engine.push();   // B reverts W2 (v5): back to the data A knew
      const setup = x1.dayCall === "a-edit" && t.get(W[1]).data.dayCall === "s2" && t.get(W[1]).version === 5 && A.engine.pending().join() === W[1];
      const hold = t.control.pause({ method: "GET", week: W[1], count: 1 });
      const pp = A.engine.push(); await hold.arrived;                      // A's push re-reads W2 (held)
      const SNAP = clone(A.engine.knownSchedule());                        // a snapshot: the weeks as A knew them (W2 = s2)
      const before = clone(A.mirror); A.mirror = clone(SNAP);
      const cp = A.engine.authoritative(clone(SNAP), true, "restore", undefined, { before });
      A.token = null;                                                      // signed out elsewhere: the restore is refused when its turn comes
      hold.release();
      const r = await cp; await pp; await A.engine.idle();
      const mid = { shown: A.mirror[W[1]].dayCall, conflicts: A.st().conflicts.map(c => c.k) };
      t.control.users.TOK_A2 = "user-a"; A.token = "TOK_A2"; const from = t.log.length;   // signed in again
      await A.engine.pull(); await A.engine.idle(); await A.engine.idle();
      const res = { setup, r: r.error, mid, row: t.get(W[1]), ws: ws(t, from), toasts: A.toasts, pending: A.engine.pending() };
      check("SE86 H1 (h) E7's savedMoved: A's lost PATCH (landed), a peer's revert — then, A's push re-read confirming that revert as the copy the restore A tapped shows, the restore REFUSED (signed out): A's lost write is NOT put back over the revert (that is someone else's change since the tap, not the data A knew) — their copy shown, the conflict told in the refusal's message; and once signed in again nothing is re-sent: the revert stands",
        setup && /changed by someone else/.test(String(r.error || "")) && mid.shown === "s2" && mid.conflicts.join() === W[1] && res.row.data.dayCall === "s2" && res.row.version === 5
          && !res.ws.some(w => w.startsWith("PATCH")) && res.pending.length === 0, JSON.stringify(res));
    }
    // (i) H3 the clear-elsewhere case (p2b): A's new week's INSERT lands, its answer and read-back lost; B clears
    {
      const t = mkTable(seedRows(3));
      const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
      await A.engine.load(); await B.engine.load();
      t.control.fail({ method: "POST", week: W[7], kind: "throw-after" }); t.control.fail({ method: "GET", week: W[7], kind: "throw" });
      A.edit(W[7], () => wk("s3")); await A.engine.push();
      const setup = !!t.get(W[7]) && A.engine.pending().join() === W[7];
      await B.engine.pull(); B.mirror = {};
      const c = await B.engine.authoritative({}, true, "clear");
      const cleared = c.ok && t.rows().length === 0, toasts0 = A.toasts.length, from = t.log.length;
      await A.engine.pull(); await A.engine.idle();
      const first = A.toasts.slice(toasts0);
      await A.engine.pull(); await A.engine.idle(); A.engine.push(); await A.engine.idle(); await A.engine.pull(); await A.engine.idle();   // later pulls and pushes: nothing more
      const all = A.toasts.slice(toasts0);
      const res = { setup, cleared, rows: t.rows().map(r => r.week_monday), ws: ws(t, from), first, all, pending: A.engine.pending() };
      check("SE86 H3 (i) (p2b) A's new week: its INSERT landed, the answer and read-back lost; another device CLEARS the schedule; A reconnects: the re-read finds no row — the week is sent again (one POST: the user's own intended week) and told, in ONE message: '" + RESENT(W[7]) + "'",
        setup && cleared && res.rows.join() === W[7] && res.ws.filter(w => w.startsWith("POST")).length === 1 && first.length === 1 && first[0] === RESENT(W[7]) && res.pending.length === 0, JSON.stringify(res));
      check("SE86 H3 (i) …told EXACTLY once: later pulls and pushes say nothing more",
        all.length === 1 && resentTold(all, W[7]) === 1, JSON.stringify(res));
    }
    // (j) controls: an INSERT whose answer arrives; one answered 5xx whose read-back found no row (it didn't land)
    {
      const t = mkTable(seedRows(2));
      const A = mkSession(t); await A.engine.load();
      A.edit(W[6], () => wk("new6")); const r1 = await A.engine.push();
      t.control.fail({ method: "POST", week: W[7], kind: "5xx-before" });
      A.edit(W[7], () => wk("new7")); const r2 = await A.engine.push();       // 503, read back: no row → pending
      const mid = A.engine.pending().join();
      await A.engine.pull(); await A.engine.idle();                          // the retry lands
      check("SE86 H3 (j) control: an ordinary INSERT whose answer arrives says nothing; nor does one answered 503 whose read-back found no row (it didn't land — nothing anyone could have deleted) when its retry lands",
        r1.ok && t.get(W[6]).data.dayCall === "new6" && !r2.ok && mid === W[7] && t.get(W[7]).data.dayCall === "new7" && A.engine.pending().length === 0 && A.toasts.every(m => !/saved again/.test(m)),
        JSON.stringify({ r1: r1.ok, r2: r2.results, mid, toasts: A.toasts, pending: A.engine.pending() }));
    }
    // (k) the re-read itself fails: nothing told, nothing sent; once it works, told once
    {
      const t = mkTable(seedRows(3));
      const A = mkSession(t); await A.engine.load();
      t.control.fail({ method: "POST", week: W[7], kind: "throw-after" }); t.control.fail({ method: "GET", week: W[7], kind: "throw" });
      A.edit(W[7], () => wk("s3")); await A.engine.push();
      t.del(W[7]);                                                           // deleted elsewhere
      t.control.fail({ method: "GET", week: W[7], kind: "5xx-before" });
      const toasts0 = A.toasts.length, from = t.log.length;
      A.engine.push(); await A.engine.idle();                                // the re-read fails
      const whileFailing = { toasts: A.toasts.slice(toasts0), posts: writes(t, from).filter(e => e.method === "POST").length, pending: A.engine.pending().join() };
      A.engine.push(); await A.engine.idle();                                // it works now
      const later = A.toasts.slice(toasts0);
      check("SE86 H3 (k) …a re-read that simply FAILS says nothing and sends nothing (the outcome still unknown); once a re-read works and finds no row: sent again, told once",
        whileFailing.toasts.every(m => !/saved again/.test(m)) && whileFailing.posts === 0 && whileFailing.pending === W[7] && !!t.get(W[7]) && resentTold(later, W[7]) === 1 && A.engine.pending().length === 0,
        JSON.stringify({ whileFailing, later, pending: A.engine.pending() }));
    }
  });

  // SE67b — review r2 tests-2 (E4, M69) on the app's path, WITH `before`
  // (17/n P2 always passes it): a week edited AFTER the tap — while a clear's
  // or a restore's whole-table read is out, or while a clear waits for its
  // turn and is cancelled at its deadline — keeps the edit, which is pushed;
  // only the weeks still showing the job's target are put back as they were.
  await run("SE67b", async () => {
    for (const what of ["clear", "restore"]) {
      const t = mkTable(seedRows(4));
      const A = mkSession(t); await A.engine.load();
      const before = clone(A.mirror);
      const target = what === "clear" ? {} : W.slice(0, 4).reduce((o, k) => (o[k] = wk("snap"), o), {});
      A.mirror = clone(target);                                         // commitSchedule(target)
      t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before" });
      const hold = t.control.pause({ method: "GET", week: "limit=5000", count: 1 });
      const cp = A.engine.authoritative(clone(target), true, what, undefined, { before }); await hold.arrived;
      A.edit(W[1], () => wk("after-tap"));                              // edited AFTER the tap, while the job's read is out
      hold.release();
      const r = await cp;
      const shown = A.mirror[W[1]] && A.mirror[W[1]].dayCall, others = [0, 2, 3].map(i => A.mirror[W[i]] && A.mirror[W[i]].dayCall);
      await A.engine.idle(); await A.engine.idle();
      check(`SE67b (${what}, with before) a ${what} refused (its read failed) keeps a week edited AFTER the tap — on screen, then saved by the follow-up push (one PATCH); the other weeks are put back as they were before the tap`,
        r.ok === false && r.wrote === false && shown === "after-tap" && others.every((c, j) => c === before[W[[0, 2, 3][j]]].dayCall) && t.get(W[1]).data.dayCall === "after-tap"
          && writes(t).length === 1 && writes(t)[0].method === "PATCH" && Object.keys(A.mirror).length === 4 && A.engine.pending().length === 0,
        JSON.stringify({ r, shown, others, table: t.get(W[1]).data.dayCall, w: writes(t).map(e => e.method) }));
    }
    const t2 = mkTable(seedRows(4));
    const B = mkSession(t2, { timeouts: shortT }); await B.engine.load();
    const hang = t2.control.pause({ method: "GET", count: 1 });           // the pull's version list never answers: the chain is stuck
    const pl = B.engine.pull(); await hang.arrived;
    const before = clone(B.mirror); B.mirror = {};
    const cp = B.engine.authoritative({}, true, "clear", undefined, { before });
    B.edit(W[1], () => wk("after-tap"));                                // edited while the clear waits for its turn
    const r = await Promise.race([cp, sleep(600).then(() => "no answer")]);
    const shown = B.mirror[W[1]] && B.mirror[W[1]].dayCall, n = Object.keys(B.mirror).length;
    hang.release(); await pl; await B.engine.idle(); await B.engine.idle(); await sleep(5); await B.engine.idle();
    check("SE67b (deadline, with before) a clear cancelled at its deadline keeps a week edited after the tap (the others back as they were); once the chain moves, the edit is saved and nothing is deleted",
      r !== "no answer" && r.reason === "timeout" && r.wrote === false && shown === "after-tap" && n === 4 && t2.get(W[1]).data.dayCall === "after-tap" && t2.rows().length === 4
        && !writes(t2).some(e => e.method === "DELETE") && B.engine.pending().length === 0,
      JSON.stringify({ r, shown, n, table: t2.get(W[1]).data.dayCall, w: writes(t2).map(e => e.method) }));
  });

  // SE76c — review r2 tests-3 (E4): a local DELETE pending from before the
  // tap (its DELETE threw, and its read-back) and then a clear whose read
  // fails: the screen is back as it was — the removed week stays OFF it and
  // pending (never put back from what the table holds) — and the follow-up
  // push deletes it.
  await run("SE76c", async () => {
    const t = mkTable(seedRows(4));
    const A = mkSession(t); await A.engine.load();
    t.control.fail({ method: "DELETE", week: W[3], kind: "throw" });
    t.control.fail({ method: "GET", week: W[3], kind: "throw" });
    A.drop(W[3]); await A.engine.push();                                // the user removed W4: pending
    const setup = A.engine.pending().join() === W[3] && !!t.get(W[3]) && !(W[3] in A.mirror);
    const before = clone(A.mirror); A.mirror = {};
    t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before" });
    const c = await A.engine.authoritative({}, true, "clear", undefined, { before });
    const shownAfter = W[3] in A.mirror, pendAfter = A.engine.pending().join(), nShown = Object.keys(A.mirror).length;
    await A.engine.idle(); await A.engine.idle();
    check("SE76c E4 a clear refused (its read failed) with a local DELETE pending from before the tap: the removed week stays OFF the screen and pending, the other weeks come back — and the follow-up push deletes it",
      setup && c.ok === false && c.wrote === false && !shownAfter && nShown === 3 && pendAfter === W[3] && !t.get(W[3]) && t.rows().length === 3 && A.engine.pending().length === 0,
      JSON.stringify({ setup, c, shownAfter, nShown, pendAfter, rows: t.rows().map(r => r.week_monday), pendingNow: A.engine.pending() }));
  });

  // SE74b — review r2 tests-6 (E2): the token marked dead is the one the
  // read was SENT with. A pull's read goes out with TOK_A, "Sign in again"
  // stores TOK_A2 while it is out, then the server refuses TOK_A: the new
  // token isn't marked dead — no sign-in line, writes not blocked: the next
  // edit lands under TOK_A2.
  await run("SE74b", async () => {
    const t = mkTable(seedRows(3));
    const A = mkSession(t); await A.engine.load();
    t.control.expiredTokens.add("TOK_A");
    const hold = t.control.pause({ method: "GET", count: 1 });
    const p = A.engine.pull(); await hold.arrived;                      // the version list, sent with TOK_A
    t.control.users.TOK_A2 = "user-a"; A.token = "TOK_A2";              // "Sign in again" stores a new token while it is out
    hold.release(); await p; await A.engine.idle();
    const after = { blocked: A.engine.authBlocked(), auth: A.st().auth, authNeeded: A.last().authNeeded, line: kindOfLine(A.last()) };
    const sentWith = (t.log.find(e => e.method === "GET" && e.status === 401) || { headers: {} }).headers.authorization;
    A.edit(W[0], w => (w.dayCall = "after-sign-in", w));
    const from = t.log.length; const r = await A.engine.push();
    const ws = writes(t, from);
    check("SE74b E2 a read SENT with the old token and refused after a new token was stored marks the OLD token dead, not the new one: no sign-in line, writes not blocked — the next edit lands under the new token",
      sentWith === "Bearer TOK_A" && !after.blocked && after.auth === "ok" && after.authNeeded === false && after.line !== "auth" && r.ok === true && ws.length === 1 && ws[0].headers.authorization === "Bearer TOK_A2" && t.get(W[0]).data.dayCall === "after-sign-in",
      JSON.stringify({ sentWith, after, r: r.results, ws: ws.map(e => e.method + " " + e.headers.authorization + " " + e.status) }));
  });

  // SE73b — review r2 tests-7 (E1, 16/n deviation 1): a push whose re-read
  // ADOPTS someone else's copy of an unconfirmed week, while a publish of
  // another week is requested meanwhile, stops for the publish (E1) — and
  // still tells that conflict: one "changed by someone else" toast, their
  // copy shown, a conflicts entry; the publish lands.
  await run("SE73b", async () => {
    const t = mkTable(seedRows(5));
    const A = mkSession(t), B = mkSession(t, { token: "TOK_B", user: "user-b" });
    await A.engine.load(); await B.engine.load();
    const setup = await unconfirmedW0(t, A);                            // A's edit of W1 unconfirmed
    B.edit(W[0], w => (w.dayCall = "theirs", w)); await B.engine.push();
    const hold = t.control.pause({ method: "GET", week: W[0], count: 1 });
    const P = A.engine.push(); await hold.arrived;                      // A's push in its re-read of W1
    A.mirror = Object.assign({}, A.mirror, { [W[6]]: wk("pub") });
    const J = A.engine.authoritative(clone(A.mirror), false, "publish", [W[6]]);   // a publish (of another week) requested meanwhile
    hold.release();
    const pr = await P, jr = await J; await A.engine.idle(); await A.engine.idle();
    check("SE73b E1 a conflict the push's re-read adopts is TOLD although the push then stops for the publish requested meanwhile: their copy shown, ONE 'changed by someone else' toast, a conflicts entry; the publish lands",
      setup && pr.skipped === "authoritative-queued" && A.mirror[W[0]].dayCall === "theirs" && t.get(W[0]).data.dayCall === "theirs" && theirsTold(A.toasts) === 1
        && A.st().conflicts.map(c => c.k).join() === W[0] && jr.ok === true && !!t.get(W[6]) && t.get(W[6]).data.dayCall === "pub" && A.engine.pending().length === 0,
      JSON.stringify({ setup, pr: { skipped: pr.skipped, results: pr.results }, toasts: A.toasts, shown: A.mirror[W[0]].dayCall, jr: jr.ok }));
  });

  // SE-I — no scenario above produced an internal error, a caught callback
  // error, or console output from the engine (A17(c)).
  check("SE-I no internal (non-network) error, no caught callback error, and no console output from the engine in any scenario",
    internal.length === 0 && caught.length === 0 && engineConsole.length === 0, internal.concat(caught, engineConsole).slice(0, 3).join(" | "));
}

// ══ SE-X. The app's code around the engine, EXECUTED (A17(b)) ══
// The REAL component slices — undoLastChange, the unload handler (hide /
// pagehide / beforeunload), the schedule load effect, both swaps, trade
// accept, the week editor's save, Accept & Publish — sliced from
// index-source.html by their anchors and run in a FRESH context (a free
// identifier throws), wired to the app's OWN engine construction (the bridge
// through createSchedSync({…}), so the engine's toasts, internal errors and
// logs go where the app sends them), the real engine, the emulated table, and
// helpers.js / config.js's real helpers. Every request, toast, console.error
// and caught callback error is recorded; each run fails on an unexpected one
// (SE-X-I) and carries a positive control proving the write it expects. The
// battery's `app` mutants (X1–X10) are killed here.
let HELPERS = null;
const appHelpers = () => {
  if (HELPERS) return HELPERS;
  const g = { console: { log() {}, warn() {}, error() {}, info() {} }, window: {}, document: undefined, navigator: { userAgent: "node-test" }, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, fetch: () => { throw new Error("the helpers' context has no network"); } };
  g.globalThis = g;
  vm.createContext(g);
  for (const f of ["helpers.js", "config.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), g, { filename: f });
  HELPERS = vm.runInContext("({ fmt, parse, addD, shiftStartDate, SHIFT_LABELS, swapMsg, cascadeMsg, tradeAcceptMsg, tradeDeclineMsg, MO, payloadLooksWiped })", g);
  return HELPERS;
};

async function appScenarios(src, createSchedSync, mergeEditorEdits, check) {
  const nsrc = src.replace(/\r\n/g, "\n");
  // The text after `start` (exactly one occurrence) up to the first `end` after it.
  const after = (start, end) => { const i = nsrc.indexOf(start); if (i < 0 || nsrc.indexOf(start, i + 1) !== -1) return null; const e = nsrc.indexOf(end, i + start.length); return e < 0 ? null : nsrc.slice(i + start.length, e); };
  const xcon = []; // app code that reaches the context's global console (it named `console` freely)
  const xctx = vm.createContext({ console: recConsole(xcon) });
  const fnX = (names, code) => { if (code === null) return null; try { return vm.runInContext(`(function (env) { const { ${names} } = env; return (${code}); })`, xctx); } catch (ex) { return null; } };
  const wrap = (head, body, tail) => (body === null ? null : head + body + tail);
  // (20/n, review r3 regress-3) The session's identity for a slice that checks it (sessionEpochRef): the env's, or
  // the app session's own — the one its schedSyncRef carries (mkApp), which that session's boundary (bEnv) moves —
  // or, with neither, a private one (no boundary is crossed under it). And the setup's baseline (setupBaseRef,
  // review r3 G7): the env's (a component's), or a private one.
  const sess = (mk) => (mk ? (env) => mk(Object.assign({}, env, {
    sessionEpochRef: env.sessionEpochRef || (env.schedSyncRef && env.schedSyncRef.sessionEpochRef) || { current: 0 },
    setupBaseRef: env.setupBaseRef || { current: null } })) : mk);
  const HX = appHelpers();
  const F = {
    wire: fnX("isPublicMode, userProfile, showToast, setEditWeekModal, swapSuggestions, swapTarget, setSwapSuggestions, setSwapTarget, schedSyncBridgeRef, useRef, createSchedSync, scheduleRef, commitSchedule, fetch, SUPABASE_URL, dbAuthHeaders, dbReadHeaders, dbHeaders, auth, setSchedSync, console",
      wrap("(() => { schedSyncBridgeRef.current = { canWrite:", after("  schedSyncBridgeRef.current = { canWrite:", "\n\n  // The edit gates"), "\n  return schedSyncRef; })()")),
    gate: fnX("schedSyncRef, showToast, setReauthNeeded", wrap("", after("  const schedEditable = ", "\n  };\n"), "\n  }")),
    pushUndo: fnX("scheduleRef, schedSyncRef, setScheduleHistory", wrap("(counts) => {", after("  const pushUndo = useCallback((counts) => {", "\n  }, []);"), "\n  }")),
    update: fnX("scheduleRef, commitSchedule", wrap("(fn) => {", after("  const updateSchedule = useCallback((fn) => {", "\n  }, [commitSchedule]);"), "\n  }")),
    undo: fnX("scheduleHistory, schedEditable, schedSyncRef, showToast, commitSchedule, setPriorCounts, setYear1Counts, setScheduleHistory", wrap("() => {", after("  const undoLastChange = () => {", "\n  };\n"), "\n  }")),
    unload: fnX("isPublicMode, dayOffDirtyRef, dayOffSaveTimerRef, clearTimeout, dayOffEnqueueRef, console, schedSyncRef, fetch, document, window",
      wrap("() => {\n    // (The blob keepalive is gone", after("  useEffect(() => {\n    // (The blob keepalive is gone", "\n  }, []);"), "\n  }")),
    load: fnX("loadFailedRef, supabase, lastSyncRef, setupReadRef, setSurgeons, setApps, USE_TIME_OFF, setVacations, setNoCallDays, setBackupMondaySet, setFierceBackupSet, setAppShifts, setPriorCounts, setYear1Counts, setStartMonth, setStartYear, setNumWeeks, setStartMondayOverride, setHolidayAssignments, setPendingLocks, setSilvisRule, sfRule, setDismissedWarnings, everHadRealDataRef, setEdgeFunctionUrl, console, setAppShiftsLoaded, appOffVisible, adoptDayOffRow, db, setVacRequests, setTradeRequests, setNotifications, showToast, schedSyncRef, scheduleRef, loadTimeOff, loadSilvisFeed, refreshSilvisFeed, setLoaded, loadedAtRef, getSupabaseRT, window, setTimeout, setInterval, clearInterval",
      wrap("() => {", after("  // ─── Supabase: Load on mount + real-time sync ───\n  useEffect(() => {", "\n  }, [reloadTrigger]);"), "\n  }")),
    swapOne: fnX("fmt, shiftStartDate, swapMsg, SHIFT_LABELS, schedEditable, schedule, scheduleRef, showToast, silvisActive, silvisBlock, silvisRefuse, pushUndo, updateSchedule, surgeons, setEditShift, setEditingWeek, setSwapSuggestions, setSwapTarget, sMap, schedulerAdminIds, addNotification, sendEmailNotif",
      wrap("", after("  const swapShift = ", "\n  };\n"), "\n  }")),
    swapTwo: fnX("fmt, shiftStartDate, swapMsg, SHIFT_LABELS, schedEditable, schedule, scheduleRef, showToast, silvisActive, silvisBlock, silvisRefuse, pushUndo, updateSchedule, surgeons, setEditShift, setEditingWeek, setSwapSuggestions, setSwapTarget, sMap, schedulerAdminIds, addNotification, sendEmailNotif",
      wrap("", after("  const executeTwoWaySwap = useCallback(", "\n  }, [surgeons, sMap, addNotification, sendEmailNotif, schedulerAdminIds, silvisActive, silvisBlock, silvisRefuse]);"), "\n  }")),
    accept: sess(fnX("fmt, shiftStartDate, showToast, schedEditable, scheduleRef, detectCascadeChanges, surgeons, silvisActive, silvisBlock, silvisRefuse, confirm, fetch, SUPABASE_URL, dbAuthHeaders, console, setTradeRequests, tradeAcceptMsg, logAudit, pushUndo, updateSchedule, addNotification, sendEmailNotif, SHIFT_LABELS, schedulerAdminIds, cascadeMsg, schedule, sessionEpochRef",
      wrap("async (req) => {", after("  const acceptTradeRequest = useCallback(async (req) => {", "\n  }, [schedule, surgeons, pushUndo, addNotification, sendEmailNotif, detectCascadeChanges, schedulerAdminIds, silvisActive, silvisBlock, silvisRefuse]);"), "\n  }"))),
    cascades: fnX("surgeons, SHIFT_LABELS", wrap("(sched, req) => {", after("  const detectCascadeChanges = useCallback((sched, req) => {", "\n  }, [surgeons]);"), "\n  }")),
    openEditor: fnX("scheduleRef, parse, addD, fmt, appShifts, appShiftsLoaded, setEditWeekModal, schedSyncRef", wrap("(mondayStr) => {", after("  const openWeekEditor = useCallback((mondayStr) => {", "\n  }, [appShifts, appShiftsLoaded]);"), "\n  }")),
    saveEditor: fnX("editWeekModal, schedule, appShifts, appShiftsLoaded, openWeekEditor, setEditWeekModal, silvisActive, silvisFakId, silvisDays, silvisBlock, silvisRefuse, sfSlotDays, confirm, pushUndo, updateSchedule, scheduleRef, schedEditable, schedSyncRef, mergeEditorEdits, SHIFT_LABELS, backupMondaySet, fierceBackupSet, surgeons, showToast, APP_SHIFTS_NOT_LOADED, setAppShifts, saveAppShifts, logAudit, nameOf, aMap, sMap, schedulerAdminIds, addNotification, sendEmailNotif, setTimeout",
      wrap("(openAfter) => {", after("  const saveWeekEdits = useCallback((openAfter) => {", "\n  }, [editWeekModal,"), "\n  }")),
    acceptPreview: sess(fnX("publishSearchRunning, showToast, cancelSearch, previewSchedule, previewNeedsOk, previewAck, publishingRef, schedEditable, schedSyncRef, previewEpochRef, previewOrigin, startMonth, startYear, numWeeks, setPublishing, setSaveStatus, snapshots, previewSchedRef, publishWeeks, MO, runPublish, setPreviewSchedule, setShowPreview, setCalMonth, setCalYear, setView, setTimeout, publishNotLanded, sessionEpochRef",
      wrap("async () => {", after("  const acceptPreview = async () => {", "\n  };\n"), "\n  }"))),
    notLanded: fnX("showToast", wrap("(pr, what) => {", after("  const publishNotLanded = (pr, what) => {", "\n  };\n"), "\n  }")),
    runPublish: fnX("schedSyncRef", after("  const runPublish = ", ";\n")),
  };
  const missing = Object.keys(F).filter(k => typeof F[k] !== "function");
  check("SE-X the component slices are extractable by their anchors and compile in a fresh context", missing.length === 0, missing.join(", "));
  if (missing.length) return;
  // 17/n (review r1's app items P1–P6, T4): more of the component, sliced the same way — by `const X = …` anchors that
  // don't name a signature, so the very same slices also run on the code BEFORE 17/n (the two-sided runs). Each
  // scenario checks the ones it runs (a slice missing fails that scenario only).
  const decl = (name, end) => wrap("", after(`  const ${name} = `, end), "\n  }");
  const G = {
    // the mirror's ONE writer (P1: it asks the engine to report)
    commit: fnX("scheduleRef, setSchedule, schedSyncRef", after("  const commitSchedule = useCallback(", ", []);\n")),
    // the weeks push effect (its 800-ms debounce)
    pushFx: fnX("loaded, isPublicMode, schedSyncRef, setTimeout, clearTimeout", wrap("() => {", after("  // for edits (the pull and the authoritative jobs request their own).\n  useEffect(() => {", "\n  }, [loaded, schedule]);"), "\n  }")),
    // the session boundary + sign-out, and the re-auth that can land on another account (P4)
    boundary: sess(fnX("searchRef, setSearching, setSearchStats, setPreviewSchedule, setShowPreview, schedSyncRef, setScheduleHistory, setEditWeekModal, setReauthNeeded, setStaleTokenWarn, setIsScheduler, setupReadRef, lastSyncRef, confirm, auth, biometric, setAuthUser, setUserProfile, setNeedsProfile, setMySurgeon, setBiometricEnrolled, setBiometricPending, sessionEpochRef",
      wrap("(() => { const sessionBoundary = () => {", after("  const sessionBoundary = () => {", "\n  // ════"), "\n  return { sessionBoundary, handleSignOut }; })()"))),
    reauth: fnX("schedSyncRef, authUser, setReauthNeeded, setStaleTokenWarn, showToast, sessionBoundary, biometric, setBiometricEnrolled, setBiometricPending, setAuthUser, dbAuth, setUserProfile, setMySurgeon, setNeedsProfile, setIsScheduler, setReloadTrigger, pendingSaveRef, setSetupSaveNudge, auth",
      decl("reauthLanded", "\n  };\n")),
    // the setup autosave effect and the edge-URL save effect (P4), and the bundle they write — with the latest-render ref (P5)
    autosave: fnX("loaded, isPublicMode, loadedAtRef, loadFailedRef, setSaveError, setSaveStatus, setupReadRef, auth, buildStateBundle, pendingSaveRef, payloadLooksWiped, everHadRealDataRef, setTimeout, clearTimeout, allowWipeSaveRef, canWriteBlob, supabase, lastSyncRef, showToast, console, setReauthNeeded, setupBaseRef, setupSig",
      wrap("() => {", after("  // ─── Supabase: Auto-save on changes ───\n  useEffect(() => {", "\n  }, [loaded, surgeons, apps,"), "\n  }")),
    urlSave: fnX("loaded, isPublicMode, loadFailedRef, edgeFunctionUrl, canWriteBlob, setupReadRef, setTimeout, clearTimeout, supabase, showToast, console",
      wrap("() => {", after("  // ─── Supabase: Save edge function URL ───\n  useEffect(() => {", "\n  }, [loaded, edgeFunctionUrl, canWriteBlob]);"), "\n  }")),
    bundle: fnX("surgeons, apps, vacations, noCallDays, backupMondaySet, fierceBackupSet, schedule, priorCounts, year1Counts, startMonth, startYear, numWeeks, holidayAssignments, startMondayOverride, pendingLocks, silvisRule, dismissedWarnings, useRef",
      wrap("(() => { const buildStateBundle = (overrides = {}) => ({", after("  const buildStateBundle = (overrides = {}) => ({", "\n\n  // Mirrors the DB predicate"), "\n  return buildStateBundle; })()")),
    // clear / factory reset / restore and their helper (P2, P3, P5, P6); Generate & Publish's commit (P6)
    runAuth: fnX("schedSyncRef, setScheduleHistory", decl("runAuthoritativeSchedule", "\n  };\n")),
    clear: sess(fnX("schedEditable, confirm, snapshots, schedSyncRef, showToast, scheduleRef, pushUndo, commitSchedule, setSaveStatus, runAuthoritativeSchedule, setTimeout, lastSyncRef, buildStateBundle, stateBundleRef, setupReadRef, auth, supabase, console, sessionEpochRef, setupBaseRef",
      decl("clearSchedule", "\n  };\n\n  // ─── Snapshot restore"))),
    reset: sess(fnX("isScheduler, userProfile, alert, schedEditable, prompt, setSaveStatus, setTimeout, snapshots, schedSyncRef, showToast, logAudit, allowWipeSaveRef, everHadRealDataRef, supabase, console, setSurgeons, INIT_SURGEONS, setApps, INIT_APPS, toClearAll, setBackupMondaySet, setFierceBackupSet, scheduleRef, commitSchedule, runAuthoritativeSchedule, setAppShifts, setPriorCounts, setYear1Counts, setStartMonth, setStartYear, sessionEpochRef",
      decl("resetAllData", "\n  };\n\n  // ─── Push Notifications"))),
    restore: sess(fnX("schedEditable, isScheduler, userProfile, setRestoreBusyId, setSaveStatus, snapshots, scheduleRef, pushUndo, commitSchedule, runAuthoritativeSchedule, schedSyncRef, confirm, snapshotReasonLabel, showToast, setSurgeons, setApps, setBackupMondaySet, setFierceBackupSet, setAppShifts, setPriorCounts, setYear1Counts, setStartMonth, setStartYear, setNumWeeks, setStartMondayOverride, setHolidayAssignments, setPendingLocks, setSilvisRule, sfRule, SF_RULE_DEFAULT, setDismissedWarnings, lastSyncRef, everHadRealDataRef, logAudit, loadSnapshots, setTimeout, alert, sessionEpochRef",
      wrap("(() => { const restoreConfirmText = ", after("  const restoreConfirmText = ", "\n  // ─── Roll forward counts"), "\n  return restoreSnapshot; })()"))),
    genCommit: sess(fnX("publishWeeks, numWeeks, MO, startMonth, startYear, runPublish, setPreviewSchedule, setShowPreview, setSaveStatus, lastSyncRef, buildStateBundle, supabase, console, showToast, setTimeout, publishNotLanded, sessionEpochRef",
      wrap("async (result) => {", after("  const commitGenerated = async (result) => {", "\n  };\n  genFinishRef.current = finishGenerate;"), "\n  }"))),
    // Generate & Publish's end (after its search) and its click — as sync-guards AH9 runs them (19/n P7: the job gate)
    finish: sess(fnX("pendingLocks, nameOf, slotLabel, showToast, setPreviewSchedule, setPreviewOrigin, setShowPreview, genInputsSig, listScheduleBends, surgeons, mondays, buildGenAvailability, buildSilvisPrimary, vacations, holidayAssignments, buildPrevWeekSeed, publishingRef, setPublishing, setSaveStatus, snapshots, genCommitRef, previewEpochRef, schedEditable, schedSyncRef, sessionEpochRef",
      decl("finishGenerate", "\n  };\n"))),
    // (20/n) Generate & Publish's notice and e-mail (doGenerateAndNotify), and the setup's signature (setupSig — review r3 G7)
    notify: sess(fnX("sessionEpochRef, doGenerate, addNotification, sendEmailNotif, MO, startMonth, endMoIdx, startYear", decl("doGenerateAndNotify", "\n  };\n"))),
    setupSig: fnX("", after("  const setupSig = ", ";\n")),
    gen: fnX("searchRef, showToast, schedEditable, schedSyncRef, buildPrefs", decl("doGenerate", "\n  };\n")), // (only its first statements are reached here: the gates, then buildPrefs)
    // (21/n) the trade's decline, and the notice paths (addNotification, sendPushNotif, sendEmailNotif) — review r4 branch-2 / fixes-3
    decline: sess(fnX("fetch, SUPABASE_URL, dbAuthHeaders, console, showToast, setTradeRequests, tradeDeclineMsg, logAudit, addNotification, sendEmailNotif, sessionEpochRef",
      wrap("async (req) => {", after("  const declineTradeRequest = useCallback(async (req) => {", "\n  }, [addNotification, sendEmailNotif]);"), "\n  }"))),
    addNote: sess(fnX("db, showToast, setNotifications, buildDeepLink, filterPushTargetsByType, sendPushNotif, console, sessionEpochRef",
      after("  const addNotification = useCallback(", ", [sendPushNotif, buildDeepLink, filterPushTargetsByType]);"))),
    pushNote: sess(fnX("edgeFunctionUrl, fetch, dbAuthHeaders, console, showToast, sessionEpochRef", after("  const sendPushNotif = useCallback(", ", [edgeFunctionUrl]);"))),
    // (21/n) "Sign in again" (reauthForSync) and the listener for another tab's change of the stored session (review r4 branch-4)
    raSync: fnX("reauthBusy, setReauthBusy, auth, reauthLanded, authUser, setReauthPassword, setReauthError, setReauthSheet", decl("reauthForSync", "\n  };\n")),
    storageFx: fnX("authUser, window, schedSyncRef, auth, setReauthNeeded", wrap("() => {\n    if (!authUser) return;\n    const onStorage = (e) => {", after("    const onStorage = (e) => {", "\n  }, [authUser]);"), "\n  }")),
    // (21/n) the sign-in form's submit and the Face ID unlock: each binds the tab to its account (review r4 branch-4)
    authSubmit: fnX("setAuthError, setAuthBusy, authMode, signupPersonId, dbAuth, auth, authEmail, authPassword, allPeople, setAuthUser, setUserProfile, setMySurgeon, setNeedsProfile, setIsScheduler, setReloadTrigger, setAuthEmail, setAuthPassword, fetch, SUPABASE_URL, dbAuthHeaders, saveNotifPref, showToast, console",
      decl("handleAuthSubmit", "\n  };\n")),
    bioUnlock: fnX("setAuthError, setAuthBusy, biometric, auth, setAuthUser, dbAuth, setUserProfile, setMySurgeon, setNeedsProfile, setBiometricPending, setReloadTrigger", decl("handleBiometricUnlock", "\n  };\n")),
    // (21/n) the time off's DELETE and its clear-all (the factory reset's third clear — review r4 fixes-2)
    delTO: sess(fnX("fetch, SUPABASE_URL, dbAuthHeaders, console, showToast, sessionEpochRef", decl("deleteTimeOff", "\n  };\n"))),
    clearTO: fnX("setVacations, setNoCallDays, logAudit, USE_TIME_OFF, deleteTimeOff", decl("toClearAll", "\n  };\n")),
    email: sess(fnX("edgeFunctionUrl, fetch, dbAuthHeaders, console, showToast, sessionEpochRef", after("  const sendEmailNotif = useCallback(", ", [edgeFunctionUrl]);"))),
    // the header: does the save-status span render (P6)?
    saveShown: fnX("saveStatus, saveError, schedLineKind", wrap("(() => { const SCHED_LINE_RED = ", after("  const SCHED_LINE_RED = ", "\n  // Clear / factory reset / restore: an authoritative"), "\n  return saveStatusShown; })()")),
  };
  const gotG = (name, keys) => { const miss = keys.filter(k => typeof G[k] !== "function"); if (miss.length) check(name + " — the component slices it runs are extractable", false, miss.join(", ")); return miss.length === 0; };
  const lineX = extractLine(src); // the header's ONE line (module scope) — from this source (an app mutant's, too)
  const LV = (st) => { const l = lineX && st ? lineX(st, { loaded: true, readOnly: false, blobStatus: false }) : null; return l ? l.kind + ":" + l.n : "none"; };

  // ── fixtures ──
  const X = ["2030-01-07", "2030-01-14", "2030-01-21", "2030-01-28"], XNEW = "2030-02-11";
  const wkX = (dc, n, off) => ({ dayCall: dc, nights: { mon: n[0], tue: n[1], wed: n[2], thu: n[3], wknd: n[4] }, off: off || "s7" });
  // (X0–X2: the trade fixture of sync-guards SE-K — this trade cascades both Tue nights)
  const ROWS = () => [wkX("s1", ["s3", "s2", "s4", "s5", "s6"]), wkX("s2", ["s4", "s1", "s3", "s5", "s6"]), wkX("s5", ["s1", "s2", "s3", "s4", "s6"]), wkX("s6", ["s1", "s2", "s3", "s4", "s5"])]
    .map((data, i) => ({ week_monday: X[i], data, version: 3, updated_by: "s1", updated_at: "2026-10-01T08:00:00.000Z" }));
  const S7 = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"].map((name, i) => ({ id: "s" + (i + 1), name }));
  const S7MAP = S7.reduce((m, s) => (m[s.id] = s, m), {});
  let xms = Date.UTC(2026, 9, 14, 12, 0, 0);
  const mkT = () => createFakeWeeksTable({ baseUrl: BASE, anonKey: "ANON", users: { TOK_A: "user-a", TOK_B: "user-b" }, rows: ROWS(), clock: () => new Date(xms += 1000).toISOString() });
  const writesOf = (t, from, tok) => t.log.slice(from || 0).filter(e => e.method !== "GET" && (!tok || e.headers.authorization === "Bearer " + tok));
  const sortDeep = (x) => Array.isArray(x) ? x.map(sortDeep) : (x && typeof x === "object") ? Object.keys(x).sort().reduce((o, k) => (o[k] = sortDeep(x[k]), o), {}) : x;
  const same = (a, b) => JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
  const tableOf = (t) => t.rows().reduce((o, r) => (o[r.week_monday] = r.data, o), {});
  const apps = [];
  // One app session: the mirror and its one writer (the REAL commitSchedule
  // — 17/n P1: it asks the engine to report; its setSchedule is recorded),
  // the undo history, ONE toast slot (the engine's onToast is the app's
  // showToast, as wired), the app's own engine construction (every status it
  // hands setSchedSync recorded, as the header's state), the stored session
  // (a.token, through config.js's auth shape), the real gate / pushUndo /
  // updateSchedule.
  const mkApp = (t, o = {}) => {
    const a = { t, token: o.token || "TOK_A", toasts: [], errors: [], warns: [], history: [], ref: { current: {} }, modal: null, sync: null, syncs: [], reauth: 0, sug: null, target: null, signOuts: 0, sessionEpochRef: { current: 0 } };
    const text = (x) => x.map(v => (v && v.stack ? String(v.message) : String(v))).join(" ");
    a.console = { error: (...x) => a.errors.push(text(x)), warn: (...x) => a.warns.push(text(x)), log: () => {}, info: () => {} };
    const engRef = { current: null };
    a.commitSchedule = G.commit ? G.commit({ scheduleRef: a.ref, setSchedule: (n) => { a.schedule = n; if (a.onSchedule) a.onSchedule(n); }, schedSyncRef: engRef }) : (n) => { a.ref.current = n; };
    a.showToast = (m, tone) => a.toasts.push([String(m), tone || "info"]);
    a.setModal = (x) => { a.modal = typeof x === "function" ? x(a.modal) : x; };
    const hdr = () => ({ apikey: "ANON", Authorization: "Bearer " + (a.token || "ANON") });
    a.auth = { getSession: () => (a.token ? { access_token: a.token } : null), signOut: async () => { a.signOuts++; a.token = null; }, bindUser: (id) => { a.bound = id; } }; // (21/n: the tab's account binding — review r4 branch-4; SE-X22 runs config.js's real one)
    if (o.cfg) a.auth = o.cfg.auth; // (21/n) a tab wired with a REAL config.js (its auth and headers, over a shared localStorage — SE-X22)
    a.bridge = { current: null };
    a.schedSyncRef = F.wire({ isPublicMode: false, userProfile: { person_id: o.person || "s1" }, showToast: a.showToast, setEditWeekModal: a.setModal,
      swapSuggestions: null, swapTarget: null, setSwapSuggestions: (v) => { a.sug = v; }, setSwapTarget: (v) => { a.target = v; },
      schedSyncBridgeRef: a.bridge, useRef: () => engRef, createSchedSync: o.timeouts ? (d) => createSchedSync(Object.assign({}, d, { timeouts: o.timeouts })) : createSchedSync, scheduleRef: a.ref, commitSchedule: a.commitSchedule, fetch: (u, i) => t.fetch(u, i), SUPABASE_URL: BASE,
      dbAuthHeaders: o.cfg ? o.cfg.dbAuthHeaders : hdr, dbReadHeaders: o.cfg ? o.cfg.dbReadHeaders : hdr, dbHeaders: o.cfg ? o.cfg.dbHeaders : { apikey: "ANON", Authorization: "Bearer ANON", "Content-Type": "application/json" },
      auth: a.auth, setSchedSync: (f) => { a.sync = typeof f === "function" ? f(a.sync) : f; a.syncs.push(a.sync); if (a.onSync) a.onSync(a.sync); }, console: a.console });
    a.eng = a.schedSyncRef.current;
    a.schedSyncRef.sessionEpochRef = a.sessionEpochRef; // (the harness: this session's identity, for every slice wired to it — sess)
    a.schedEditable = F.gate({ schedSyncRef: a.schedSyncRef, showToast: a.showToast, setReauthNeeded: () => { a.reauth++; } });
    a.setScheduleHistory = (f) => { a.history = typeof f === "function" ? f(a.history) : f; };
    a.pushUndo = F.pushUndo({ scheduleRef: a.ref, schedSyncRef: a.schedSyncRef, setScheduleHistory: a.setScheduleHistory });
    a.updateSchedule = F.update({ scheduleRef: a.ref, commitSchedule: a.commitSchedule });
    a.edit = (k, f) => a.updateSchedule(p => Object.assign({}, p, { [k]: f(JSON.parse(JSON.stringify(p[k] || {}))) }));
    a.settle = async () => { for (let i = 0; i < 4; i++) await a.eng.idle(); };
    a.unexpected = () => a.errors.concat(a.warns.filter(w => / threw /.test(w)));
    apps.push(a);
    return a;
  };
  const pair = async () => { const t = mkT(), A = mkApp(t), P = mkApp(t, { token: "TOK_B", person: "s2" }); await A.eng.load(); await P.eng.load(); return { t, A, P }; };
  const run = async (name, fn) => {
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timed out after 10 s (a request never settled)")), 10000); });
    try { await Promise.race([fn(), timeout]); }
    catch (ex) { check(name + " (scenario crashed)", false, String(ex && ex.stack || ex).split("\n").slice(0, 3).join(" | ")); }
    finally { clearTimeout(timer); }
  };

  // SE-X1 — the REAL undoLastChange (with the real pushUndo / gate): Undo is
  // all-or-nothing. Control: it reverts a landed edit by CAS. A week the Undo
  // would revert that someone else changed since the step was taken (adopted
  // by a pull) → refused whole: zero writes to it (or anything), and one toast
  // naming it. An adoption that changed nothing on screen doesn't block it.
  await run("SE-X1", async () => {
    const { t, A, P } = await pair();
    const undo = () => F.undo({ scheduleHistory: A.history, schedEditable: A.schedEditable, schedSyncRef: A.schedSyncRef, showToast: A.showToast, commitSchedule: A.commitSchedule,
      setPriorCounts: () => {}, setYear1Counts: () => {}, setScheduleHistory: A.setScheduleHistory })(); // re-rendered: it reads this render's history
    const orig = tableOf(t);
    A.pushUndo(); A.edit(X[0], w => (w.dayCall = "s7", w)); A.edit(X[1], w => (w.dayCall = "s7", w)); await A.eng.push();
    const from0 = t.log.length;
    undo(); await A.eng.push();
    const w0 = writesOf(t, from0, "TOK_A");
    check("SE-X1 the real undoLastChange, control: Undo of a landed two-week edit puts both back on the table by CAS (two PATCHes at v4), the step used up, no toast",
      w0.length === 2 && w0.every(e => e.method === "PATCH" && /version=eq\.4&updated_at=eq\./.test(e.url) && e.status === 200) && same(tableOf(t), orig) && A.history.length === 0 && A.toasts.length === 0,
      JSON.stringify({ w0: w0.map(e => e.method + " " + e.url.split("?")[1] + " " + e.status), h: A.history.length, toasts: A.toasts }));
    A.pushUndo(); A.edit(X[0], w => (w.dayCall = "s6", w)); A.edit(X[1], w => (w.dayCall = "s6", w)); await A.eng.push();
    await P.eng.pull(); P.edit(X[1], w => (w.nights.tue = "s5", w)); await P.eng.push();
    await A.eng.pull();
    const adopted = A.ref.current[X[1]].nights.tue === "s5", shown = JSON.parse(JSON.stringify(A.ref.current)), from1 = t.log.length;
    undo(); await A.eng.push(); await A.settle();
    const w1 = writesOf(t, from1, "TOK_A");
    check("SE-X1 adopt, then Undo: someone else's change to a week the Undo would revert was adopted after the step → refused WHOLE — zero writes (none to the adopted week), the screen and the step untouched, ONE toast naming that week",
      adopted && w1.length === 0 && same(A.ref.current, shown) && A.history.length === 1 && t.get(X[1]).data.nights.tue === "s5" && t.get(X[0]).data.dayCall === "s6"
        && A.toasts.length === 1 && A.toasts[0][1] === "error" && A.toasts[0][0] === `Can't undo — the week of ${X[1]} was changed by someone else since. Nothing was changed.`,
      JSON.stringify({ adopted, w1: w1.map(e => e.method + " " + e.url), toasts: A.toasts, h: A.history.length }));
    A.history = []; A.toasts.length = 0;
    A.pushUndo(); A.edit(X[0], w => (w.dayCall = "s5", w)); await A.eng.push();
    await t.oldBuild("TOK_B", "s2").upsert({ [X[3]]: JSON.parse(JSON.stringify(t.get(X[3]).data)) }); // X3 re-saved elsewhere, unchanged
    await A.eng.pull();
    const from2 = t.log.length;
    undo(); await A.eng.push();
    const w2 = writesOf(t, from2, "TOK_A");
    check("SE-X1 …an adoption that changed nothing on screen (X3 re-saved elsewhere unchanged) doesn't block it: the edit is undone (one PATCH, X1's week), zero writes to the re-saved week, no toast",
      w2.length === 1 && w2[0].url.includes(X[0]) && t.get(X[0]).data.dayCall === "s6" && A.history.length === 0 && A.toasts.length === 0,
      JSON.stringify({ w2: w2.map(e => e.method + " " + e.url), toasts: A.toasts }));
  });

  // SE-X2 — the REAL unload handler (its []-deps effect, with the real
  // engine): hide pushes through the chain (no keepalive side-write);
  // pagehide sends CAS keepalive PATCHes that land (control); after a
  // confirmed save, or a conflict, it changes 0 rows; beforeunload asks only
  // while weeks are unsaved; never an insert or a delete; nothing in a public view.
  await run("SE-X2", async () => {
    const { t, A, P } = await pair();
    const rig = (o = {}) => {
      const on = {}, ka = [];
      const doc = { hidden: false, addEventListener: (ev, f) => { on["doc:" + ev] = f; }, removeEventListener: () => {} };
      const win = { addEventListener: (ev, f) => { on["win:" + ev] = f; }, removeEventListener: () => {} };
      F.unload({ isPublicMode: !!o.pub, dayOffDirtyRef: { current: false }, dayOffSaveTimerRef: { current: null }, clearTimeout, dayOffEnqueueRef: { current: () => {} }, console: A.console,
        schedSyncRef: A.schedSyncRef, fetch: (u, i) => { const p = t.fetch(u, i); ka.push({ url: String(u), init: i, p }); return p; }, document: doc, window: win })();
      return { ka,
        hide: () => { doc.hidden = true; on["doc:visibilitychange"](); doc.hidden = false; },
        pagehide: () => on["win:pagehide"](),
        beforeunload: () => { const ev = { prevented: 0, returnValue: undefined, preventDefault() { this.prevented++; } }; on["win:beforeunload"](ev); return ev; },
        sent: async (n0) => { const xs = ka.slice(n0); await Promise.all(xs.map(x => x.p.catch(() => {}))); return xs; } };
    };
    const U = rig();
    const rowsNow = () => JSON.stringify(t.rows());
    const isKa = (x) => x.init && x.init.keepalive === true && x.init.method === "PATCH" && /version=eq\.\d+&updated_at=eq\./.test(x.url) && /return=minimal/.test(x.init.headers.Prefer || "");
    // (a) hide: through the chain
    A.edit(X[0], w => (w.dayCall = "s7", w));
    let from = t.log.length;
    U.hide(); await A.settle();
    const hideW = writesOf(t, from, "TOK_A");
    check("SE-X2 the real unload handler, HIDE (visibilitychange → hidden): no keepalive side-write — the unsaved week goes out through the engine's chain (a CAS PATCH with return=representation) and lands",
      U.ka.length === 0 && hideW.length === 1 && hideW[0].method === "PATCH" && /return=representation/.test(hideW[0].headers.prefer || "") && t.get(X[0]).data.dayCall === "s7",
      JSON.stringify({ ka: U.ka.length, w: hideW.map(e => e.method + " " + (e.headers.prefer || "")) }));
    // (b) pagehide: the CAS keepalive lands (control)
    A.edit(X[1], w => (w.dayCall = "s7", w));
    let n0 = U.ka.length; U.pagehide();
    const kb = await U.sent(n0), eb = t.log[t.log.length - 1];
    check("SE-X2 PAGEHIDE (control): one keepalive — a PATCH with keepalive:true, the CAS (version, updated_at) and return=minimal — and it changes the row (1 row)",
      kb.length === 1 && isKa(kb[0]) && eb.method === "PATCH" && eb.applied === true && t.get(X[1]).data.dayCall === "s7", JSON.stringify(kb.map(x => [x.init.method, x.init.keepalive, x.url.split("?")[1]])));
    // (c) after a confirmed save: 0 rows changed
    await A.eng.push();               // the page survived: the keepalive's body is confirmed as ours
    A.edit(X[2], w => (w.dayCall = "s7", w)); await A.eng.push();
    const before = rowsNow(); n0 = U.ka.length; U.pagehide();
    const kc = await U.sent(n0);
    check("SE-X2 …after the saves are CONFIRMED: pagehide sends nothing — 0 rows changed", kc.length === 0 && rowsNow() === before && A.eng.pending().length === 0, JSON.stringify(kc.map(x => x.url)));
    // (d) a conflict not yet seen: the keepalive's CAS matches nothing
    await P.eng.pull(); P.edit(X[3], w => (w.dayCall = "s4", w)); await P.eng.push();
    A.edit(X[3], w => (w.dayCall = "s7", w));
    const beforeD = rowsNow(); n0 = U.ka.length; U.pagehide();
    const kd = await U.sent(n0), ed = t.log[t.log.length - 1];
    check("SE-X2 …a week someone else changed meanwhile (not yet seen here): pagehide's keepalive carries this session's old CAS — 0 rows changed, their change stands",
      kd.length === 1 && isKa(kd[0]) && ed.applied === false && rowsNow() === beforeD && t.get(X[3]).data.dayCall === "s4", JSON.stringify({ kd: kd.map(x => x.url.split("?")[1]), applied: ed.applied }));
    // (e) …the conflict resolved (the page survived; the push met their copy): nothing more
    await A.eng.push();
    const resolved = A.ref.current[X[3]].dayCall === "s4" && A.toasts.length === 1 && /changed by someone else/.test(A.toasts[0][0]);
    const beforeE = rowsNow(); n0 = U.ka.length; U.pagehide();
    const ke = await U.sent(n0);
    check("SE-X2 …and after that conflict is settled (their copy shown, one toast): pagehide sends nothing — 0 rows changed", resolved && ke.length === 0 && rowsNow() === beforeE, JSON.stringify({ resolved, toasts: A.toasts, ke: ke.length }));
    // (f) beforeunload asks only while weeks are unsaved (and still sends the keepalive)
    A.edit(X[0], w => (w.nights.mon = "s7", w));
    n0 = U.ka.length; const ev1 = U.beforeunload(); const kf = await U.sent(n0);
    await A.eng.push();
    n0 = U.ka.length; const ev2 = U.beforeunload(); const kf2 = await U.sent(n0);
    check("SE-X2 BEFOREUNLOAD with a week unsaved: the browser is asked to confirm (preventDefault, returnValue '') and the keepalive goes (lands); with nothing unsaved: not asked, nothing sent",
      ev1.prevented === 1 && ev1.returnValue === "" && kf.length === 1 && isKa(kf[0]) && t.get(X[0]).data.nights.mon === "s7" && ev2.prevented === 0 && ev2.returnValue === undefined && kf2.length === 0,
      JSON.stringify({ ev1: [ev1.prevented, ev1.returnValue], kf: kf.length, ev2: [ev2.prevented, ev2.returnValue], kf2: kf2.length }));
    // (g) never an insert, never a delete
    A.edit(XNEW, () => wkX("s3", ["s1", "s2", "s4", "s5", "s6"]));
    A.updateSchedule(p => { const n = Object.assign({}, p); delete n[X[2]]; return n; });
    const beforeG = rowsNow(); n0 = U.ka.length; U.pagehide();
    const kg = await U.sent(n0);
    check("SE-X2 …a brand-new week and a deleted one: pagehide sends NO insert and NO delete (both wait for the chain) — 0 rows changed",
      kg.length === 0 && rowsNow() === beforeG && !!t.get(X[2]) && !t.get(XNEW), JSON.stringify(kg.map(x => x.init.method + " " + x.url)));
    await A.eng.push();
    // (h) a public / OR-board view: nothing, on any event
    const Pub = rig({ pub: true });
    A.edit(X[1], w => (w.nights.wed = "s7", w));
    from = t.log.length;
    Pub.hide(); Pub.pagehide(); const evp = Pub.beforeunload(); await A.settle();
    check("SE-X2 …a public / OR-board view: no keepalive, no push, never asks — on hide, pagehide or beforeunload",
      Pub.ka.length === 0 && writesOf(t, from).length === 0 && evp.prevented === 0, JSON.stringify({ ka: Pub.ka.length, w: writesOf(t, from).length }));
  });

  // SE-X3 — the REAL schedule load effect (the [reloadTrigger] effect, the
  // blob reads stubbed), the real gate: the schedule is seeded before the app
  // says it has loaded, and edits are refused until the first table read
  // succeeds; a failed read leaves the engine unloaded and the 60-s poll
  // repairs it; a second pass (sign-in) is a pull — an edit made in between
  // survives and is sent.
  await run("SE-X3", async () => {
    const rig = (a) => {
      const r = { order: [], polls: [], ever: { current: false } };
      let done; r.loaded = new Promise(res => { done = res; });
      const noop = () => {};
      const single = async () => ({ data: null, error: null });
      F.load({ loadFailedRef: { current: false }, supabase: { from: () => ({ select: () => ({ eq: () => ({ single }) }) }) }, lastSyncRef: { current: null }, setupReadRef: { current: false },
        setSurgeons: noop, setApps: noop, USE_TIME_OFF: true, setVacations: noop, setNoCallDays: noop, setBackupMondaySet: noop, setFierceBackupSet: noop, setAppShifts: noop, setPriorCounts: noop, setYear1Counts: noop,
        setStartMonth: noop, setStartYear: noop, setNumWeeks: noop, setStartMondayOverride: noop, setHolidayAssignments: noop, setPendingLocks: noop, setSilvisRule: noop, sfRule: (x) => x, setDismissedWarnings: noop,
        everHadRealDataRef: r.ever, setEdgeFunctionUrl: noop, console: a.console, setAppShiftsLoaded: noop, appOffVisible: false, adoptDayOffRow: noop, db: { query: async () => [] },
        setVacRequests: noop, setTradeRequests: noop, setNotifications: noop, showToast: a.showToast, schedSyncRef: a.schedSyncRef, scheduleRef: a.ref,
        loadTimeOff: async () => { r.order.push("timeoff"); }, loadSilvisFeed: async () => {}, refreshSilvisFeed: noop,
        setLoaded: (v) => { r.order.push("loaded:" + v + ":" + (a.eng.isSeeded() ? "seeded" : "unseeded") + ":" + Object.keys(a.ref.current).length); done(); },
        loadedAtRef: { current: 0 }, getSupabaseRT: () => null, window: { addEventListener: noop, removeEventListener: noop }, setTimeout: () => 0,
        setInterval: (f) => { r.polls.push(f); return r.polls.length; }, clearInterval: noop })();
      return r;
    };
    const NOT_LOADED = /^The schedule hasn't loaded yet — nothing was changed\./;
    // (a) the first read fails
    const t = mkT(), A = mkApp(t);
    t.control.fail({ method: "GET", kind: "5xx-before", count: 1 });
    const L = rig(A); await L.loaded; await A.settle();
    const gate1 = A.schedEditable(), toasts1 = A.toasts.slice(), w1 = writesOf(t, 0).length;
    check("SE-X3 the real load effect, the schedule read FAILS: the app still finishes loading (after the engine answered), the engine is unloaded, and the edit gate refuses — 'hasn't loaded yet', nothing written; nothing armed as real data",
      L.order.join() === "timeoff,loaded:true:unseeded:0" && !A.eng.isSeeded() && gate1 === false && toasts1.length === 1 && NOT_LOADED.test(toasts1[0][0]) && w1 === 0 && L.ever.current === false,
      JSON.stringify({ order: L.order, gate1, toasts1 }));
    await L.polls[0](); await A.settle();
    const gate2 = A.schedEditable();
    A.edit(X[0], w => (w.dayCall = "s7", w)); await A.eng.push();
    check("SE-X3 …the effect's 60-s poll repairs it: the table is read and seeded, the gate opens, and an edit then lands by CAS (control)",
      L.polls.length === 1 && A.eng.isSeeded() && gate2 === true && t.get(X[0]).data.dayCall === "s7" && t.get(X[0]).version === 4 && A.toasts.length === 1, JSON.stringify({ gate2, toasts: A.toasts }));
    // (b) gated during the load; seeded before "loaded"
    const t2 = mkT(), B = mkApp(t2);
    const hold = t2.control.pause({ method: "GET", count: 1 });
    const L2 = rig(B); await hold.arrived; await null;
    const during = { gate: B.schedEditable(), order: L2.order.slice(), shown: Object.keys(B.ref.current).length };
    hold.release(); await L2.loaded; await B.settle();
    check("SE-X3 the schedule read still OUT: not loaded yet and the gate refuses; once it lands the mirror is seeded (= the table) BEFORE the app says loaded, real data armed, the gate opens",
      during.gate === false && during.order.length === 0 && during.shown === 0 && L2.order.join() === "timeoff,loaded:true:seeded:4" && same(B.ref.current, tableOf(t2)) && L2.ever.current === true && B.schedEditable() === true,
      JSON.stringify({ during, order: L2.order }));
    // (c) a second pass: an edit made in between survives and is sent; a peer's change arrives
    B.edit(X[0], w => (w.nights.thu = "s7", w));
    const Q = mkApp(t2, { token: "TOK_B", person: "s2" }); await Q.eng.load(); Q.edit(X[1], w => (w.nights.wed = "s7", w)); await Q.eng.push();
    const L3 = rig(B); await L3.loaded; await B.settle();
    check("SE-X3 a SECOND pass (sign-in, reloadTrigger): a pull, not a re-seed — the edit made in between stays on screen and lands; the peer's change to another week arrives; nothing pending",
      L3.order.join() === "timeoff,loaded:true:seeded:4" && B.ref.current[X[0]].nights.thu === "s7" && t2.get(X[0]).data.nights.thu === "s7" && B.ref.current[X[1]].nights.wed === "s7" && B.eng.pending().length === 0,
      JSON.stringify({ order: L3.order, pending: B.eng.pending() }));
  });

  // SE-X4 — the REAL executeTwoWaySwap / swapShift on the real engine (A13):
  // a pull adopts a change to the target's or the return's holder between the
  // suggestion and the tap → zero writes, zero notices, the refusal toast,
  // the suggestions closed; the same for a one-way swap from suggestions;
  // each with its control landing by CAS.
  await run("SE-X4", async () => {
    const env = (a, rec) => ({ fmt: HX.fmt, shiftStartDate: HX.shiftStartDate, swapMsg: HX.swapMsg, SHIFT_LABELS: HX.SHIFT_LABELS, schedEditable: a.schedEditable, schedule: {}, scheduleRef: a.ref, showToast: a.showToast,
      silvisActive: false, silvisBlock: () => null, silvisRefuse: () => false, pushUndo: a.pushUndo, updateSchedule: a.updateSchedule, surgeons: S7, setEditShift: () => {}, setEditingWeek: () => {},
      setSwapSuggestions: (v) => rec.cleared.push("suggestions:" + v), setSwapTarget: (v) => rec.cleared.push("target:" + v), sMap: S7MAP, schedulerAdminIds: ["s7"],
      addNotification: (type) => { rec.notes.push(type); }, sendEmailNotif: (type) => { rec.emails.push(type); } });
    const tap = async (two, change) => {
      const { t, A, P } = await pair();
      if (change) { await P.eng.pull(); P.edit(change[0], change[1]); await P.eng.push(); await A.eng.pull(); }
      const rec = { cleared: [], notes: [], emails: [] }, from = t.log.length;
      if (two) F.swapTwo(env(A, rec))(X[0], "tue", "s2", "s4", X[1], "mon");   // AAA's suggestion: DDD takes BBB's Tue night of X0, BBB takes DDD's Mon night of X1
      else F.swapOne(env(A, rec))(X[0], "tue", "s6", "s2");                    // a one-way swap from suggestions: FFF takes BBB's Tue night
      await A.eng.push();
      return { t, A, rec, w: writesOf(t, from, "TOK_A") };
    };
    const refused = (r, re) => r.w.length === 0 && r.rec.notes.length === 0 && r.rec.emails.length === 0 && r.A.history.length === 0 && r.rec.cleared.join() === "suggestions:null,target:null"
      && r.A.toasts.length === 1 && re.test(r.A.toasts[0][0]);
    const sh = (r) => JSON.stringify({ w: r.w.map(e => e.method + " " + e.url.split("?")[1]), notes: r.rec.notes, toasts: r.A.toasts, cleared: r.rec.cleared });
    const tgt = await tap(true, [X[0], w => (w.nights.tue = "s5", w)]), ret = await tap(true, [X[1], w => (w.nights.mon = "s5", w)]), ok2 = await tap(true, null);
    check("SE-X4 the real executeTwoWaySwap: a pull adopts a change to the TARGET's holder between the suggestion and the tap → refused: zero writes, zero notices / emails, no undo step, the suggestions closed, 'This swap is out of date'",
      refused(tgt, /^This swap is out of date — those shifts changed/) && tgt.t.get(X[0]).data.nights.tue === "s5", sh(tgt));
    check("SE-X4 …a change to the RETURN slot's holder → refused the same way", refused(ret, /^This swap is out of date/) && ret.t.get(X[1]).data.nights.mon === "s5", sh(ret));
    check("SE-X4 …control: unchanged → the swap lands on the table by CAS (two PATCHes at v3), one undo step, the notice and the email",
      ok2.w.length === 2 && ok2.w.every(e => e.method === "PATCH" && /version=eq\.3/.test(e.url) && e.status === 200) && ok2.t.get(X[0]).data.nights.tue === "s4" && ok2.t.get(X[1]).data.nights.mon === "s2"
        && ok2.A.history.length === 1 && ok2.rec.notes.join() === "schedule_changed" && ok2.rec.emails.length === 1 && ok2.A.toasts.length === 0, sh(ok2));
    const one = await tap(false, [X[0], w => (w.nights.tue = "s5", w)]), ok1 = await tap(false, null);
    check("SE-X4 the real swapShift from suggestions: the slot changed since (adopted by a pull) → refused, zero writes / notices, the suggestions closed; control: it lands by CAS",
      refused(one, /^This swap is out of date — that shift changed/) && ok1.w.length === 1 && ok1.t.get(X[0]).data.nights.tue === "s6" && ok1.rec.notes.length === 1 && ok1.A.toasts.length === 0, sh(one) + " " + sh(ok1));
  });

  // SE-X5 — the REAL acceptTradeRequest + detectCascadeChanges on the real
  // engine (A13): the proposer lost the slot before the tap (adopted by a
  // pull) → refused before any request, the trade untouched; a change to a
  // confirmed cascade's slot adopted DURING the status PATCH → not applied
  // (set back to pending), zero schedule writes; control: it lands by CAS.
  await run("SE-X5", async () => {
    const REQ = { id: 42, from_surgeon_id: "s1", to_surgeon_id: "s2", from_surgeon_name: "AAA", to_surgeon_name: "BBB", week_monday: X[0], shift_key: "dayCall", shift_label: "Service Week",
      return_week: X[1], return_shift: "dayCall", status: "pending" };
    const detect = F.cascades({ surgeons: S7, SHIFT_LABELS: HX.SHIFT_LABELS });
    const resp = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json) });
    const accept = async (o = {}) => {
      const { t, A, P } = await pair();
      if (o.before) { await P.eng.pull(); P.edit(o.before[0], o.before[1]); await P.eng.push(); await A.eng.pull(); }
      const rec = { reqs: [], confirms: [], audits: [], notes: [], emails: [], list: [Object.assign({}, REQ)] }, from = t.log.length;
      await F.accept({ fmt: HX.fmt, shiftStartDate: HX.shiftStartDate, SHIFT_LABELS: HX.SHIFT_LABELS, tradeAcceptMsg: HX.tradeAcceptMsg, cascadeMsg: HX.cascadeMsg,
        showToast: A.showToast, schedEditable: A.schedEditable, scheduleRef: A.ref, surgeons: S7, schedule: {}, detectCascadeChanges: detect,
        silvisActive: false, silvisBlock: () => null, silvisRefuse: () => false, confirm: (m) => { rec.confirms.push(String(m)); return true; },
        SUPABASE_URL: BASE, dbAuthHeaders: () => ({ apikey: "ANON", Authorization: "Bearer TOK_A" }), console: A.console,
        setTradeRequests: (f) => { rec.list = f(rec.list); }, logAudit: (action) => rec.audits.push(action), pushUndo: A.pushUndo, updateSchedule: A.updateSchedule,
        addNotification: async (type) => { rec.notes.push(type); }, sendEmailNotif: (type) => { rec.emails.push(type); }, schedulerAdminIds: ["s7"],
        fetch: async (url, init) => {
          const r = { url: String(url), method: (init && init.method) || "GET" };
          rec.reqs.push(r);
          if (/\/rest\/v1\/shift_trade_requests\?id=eq\.42&status=eq\.pending$/.test(r.url)) {
            if (o.during) { await P.eng.pull(); P.edit(o.during[0], o.during[1]); await P.eng.push(); await A.eng.pull(); }
            return resp(200, [Object.assign({}, REQ, { status: "accepted" })]);
          }
          if (/\/rest\/v1\/shift_trade_requests\?id=eq\.42&status=eq\.accepted$/.test(r.url)) return resp(200, [Object.assign({}, REQ, { status: "pending", reviewed_at: null })]);
          throw new Error("unrouted request: " + r.method + " " + r.url);
        } })(Object.assign({}, REQ));
      await A.eng.push();
      return { t, A, rec, w: writesOf(t, from, "TOK_A") };
    };
    const sh = (r) => JSON.stringify({ reqs: r.rec.reqs.map(x => x.method + " " + x.url.replace(/^.*\/rest\/v1\//, "")), w: r.w.map(e => e.method + " " + e.url.split("?")[1]), toasts: r.A.toasts, audits: r.rec.audits, status: r.rec.list[0].status });
    const pre = await accept({ before: [X[0], w => (w.dayCall = "s7", w)] });
    check("SE-X5 the real acceptTradeRequest: the proposer lost the service week before the tap (adopted by a pull) → refused BEFORE any request: no status PATCH, no confirm, zero schedule writes / notices, the trade still pending, 'This trade is out of date'",
      pre.rec.reqs.length === 0 && pre.rec.confirms.length === 0 && pre.w.length === 0 && pre.rec.notes.length === 0 && pre.rec.list[0].status === "pending" && pre.A.history.length === 0
        && pre.A.toasts.length === 1 && /^This trade is out of date/.test(pre.A.toasts[0][0]) && pre.t.get(X[0]).data.dayCall === "s7", sh(pre));
    const mid = await accept({ during: [X[1], w => (w.nights.tue = "s7", w)] });
    check("SE-X5 …a change to a confirmed cascade's slot (X1's Tue night) adopted DURING the status PATCH → not applied: the status set back (the compensating PATCH), zero schedule writes, no undo step or notice, their change stands",
      mid.rec.reqs.length === 2 && /status=eq\.accepted$/.test(mid.rec.reqs[1].url) && mid.w.length === 0 && mid.A.history.length === 0 && mid.rec.notes.length === 0 && mid.rec.list[0].status === "pending"
        && mid.rec.audits.join() === "trade.accept_unapplied" && mid.t.get(X[1]).data.nights.tue === "s7" && mid.A.toasts.length === 1 && /^This trade was not applied/.test(mid.A.toasts[0][0]), sh(mid));
    const ok = await accept();
    check("SE-X5 …control: nothing changes → applied: one status PATCH, then both legs + both cascades land on the table by CAS (X0, X1 at v3 → 4), the notices and emails sent",
      ok.rec.reqs.length === 1 && ok.w.length === 2 && ok.w.every(e => e.method === "PATCH" && /version=eq\.3/.test(e.url) && e.status === 200) && ok.rec.list[0].status === "accepted"
        && ok.t.get(X[0]).data.dayCall === "s2" && ok.t.get(X[0]).data.nights.tue === "s1" && ok.t.get(X[1]).data.dayCall === "s1" && ok.t.get(X[1]).data.nights.tue === "s2"
        && ok.rec.notes.join() === "trade_accepted,schedule_changed,schedule_changed" && ok.rec.emails.length === 3 && ok.A.toasts.length === 0, sh(ok));
  });

  // SE-X6 — the REAL openWeekEditor + saveWeekEdits + mergeEditorEdits on the
  // real engine (§2.6): someone else's change to the slot edited here,
  // adopted while the editor is open → refused, zero writes; to another slot
  // → both kept; control: the edit lands.
  await run("SE-X6", async () => {
    const { t, A, P } = await pair();
    const rec = { audits: [], notes: [] };
    const open = F.openEditor({ scheduleRef: A.ref, parse: HX.parse, addD: HX.addD, fmt: HX.fmt, appShifts: {}, appShiftsLoaded: true, setEditWeekModal: A.setModal, schedSyncRef: A.schedSyncRef });
    const draft = (f) => { const d = JSON.parse(JSON.stringify(A.modal.draft)); f(d); A.modal = Object.assign({}, A.modal, { draft: d }); };
    const save = () => F.saveEditor({ editWeekModal: A.modal, schedule: {}, appShifts: {}, appShiftsLoaded: true, openWeekEditor: open, setEditWeekModal: A.setModal,
      silvisActive: false, silvisFakId: null, silvisDays: { primary: new Set() }, silvisBlock: () => null, silvisRefuse: () => false, sfSlotDays: () => [], confirm: () => true,
      pushUndo: A.pushUndo, updateSchedule: A.updateSchedule, scheduleRef: A.ref, schedEditable: A.schedEditable, schedSyncRef: A.schedSyncRef, mergeEditorEdits, SHIFT_LABELS: HX.SHIFT_LABELS,
      backupMondaySet: new Set(), fierceBackupSet: new Set(), surgeons: S7, showToast: A.showToast, APP_SHIFTS_NOT_LOADED: "APP shifts haven't loaded yet",
      setAppShifts: () => {}, saveAppShifts: () => {}, logAudit: (x, msg, meta) => rec.audits.push(meta), nameOf: (x) => x, aMap: {}, sMap: S7MAP, schedulerAdminIds: [],
      addNotification: (type, title, msg) => rec.notes.push(msg), sendEmailNotif: () => {}, setTimeout: () => {} })(null);
    const peer = async (k, f) => { await P.eng.pull(); P.edit(k, f); await P.eng.push(); await A.eng.pull(); };
    open(X[0]); draft(d => { d.nights.tue = "s1"; });
    await peer(X[0], w => (w.nights.tue = "s5", w));
    let from = t.log.length; save(); await A.eng.push();
    check("SE-X6 the real editor: someone else's change to the slot edited here (X0's Tue night) adopted while it is open → Save REFUSED, naming it — zero writes, no undo step or audit, the editor still open, their value on screen and on the table",
      writesOf(t, from, "TOK_A").length === 0 && A.history.length === 0 && rec.audits.length === 0 && !!A.modal && A.modal.mondayStr === X[0] && A.ref.current[X[0]].nights.tue === "s5" && t.get(X[0]).data.nights.tue === "s5"
        && A.toasts.length === 1 && /They changed the Tue Night you edited here\./.test(A.toasts[0][0]), JSON.stringify({ toasts: A.toasts, w: writesOf(t, from, "TOK_A").length }));
    A.setModal(null); A.toasts.length = 0;
    open(X[1]); draft(d => { d.dayCall = "s7"; });
    await peer(X[1], w => (w.nights.wed = "s6", w));
    from = t.log.length; save(); await A.eng.push();
    check("SE-X6 …their change to ANOTHER slot (X1's Wed night) → Save writes only the edit, onto the latest week: the table has both, by one CAS PATCH",
      writesOf(t, from, "TOK_A").length === 1 && t.get(X[1]).data.dayCall === "s7" && t.get(X[1]).data.nights.wed === "s6" && A.modal === null && A.toasts.length === 0, JSON.stringify({ row: t.get(X[1]).data, toasts: A.toasts }));
    open(X[2]); draft(d => { d.dayCall = "s6"; });
    from = t.log.length; save(); await A.eng.push();
    check("SE-X6 …control: nobody else touches the week → the edit lands (one PATCH), one undo step, one audit line",
      writesOf(t, from, "TOK_A").length === 1 && t.get(X[2]).data.dayCall === "s6" && A.history.length === 2 && rec.audits.length === 2 && A.toasts.length === 0, JSON.stringify({ h: A.history.length, audits: rec.audits.length }));
  });

  // SE-X7 — the REAL acceptPreview (and publishNotLanded / runPublish) on the
  // real engine (A13 / A14): a week of the preview someone else changed since
  // it was generated (adopted) → refused before anything is captured or
  // written, naming it; control: it publishes (the job lands the weeks); a
  // change to a week OUTSIDE the preview doesn't stop it, and isn't written.
  await run("SE-X7", async () => {
    const go = async (change) => {
      const { t, A, P } = await pair();
      const stamp = A.eng.epochNow();                       // the preview is generated now
      const weeks = { [X[0]]: wkX("s4", ["s1", "s2", "s3", "s5", "s6"]), [X[1]]: wkX("s3", ["s1", "s2", "s4", "s5", "s6"]) };
      if (change) { await P.eng.pull(); P.edit(change[0], change[1]); await P.eng.push(); await A.eng.pull(); }
      const r = { snaps: 0, status: [], published: 0 }, from = t.log.length;
      await F.acceptPreview({ publishSearchRunning: () => false, showToast: A.showToast, cancelSearch: () => {}, previewSchedule: weeks, previewNeedsOk: { items: [], cost: 0 }, previewAck: true,
        publishingRef: { current: false }, schedEditable: A.schedEditable, schedSyncRef: A.schedSyncRef, previewEpochRef: { current: stamp }, previewOrigin: "generated", startMonth: 0, startYear: 2030, numWeeks: 2,
        setPublishing: () => {}, setSaveStatus: (s) => r.status.push(s), snapshots: { capture: async () => { r.snaps++; return { ok: true }; } }, previewSchedRef: { current: weeks },
        // (the real publishWeeks also moves the counts and audits; its schedule part is this)
        publishWeeks: (w) => { r.published++; A.pushUndo(); A.commitSchedule(Object.assign({}, A.ref.current, w)); return {}; },
        MO: HX.MO, runPublish: F.runPublish({ schedSyncRef: A.schedSyncRef }), setPreviewSchedule: () => {}, setShowPreview: () => {}, setCalMonth: () => {}, setCalYear: () => {}, setView: () => {}, setTimeout: () => 0,
        publishNotLanded: F.notLanded({ showToast: A.showToast }) })();
      await A.settle();
      return { t, A, r, weeks, w: writesOf(t, from, "TOK_A") };
    };
    const sh = (x) => JSON.stringify({ r: x.r, w: x.w.map(e => e.method + " " + e.url.split("?")[1]), toasts: x.A.toasts });
    const red = await go([X[1], w => (w.nights.thu = "s7", w)]), ok = await go(null), out = await go([X[3], w => (w.nights.thu = "s7", w)]);
    check("SE-X7 the real acceptPreview: a week of the preview someone else changed since it was generated (adopted) → refused before ANYTHING — no snapshot, no publish, zero writes — naming that week; their change stands",
      red.r.snaps === 0 && red.r.published === 0 && red.w.length === 0 && red.A.toasts.length === 1 && red.A.toasts[0][0] === `The week of ${X[1]} changed since this preview was generated — nothing was published. Generate the preview again.`
        && red.t.get(X[1]).data.nights.thu === "s7", sh(red));
    check("SE-X7 …control: nothing changed → one snapshot, published: the job writes the preview's weeks (X0, X1) to the table, 'Published — totals updated', no toast",
      ok.r.snaps === 1 && ok.r.published === 1 && ok.w.length === 2 && same({ [X[0]]: ok.t.get(X[0]).data, [X[1]]: ok.t.get(X[1]).data }, ok.weeks) && ok.r.status.includes("Published — totals updated") && ok.A.toasts.length === 0, sh(ok));
    check("SE-X7 …a change to a week OUTSIDE the preview doesn't stop it: published, and zero writes to that week (their change stands)",
      out.r.published === 1 && out.w.length === 2 && out.w.every(e => !e.url.includes(X[3])) && out.t.get(X[3]).data.nights.thu === "s7" && out.A.ref.current[X[3]].nights.thu === "s7", sh(out));
  });

  // SE-X8 — 16/n E5 (review r1 app-3): what a REFUSED publish tells, through
  // the real acceptPreview, runPublish and publishNotLanded on the real engine:
  // ONE message, with "Nobody was notified." exactly once and never "nothing
  // was published" — that the new weeks stay on this screen and are saved
  // automatically (its re-read failed), or once signed in again (the server
  // refused the token at that read). And that is what happens: they land.
  await run("SE-X8", async () => {
    const go = async (inject) => {
      const { t, A } = await pair();
      const weeks = { [X[0]]: wkX("s4", ["s1", "s2", "s3", "s5", "s6"]), [X[1]]: wkX("s3", ["s1", "s2", "s4", "s5", "s6"]) };
      const r = { snaps: 0, status: [], published: 0 };
      inject(t);
      await F.acceptPreview({ publishSearchRunning: () => false, showToast: A.showToast, cancelSearch: () => {}, previewSchedule: weeks, previewNeedsOk: { items: [], cost: 0 }, previewAck: true,
        publishingRef: { current: false }, schedEditable: A.schedEditable, schedSyncRef: A.schedSyncRef, previewEpochRef: { current: A.eng.epochNow() }, previewOrigin: "generated", startMonth: 0, startYear: 2030, numWeeks: 2,
        setPublishing: () => {}, setSaveStatus: (s) => r.status.push(s), snapshots: { capture: async () => { r.snaps++; return { ok: true }; } }, previewSchedRef: { current: weeks },
        publishWeeks: (w) => { r.published++; A.pushUndo(); A.commitSchedule(Object.assign({}, A.ref.current, w)); return {}; },
        MO: HX.MO, runPublish: F.runPublish({ schedSyncRef: A.schedSyncRef }), setPreviewSchedule: () => {}, setShowPreview: () => {}, setCalMonth: () => {}, setCalYear: () => {}, setView: () => {}, setTimeout: () => 0,
        publishNotLanded: F.notLanded({ showToast: A.showToast }) })();
      const msg = (A.toasts.find(x => /^Published on this screen/.test(x[0])) || [""])[0];
      const shown = same({ [X[0]]: A.ref.current[X[0]], [X[1]]: A.ref.current[X[1]] }, weeks), pending = A.eng.pending().join();
      await A.settle();
      return { t, A, r, weeks, msg, shown, pending };
    };
    const once = (m) => (m.match(/Nobody was notified\./g) || []).length === 1;
    const landed = (x) => same({ [X[0]]: x.t.get(X[0]).data, [X[1]]: x.t.get(X[1]).data }, x.weeks) && x.A.eng.pending().length === 0;
    const rd = await go(t => t.control.fail({ method: "GET", week: "in.(", kind: "5xx-before" }));
    check("SE-X8 E5 the real acceptPreview + publishNotLanded, the publish's re-read FAILS: ONE message — 'Published on this screen: Couldn't read the saved weeks first — the new weeks stay on this screen and will be saved automatically. Nobody was notified.' (that once; no 'nothing was published'), the weeks still shown and pending; and the follow-up push lands them, with no other toast",
      rd.r.published === 1 && rd.msg === "Published on this screen: Couldn't read the saved weeks first — the new weeks stay on this screen and will be saved automatically. Nobody was notified." && once(rd.msg) && !/nothing was published/i.test(rd.msg)
        && rd.shown && rd.pending === [X[0], X[1]].join() && landed(rd) && rd.A.toasts.length === 1 && rd.A.toasts[0][1] === "error", JSON.stringify({ msg: rd.msg, toasts: rd.A.toasts, pending: rd.pending, status: rd.r.status }));
    const au = await go(t => t.control.fail({ method: "GET", week: "in.(", kind: "401" }));
    const auMsg = au.msg, waited = au.A.eng.authBlocked() && au.A.eng.pending().join() === [X[0], X[1]].join() && !au.t.log.some(e => e.method !== "GET" && e.headers.authorization === "Bearer TOK_A" && e.url.includes(X[0]));
    au.t.control.users.TOK_A2 = "user-a"; au.A.token = "TOK_A2"; await au.A.eng.pull(); await au.A.settle();
    check("SE-X8 E5 …the server refuses the token at the publish's own read (I5: dead, the read goes on as anon): the message is 'Published on this screen: Your sign-in has expired — the new weeks stay on this screen and will be saved once you sign in again (tap \"Sign in again\" at the top). Nobody was notified.' (that once); the weeks wait, pending, and land after 'Sign in again'",
      au.r.published === 1 && auMsg === "Published on this screen: " + PUB_AUTH && once(auMsg) && !/nothing was (published|changed)/i.test(auMsg) && au.shown && waited && landed(au),
      JSON.stringify({ msg: auMsg, toasts: au.A.toasts, waited, pending: au.A.eng.pending() }));
  });

  // ══ 17/n (review r1, the app items P1–P6 and T4) ══
  // A component around one app session (P4, P5): its state as far as these
  // slices read it, and React as far as they need it — a state change
  // re-renders (in a microtask, coalesced), and an effect re-runs when one of
  // its deps changed (its cleanup first); its timers are held and fired by
  // hand. Every setup write (the blob, the edge URL) is recorded with the
  // token it goes out with — the stored session's, or anon, which RLS refuses
  // (42501) as the live tables do.
  const DENY = { error: '{"code":"42501","message":"new row violates row-level security policy for table \\"call_schedule_data\\""}' };
  // The setup autosave's deps as the SOURCE lists them: an emulated render re-runs it exactly when one of those changed (19/n P9's nudge included — or not, on an older source).
  const AUTO_DEPS = (() => { const a = nsrc.indexOf("  // ─── Supabase: Auto-save on changes ───\n  useEffect(() => {"), e = a < 0 ? -1 : nsrc.indexOf("\n  }, [", a); return e < 0 ? [] : nsrc.slice(e + 7, nsrc.indexOf("]);", e)).split(",").map(x => x.trim()); })();
  const SETUP_SIG = G.setupSig ? G.setupSig({}) : (() => ""); // (20/n) the component's setupSig — none before it (the autosave then doesn't ask)
  const mkComp = (A, o = {}) => {
    const c = { st: Object.assign({ loaded: true, isScheduler: true, numWeeks: 13, surgeons: S7, schedule: A.ref.current, edgeFunctionUrl: "https://fn.test/functions/v1/send-notification", setupSaveNudge: 0 }, o.st || {}),
      upserts: [], status: [], timers: new Map(), tid: 0, renders: 0, queued: false, reloads: 0, roles: [], saveError: false, reauth: 0,
      setupReadRef: { current: true }, lastSyncRef: { current: "2026-10-01T08:00:00+00:00" }, loadedAtRef: { current: 1 }, loadFailedRef: { current: false }, everRef: { current: true }, bundleRef: { current: null }, pendingSaveRef: { current: null }, setupBaseRef: { current: null } };
    c.setTimeout = (f) => { const id = ++c.tid; c.timers.set(id, f); return id; };
    c.clearTimeout = (id) => { c.timers.delete(id); };
    c.fire = async () => { for (let n = 0; n < 5 && c.timers.size; n++) { const fs = [...c.timers.values()]; c.timers.clear(); for (const f of fs) await f(); } }; // (and the timers those set: "Saved" clears itself after 2 s)
    c.fireOnce = async () => { const fs = [...c.timers.values()]; c.timers.clear(); for (const f of fs) await f(); }; // (just the timers due now: "Saved" stays)
    c.supabase = { from: (tb) => ({ upsert: async (row) => {
      const s = A.auth.getSession();
      c.upserts.push({ tb, as: s ? s.access_token : "ANON", numWeeks: row.data ? row.data.numWeeks : undefined, url: row.edge_function_url, clear: !!(row.data && row.data._intentionalClear) });
      return s ? { error: null } : DENY;
    } }) };
    c.blobs = () => c.upserts.filter(u => u.tb === "call_schedule_data");
    c.set = (k) => (v) => {
      const nv = typeof v === "function" ? v(c.st[k]) : v;
      if (k === "isScheduler") c.roles.push(nv);
      if (nv === c.st[k]) return;
      c.st = Object.assign({}, c.st, { [k]: nv });
      if (!c.queued) { c.queued = true; Promise.resolve().then(() => { c.queued = false; c.render(); }); }
    };
    A.onSchedule = c.set("schedule");
    const VAC = { s2: [["2030-01-08", "2030-01-10"]] }, NOSET = new Set();
    let aDeps = null, aClean = null, uDeps = null, uClean = null;
    c.render = () => {
      c.renders++;
      const s = c.st;
      c.bundle = G.bundle({ surgeons: s.surgeons, apps: [], vacations: s.vacations || VAC, noCallDays: s.noCallDays || {}, backupMondaySet: NOSET, fierceBackupSet: NOSET, schedule: s.schedule, priorCounts: {}, year1Counts: {},
        startMonth: 0, startYear: 2030, numWeeks: s.numWeeks, holidayAssignments: {}, startMondayOverride: "", pendingLocks: [], silvisRule: null, dismissedWarnings: [], useRef: () => c.bundleRef });
      const ad = AUTO_DEPS.map(n => s[n]); // (the autosave's deps, by the source's list: those that move here — loaded, surgeons, schedule, numWeeks, the nudge — and the others, which stay put)
      if (!aDeps || ad.some((v, i) => v !== aDeps[i])) {
        aDeps = ad; if (aClean) aClean();
        aClean = G.autosave({ loaded: s.loaded, isPublicMode: false, loadedAtRef: c.loadedAtRef, loadFailedRef: c.loadFailedRef, setSaveError: (x) => { c.saveError = x; }, setSaveStatus: (x) => c.status.push(x), setupReadRef: c.setupReadRef, auth: A.auth,
          buildStateBundle: c.bundle, pendingSaveRef: c.pendingSaveRef, payloadLooksWiped: HX.payloadLooksWiped, everHadRealDataRef: c.everRef, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, allowWipeSaveRef: { current: false },
          canWriteBlob: s.isScheduler, supabase: c.supabase, lastSyncRef: c.lastSyncRef, showToast: A.showToast, console: A.console, setReauthNeeded: (v) => { if (v) c.reauth++; },
          setupBaseRef: c.setupBaseRef, setupSig: SETUP_SIG })() || null;
      }
      const ud = [s.loaded, s.edgeFunctionUrl, s.isScheduler];
      if (!uDeps || ud.some((v, i) => v !== uDeps[i])) {
        uDeps = ud; if (uClean) uClean();
        uClean = G.urlSave({ loaded: s.loaded, isPublicMode: false, loadFailedRef: c.loadFailedRef, edgeFunctionUrl: s.edgeFunctionUrl, canWriteBlob: s.isScheduler, setupReadRef: c.setupReadRef,
          setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, supabase: c.supabase, showToast: A.showToast, console: A.console })() || null;
      }
    };
    return c;
  };
  // The session boundary's env (the real sessionBoundary / handleSignOut) for an app session + its component.
  const bEnv = (A, c) => { const noop = () => {}; return { searchRef: { current: null }, setSearching: noop, setSearchStats: noop, setPreviewSchedule: noop, setShowPreview: noop, schedSyncRef: A.schedSyncRef,
    setScheduleHistory: A.setScheduleHistory, setEditWeekModal: A.setModal, setReauthNeeded: noop, setStaleTokenWarn: noop, setIsScheduler: c.set("isScheduler"), setupReadRef: c.setupReadRef, lastSyncRef: c.lastSyncRef,
    confirm: () => true, auth: A.auth, biometric: { unenroll: noop }, setAuthUser: c.set("authUser"), setUserProfile: c.set("userProfile"), setNeedsProfile: noop, setMySurgeon: noop, setBiometricEnrolled: noop, setBiometricPending: noop,
    pendingSaveRef: c.pendingSaveRef, setSetupSaveNudge: c.set("setupSaveNudge") }; };
  // …and "Sign in again" landing on the SAME account (a renewed session — the real reauthLanded's same-account branch).
  const sameAccount = (A, c) => Object.assign(bEnv(A, c), { authUser: { id: "auth-a" }, showToast: A.showToast, dbAuth: { getProfile: async () => null }, setReloadTrigger: () => { c.reloads++; } });
  // …and "Sign in again" landing on ANOTHER account, a scheduler (the real reauthLanded, crossing that boundary).
  const otherAccount = async (A, c) => {
    A.token = "TOK_B"; // the new account's session is stored
    const env = Object.assign(bEnv(A, c), { authUser: { id: "auth-a" }, showToast: A.showToast, dbAuth: { getProfile: async () => ({ person_id: "s2", role: "scheduler" }) }, setReloadTrigger: () => { c.reloads++; } });
    env.sessionBoundary = G.boundary(env).sessionBoundary;
    return G.reauth(env)({ id: "auth-b", email: "b@dsg.test" });
  };
  // The REAL load effect (the [reloadTrigger] one) for a component: its setup read answers o.blob (read at each call;
  // or throws while o.blobFails() says so); what it adopts goes into the component's state. A timer still pending
  // from an earlier render fires at the very moment a read is adopted, before the render that adopts it: the race a
  // write from a render made before that read would win (P4).
  const loadRig = (A, c, o) => {
    const r = { polls: [], errors: [] }; let done; r.loaded = new Promise(res => { done = res; });
    const noop = () => {};
    const single = (tb) => async () => {
      if (tb !== "call_schedule_data") return { data: null, error: null };
      if (o.gate) await o.gate; // (19/n, r2-tests-1: the read held — a slow setup read)
      if (o.blobFails && o.blobFails()) throw new Error("HTTP 503");
      return { data: o.blob, error: null };
    };
    const adopt = (k) => (v) => { const stale = [...c.timers.values()]; c.timers.clear(); stale.forEach(f => f()); c.set(k)(v); };
    F.load({ loadFailedRef: c.loadFailedRef, supabase: { from: (tb) => ({ select: () => ({ eq: () => ({ single: single(tb) }) }) }) }, lastSyncRef: c.lastSyncRef, setupReadRef: c.setupReadRef,
      setSurgeons: noop, setApps: noop, USE_TIME_OFF: true, setVacations: noop, setNoCallDays: noop, setBackupMondaySet: noop, setFierceBackupSet: noop, setAppShifts: noop, setPriorCounts: noop, setYear1Counts: noop,
      setStartMonth: noop, setStartYear: noop, setNumWeeks: adopt("numWeeks"), setStartMondayOverride: noop, setHolidayAssignments: noop, setPendingLocks: noop, setSilvisRule: noop, sfRule: (x) => x, setDismissedWarnings: noop,
      everHadRealDataRef: c.everRef, setEdgeFunctionUrl: noop, console: { error: (...x) => r.errors.push(x.map(String).join(" ")), warn: noop, log: noop, info: noop }, setAppShiftsLoaded: noop, appOffVisible: false, adoptDayOffRow: noop,
      db: { query: async () => [] }, setVacRequests: noop, setTradeRequests: noop, setNotifications: noop, showToast: A.showToast, schedSyncRef: A.schedSyncRef, scheduleRef: A.ref,
      loadTimeOff: async () => {}, loadSilvisFeed: async () => {}, refreshSilvisFeed: noop, setLoaded: () => done(), loadedAtRef: c.loadedAtRef, getSupabaseRT: () => null,
      window: { addEventListener: noop, removeEventListener: noop }, setTimeout: () => 0, setInterval: (f) => { r.polls.push(f); return r.polls.length; }, clearInterval: noop })();
    return r;
  };
  const ticks = async (A, n) => { for (let i = 0; i < (n || 1); i++) { await A.settle(); for (let j = 0; j < 4; j++) await null; } };
  // ── 19/n (review r2, the app items P7–P10 and the test gaps) ──
  const nap = (n) => new Promise(res => setTimeout(res, n));
  const noopX = () => {};
  const dc = (o) => Object.keys(o || {}).sort().map(k => k + "=" + (o[k] && o[k].dayCall)).join(" ");
  // config.js's snapshots.restore as the app sees it (sync-guards C and SE-G run the real one): the confirm, then (the
  // before_restore capture and) the blob written, then the schedule leg — and, whenever the blob was written, the
  // restored blob in its answer (19/n P8: also when the leg is refused or doesn't fully land). o.beforeConfirm /
  // o.beforeApply: awaited first (a slow snapshot read; a slow capture + blob write); o.rec counts its calls and blob writes.
  const restoreStub = (SNAP, o = {}) => ({ restore: async (id, apply, opts) => {
    if (o.rec) o.rec.calls++;
    if (o.beforeConfirm) await o.beforeConfirm;
    if (opts && opts.confirm && !(await opts.confirm(SNAP, {}))) return { ok: false, cancelled: true };
    if (o.beforeBlob) await o.beforeBlob;                                        // (20/n) the before_restore snapshot, slow
    if (opts && typeof opts.proceed === "function" && !opts.proceed()) return { ok: false, cancelled: true }; // config.js asks right before the blob (review r3)
    if (o.beforeApply) await o.beforeApply;
    if (o.rec) o.rec.blobWrites++;
    const blob = o.blob || {}, ts = "2026-10-14T10:00:00Z";
    const applied = await apply(SNAP);
    if (applied && applied.running) return { ok: false, running: true, error: applied.error, blobRestored: true, blob, schedule: SNAP, ts };
    if (applied && applied.ok === false) return { ok: false, error: applied.error || "Schedule apply failed", blobRestored: true, blob, schedule: SNAP, ts };
    return { ok: true, blob, schedule: SNAP, ts };
  } });
  const mkRec = () => ({ status: [], upserts: [], upsertsAs: [], snaps: 0, confirms: 0, prompts: 0, calls: 0, blobWrites: 0, alerts: 0, adopted: [], published: 0, setupReset: 0, timeOff: 0, prefs: 0, jobP: null });
  // The REAL clearSchedule / restoreSnapshot / resetAllData / acceptPreview for one app session, every effect recorded in
  // rec (the confirm and the snapshot asked, the setup writes, the statuses, the setup adopted); o.captureGate /
  // o.upsertGate / o.upsertGate2: a slow snapshot capture / a slow first / second setup write; o.upsertFails:
  // { table: "throw" | an {error} text } (20/n); o.server: the setup rows a write that lands replaces; o.env:
  // overrides (a component's setters and refs). Every setup write is recorded with the token it goes out with.
  const appJobs = (A, rec, o = {}) => {
    const ra = G.runAuth({ schedSyncRef: A.schedSyncRef, setScheduleHistory: A.setScheduleHistory });
    const sup = { from: (tb) => ({ upsert: async (row) => {
      rec.upserts.push(tb); const s = A.auth.getSession(); rec.upsertsAs.push(tb + ":" + (s ? s.access_token : "ANON"));
      if (o.upsertGate && rec.upserts.length === 1) await o.upsertGate;
      if (o.upsertGate2 && rec.upserts.length === 2) await o.upsertGate2;
      const f = o.upsertFails && o.upsertFails[tb];
      if (f === "throw") throw new TypeError("Failed to fetch");
      if (f) return { error: f };
      if (o.server && row) o.server[tb] = row.data;
      return { error: null };
    } }) };
    const capture = async () => { rec.snaps++; if (o.captureGate) await o.captureGate; return o.captureFails ? { ok: false, error: "snapshot insert failed: HTTP 401" } : { ok: true }; }; // (21/n o.captureFails: its insert refused — r4-fix-6)
    const confirm = () => { rec.confirms++; return true; };
    const env = (base) => Object.assign(base, o.env || {});
    return {
      clear: () => G.clear(env({ schedEditable: A.schedEditable, confirm, snapshots: { capture }, schedSyncRef: A.schedSyncRef, showToast: A.showToast,
        scheduleRef: A.ref, pushUndo: A.pushUndo, commitSchedule: A.commitSchedule, setSaveStatus: (s) => rec.status.push(s), runAuthoritativeSchedule: ra, setTimeout: () => 0, lastSyncRef: { current: null },
        buildStateBundle: (x) => Object.assign({}, x), stateBundleRef: { current: (x) => Object.assign({}, x) }, setupReadRef: { current: true }, auth: A.auth, supabase: sup, console: A.console }))(),
      restore: (SNAP, so) => G.restore(env({ schedEditable: A.schedEditable, isScheduler: true, userProfile: null, setRestoreBusyId: noopX, setSaveStatus: (s) => rec.status.push(s),
        snapshots: restoreStub(SNAP, Object.assign({ rec }, so || {})), scheduleRef: A.ref, pushUndo: A.pushUndo, commitSchedule: A.commitSchedule, runAuthoritativeSchedule: ra, schedSyncRef: A.schedSyncRef, confirm, snapshotReasonLabel: (r) => r,
        showToast: A.showToast, setSurgeons: noopX, setApps: noopX, setBackupMondaySet: noopX, setFierceBackupSet: noopX, setAppShifts: noopX, setPriorCounts: noopX, setYear1Counts: noopX, setStartMonth: noopX, setStartYear: noopX,
        setNumWeeks: (n) => rec.adopted.push(n), setStartMondayOverride: noopX, setHolidayAssignments: noopX, setPendingLocks: noopX, setSilvisRule: noopX, sfRule: (x) => x, SF_RULE_DEFAULT: {}, setDismissedWarnings: noopX,
        lastSyncRef: { current: null }, everHadRealDataRef: { current: false }, logAudit: noopX, loadSnapshots: noopX, setTimeout: () => 0, alert: () => { rec.alerts++; } }))({ id: 9, reason: "manual", created_at: "2026-10-13T00:00:00Z" }),
      reset: () => G.reset(env({ isScheduler: true, userProfile: null, alert: noopX, schedEditable: A.schedEditable, prompt: () => { rec.prompts++; return "RESET"; }, setSaveStatus: (s) => rec.status.push(s), setTimeout: () => 0,
        snapshots: { capture }, schedSyncRef: A.schedSyncRef, showToast: A.showToast, logAudit: noopX, allowWipeSaveRef: { current: false }, everHadRealDataRef: { current: true },
        supabase: sup, console: A.console, setSurgeons: () => { rec.setupReset++; }, INIT_SURGEONS: [], setApps: noopX, INIT_APPS: [], toClearAll: async () => { rec.timeOff++; return { ok: true }; }, // (21/n: it answers { ok } — review r4 fixes-2)
        setBackupMondaySet: noopX, setFierceBackupSet: noopX, scheduleRef: A.ref, commitSchedule: A.commitSchedule, runAuthoritativeSchedule: (...a) => (rec.jobP = ra(...a)),
        setAppShifts: noopX, setPriorCounts: noopX, setYear1Counts: noopX, setStartMonth: noopX, setStartYear: noopX }))(),
      accept: (weeks) => F.acceptPreview(env({ publishSearchRunning: () => false, showToast: A.showToast, cancelSearch: noopX, previewSchedule: weeks, previewNeedsOk: { items: [], cost: 0 }, previewAck: true,
        publishingRef: { current: false }, schedEditable: A.schedEditable, schedSyncRef: A.schedSyncRef, previewEpochRef: { current: A.eng.epochNow() }, previewOrigin: "generated", startMonth: 0, startYear: 2030, numWeeks: 2,
        setPublishing: noopX, setSaveStatus: (s) => rec.status.push(s), snapshots: { capture }, previewSchedRef: { current: weeks },
        publishWeeks: (w) => { rec.published++; A.pushUndo(); A.commitSchedule(Object.assign({}, A.ref.current, w)); return {}; }, MO: HX.MO, runPublish: F.runPublish({ schedSyncRef: A.schedSyncRef }),
        setPreviewSchedule: noopX, setShowPreview: noopX, setCalMonth: noopX, setCalYear: noopX, setView: noopX, setTimeout: () => 0, publishNotLanded: F.notLanded({ showToast: A.showToast }) }))(),
      // Generate & Publish after its search (finishGenerate, as AH9: a clean result, unchanged inputs) — its commit recorded, not run
      finish: (RES) => G.finish({ pendingLocks: [], nameOf: (x) => x, slotLabel: () => "slot", showToast: A.showToast, setPreviewSchedule: noopX, setPreviewOrigin: noopX, setShowPreview: noopX,
        genInputsSig: () => "SIG0", listScheduleBends: () => ({ items: [] }), surgeons: [], mondays: [], buildGenAvailability: () => ({}), buildSilvisPrimary: () => null, vacations: {}, holidayAssignments: {}, buildPrevWeekSeed: () => null,
        publishingRef: { current: false }, setPublishing: noopX, setSaveStatus: (s) => rec.status.push(s), snapshots: { capture },
        genCommitRef: { current: async () => { rec.published++; return { ok: true }; } }, previewEpochRef: { current: -1 }, schedEditable: A.schedEditable, schedSyncRef: A.schedSyncRef })(RES, false, "SIG0", [], A.eng.epochNow()),
      // Generate / Generate & Publish at the click (doGenerate) — up to its first step past the gates (buildPrefs, which stops it here)
      gen: (preview) => G.gen({ searchRef: { current: null }, showToast: A.showToast, schedEditable: A.schedEditable, schedSyncRef: A.schedSyncRef, buildPrefs: () => { rec.prefs++; throw new Error("STOP"); } })(preview).catch(e => "stopped:" + (e && e.message)),
    };
  };

  // SE-X9 — 17/n P1 (review r1 app-2 = regress-synced-while-unsaved): what the
  // header says while an edit is unsaved, through the app's OWN wiring — the
  // real commitSchedule (it asks the engine to report), updateSchedule, the
  // weeks push effect, the engine as wired (onStatus → setSchedSync) and the
  // real schedSyncLine: the edit reads "saving" from its commit — before the
  // push's 800-ms debounce has fired — and while its PATCH is on the wire;
  // no report reads "synced" until the table holds it; then "synced".
  await run("SE-X9", async () => {
    if (!gotG("SE-X9 17/n P1", ["commit", "pushFx"]) || typeof lineX !== "function") return;
    const { t, A } = await pair(); await ticks(A);
    const idle = LV(A.sync), seen = [];
    A.onSync = (st) => seen.push({ l: LV(st), landed: t.get(X[0]).data.dayCall === "s7" });
    A.edit(X[0], w => (w.dayCall = "s7", w));           // a swap: the real updateSchedule → commitSchedule
    for (let j = 0; j < 4; j++) await null;               // (the commit's microtask)
    const atCommit = LV(A.sync);
    const timers = [];
    G.pushFx({ loaded: true, isPublicMode: false, schedSyncRef: A.schedSyncRef, setTimeout: (f, ms) => { timers.push([f, ms]); return timers.length; }, clearTimeout: () => {} })(); // the push effect for that render: its timer set, not fired
    const inDebounce = LV(A.sync);
    const hold = t.control.pause({ method: "PATCH", count: 1 });
    timers[0][0]();                                       // 800 ms later: the push
    await hold.arrived;
    const onWire = LV(A.sync), tableThen = t.get(X[0]).data.dayCall;
    hold.release(); await ticks(A);
    const after = LV(A.sync), early = seen.filter(x => !x.landed);
    check("SE-X9 17/n P1 the header through the app's real wiring (commitSchedule, the push effect, onStatus → setSchedSync, schedSyncLine): idle 'synced'; an edit reads 'saving:1' from its commit — before the push's 800-ms debounce has fired — and while its PATCH is on the wire (the table not yet changed); no report reads 'synced' until the table holds the edit; then 'synced'",
      idle === "synced:0" && atCommit === "saving:1" && timers.length === 1 && timers[0][1] === 800 && inDebounce === "saving:1" && onWire === "saving:1" && tableThen === "s1"
        && early.length > 0 && early.every(x => x.l === "saving:1") && after === "synced:0" && t.get(X[0]).data.dayCall === "s7",
      JSON.stringify({ idle, atCommit, inDebounce, onWire, after, seen }));
  });

  // SE-X10 — 17/n P2 (review r1 app-1) and P3 (app-4): clear, restore and
  // factory reset hand the engine the screen as it was before their commit
  // (`before`). The REAL clearSchedule, restoreSnapshot (its snapshot read
  // stubbed as config.js's restore runs it: the confirm, then the schedule
  // leg), resetAllData and runAuthoritativeSchedule, on the app's engine: an
  // edited week and a new local week pending from BEFORE the tap (their writes
  // threw, the read-backs failed), then the job's whole-table read fails →
  // both shown again and still pending, nothing written by the job, its Undo
  // step taken back (the screen is where that step would take it; the earlier
  // step stays), ONE message; and the follow-up push lands both. P3: the
  // refused reset says what DID happen — the setup, APP shifts and time off
  // were reset, the weeks NOT cleared, and why — never "nothing was changed",
  // and no "Reset complete"; a reset that lands says "Reset complete" only
  // once its job has.
  await run("SE-X10", async () => {
    if (!gotG("SE-X10 17/n P2 / P3", ["runAuth", "clear", "reset", "restore"])) return;
    const noop = () => {};
    const SNAP = { [X[0]]: wkX("s6", ["s1", "s2", "s3", "s4", "s5"]), [X[1]]: wkX("s5", ["s1", "s2", "s3", "s4", "s6"]) };
    // config.js's restore, as far as the schedule leg goes: the confirm, (the before_restore capture and the blob) then the leg
    const snapStub = restoreStub(SNAP, { rec: { calls: 0, blobWrites: 0 } });
    const upsertStub = (rec) => ({ from: () => ({ upsert: async () => { rec.upserts++; return { error: null }; } }) });
    const clearJob = (A, ra, rec) => G.clear({ schedEditable: A.schedEditable, confirm: () => true, snapshots: { capture: async () => ({ ok: true }) }, schedSyncRef: A.schedSyncRef, showToast: A.showToast,
      scheduleRef: A.ref, pushUndo: A.pushUndo, commitSchedule: A.commitSchedule, setSaveStatus: (s) => rec.status.push(s), runAuthoritativeSchedule: ra, setTimeout: () => 0, lastSyncRef: { current: null },
      buildStateBundle: (x) => Object.assign({}, x), stateBundleRef: { current: (x) => Object.assign({}, x) }, setupReadRef: { current: true }, auth: A.auth, supabase: upsertStub(rec), console: A.console })();
    const restoreJob = (A, ra, rec) => G.restore({ schedEditable: A.schedEditable, isScheduler: true, userProfile: null, setRestoreBusyId: noop, setSaveStatus: (s) => rec.status.push(s),
      snapshots: snapStub, scheduleRef: A.ref, pushUndo: A.pushUndo, commitSchedule: A.commitSchedule, runAuthoritativeSchedule: ra, schedSyncRef: A.schedSyncRef, confirm: () => true, snapshotReasonLabel: (r) => r,
      showToast: A.showToast, setSurgeons: noop, setApps: noop, setBackupMondaySet: noop, setFierceBackupSet: noop, setAppShifts: noop, setPriorCounts: noop, setYear1Counts: noop, setStartMonth: noop, setStartYear: noop,
      setNumWeeks: noop, setStartMondayOverride: noop, setHolidayAssignments: noop, setPendingLocks: noop, setSilvisRule: noop, sfRule: (x) => x, SF_RULE_DEFAULT: {}, setDismissedWarnings: noop,
      lastSyncRef: { current: null }, everHadRealDataRef: { current: false }, logAudit: noop, loadSnapshots: noop, setTimeout: () => 0, alert: () => { rec.alerts++; } })({ id: 9, reason: "manual", created_at: "2026-10-13T00:00:00Z" });
    const resetJob = (A, ra, rec) => G.reset({ isScheduler: true, userProfile: null, alert: noop, schedEditable: A.schedEditable, prompt: () => "RESET", setSaveStatus: (s) => rec.status.push(s), setTimeout: () => 0,
      snapshots: { capture: async () => ({ ok: true }) }, schedSyncRef: A.schedSyncRef, showToast: A.showToast, logAudit: noop, allowWipeSaveRef: { current: false }, everHadRealDataRef: { current: true },
      supabase: upsertStub(rec), console: A.console, setSurgeons: noop, INIT_SURGEONS: [], setApps: noop, INIT_APPS: [], toClearAll: async () => { rec.timeOff++; return { ok: true }; }, // (21/n: it answers { ok })
      setBackupMondaySet: noop, setFierceBackupSet: noop, scheduleRef: A.ref, commitSchedule: A.commitSchedule, runAuthoritativeSchedule: ra, setAppShifts: noop, setPriorCounts: noop, setYear1Counts: noop, setStartMonth: noop, setStartYear: noop })();
    const go = async (job, o = {}) => {
      const { t, A } = await pair();
      const rec = { status: [], upserts: 0, alerts: 0, timeOff: 0, jobP: null };
      if (o.pending !== false) {
        A.pushUndo();
        A.edit(X[1], w => (w.dayCall = "s7", w)); A.edit(XNEW, () => wkX("s3", ["s1", "s2", "s4", "s5", "s6"]));
        t.control.fail({ method: "PATCH", kind: "throw", count: 1 }); t.control.fail({ method: "GET", kind: "5xx-before", count: 1 }); // the edit's PATCH and its read-back fail (an unknown outcome: the push stops there — the new week waits, unsent)
        await A.eng.push(); await ticks(A);
      }
      const earlier = A.history[0], pendBefore = A.eng.pending().join();
      A.toasts.length = 0;
      const ra0 = G.runAuth({ schedSyncRef: A.schedSyncRef, setScheduleHistory: A.setScheduleHistory });
      const ra = (...args) => (rec.jobP = ra0(...args));
      if (o.refuse) t.control.fail({ method: "GET", kind: "5xx-before", count: 1 }); // the job's whole-table read
      const holdP = t.control.pause({ method: "PATCH", count: 1 }), holdI = t.control.pause({ method: "POST", count: 1 }); // the follow-up push, held: the screen is looked at first
      const from = t.log.length;
      await job(A, ra, rec);
      const during = rec.status.slice();
      if (rec.jobP) await rec.jobP;
      for (let j = 0; j < 4; j++) await null;
      const shown = { w1: A.ref.current[X[1]] ? A.ref.current[X[1]].dayCall : null, neu: !!A.ref.current[XNEW], n: Object.keys(A.ref.current).length };
      const pend = A.eng.pending().join(), hist = A.history.slice(), toasts = A.toasts.slice(), status = rec.status.slice();
      const jobWrites = writesOf(t, from).filter(e => e.applied || e.method === "DELETE").length;
      holdP.release(); holdI.release(); await ticks(A, 2);
      return { t, A, earlier, pendBefore, shown, pend, hist, toasts, status, during, jobWrites, rec };
    };
    const show = (x) => JSON.stringify({ pendBefore: x.pendBefore, shown: x.shown, pend: x.pend, hist: x.hist.length, toasts: x.toasts, status: x.status, during: x.during, jobWrites: x.jobWrites, upserts: x.rec.upserts,
      table: { w1: x.t.get(X[1]) && x.t.get(X[1]).data.dayCall, neu: !!x.t.get(XNEW), rows: x.t.rows().length }, pendingNow: x.A.eng.pending(),
      log: x.t.log.slice(-14).map(e => e.method + " " + e.url.replace(/^.*schedule_weeks/, "") + " " + e.status + (e.applied ? " applied" : "") + (e.injected ? " inj:" + e.injected : "")) });
    const PEND = [X[1], XNEW].join();
    const back = (x) => x.pendBefore === PEND && x.shown.w1 === "s7" && x.shown.neu && x.shown.n === 5 && x.pend === PEND && x.jobWrites === 0
      && x.t.get(X[1]).data.dayCall === "s7" && !!x.t.get(XNEW) && x.t.rows().length === 5 && x.A.eng.pending().length === 0;
    const READ = "Couldn't read the saved schedule — nothing was changed.";
    const cl = await go(clearJob, { refuse: true });
    check("SE-X10 17/n P2 the real clearSchedule, refused (its whole-table read fails), with an edited week and a new local week pending from BEFORE the tap: both shown again and still pending, nothing written by the job; its Undo step taken back (the earlier one stays); ONE message, no blob save; and the follow-up push lands both",
      back(cl) && cl.hist.length === 1 && cl.hist[0] === cl.earlier && cl.toasts.length === 1 && cl.toasts[0][0] === "The schedule was NOT cleared — " + READ && cl.rec.upserts === 0, show(cl));
    const rv = await go(restoreJob, { refuse: true });
    check("SE-X10 17/n P2 the real restoreSnapshot's schedule leg, refused the same way: the pending weeks shown again (not the snapshot's, not the table's) and still pending, nothing written by the job; its Undo step taken back (the earlier one stays); ONE message — (19/n P8) that the roster and setup WERE restored, the weeks not, and why: 'Restore: the roster and setup were restored, but the schedule weeks were NOT restored: Couldn't read the saved schedule. Try the restore again.'; and the follow-up push lands both",
      back(rv) && rv.hist.length === 1 && rv.hist[0] === rv.earlier && rv.toasts.length === 1 && rv.toasts[0][0] === "Restore: the roster and setup were restored, but the schedule weeks were NOT restored: Couldn't read the saved schedule. Try the restore again." && rv.toasts[0][1] === "error" && rv.rec.alerts === 0, show(rv));
    const rs = await go(resetJob, { refuse: true });
    const RESET_NOT = "Factory reset: the setup, APP shifts and time off were reset, but the schedule weeks were NOT cleared: Couldn't read the saved schedule. Run the reset again, or restore the \"Before factory reset\" snapshot.";
    check("SE-X10 17/n P2 the real resetAllData, its weeks job refused the same way: the pending weeks shown again and still pending, nothing written by the job; and the follow-up push lands both",
      back(rs) && rs.hist.length === 1 && rs.hist[0] === rs.earlier, show(rs));
    check("SE-X10 17/n P3 …its ONE message says what DID happen — '" + RESET_NOT + "' (never 'nothing was changed': the stored setup and APP shifts were cleared, time off too); no 'Reset complete'",
      rs.toasts.length === 1 && rs.toasts[0][0] === RESET_NOT && rs.toasts[0][1] === "error" && !/nothing was changed/i.test(rs.toasts[0][0]) && rs.rec.upserts === 2 && rs.rec.timeOff === 1 && !rs.status.includes("Reset complete"), show(rs));
    const ok = await go(resetJob, { pending: false });
    check("SE-X10 17/n P3 control: a factory reset that lands — every week deleted, no toast, and 'Reset complete' only once its job has (not while it runs)",
      ok.t.rows().length === 0 && ok.toasts.length === 0 && !ok.during.includes("Reset complete") && ok.status.includes("Reset complete") && ok.jobWrites === 4, show(ok));
  });

  // SE-X11 — 17/n P4 (review r1 regress-signout-blob-write, app-5): sign-out,
  // and "Sign in again" landing on another account, never write the setup.
  // The REAL sessionBoundary, handleSignOut, reauthLanded, the setup autosave
  // effect, the edge-URL save effect, the load effect, buildStateBundle and
  // commitSchedule, on the app's engine, in the emulated component (mkComp).
  await run("SE-X11", async () => {
    if (!gotG("SE-X11 17/n P4", ["commit", "boundary", "reauth", "autosave", "urlSave", "bundle"])) return;
    // (a) a scheduler with nothing pending signs out
    let sa;
    { const { A } = await pair(); const c = mkComp(A); c.render(); await c.fire(); const base = c.upserts.map(u => u.tb + ":" + u.as).join(); c.upserts.length = 0; A.toasts.length = 0;
      await G.boundary(bEnv(A, c)).handleSignOut();
      for (let i = 0; i < 3; i++) { await ticks(A); await c.fire(); }
      sa = { base, ups: c.upserts.slice(), toasts: A.toasts.slice(), roles: c.roles.slice(), isScheduler: c.st.isScheduler, armed: c.setupReadRef.current, last: c.lastSyncRef.current, signOuts: A.signOuts, renders: c.renders, shown: Object.keys(A.ref.current).length };
    }
    check("SE-X11 17/n P4 a scheduler with nothing pending signs out — the real sessionBoundary + handleSignOut (the engine resets and reloads the table: the schedule changes twice under the setup autosave): no setup write at all — none as anon, none under the old token — and no 'no permission' toast; the scheduler flag cleared at the boundary (the next account's profile sets it again), the setup autosave disarmed and its row forgotten",
      sa.base === "call_schedule_data:TOK_A,call_schedule_config:TOK_A" && sa.ups.length === 0 && !sa.toasts.some(x => /permission|Couldn't save/.test(x[0])) && sa.roles.join() === "false" && sa.isScheduler === false
        && sa.armed === false && sa.last === null && sa.signOuts === 1 && sa.renders >= 3 && sa.shown === 4, JSON.stringify(sa));
    // (b) no stored session, no boundary crossed here (another tab signed out) — 19/n P9 (review r2 regress-2, R2-1):
    // still never written (not as anon), but never silently: kept pending and SAID — "⚠ Not saved — you're signed out.
    // Sign in again" (saveError), the red "Sign in again" banner (reauthNeeded), the header not "Synced"; the same when
    // the session goes DURING the autosave's debounce (its timer); and when the SAME account signs in again (the real
    // reauthLanded — no dep of the autosave changes on a sign-in), the change kept pending goes out under the renewed token.
    const NOT_SIGNED = "⚠ Not saved — you're signed out. Sign in again";
    let sb;
    { const { t, A } = await pair(); const c = mkComp(A); c.render(); await c.fire(); c.upserts.length = 0; A.toasts.length = 0; c.status.length = 0;
      A.token = null;
      c.set("numWeeks")(20); await ticks(A); await c.fire();
      const shown1 = c.status.filter(Boolean).slice(-1)[0] || "";
      const r1 = { ups: c.upserts.length, status: c.status.slice(), err: c.saveError, reauth: c.reauth, pending: c.pendingSaveRef.current ? c.pendingSaveRef.current.numWeeks : null,
        header: lineX ? ((lineX(A.sync, { loaded: true, readOnly: false, blobStatus: !!shown1 }) || { kind: "none" }).kind) : "no line" };
      A.token = "TOK_A"; c.saveError = false; c.status.length = 0; c.reauth = 0;
      c.set("numWeeks")(21); await ticks(A);                      // signed in again there; a change here, its autosave debounced…
      const debounced = c.timers.size;
      A.token = null; await c.fire();                             // …and that tab signs out within those 800 ms
      const r2 = { ups: c.upserts.length, status: c.status.slice(), err: c.saveError, reauth: c.reauth, pending: c.pendingSaveRef.current ? c.pendingSaveRef.current.numWeeks : null };
      t.control.users.TOK_A2 = "user-a"; A.token = "TOK_A2";      // "Sign in again": the same account, a renewed session
      c.status.length = 0;
      const how = await G.reauth(sameAccount(A, c))({ id: "auth-a", email: "a@dsg.test" }); await ticks(A); await c.fire();
      sb = { r1, debounced, r2, how, ups: c.upserts.slice(), status: c.status.slice(), err: c.saveError, toasts: A.toasts.map(x => x[0]) };
    }
    check("SE-X11 19/n P9 no stored session (another tab signed out: no boundary crossed here — still armed, still a scheduler): a setup change writes NOTHING (not as anon) — but is never dropped silently: kept pending, '" + NOT_SIGNED + "' (saveError), the red 'Sign in again' banner raised, the header not 'Synced'; the same when the session goes DURING the autosave's 800-ms debounce",
      sb.r1.ups === 0 && sb.r1.status.slice(-1)[0] === NOT_SIGNED && sb.r1.err === true && sb.r1.reauth >= 1 && sb.r1.pending === 20 && sb.r1.header !== "synced"
        && sb.debounced === 1 && sb.r2.ups === 0 && sb.r2.status.slice(-1)[0] === NOT_SIGNED && sb.r2.err === true && sb.r2.reauth >= 1 && sb.r2.pending === 21, JSON.stringify(sb));
    check("SE-X11 19/n P9 …and when the SAME account signs in again (the real reauthLanded: a renewed token; no dep of the autosave changed), the setup change kept pending goes out — once, under the renewed token, the latest (numWeeks 21) — and the status says 'Saved'",
      sb.how === "same" && sb.ups.length === 1 && sb.ups[0].tb === "call_schedule_data" && sb.ups[0].as === "TOK_A2" && sb.ups[0].numWeeks === 21 && sb.status.includes("Saved") && sb.err === false, JSON.stringify(sb));
    let sbm;
    { const { A } = await pair(); const c = mkComp(A, { st: { isScheduler: false } }); c.render(); await c.fire(); c.upserts.length = 0; c.status.length = 0;
      A.token = null; c.set("numWeeks")(20); await ticks(A); await c.fire();
      sbm = { ups: c.upserts.length, status: c.status.slice(), err: c.saveError, reauth: c.reauth };
    }
    check("SE-X11 19/n P9 …a MEMBER (who never writes the setup) with no stored session: nothing written, and no false 'Not saved' or banner (the autosave's deps move for a member only by adoption)",
      sbm.ups === 0 && sbm.status.length === 0 && sbm.err === false && sbm.reauth === 0, JSON.stringify(sbm));
    // (c) "Sign in again" lands on ANOTHER account, a scheduler; its setup read works
    let sc;
    { const { t, A } = await pair(); const c = mkComp(A); c.render(); await c.fire(); c.upserts.length = 0; A.toasts.length = 0;
      const holdL = t.control.pause({ method: "GET", count: 1 }); // the engine's reload after the boundary, held: B's role arrives before the table does
      const how = await otherAccount(A, c);
      for (let j = 0; j < 8; j++) await null; // (not A.settle(): the engine's chain waits on that held read)
      const roleOn = c.st.isScheduler;
      holdL.release(); await ticks(A);                            // the table reloads: the schedule changes, with B's scheduler role on
      c.set("numWeeks")(14); await ticks(A);                      // a setup change, before B's setup has been read
      const timersBefore = c.timers.size;
      // the reload trigger: the REAL load effect reads B's setup (the server says numWeeks 26); a write still pending from a render before it fires as it's adopted
      const L = loadRig(A, c, { blob: { data: { numWeeks: 26 }, updated_at: "2026-10-14T09:00:00+00:00" } });
      await L.loaded; await ticks(A);
      const atRead = c.upserts.slice(), adopted = c.st.numWeeks;
      c.loadedAtRef.current = 1; await c.fire();                  // (past the load's 3-s quiet)
      c.set("numWeeks")(27); await ticks(A); await c.fire();
      sc = { how, roleOn, roles: c.roles.slice(), timersBefore, atRead, adopted, last: c.blobs().slice(-1)[0], reloads: c.reloads, errors: L.errors, armed: c.setupReadRef.current };
    }
    check("SE-X11 17/n P4 'Sign in again' lands on ANOTHER account (a scheduler) — the real reauthLanded, crossing the real boundary: the scheduler flag goes off at the boundary, then on from B's profile; until B's setup has been read NOTHING of this page's setup is written as B — not as the table reloads, not on a setup change, not the edge URL as B's role arrives, not a write scheduled before the read that would fire as it's adopted",
      sc.how === "switched" && sc.roleOn === true && sc.roles.join() === "false,true" && sc.timersBefore === 0 && sc.atRead.length === 0 && sc.reloads === 1 && sc.errors.length === 0, JSON.stringify(sc));
    check("SE-X11 17/n P4 …once B's setup is read (the load) it is adopted (numWeeks 26), and the autosave writes again — as B: a setup change lands under TOK_B",
      sc.adopted === 26 && sc.armed === true && !!sc.last && sc.last.as === "TOK_B" && sc.last.numWeeks === 27, JSON.stringify(sc));
    // (d) another account whose setup read FAILS at the load; the 60-s poll's read repairs it
    let sd;
    { const { A } = await pair(); const c = mkComp(A); c.render(); await c.fire(); c.upserts.length = 0; A.toasts.length = 0;
      const lastSeen = c.lastSyncRef.current; // this page's own last setup write (the mount's autosave)
      await otherAccount(A, c); await ticks(A, 2);
      let fails = 1;
      const L = loadRig(A, c, { blob: { data: { numWeeks: 13 }, updated_at: lastSeen }, blobFails: () => fails-- > 0 }); // that very row, unchanged since
      await L.loaded; await ticks(A);
      const s0 = c.status.length;
      c.loadedAtRef.current = 1; c.set("numWeeks")(15); await ticks(A); await c.fire();
      const whileFailed = { ups: c.upserts.length, status: c.status.slice(s0).join("|") };
      L.polls[0](); await ticks(A, 2);                            // the 60-s poll: its read works now
      c.loadedAtRef.current = 1; await c.fire();
      c.set("numWeeks")(28); await ticks(A); await c.fire();
      sd = { whileFailed, last: c.blobs().slice(-1)[0], numWeeks: c.st.numWeeks, errors: L.errors, toasts: A.toasts.map(x => x[0]) };
    }
    check("SE-X11 17/n P4 …another account whose setup read FAILS at the load: the autosave says it isn't saving, and writes nothing; the 60-s poll's read — of the very row this page last saw (the boundary forgot it, so it is adopted) — arms it again, and the next setup change lands as B",
      sd.whileFailed.ups === 0 && sd.whileFailed.status === "⚠ Not saving — schedule failed to load" && sd.numWeeks === 28 && !!sd.last && sd.last.as === "TOK_B" && sd.last.numWeeks === 28
        && sd.errors.length === 1 && /^Supabase load error/.test(sd.errors[0]), JSON.stringify(sd));
    // (e) 19/n r2-tests-1 (R7d): B's setup read is still OUT (held) — a render meanwhile, its timers fired: nothing of this
    // page's setup is written as B; the autosave arms only once that read has answered (and then writes as B).
    let se;
    { const { A } = await pair(); const c = mkComp(A); c.render(); await c.fire(); c.upserts.length = 0; A.toasts.length = 0;
      await otherAccount(A, c); await ticks(A, 2);                // "Sign in again" landed on B (a scheduler); the boundary disarmed the autosave
      let open; const gate = new Promise(res => { open = res; });
      const L = loadRig(A, c, { gate, blob: { data: { numWeeks: 26 }, updated_at: "2026-10-14T09:00:00+00:00" } }); // the reload's setup read: SLOW
      for (let j = 0; j < 6; j++) await null;
      c.set("numWeeks")(14); await ticks(A);                      // a render while B's setup read is still out
      await c.fire();                                             // the autosave's 800 ms pass before that read answers
      const whileOut = c.blobs().slice(), armedWhileOut = c.setupReadRef.current;
      open(); await L.loaded; await ticks(A);
      c.loadedAtRef.current = 1; c.set("numWeeks")(27); await ticks(A); await c.fire();
      se = { whileOut, armedWhileOut, adopted: c.st.numWeeks, last: c.blobs().slice(-1)[0] };
    }
    check("SE-X11 19/n (r2-tests-1) while the next account's setup read is still OUT (held), a render and its 800 ms pass: NOTHING of this page's setup is written as that account — the autosave arms only once the read has answered; then a change lands as B",
      se.whileOut.length === 0 && se.armedWhileOut === false && !!se.last && se.last.as === "TOK_B" && se.last.numWeeks === 27, JSON.stringify(se));
    // (f) 19/n r2-tests-4 (R8): an autosave timer still PENDING (A's change, debounced) when the boundary into another
    // signed-in account is crossed, coming due before the next render clears it: nothing written as that account.
    let sf;
    { const { A } = await pair(); const c = mkComp(A); c.render(); await c.fire(); c.upserts.length = 0; A.toasts.length = 0;
      c.set("numWeeks")(14); await ticks(A);                      // A's own setup change: its autosave timer is pending (800 ms)
      const pending = c.timers.size;
      const p = otherAccount(A, c);                               // "Sign in again" lands on B: the boundary runs now…
      await c.fire();                                             // …and that timer comes due before the next render clears it
      await p; await ticks(A, 2);
      sf = { pending, asB: c.blobs().filter(u => u.as === "TOK_B"), ups: c.upserts.slice() };
    }
    check("SE-X11 19/n (r2-tests-4) an autosave timer still pending when the boundary into ANOTHER signed-in account is crossed (the session is there — B's): it writes nothing as that account (this account's setup not read yet)",
      sf.pending === 1 && sf.asB.length === 0, JSON.stringify(sf));
    // (g) review r3 (G7, 19/n open item 2): with no session (another tab signed out — no boundary here), only a setup
    // that differs from the one last WRITTEN or READ is "not saved". A peer's week adopted re-runs the autosave with
    // the setup unchanged → nothing said, nothing kept; a peer's SETUP read by the poll → nothing (that is what was
    // read); then a real setting change → '⚠ Not saved — you're signed out…', kept, and once "Sign in again" lands
    // on the same account, sent once (the latest). The session going during the debounce of an unchanged setup:
    // nothing. And the clear's own setup save is no read: a change after it, signed out, is said.
    const SIGNED = "⚠ Not saved — you're signed out. Sign in again";
    const said = (c) => c.status.filter(s => s === SIGNED).length;
    let sg;
    { const { t, A, P } = await pair(); const c = mkComp(A); c.render(); await c.fire();
      const R = { blob: { data: { numWeeks: 13 }, updated_at: "2026-10-14T09:00:00+00:00" } };
      const L = loadRig(A, c, R); await L.loaded; await ticks(A); c.loadedAtRef.current = 1; await c.fire();   // this account's setup read (the load), as it is
      c.upserts.length = 0; A.toasts.length = 0; c.status.length = 0; c.reauth = 0; c.saveError = false;
      A.token = null;                                              // another tab signed out
      await P.eng.pull(); P.edit(X[1], w => (w.nights.wed = "s7", w)); await P.eng.push();
      await A.eng.pull(); await ticks(A); await c.fire();          // a peer's week adopted: the schedule moves under the autosave
      const week = { adopted: A.ref.current[X[1]].nights.wed === "s7", said: said(c), err: c.saveError, reauth: c.reauth, pending: c.pendingSaveRef.current };
      R.blob = { data: { numWeeks: 30 }, updated_at: "2026-10-14T09:30:00+00:00" };
      L.polls[0](); await ticks(A, 2); await c.fire();             // a peer's setup change, read by the poll (anon)
      const read = { numWeeks: c.st.numWeeks, said: said(c), err: c.saveError, reauth: c.reauth, pending: c.pendingSaveRef.current };
      c.set("numWeeks")(31); await ticks(A); await c.fire();       // a real setting change
      const change = { said: said(c), err: c.saveError, reauth: c.reauth, pending: c.pendingSaveRef.current ? c.pendingSaveRef.current.numWeeks : null, ups: c.upserts.length };
      t.control.users.TOK_A2 = "user-a"; A.token = "TOK_A2"; c.status.length = 0;
      const how = await G.reauth(sameAccount(A, c))({ id: "auth-a", email: "a@dsg.test" }); await ticks(A); await c.fire();
      sg = { week, read, change, how, ups: c.upserts.slice(), status: c.status.slice() };
    }
    check("SE-X11 (review r3, G7) no session, the setup UNCHANGED: a peer's week adopted (the autosave re-runs) says nothing and keeps nothing — no 'Not saved', no banner — nor does a peer's setup change read by the poll (it is what was read: numWeeks 30)",
      sg.week.adopted && sg.week.said === 0 && sg.week.err === false && sg.week.reauth === 0 && sg.week.pending === null
        && sg.read.numWeeks === 30 && sg.read.said === 0 && sg.read.err === false && sg.read.reauth === 0 && sg.read.pending === null, JSON.stringify(sg));
    check("SE-X11 (review r3, G7) …then a REAL setting change (numWeeks 31): '" + SIGNED + "', the banner, kept pending, nothing written — and 'Sign in again' on the same account sends it once, under the renewed token, the latest (31)",
      sg.change.said === 1 && sg.change.err === true && sg.change.reauth >= 1 && sg.change.pending === 31 && sg.change.ups === 0
        && sg.how === "same" && sg.ups.length === 1 && sg.ups[0].tb === "call_schedule_data" && sg.ups[0].as === "TOK_A2" && sg.ups[0].numWeeks === 31 && sg.status.includes("Saved"), JSON.stringify(sg));
    let sh;
    { const { t, A, P } = await pair(); const c = mkComp(A); c.render(); await c.fire(); c.upserts.length = 0; c.status.length = 0; c.reauth = 0; c.saveError = false;
      await P.eng.pull(); P.edit(X[1], w => (w.nights.wed = "s7", w)); await P.eng.push();
      await A.eng.pull(); await ticks(A);                          // signed in: a peer's week adopted — the autosave's timer armed (an unchanged setup)
      const armed = c.timers.size;
      A.token = null; await c.fire();                              // …and the session goes within its 800 ms
      sh = { armed, said: said(c), err: c.saveError, reauth: c.reauth, pending: c.pendingSaveRef.current, ups: c.upserts.length };
    }
    check("SE-X11 (review r3, G7) …the session going DURING the autosave's debounce of an UNCHANGED setup (a peer's week adopted): nothing said, nothing kept, nothing written",
      sh.armed === 1 && sh.said === 0 && sh.err === false && sh.reauth === 0 && sh.pending === null && sh.ups === 0, JSON.stringify(sh));
    // (21/n, H5 — review r4 fixes-1: this control used to depend on the clock. A write before the clear (the mount's
    // autosave) and the clear's own write landing in the SAME millisecond made the G7e mutant behave like the real
    // code, so nothing killed it — a random red CI gate on a clean tree. Now there is no write before the clear: the
    // baseline's moment is mkComp's fixed one, which no fresh timestamp can equal; and the baseline itself is checked:
    // the clear keeps its SETUP and takes the clear's write as its moment — at === lastSyncRef.)
    let si;
    { const { t, A } = await pair(); await ticks(A); const c = mkComp(A); c.render(); c.timers.clear(); c.upserts.length = 0; c.status.length = 0; c.reauth = 0; c.saveError = false; // (the mount's debounced writes never come due before the clear)
      const base0 = c.setupBaseRef.current ? { at: c.setupBaseRef.current.at, sig: c.setupBaseRef.current.sig } : null;
      const rec = mkRec(), J = appJobs(A, rec, { env: { setSaveStatus: (s) => c.status.push(s), lastSyncRef: c.lastSyncRef, stateBundleRef: c.bundleRef, setupReadRef: c.setupReadRef, supabase: c.supabase, setupBaseRef: c.setupBaseRef } });
      await J.clear(); await ticks(A, 2);                          // the clear lands, with its own setup save
      const clearSaved = c.blobs().filter(b => b.clear).length;
      const after = c.setupBaseRef.current ? { at: c.setupBaseRef.current.at, sig: c.setupBaseRef.current.sig } : null, last = c.lastSyncRef.current;
      c.status.length = 0; A.token = null;                         // another tab signed out
      c.set("numWeeks")(22); await ticks(A); await c.fire();       // a setting change
      si = { base0, after, last, clearSaved, rows: t.rows().length, said: said(c), pending: c.pendingSaveRef.current ? c.pendingSaveRef.current.numWeeks : null };
    }
    check("SE-X11 (review r3, G7) …the clear's own setup save isn't a read: a setting change after it, signed out, is said ('" + SIGNED + "') and kept — (H5, re-pinned 21/n) clock-independent: the baseline keeps its setup (the signature before the clear) and takes the clear's write as its moment (at === lastSyncRef, the clear's)",
      si.clearSaved === 1 && si.rows === 0 && si.said === 1 && si.pending === 22
        && !!si.base0 && si.base0.at === "2026-10-01T08:00:00+00:00" && !!si.after && si.after.sig === si.base0.sig && si.after.at === si.last && si.last !== si.base0.at, JSON.stringify(si));
    // (r4-fix-9) …and with no session, time off reloaded — a new vacations / no-call object (the 60-s poll's
    // loadTimeOff: a peer's vacation) — with the setup unchanged: nothing said, nothing kept (setupSig leaves the
    // time off out: it isn't the blob's).
    let sj;
    { const { A } = await pair(); const c = mkComp(A); c.render(); await c.fire();
      const R = { blob: { data: { numWeeks: 13 }, updated_at: "2026-10-14T09:00:00+00:00" } };
      const L = loadRig(A, c, R); await L.loaded; await ticks(A); c.loadedAtRef.current = 1; await c.fire();
      c.upserts.length = 0; A.toasts.length = 0; c.status.length = 0; c.reauth = 0; c.saveError = false; c.pendingSaveRef.current = null;
      A.token = null;                                              // another tab signed out
      c.set("vacations")({ s2: [["2030-01-08", "2030-01-10", 1]], s3: [["2030-02-04", "2030-02-06", 2]] }); await ticks(A); await c.fire();
      const vac = { said: said(c), err: c.saveError, reauth: c.reauth, pending: c.pendingSaveRef.current };
      c.set("noCallDays")({ s4: [["2030-01-15", "2030-01-15", 3]] }); await ticks(A); await c.fire();
      sj = { vac, nc: { said: said(c), err: c.saveError, reauth: c.reauth, pending: c.pendingSaveRef.current }, renders: c.renders, ups: c.upserts.length };
    }
    check("SE-X11 (r4-fix-9) no session, the TIME OFF reloaded (a peer's vacation, then a no-call day — new objects, as loadTimeOff sets them) and the setup unchanged: no '" + SIGNED + "', no banner, nothing kept to send, nothing written",
      sj.vac.said === 0 && sj.vac.err === false && sj.vac.reauth === 0 && sj.vac.pending === null && sj.nc.said === 0 && sj.nc.err === false && sj.nc.reauth === 0 && sj.nc.pending === null && sj.ups === 0, JSON.stringify(sj));
  });

  // SE-X12 — 17/n P5 (review r1 regress-clear-stale-blob): the clear's own
  // setup save, after its whole job, is built from the LATEST render's state
  // (stateBundleRef), never the tap's — a setting changed during the job, or
  // another scheduler's setup adopted during it (the real poll), isn't
  // reverted by it. And (P4) it never writes across the session boundary:
  // signed out during the job → nothing written, no permission toast.
  await run("SE-X12", async () => {
    if (!gotG("SE-X12 17/n P5", ["commit", "bundle", "autosave", "urlSave", "runAuth", "clear", "boundary"])) return;
    const go = async (o) => {
      const { t, A } = await pair(); const c = mkComp(A); c.render(); await c.fire();
      const R = { blob: { data: { numWeeks: 13 }, updated_at: "2026-10-14T08:00:00+00:00" } };
      const L = o.poll ? loadRig(A, c, R) : null;
      if (L) { await L.loaded; await ticks(A); c.loadedAtRef.current = 1; await c.fire(); }
      c.upserts.length = 0; A.toasts.length = 0;
      const ra = G.runAuth({ schedSyncRef: A.schedSyncRef, setScheduleHistory: A.setScheduleHistory });
      const hold = t.control.pause({ method: "DELETE", count: 1 }); // the clear's first DELETE on the wire: the job is running
      const p = G.clear({ schedEditable: A.schedEditable, confirm: () => true, snapshots: { capture: async () => ({ ok: true }) }, schedSyncRef: A.schedSyncRef, showToast: A.showToast,
        scheduleRef: A.ref, pushUndo: A.pushUndo, commitSchedule: A.commitSchedule, setSaveStatus: (s) => c.status.push(s), runAuthoritativeSchedule: ra, setTimeout: () => 0, lastSyncRef: c.lastSyncRef,
        buildStateBundle: c.bundle /* the tap's render */, stateBundleRef: c.bundleRef, setupReadRef: c.setupReadRef, auth: A.auth, supabase: c.supabase, console: A.console })();
      await hold.arrived;
      await o.during(A, c, R, L);
      hold.release(); await p; await ticks(A, 2); await c.fire();
      const blobs = c.blobs();
      return { t, A, c, blobs, last: blobs[blobs.length - 1], toasts: A.toasts.map(x => x[0]), rows: t.rows().length };
    };
    const show = (x) => JSON.stringify({ blobs: x.blobs, toasts: x.toasts, rows: x.rows, numWeeks: x.c.st.numWeeks });
    // (no A.settle() while the job is held: the engine's chain waits on it)
    const set = await go({ during: async (A, c) => { c.set("numWeeks")(26); for (let j = 0; j < 6; j++) await null; await c.fire(); } }); // Setup changed (the autosave writes 26 meanwhile)
    check("SE-X12 17/n P5 the real clearSchedule: a setting changed DURING its job (numWeeks 13 → 26, saved by the autosave meanwhile) — its own setup save after the job carries 26 (the latest render's), not the tap's 13: the change stands; the table cleared",
      set.rows === 0 && !!set.last && set.last.clear === true && set.last.numWeeks === 26 && set.blobs.length === 2 && set.blobs[0].numWeeks === 26 && set.toasts.length === 0, show(set));
    const adopt = await go({ poll: true, during: async (A, c, R, L) => { R.blob = { data: { numWeeks: 30 }, updated_at: "2026-10-14T09:30:00+00:00" }; L.polls[0](); for (let j = 0; j < 12; j++) await null; await c.fire(); } });
    check("SE-X12 17/n P5 …another scheduler's setup adopted DURING the job (the real poll: numWeeks 30) — the clear's save carries 30, not the tap's 13: their change isn't reverted for everyone",
      adopt.rows === 0 && !!adopt.last && adopt.last.clear === true && adopt.last.numWeeks === 30 && adopt.c.st.numWeeks === 30, show(adopt));
    const out = await go({ during: async (A, c) => { await G.boundary(bEnv(A, c)).handleSignOut(); for (let j = 0; j < 6; j++) await null; } });
    check("SE-X12 17/n P4 …signed out DURING the job (the real handleSignOut: the job is fenced): the clear's setup save is NOT made — nothing written after the sign-out, as anon or otherwise; no permission / 'Couldn't save' toast",
      out.blobs.length === 0 && out.c.upserts.length === 0 && !out.toasts.some(m => /permission|Couldn't save/.test(m)) && out.A.signOuts === 1, show(out));
    const other = await go({ during: async (A, c) => { await otherAccount(A, c); for (let j = 0; j < 6; j++) await null; } });
    check("SE-X12 19/n (r2-tests-4) …'Sign in again' lands on ANOTHER account during the job (a session is there — B's — but B's setup isn't read yet): the clear's setup save is NOT made as that account",
      other.blobs.filter(u => u.as === "TOK_B").length === 0 && other.c.upserts.filter(u => u.as === "TOK_B").length === 0, show(other));
    // 19/n (r2-tests-4, P5b / R9): the boundary crossed while the clear's job RUNS, its request still out when its deadline
    // passes — so the clear is answered "still running" (not fenced: 19/n P10 silences a fenced one before its save) and goes
    // on to its setup save: never made across the boundary — not as anon after a sign-out, not as the next account.
    const lateCross = async (cross) => {
      const t = mkT(), A = mkApp(t, { timeouts: { deadline: 40 } }); await A.eng.load(); await ticks(A);
      const c = mkComp(A); c.render(); await c.fire(); c.upserts.length = 0; A.toasts.length = 0;
      const ra = G.runAuth({ schedSyncRef: A.schedSyncRef, setScheduleHistory: A.setScheduleHistory });
      const hold = t.control.pause({ method: "DELETE", count: 1 }); // the clear's first DELETE on the wire: the job runs
      const p = G.clear({ schedEditable: A.schedEditable, confirm: () => true, snapshots: { capture: async () => ({ ok: true }) }, schedSyncRef: A.schedSyncRef, showToast: A.showToast,
        scheduleRef: A.ref, pushUndo: A.pushUndo, commitSchedule: A.commitSchedule, setSaveStatus: (s) => c.status.push(s), runAuthoritativeSchedule: ra, setTimeout: () => 0, lastSyncRef: c.lastSyncRef,
        buildStateBundle: c.bundle, stateBundleRef: c.bundleRef, setupReadRef: c.setupReadRef, auth: A.auth, supabase: c.supabase, console: A.console })();
      await hold.arrived;
      await cross(A, c); for (let j = 0; j < 6; j++) await null;
      await p; await c.fire();                                    // answered at its deadline ("still running"): its setup save, if any, is made now
      const ups = c.upserts.filter(u => u.tb === "call_schedule_data");
      hold.release(); await ticks(A, 2);
      return { ups, toasts: A.toasts.map(x => x[0]) };
    };
    const lo = await lateCross(async (A, c) => { await G.boundary(bEnv(A, c)).handleSignOut(); });
    const lb = await lateCross(async (A, c) => { await otherAccount(A, c); });
    check("SE-X12 19/n (r2-tests-4; re-pinned 20/n — G1, review r3) …the boundary crossed while the clear's job RUNS, its request still out at the deadline: the clear is answered as fenced (never 'still running'), so nothing of it is said on the next screen — no 'taking longer than expected' (19/n open item 1) — and its setup save is NOT made across the boundary: not as anon after a sign-out, not as the next account after 'Sign in again' lands on another",
      lo.ups.length === 0 && lb.ups.length === 0 && lo.toasts.length === 0 && !lb.toasts.some(m => /taking longer than expected|Clearing the schedule|cleared/i.test(m)), JSON.stringify({ lo, lb }));
    // (20/n) the session gone WITHOUT a boundary crossed here (another tab signed out) as the clear's job lands: its
    // setup save is NOT made — never as anon, no false 'Couldn't save the cleared state' (P5b).
    { const { t, A } = await pair(); const c = mkComp(A); c.render(); await c.fire(); c.upserts.length = 0; A.toasts.length = 0;
      const ra = G.runAuth({ schedSyncRef: A.schedSyncRef, setScheduleHistory: A.setScheduleHistory });
      const hold = t.control.pause({ method: "DELETE", week: X[3], count: 1 }); // the clear's LAST delete on the wire
      const p = G.clear({ schedEditable: A.schedEditable, confirm: () => true, snapshots: { capture: async () => ({ ok: true }) }, schedSyncRef: A.schedSyncRef, showToast: A.showToast,
        scheduleRef: A.ref, pushUndo: A.pushUndo, commitSchedule: A.commitSchedule, setSaveStatus: (s) => c.status.push(s), runAuthoritativeSchedule: ra, setTimeout: () => 0, lastSyncRef: c.lastSyncRef,
        buildStateBundle: c.bundle, stateBundleRef: c.bundleRef, setupReadRef: c.setupReadRef, auth: A.auth, supabase: c.supabase, console: A.console, setupBaseRef: c.setupBaseRef })();
      await hold.arrived; A.token = null; hold.release();
      await p; await ticks(A, 2); await c.fire();
      const gone = { rows: t.rows().length, blobs: c.blobs(), status: c.status.slice(), toasts: A.toasts.map(x => x[0]) };
      check("SE-X12 (20/n) …the session gone WITHOUT a boundary crossed here (another tab signed out) as the clear's job lands: 'Schedule cleared', and its setup save is NOT made — never as anon, no 'Couldn't save the cleared state'",
        gone.rows === 0 && gone.status.includes("Schedule cleared") && gone.blobs.length === 0 && !gone.toasts.some(m => /Couldn't save/.test(m)), JSON.stringify(gone));
    }
  });

  // SE-X13 — 17/n P6 (review r1 regress-dup-status-line): ONE status line.
  // While the engine's busy line shows ("Clearing… / Publishing… /
  // Restoring… keep the app open"), the callers' own status says nothing — the
  // real clearSchedule, acceptPreview, commitGenerated (Generate & Publish)
  // and restoreSnapshot, each looked at with its job on the wire; "Saving
  // backup snapshot…" before the job and the final statuses stay. And the
  // header's real saveStatusShown: the setup autosave's "☁ Saved" doesn't
  // render beside a red schedule line; its errors, and the other statuses, do.
  await run("SE-X13", async () => {
    if (!gotG("SE-X13 17/n P6", ["runAuth", "clear", "restore", "genCommit"])) return;
    const noop = () => {};
    const WEEKS = () => ({ [X[0]]: wkX("s4", ["s1", "s2", "s3", "s5", "s6"]), [X[1]]: wkX("s3", ["s1", "s2", "s4", "s5", "s6"]) });
    const atJob = async (week, start) => {
      const { t, A } = await pair();
      const status = [];
      const hold = t.control.pause({ method: "GET", week, count: 1 }); // the job's own read, held: the job is running
      const p = start(A, (s) => status.push(s));
      await hold.arrived;
      const mid = { line: LV(A.sync), status: status.slice() };
      hold.release(); await p; await ticks(A, 2);
      return { mid, status, toasts: A.toasts.map(x => x[0]) };
    };
    // the status the header shows at that moment is none (empty), and no job-time status was ever set (a restore's "Restoring snapshot…" comes BEFORE its job)
    const quiet = (x) => x.mid.line === "busy:0" && (x.mid.status.length === 0 || x.mid.status[x.mid.status.length - 1] === "") && !x.status.some(s => /Clearing|Publishing|Restoring…/.test(s));
    const ra = (A) => G.runAuth({ schedSyncRef: A.schedSyncRef, setScheduleHistory: A.setScheduleHistory });
    const cl = await atJob(undefined, (A, ss) => G.clear({ schedEditable: A.schedEditable, confirm: () => true, snapshots: { capture: async () => ({ ok: true }) }, schedSyncRef: A.schedSyncRef, showToast: A.showToast,
      scheduleRef: A.ref, pushUndo: A.pushUndo, commitSchedule: A.commitSchedule, setSaveStatus: ss, runAuthoritativeSchedule: ra(A), setTimeout: () => 0, lastSyncRef: { current: null },
      buildStateBundle: (x) => Object.assign({}, x), stateBundleRef: { current: (x) => Object.assign({}, x) }, setupReadRef: { current: true }, auth: A.auth, supabase: { from: () => ({ upsert: async () => ({ error: null }) }) }, console: A.console })());
    const ac = await atJob("in.(", (A, ss) => { const weeks = WEEKS(); return F.acceptPreview({ publishSearchRunning: () => false, showToast: A.showToast, cancelSearch: noop, previewSchedule: weeks, previewNeedsOk: { items: [], cost: 0 }, previewAck: true,
      publishingRef: { current: false }, schedEditable: A.schedEditable, schedSyncRef: A.schedSyncRef, previewEpochRef: { current: A.eng.epochNow() }, previewOrigin: "generated", startMonth: 0, startYear: 2030, numWeeks: 2,
      setPublishing: noop, setSaveStatus: ss, snapshots: { capture: async () => ({ ok: true }) }, previewSchedRef: { current: weeks },
      publishWeeks: (w) => { A.pushUndo(); A.commitSchedule(Object.assign({}, A.ref.current, w)); return {}; }, MO: HX.MO, runPublish: F.runPublish({ schedSyncRef: A.schedSyncRef }),
      setPreviewSchedule: noop, setShowPreview: noop, setCalMonth: noop, setCalYear: noop, setView: noop, setTimeout: () => 0, publishNotLanded: F.notLanded({ showToast: A.showToast }) })(); });
    const gp = await atJob("in.(", (A, ss) => { ss("Saving backup snapshot…"); /* finishGenerate's, before the snapshot */ return G.genCommit({ publishWeeks: (w) => { A.pushUndo(); A.commitSchedule(Object.assign({}, A.ref.current, w)); return { merged: A.ref.current, prior: {}, y1: {} }; },
      numWeeks: 2, MO: HX.MO, startMonth: 0, startYear: 2030, runPublish: F.runPublish({ schedSyncRef: A.schedSyncRef }), setPreviewSchedule: noop, setShowPreview: noop, setSaveStatus: ss, lastSyncRef: { current: null },
      buildStateBundle: (x) => Object.assign({}, x), supabase: { from: () => ({ upsert: async () => ({ error: null }) }) }, console: A.console, showToast: A.showToast, setTimeout: () => 0, publishNotLanded: F.notLanded({ showToast: A.showToast }) })(WEEKS()); });
    const SNAP = WEEKS();
    const snapStub = restoreStub(SNAP, { rec: { calls: 0, blobWrites: 0 } });
    const rv = await atJob(undefined, (A, ss) => G.restore({ schedEditable: A.schedEditable, isScheduler: true, userProfile: null, setRestoreBusyId: noop, setSaveStatus: ss, snapshots: snapStub, scheduleRef: A.ref, pushUndo: A.pushUndo,
      commitSchedule: A.commitSchedule, runAuthoritativeSchedule: ra(A), schedSyncRef: A.schedSyncRef, confirm: () => true, snapshotReasonLabel: (r) => r, showToast: A.showToast, setSurgeons: noop, setApps: noop,
      setBackupMondaySet: noop, setFierceBackupSet: noop, setAppShifts: noop, setPriorCounts: noop, setYear1Counts: noop, setStartMonth: noop, setStartYear: noop, setNumWeeks: noop, setStartMondayOverride: noop,
      setHolidayAssignments: noop, setPendingLocks: noop, setSilvisRule: noop, sfRule: (x) => x, SF_RULE_DEFAULT: {}, setDismissedWarnings: noop, lastSyncRef: { current: null }, everHadRealDataRef: { current: false },
      logAudit: noop, loadSnapshots: noop, setTimeout: () => 0, alert: noop })({ id: 9, reason: "manual", created_at: "2026-10-13T00:00:00Z" }));
    const last = (x) => x.status[x.status.length - 1];
    check("SE-X13 17/n P6 ONE line while the job runs — the engine's 'busy' (Clearing… / Publishing… / Restoring… keep the app open) and NO status of the caller's beside it (no 'Clearing…', 'Publishing…', 'Restoring…'): the real clearSchedule, acceptPreview, commitGenerated and restoreSnapshot, each looked at with its job's own read on the wire; their final statuses still come ('Schedule cleared', 'Published — totals updated', 'Regenerated!', 'Snapshot restored')",
      quiet(cl) && last(cl) === "Schedule cleared" && quiet(ac) && last(ac) === "Published — totals updated" && quiet(gp) && last(gp) === "Regenerated!" && quiet(rv) && last(rv) === "Snapshot restored",
      JSON.stringify({ cl: [cl.mid, cl.status], ac: [ac.mid, ac.status], gp: [gp.mid, gp.status], rv: [rv.mid, rv.status] }));
    check("SE-X13 17/n P6 …and 'Saving backup snapshot…' still shows before the job (Accept & Publish, Generate & Publish); the restore says 'Reading the snapshot…' / 'Restoring snapshot…' before its job",
      ac.mid.status[0] === "Saving backup snapshot…" && gp.mid.status[0] === "Saving backup snapshot…" && rv.mid.status.join("|") === "Reading the snapshot…|Restoring snapshot…|", JSON.stringify({ ac: ac.mid.status, gp: gp.mid.status, rv: rv.mid.status }));
    // the header's save-status span, with the real schedSyncLine's kinds
    if (!gotG("SE-X13 17/n P6 the header's save status", ["saveShown"])) return;
    const { t, A } = await pair();
    t.control.fail({ method: "PATCH", week: X[0], kind: "5xx-before", count: 1 });
    A.edit(X[0], w => (w.dayCall = "s7", w)); await A.eng.push(); await ticks(A);
    const redKind = LV(A.sync).split(":")[0];
    await A.eng.push(); await ticks(A);
    const okKind = LV(A.sync).split(":")[0];
    const S = (saveStatus, saveError, schedLineKind) => G.saveShown({ saveStatus, saveError, schedLineKind });
    const RED = ["auth", "loadFailed", "notSaved", "rejected", "blocked", "stalled"], HIDES = RED.concat(["busy"]), OTHER = ["stale", "conflicts", "saving", "synced", null];
    check("SE-X13 17/n P6 the header (the real saveStatusShown): the setup autosave's '☁ Saved' does NOT render beside a red schedule line — the one a failed week write gives (the real 'notSaved') and every other red kind (sign in again, didn't load, couldn't be saved, deletions blocked, stalled) — nor (19/n P10, review r2 fixes-2) beside a job's busy line; its errors still do ('⚠ Not saved — no permission', saveError), and so do the other statuses (a job's 'Schedule cleared'); beside any other line it renders",
      redKind === "notSaved" && okKind === "synced" && S("Saved", false, redKind) === false && S("Saved", false, okKind) === true && HIDES.every(k => S("Saved", false, k) === false)
        && HIDES.every(k => S("Not saved — no permission", true, k) === true && S("Schedule cleared", false, k) === true) && OTHER.every(k => S("Saved", false, k) === true) && S("", false, "synced") === false,
      JSON.stringify({ redKind, okKind, hides: HIDES.map(k => [k, S("Saved", false, k)]), other: OTHER.map(k => [k, S("Saved", false, k)]) }));
  });

  // SE-X14 — 17/n T4 (review r1 tests-5): the engine's token() as the app
  // wires it (its real F.wire): a write refused for the stored token (401)
  // blocks writes for THAT token; once "Sign in again" stores a new one, the
  // engine is unblocked at once and the next pull sends the pending week
  // under it, by CAS, and it lands; with no stored session, auth is "none".
  // (N19 / N19b: a constant token(), one captured once.)
  await run("SE-X14", async () => {
    const { t, A } = await pair();
    t.control.expiredTokens.add("TOK_A");
    A.edit(X[2], w => (w.dayCall = "s7", w)); await A.eng.push(); await ticks(A);
    const blocked = A.eng.authBlocked() && A.eng.pending().join() === X[2] && A.eng.status().auth === "expired";
    t.control.users.TOK_A2 = "user-a"; A.token = "TOK_A2";      // "Sign in again" stored a new token
    const unblocked = !A.eng.authBlocked() && A.eng.status().auth === "ok";
    const from = t.log.length;
    await A.eng.pull(); await ticks(A);
    const w = writesOf(t, from);
    A.token = null; const none = A.eng.status().auth; A.token = "TOK_A2";
    check("SE-X14 17/n T4 the app's token() (its real wiring): after a 401 for TOK_A writes are blocked ('expired') and the week pending; a new stored token (TOK_A2) unblocks at once, and the next pull sends the week under it — one CAS PATCH, Bearer TOK_A2, landed; no stored session → 'none'",
      blocked && unblocked && w.length === 1 && w[0].method === "PATCH" && w[0].headers.authorization === "Bearer TOK_A2" && /version=eq\.3/.test(w[0].url) && w[0].status === 200
        && t.get(X[2]).data.dayCall === "s7" && A.eng.pending().length === 0 && none === "none", JSON.stringify({ blocked, unblocked, w: w.map(e => [e.method, e.headers.authorization, e.status]), none, toasts: A.toasts }));
  });

  // SE-X15 — 19/n P7 (review r2 regress-1, the app half): ONE clear / reset / restore / publish at a time from the UI
  // — the job gate (schedEditable("job")), asked at the tap and again after each await, right before the commit;
  // refused with one toast naming the job queued or running. The REAL clearSchedule, restoreSnapshot, resetAllData,
  // acceptPreview, finishGenerate and doGenerate on the app's engine. (a) R2V-1 (r2-verify-regress): an ordinary save
  // holds the chain; Clear, then Restore while the clear is queued (and the reverse); both jobs' whole-table reads fail.
  // Before P7 the second's `before` was the first's target — a saved week deleted, or the snapshot's copy written — and
  // both said "nothing was changed". Now the second is refused at its tap: nothing asked, read or written, and the table
  // is unchanged. (b) the checks after the awaits: a job requested while the second waits on its snapshot read, its blob
  // write or its own snapshot capture refuses it there — nothing of it committed, no job of its own. (c) a publish
  // refused during a clear (at its tap, after its snapshot), Generate & Publish (at its tap, after its search, after its
  // snapshot) — a Generate preview is never held back. (d) factory reset: at its tap, after its snapshot, and after the
  // stored-data clears (then the setup WAS reset, the weeks not — said so).
  await run("SE-X15", async () => {
    if (!gotG("SE-X15 19/n P7", ["runAuth", "clear", "reset", "restore", "finish", "gen"])) return;
    const BUSY = (label) => `${label} is still running — wait for it to finish, then try again.`;
    const CLEARING = BUSY("Clearing the schedule"), RESTORING = BUSY("Restoring the snapshot"), PUBLISHING = BUSY("Publishing the new weeks");
    const READ = "Couldn't read the saved schedule — nothing was changed.";
    const SNAP = () => ({ [X[0]]: wkX("s6", ["s1", "s2", "s3", "s4", "s5"]) });
    const WEEKS = () => ({ [X[0]]: wkX("s4", ["s1", "s2", "s3", "s5", "s6"]), [XNEW]: wkX("s3", ["s1", "s2", "s4", "s5", "s6"]) });
    const toastsOf = (A) => A.toasts.map(x => x[0]);
    const wire = (t, from) => writesOf(t, from).map(e => e.method + " " + e.url.replace(/^.*schedule_weeks\??/, "").split("&")[0]);
    // (a) R2V-1
    const stacked = async (order) => {
      const { t, A } = await pair(); await ticks(A);
      const rec = mkRec(), J = appJobs(A, rec);
      const hold = t.control.pause({ method: "PATCH", count: 1 });  // an ordinary save holds the chain (a slow save)
      const from = t.log.length;
      A.edit(X[3], w => (w.dayCall = "s7", w));
      const pp = A.eng.push(); await hold.arrived;
      const expect = dc(Object.assign(tableOf(t), { [X[3]]: A.ref.current[X[3]] }));
      A.toasts.length = 0;
      let p1, p2;
      if (order === "clear-then-restore") { p1 = J.clear(); for (let j = 0; j < 20; j++) await null; p2 = J.restore(SNAP()); }
      else { p1 = J.restore(SNAP()); for (let j = 0; j < 20; j++) await null; p2 = J.clear(); }
      for (let j = 0; j < 20; j++) await null;
      const pend = A.eng.jobPending();
      t.control.fail({ method: "GET", week: "limit=5000", kind: "5xx-before", count: 2 }); // the jobs' whole-table reads
      hold.release(); await pp; await p1; await p2; await ticks(A, 4);
      return { pend, rec, expect, table: dc(tableOf(t)), screen: dc(A.ref.current), toasts: toastsOf(A), pending: A.eng.pending(), writes: wire(t, from), history: A.history.length };
    };
    const showS = (x) => JSON.stringify(Object.assign({}, x, { rec: { calls: x.rec.calls, blobWrites: x.rec.blobWrites, confirms: x.rec.confirms, snaps: x.rec.snaps } }));
    const cr = await stacked("clear-then-restore");
    check("SE-X15 19/n P7 (R2V-1) the real clearSchedule, then the real restoreSnapshot while the clear is still queued (an ordinary save holds the chain), both whole-table reads failing: the restore is refused at its tap — '" + CLEARING + "' — reading, asking and writing nothing (no snapshot read, no blob, no job); the clear is refused as before; the table is unchanged (the ordinary save its only write), the screen equals it, nothing pending",
      cr.pend === "clear" && cr.rec.calls === 0 && cr.rec.blobWrites === 0 && cr.toasts.length === 2 && cr.toasts[0] === CLEARING && cr.toasts[1] === "The schedule was NOT cleared — " + READ
        && cr.table === cr.expect && cr.screen === cr.expect && cr.writes.join() === "PATCH week_monday=eq." + X[3] && cr.pending.length === 0, showS(cr));
    const rc = await stacked("restore-then-clear");
    check("SE-X15 19/n P7 (R2V-1) …the reverse — the real restoreSnapshot queued, then the real clearSchedule: the clear is refused at its tap — '" + RESTORING + "' — before its question (no confirm, no snapshot, no Undo step); the restore is refused (its weeks NOT restored, said so); the snapshot's copy is never written — the table unchanged, the screen equals it, nothing pending",
      rc.pend === "restore" && rc.rec.confirms === 1 && rc.rec.snaps === 0 && rc.toasts.length === 2 && rc.toasts[0] === RESTORING && /^Restore: the roster and setup were restored, but the schedule weeks were NOT restored: /.test(rc.toasts[1])
        && rc.table === rc.expect && rc.screen === rc.expect && rc.writes.join() === "PATCH week_monday=eq." + X[3] && rc.pending.length === 0 && rc.history === 0, showS(rc));
    // (b) the re-checks after the awaits
    { const { t, A } = await pair(); await ticks(A);
      let openRead; const slowRead = new Promise(r => { openRead = r; });
      const rec = mkRec(), J = appJobs(A, rec);
      A.toasts.length = 0;
      const holdC = t.control.pause({ method: "DELETE", count: 1 });
      const pr = J.restore(SNAP(), { beforeConfirm: slowRead });   // the restore tapped first (nothing queued): its snapshot read is slow
      for (let j = 0; j < 6; j++) await null;
      const pc = J.clear(); await holdC.arrived;                    // …a clear meanwhile: its job runs
      openRead(); for (let j = 0; j < 20; j++) await null;
      const at = { calls: rec.calls, blobWrites: rec.blobWrites, confirms: rec.confirms, toasts: toastsOf(A) };
      holdC.release(); await pc; await pr; await ticks(A, 3);
      check("SE-X15 19/n P7 …a restore tapped while nothing was queued, a clear requested while its snapshot was being read: the restore is refused once the snapshot has been read — before its question ('" + CLEARING + "') — nothing written (no blob, no job); the clear lands, and the snapshot's copy is never written",
        at.calls === 1 && at.blobWrites === 0 && at.confirms === 1 && at.toasts.join("|") === CLEARING && t.rows().length === 0 && Object.keys(A.ref.current).length === 0 && toastsOf(A).length === 1,
        JSON.stringify({ at, rows: t.rows().length, toasts: toastsOf(A) }));
    }
    { const { t, A } = await pair(); await ticks(A);
      let openBlob; const slowBlob = new Promise(r => { openBlob = r; });
      const rec = mkRec(), J = appJobs(A, rec);
      A.toasts.length = 0;
      const shown = []; A.onSchedule = (n) => shown.push(dc(n));
      const holdC = t.control.pause({ method: "DELETE", count: 1 });
      const pr = J.restore(SNAP(), { beforeApply: slowBlob, blob: { numWeeks: 20 } }); // past its question: its before_restore snapshot and blob being written
      for (let j = 0; j < 6; j++) await null;
      const pc = J.clear(); await holdC.arrived;                    // …a clear meanwhile: its job runs
      openBlob(); for (let j = 0; j < 20; j++) await null;
      const at = { toasts: toastsOf(A), snapShown: shown.some(x => x.includes(X[0] + "=s6")), adopted: rec.adopted.slice(), blobWrites: rec.blobWrites };
      holdC.release(); await pc; await pr; await ticks(A, 3);
      const RB = "Restore: the roster and setup were restored, but the schedule weeks were NOT restored: Clearing the schedule is still running — wait for it to finish. Try the restore again.";
      check("SE-X15 19/n P7 …a restore past its question, a clear requested while its before_restore snapshot and blob were written: the check right before its commit — the weeks are left as they are (never on screen, no job of the restore's), the setup it wrote is adopted (numWeeks 20), and ONE message says so: '" + RB + "'; the clear lands, the snapshot's copy never written",
        at.toasts.join("|") === RB && !at.snapShown && at.adopted.join() === "20" && at.blobWrites === 1 && t.rows().length === 0 && Object.keys(A.ref.current).length === 0 && !shown.some(x => x.includes(X[0] + "=s6")),
        JSON.stringify({ at, rows: t.rows().length, shown }));
    }
    { const { t, A } = await pair(); await ticks(A);
      let openSnap; const slowSnap = new Promise(r => { openSnap = r; });
      const rec = mkRec(), Jc = appJobs(A, rec, { captureGate: slowSnap }), rec2 = mkRec(), Jp = appJobs(A, rec2);
      A.toasts.length = 0;
      const pc = Jc.clear(); for (let j = 0; j < 20; j++) await null; // the clear: asked; its snapshot being written (slow)
      const holdP = t.control.pause({ method: "GET", week: "in.(", count: 1 });
      const pa = Jp.accept(WEEKS()); await holdP.arrived;           // an Accept & Publish meanwhile: its job runs (its re-read out)
      openSnap(); for (let j = 0; j < 20; j++) await null;
      const at = { toasts: toastsOf(A), history: A.history.length, shown: dc(A.ref.current) };
      holdP.release(); await pa; await pc; await ticks(A, 3);
      check("SE-X15 19/n P7 …a clear asked, an Accept & Publish requested while the clear's snapshot was being written: the clear is refused after its snapshot — '" + PUBLISHING + "' — no Undo step of its own, nothing committed (the published weeks stay on screen); the publish lands, nothing deleted",
        rec.confirms === 1 && rec.snaps === 1 && at.toasts.join("|") === PUBLISHING && at.history === 1 && at.shown.includes(X[0] + "=s4") && t.rows().length === 5 && t.get(X[0]).data.dayCall === "s4" && !!t.get(XNEW) && rec.upserts.length === 0,
        JSON.stringify({ at, rows: t.rows().map(r => r.week_monday + "=" + r.data.dayCall), toasts: toastsOf(A) }));
    }
    // (c) the publish paths
    { const { t, A } = await pair(); await ticks(A);
      const rec = mkRec(), J = appJobs(A, rec);
      const holdC = t.control.pause({ method: "DELETE", count: 1 });
      const pc = J.clear(); await holdC.arrived; A.toasts.length = 0; // the clear's job runs
      const snaps0 = rec.snaps;
      const pa = J.accept(WEEKS()); for (let j = 0; j < 20; j++) await null;
      const fin = await J.finish(WEEKS());                          // Generate & Publish, its search done
      const g1 = await J.gen(false), g0 = await J.gen(true);        // Generate & Publish tapped; Generate (a preview) tapped
      const at = { toasts: toastsOf(A), snaps: rec.snaps - snaps0, published: rec.published, fin, g1, g0, prefs: rec.prefs };
      holdC.release(); await pc; await pa; await ticks(A, 3);
      check("SE-X15 19/n P7 …during a clear: Accept & Publish refused at its tap, Generate & Publish refused at its tap and after its search — each '" + CLEARING + "', no snapshot taken, nothing published; a Generate PREVIEW is not held back (it goes on); the clear lands, no published week in the table",
        at.toasts.length === 3 && at.toasts.every(m => m === CLEARING) && at.snaps === 0 && at.published === 0 && at.fin === "refused" && at.g1 === "refused" && at.g0 === "stopped:STOP" && at.prefs === 1 && t.rows().length === 0,
        JSON.stringify({ at, rows: t.rows().length }));
    }
    { const { t, A } = await pair(); await ticks(A);
      let openSnap; const slowSnap = new Promise(r => { openSnap = r; });
      const rec = mkRec(), Ja = appJobs(A, rec, { captureGate: slowSnap }), rec2 = mkRec(), Jc = appJobs(A, rec2);
      A.toasts.length = 0;
      const pa = Ja.accept(WEEKS()), pf = Ja.finish(WEEKS()); for (let j = 0; j < 20; j++) await null; // both asked; their snapshots being written (slow)
      const holdC = t.control.pause({ method: "DELETE", count: 1 });
      const pc = Jc.clear(); await holdC.arrived;                    // …a clear meanwhile: its job runs
      openSnap(); for (let j = 0; j < 20; j++) await null;
      const at = { toasts: toastsOf(A), published: rec.published, snaps: rec.snaps };
      holdC.release(); await pc; const fin = await pf; await pa; await ticks(A, 3);
      check("SE-X15 19/n P7 …Accept & Publish and Generate & Publish past their taps, a clear requested while their snapshots were being written: both refused after the snapshot ('" + CLEARING + "'), nothing published; the clear lands",
        at.snaps === 2 && at.toasts.length === 2 && at.toasts.every(m => m === CLEARING) && at.published === 0 && fin === "refused" && t.rows().length === 0, JSON.stringify({ at, fin, rows: t.rows().length }));
    }
    // (d) factory reset
    { const { t, A } = await pair(); await ticks(A);
      const rec = mkRec(), J = appJobs(A, rec);
      const holdC = t.control.pause({ method: "DELETE", count: 1 });
      const pc = J.clear(); await holdC.arrived; A.toasts.length = 0;
      const rs0 = mkRec(), Jr = appJobs(A, rs0);
      await Jr.reset(); for (let j = 0; j < 6; j++) await null;
      const at = { toasts: toastsOf(A), prompts: rs0.prompts, snaps: rs0.snaps, upserts: rs0.upserts.length, setup: rs0.setupReset };
      holdC.release(); await pc; await ticks(A, 3);
      check("SE-X15 19/n P7 …a factory reset tapped during a clear: refused at its tap — '" + CLEARING + "' — before its typed confirmation; nothing captured, cleared or written",
        at.toasts.join("|") === CLEARING && at.prompts === 0 && at.snaps === 0 && at.upserts === 0 && at.setup === 0, JSON.stringify(at));
    }
    { const { t, A } = await pair(); await ticks(A);
      let openSnap; const slowSnap = new Promise(r => { openSnap = r; });
      const rs0 = mkRec(), Jr = appJobs(A, rs0, { captureGate: slowSnap }), rec = mkRec(), J = appJobs(A, rec);
      A.toasts.length = 0;
      const pr = Jr.reset(); for (let j = 0; j < 20; j++) await null; // confirmed; its snapshot being written (slow)
      const holdC = t.control.pause({ method: "DELETE", count: 1 });
      const pc = J.clear(); await holdC.arrived;
      openSnap(); await pr; for (let j = 0; j < 6; j++) await null;
      const at = { toasts: toastsOf(A), upserts: rs0.upserts.length, setup: rs0.setupReset, status: rs0.status.slice() };
      holdC.release(); await pc; await ticks(A, 3);
      check("SE-X15 19/n P7 …a factory reset past its question, a clear requested while its snapshot was being written: refused after the snapshot, before the first write ('" + CLEARING + "', 'Reset cancelled') — the setup not cleared, nothing written",
        at.toasts.join("|") === CLEARING && at.upserts === 0 && at.setup === 0 && at.status.includes("Reset cancelled"), JSON.stringify(at));
    }
    { const { t, A } = await pair(); await ticks(A);
      let openUp; const slowUp = new Promise(r => { openUp = r; });
      const rs0 = mkRec(), Jr = appJobs(A, rs0, { upsertGate: slowUp }), rec = mkRec(), J = appJobs(A, rec);
      A.toasts.length = 0;
      const pr = Jr.reset(); for (let j = 0; j < 20; j++) await null; // its stored-data clears under way (the first one slow)
      const holdC = t.control.pause({ method: "DELETE", count: 1 });
      const pc = J.clear(); await holdC.arrived;
      openUp(); await pr; for (let j = 0; j < 6; j++) await null;
      const at = { toasts: toastsOf(A), upserts: rs0.upserts.slice(), setup: rs0.setupReset, timeOff: rs0.timeOff, job: rs0.jobP !== null };
      holdC.release(); await pc; await ticks(A, 3);
      const RSB = "Factory reset: the setup, APP shifts and time off were reset, but the schedule weeks were NOT cleared: Clearing the schedule is still running — wait for it to finish. Run the reset again, or restore the \"Before factory reset\" snapshot.";
      check("SE-X15 19/n P7 …a factory reset whose stored-data clears were under way when a clear was requested: the check right before its commit — no weeks job of its own (the weeks left as they are, to the clear), and ONE message says what DID happen: '" + RSB + "'",
        at.toasts.join("|") === RSB && at.upserts.join() === "call_schedule_data,app_shifts_data" && at.setup === 1 && at.timeOff === 1 && at.job === false && t.rows().length === 0, JSON.stringify(at));
    }
    // (e) review r3 tests-3 (G5, R3M09): a PUBLISH queued, not started (behind a slow save), counts as pending too —
    // the real clearSchedule tapped then is refused at its tap; jobPending() names the publish; the header is busy.
    { const { t, A } = await pair(); await ticks(A);
      const rec = mkRec(), J = appJobs(A, rec), rec2 = mkRec(), Jc = appJobs(A, rec2);
      const hold = t.control.pause({ method: "PATCH", count: 1 });
      A.edit(X[3], w => (w.dayCall = "s7", w)); const pp = A.eng.push(); await hold.arrived;   // a slow save holds the chain
      const pa = J.accept({ [X[0]]: wkX("s4", ["s1", "s2", "s3", "s5", "s6"]) }); for (let j = 0; j < 20; j++) await null; // the publish: QUEUED
      const pend = A.eng.jobPending(), busyLine = LV(A.sync);
      A.toasts.length = 0;
      const pc = Jc.clear(); for (let j = 0; j < 20; j++) await null;
      const at = { toasts: toastsOf(A), confirms: rec2.confirms, snaps: rec2.snaps };
      hold.release(); await pp; await pa; await pc; await ticks(A, 4);
      check("SE-X15 (review r3 tests-3) …a PUBLISH queued, not started (behind a slow save), counts too: the real clearSchedule tapped then is refused at its tap — '" + PUBLISHING + "' — before its question (no confirm, no snapshot); jobPending() names the publish and the header says it is busy; the publish lands, nothing deleted",
        rec.published === 1 && pend === "publish" && /^busy/.test(busyLine) && at.confirms === 0 && at.snaps === 0 && at.toasts.join("|") === PUBLISHING && t.rows().length === 4 && t.get(X[0]).data.dayCall === "s4",
        JSON.stringify({ pend, busyLine, at, rows: t.rows().map(r => r.week_monday + "=" + r.data.dayCall), toasts: toastsOf(A) }));
    }
  });

  // SE-X16 — 19/n P8 (review r2 fixes-1; 17/n's open item "a refused restore says nothing was changed"): a factory reset
  // or a restore whose weeks job is refused — in time, or after its deadline (opts.late, E8) — says what really
  // happened, never "nothing was changed": the setup was reset / restored, the weeks NOT, and why. The restore's setup
  // (written before the weeks job) is adopted, so no autosave writes the pre-restore setup back over it.
  await run("SE-X16", async () => {
    if (!gotG("SE-X16 19/n P8", ["runAuth", "reset", "restore", "commit", "autosave", "bundle"])) return;
    const LATE_T = { deadline: 40 };
    const WHOLE = "select=week_monday,data";                       // a whole-table read (the job's own; not the pull's version list)
    const RUNNING = (label) => `${label} is taking longer than expected. It's still running — keep the app open; you'll see a message when it ends.`;
    const RESET_NOT = (why) => `Factory reset: the setup, APP shifts and time off were reset, but the schedule weeks were NOT cleared: ${why} Run the reset again, or restore the "Before factory reset" snapshot.`;
    const RESTORE_NOT = (why) => `Restore: the roster and setup were restored, but the schedule weeks were NOT restored: ${why} Try the restore again.`;
    const READ_WHY = "Couldn't read the saved schedule.", AUTH_WHY = "Your sign-in has expired — tap \"Sign in again\", then retry.";
    const lateApp = async () => { const t = mkT(), A = mkApp(t, { timeouts: LATE_T }); await A.eng.load(); return { t, A }; };
    // (a) the factory reset's weeks job STARTS in time and is refused after its deadline (r2-verify-fixes v1-reset-late)
    { const { t, A } = await lateApp(); await ticks(A); const rec = mkRec(), J = appJobs(A, rec);
      t.control.fail({ method: "GET", week: WHOLE, kind: "5xx-before", count: 1 });
      const hold = t.control.pause({ method: "GET", week: WHOLE, count: 1 });  // its whole-table read: out — it answers 503 once released
      A.toasts.length = 0;
      await J.reset(); await hold.arrived; await nap(LATE_T.deadline + 40);
      const atDeadline = A.toasts.map(x => x.join(":"));
      hold.release(); if (rec.jobP) await rec.jobP; await ticks(A, 3); await nap(5); await ticks(A);
      const all = A.toasts.map(x => x[0]);
      check("SE-X16 19/n P8 (review r2 fixes-1) the real resetAllData, its weeks job started in time and refused AFTER its deadline: first 'still running' (info), then ONE message in the reset's own words (opts.late) — '" + RESET_NOT(READ_WHY) + "' — never the engine's 'Clearing the schedule stopped — … nothing was changed.'; the weeks unchanged",
        atDeadline.join("|") === RUNNING("Clearing the schedule") + ":info" && A.toasts.length === 2 && A.toasts[1][0] === RESET_NOT(READ_WHY) && A.toasts[1][1] === "error"
          && !all.some(m => /nothing was changed/i.test(m)) && rec.upserts.length === 2 && rec.timeOff === 1 && t.rows().length === 4, JSON.stringify({ toasts: A.toasts, rows: t.rows().length }));
    }
    // (b) r2-tests-5: refused for the SIGN-IN at its own whole-table read (the server refuses A's token; the device didn't know)
    { const { t, A } = await pair(); await ticks(A); const rec = mkRec(), J = appJobs(A, rec);
      t.control.expiredTokens.add("TOK_A"); A.toasts.length = 0;
      await J.reset(); if (rec.jobP) await rec.jobP; for (let j = 0; j < 6; j++) await null;
      const msg = (A.toasts.find(x => /^Factory reset/.test(x[0])) || [""])[0];
      check("SE-X16 19/n P8 (r2-tests-5) …a factory reset refused for the SIGN-IN (the token refused at the job's own whole-table read — the gate had passed): exactly '" + RESET_NOT(AUTH_WHY) + "' — no 'Nothing was changed.' after the setup was reset",
        rec.upserts.length === 2 && msg === RESET_NOT(AUTH_WHY) && !A.toasts.some(x => /nothing was changed/i.test(x[0])), JSON.stringify(A.toasts));
      await A.settle();
    }
    // (c) – (f) a restore: its weeks job refused in time / for the sign-in / after its deadline / partly failed — in a
    // component (the setup autosave running), its snapshot's setup numWeeks 20 (the screen's: 13)
    const restoreIn = async (o) => {
      const { t, A } = o.late ? await lateApp() : await pair(); await ticks(A);
      const c = mkComp(A); c.render(); await c.fire(); c.upserts.length = 0; A.toasts.length = 0;
      const orig = dc(tableOf(t));
      const rec = mkRec(), J = appJobs(A, rec, { env: { setNumWeeks: c.set("numWeeks"), lastSyncRef: c.lastSyncRef, everHadRealDataRef: c.everRef } });
      const SN = { [X[0]]: wkX("s6", ["s1", "s2", "s3", "s4", "s5"]), [X[1]]: wkX("s5", ["s1", "s2", "s3", "s4", "s6"]) };
      if (o.inject) o.inject(t);
      const hold = o.late ? t.control.pause({ method: "GET", week: WHOLE, count: 1 }) : null;
      const p = J.restore(SN, { blob: { numWeeks: 20 } });
      if (hold) { await hold.arrived; await nap(LATE_T.deadline + 40); }
      const atDeadline = A.toasts.map(x => x.join(":"));
      if (hold) hold.release();
      await p; await ticks(A, 3); await nap(5); await ticks(A, 2);
      c.loadedAtRef.current = 1; await c.fire();                   // the setup autosave, re-run by the adoption and by the weeks put back
      return { t, A, c, rec, orig, atDeadline, toasts: A.toasts.map(x => x.join(":")), blobs: c.blobs(), numWeeks: c.st.numWeeks, table: dc(tableOf(t)), rows: t.rows().length };
    };
    const showR = (x) => JSON.stringify({ toasts: x.toasts, atDeadline: x.atDeadline, blobs: x.blobs, numWeeks: x.numWeeks, table: x.table, orig: x.orig, alerts: x.rec.alerts });
    const setupKept = (x) => x.numWeeks === 20 && x.blobs.length >= 1 && x.blobs.every(b => b.numWeeks === 20 && b.as === "TOK_A");
    const inTime = await restoreIn({ inject: (t) => t.control.fail({ method: "GET", week: WHOLE, kind: "5xx-before", count: 1 }) });
    check("SE-X16 19/n P8 a restore whose weeks job is refused IN time (its read fails): ONE message — '" + RESTORE_NOT(READ_WHY) + "' (never 'Restore failed … nothing was changed': the roster and setup were written first); the restored setup is ADOPTED (numWeeks 20), so the setup autosave writes it — never the pre-restore one; the weeks unchanged",
      inTime.toasts.join("|") === RESTORE_NOT(READ_WHY) + ":error" && setupKept(inTime) && inTime.table === inTime.orig && inTime.rec.alerts === 0, showR(inTime));
    const auth = await restoreIn({ inject: (t) => t.control.expiredTokens.add("TOK_A") });
    check("SE-X16 19/n P8 …refused for the SIGN-IN: '" + RESTORE_NOT(AUTH_WHY) + "' — its 'Nothing was changed.' dropped; the setup adopted",
      auth.toasts.filter(m => /^Restore/.test(m)).join("|") === RESTORE_NOT(AUTH_WHY) + ":error" && auth.numWeeks === 20 && !auth.toasts.some(m => /nothing was changed/i.test(m)), showR(auth));
    const late = await restoreIn({ late: true, inject: (t) => t.control.fail({ method: "GET", week: WHOLE, kind: "5xx-before", count: 1 }) });
    check("SE-X16 19/n P8 …its weeks job started in time and refused AFTER its deadline: 'The roster and setup are restored. " + RUNNING("Restoring the snapshot") + "' (info), then ONE message in the restore's words (opts.late) — '" + RESTORE_NOT(READ_WHY) + "' — never the engine's 'Restoring the snapshot stopped — … nothing was changed.'; the setup adopted, never written back as it was",
      late.atDeadline.join("|") === "The roster and setup are restored. " + RUNNING("Restoring the snapshot") + ":info" && late.toasts.length === 2 && late.toasts[1] === RESTORE_NOT(READ_WHY) + ":error"
        && setupKept(late) && late.table === late.orig, showR(late));
    const part = await restoreIn({ inject: (t) => t.control.fail({ method: "PATCH", week: X[1], kind: "5xx-before", count: 1 }) });
    check("SE-X16 19/n P8 …a restore whose weeks job PARTLY failed (one week's write refused, retried): 'Restore: the roster and setup were restored, but not every schedule week is saved yet: Couldn't save 1 week yet — retrying every minute while the app is open.' (not 'Restore failed'); the setup adopted; the follow-up push lands the week",
      part.toasts.join("|") === "Restore: the roster and setup were restored, but not every schedule week is saved yet: Couldn't save 1 week yet — retrying every minute while the app is open.:error"
        && setupKept(part) && part.rows === 2 && part.t.get(X[1]).data.dayCall === "s5", showR(part));
  });

  // SE-X17 — 19/n P10: the small message and status fixes. (a) review r2 fixes-2: the setup autosave's "☁ Saved" doesn't
  // render beside a job's busy line either — the real clearSchedule with its job running, the autosave re-run by its
  // commit and saved meanwhile. (b) a clear cancelled at its deadline says the schedule is as it was and to try again in a
  // minute — never "reload" (edits waiting to save are back on screen; a phone's reload doesn't ask). (c) a job fenced by
  // a sign-out (running: skipped "reset"; still queued: cancelled) says nothing on the sign-in screen — clear, factory
  // reset, restore (nothing adopted either) and a publish.
  await run("SE-X17", async () => {
    if (!gotG("SE-X17 19/n P10", ["runAuth", "clear", "reset", "restore", "commit", "autosave", "bundle", "boundary", "saveShown"])) return;
    // (a)
    { const { t, A } = await pair(); await ticks(A); const c = mkComp(A); c.render(); await c.fire(); c.status.length = 0; c.upserts.length = 0;
      const rec = mkRec(), J = appJobs(A, rec, { env: { setSaveStatus: (s) => c.status.push(s), lastSyncRef: c.lastSyncRef, stateBundleRef: c.bundleRef, setupReadRef: c.setupReadRef, supabase: c.supabase } });
      const hold = t.control.pause({ method: "DELETE", count: 1 });  // the clear's first DELETE on the wire: its job runs
      const p = J.clear(); await hold.arrived;
      for (let j = 0; j < 6; j++) await null; await c.fireOnce();   // the autosave's 800 ms pass while the job runs: it saves the setup
      const kind = LV(A.sync).split(":")[0], last = c.status[c.status.length - 1], saved = c.blobs().length;
      const shown = G.saveShown({ saveStatus: last, saveError: c.saveError, schedLineKind: kind });
      hold.release(); await p; await ticks(A, 2);
      check("SE-X17 19/n P10 (review r2 fixes-2) the real clearSchedule with its job running — the setup autosave re-run by its commit and saved meanwhile ('Saved'): the header's line is the engine's busy one, and the real saveStatusShown does NOT render '☁ Saved' beside it",
        kind === "busy" && last === "Saved" && saved === 1 && shown === false, JSON.stringify({ kind, status: c.status, saved, shown }));
    }
    // (b)
    { const t = mkT(), A = mkApp(t, { timeouts: { deadline: 40 } }); await A.eng.load(); await ticks(A);
      const rec = mkRec(), J = appJobs(A, rec);
      const hold = t.control.pause({ method: "PATCH", count: 1 });   // an ordinary save holds the chain past the clear's deadline
      A.edit(X[3], w => (w.dayCall = "s7", w)); const pp = A.eng.push(); await hold.arrived;
      A.toasts.length = 0;
      const p = J.clear(); await nap(90);
      const at = { toasts: A.toasts.map(x => x[0]), shown: dc(A.ref.current) };
      hold.release(); await pp; await p; await ticks(A, 3);
      const CANCEL = "The schedule was NOT cleared — The sync is stuck behind an earlier save — nothing was changed. The schedule on screen is as it was; try again in a minute.";
      check("SE-X17 19/n P10 the real clearSchedule cancelled at its deadline (stuck behind a slow save): '" + CANCEL + "' — the schedule back on screen as it was (the edit waiting to save included), never 'reload'; then the save lands and nothing is deleted",
        at.toasts.length === 1 && at.toasts[0] === CANCEL && !/reload/i.test(at.toasts[0]) && at.shown.includes(X[3] + "=s7") && Object.keys(A.ref.current).length === 4
          && t.rows().length === 4 && t.get(X[3]).data.dayCall === "s7" && !t.log.some(e => e.method === "DELETE"), JSON.stringify({ at, rows: t.rows().length }));
    }
    // (c)
    const fenced = async (start, o = {}) => {
      const { t, A } = await pair(); await ticks(A); const c = mkComp(A); c.render(); await c.fire(); A.toasts.length = 0;
      const rec = mkRec(), J = appJobs(A, rec);
      let pp = null;
      const hold = t.control.pause({ method: o.queued ? "PATCH" : o.wire, count: 1 });
      if (o.queued) { A.edit(X[3], w => (w.dayCall = "s7", w)); pp = A.eng.push(); await hold.arrived; } // an ordinary save holds the chain: the job only QUEUED
      const p = start(J);
      if (o.queued) for (let j = 0; j < 20; j++) await null; else await hold.arrived; // its job queued / on the wire
      await G.boundary(bEnv(A, c)).handleSignOut(); for (let j = 0; j < 6; j++) await null;
      hold.release(); await p; if (pp) await pp; if (rec.jobP) await rec.jobP; await ticks(A, 3);
      return { toasts: A.toasts.map(x => x[0]), adopted: rec.adopted.slice(), signOuts: A.signOuts };
    };
    const SN = { [X[0]]: wkX("s6", ["s1", "s2", "s3", "s4", "s5"]) };
    const fc = await fenced((J) => J.clear(), { wire: "DELETE" }), fq = await fenced((J) => J.clear(), { queued: true });
    const fr = await fenced((J) => J.reset(), { wire: "DELETE" }), fv = await fenced((J) => J.restore(SN, { blob: { numWeeks: 20 } }), { wire: "PATCH" });
    const fp = await fenced((J) => J.accept({ [X[0]]: wkX("s4", ["s1", "s2", "s3", "s5", "s6"]) }), { wire: "PATCH" });
    check("SE-X17 19/n P10 a job fenced by a sign-out says NOTHING on the sign-in screen: a clear running (skipped 'reset') — no 'wasn't fully cleared…' — or still queued (cancelled) — no 'NOT cleared — It was cancelled…'; a factory reset; a restore (and adopts nothing of its setup); a publish (no 'Published on this screen…')",
      [fc, fq, fr, fv, fp].every(x => x.toasts.length === 0 && x.signOuts === 1) && fv.adopted.length === 0,
      JSON.stringify({ clear: fc.toasts, queued: fq.toasts, reset: fr.toasts, restore: [fv.toasts, fv.adopted], publish: fp.toasts }));
    // (d) review r3 (G1 — R3P-X1): the same jobs QUEUED at the sign-out and STILL queued when their deadline passes (the
    // slow save's request still out): nothing said on the sign-in screen, then or after; no 'replaced by someone
    // else's change' entries left for the next session; nothing of the old screen put back; nothing of the restore's
    // setup adopted.
    const fencedLate = async (start) => {
      const t = mkT(), A = mkApp(t, { timeouts: { deadline: 20 } }); await A.eng.load(); await ticks(A);
      const c = mkComp(A); c.render(); await c.fire(); A.toasts.length = 0;
      const rec = mkRec(), J = appJobs(A, rec);
      const hold = t.control.pause({ method: "PATCH", count: 1 });
      A.edit(X[3], w => (w.dayCall = "s7", w)); const pp = A.eng.push(); await hold.arrived;   // a slow save holds the chain
      const p = start(J); for (let j = 0; j < 60; j++) await null;                               // the job: QUEUED behind it
      const pend = A.eng.jobPending();
      await G.boundary(bEnv(A, c)).handleSignOut(); for (let j = 0; j < 6; j++) await null;      // signed out: the queued job fenced
      await nap(35);                                                                              // its deadline passes; the chain still stuck
      const atDeadline = { toasts: A.toasts.map(x => x[0]), conflicts: A.eng.status().conflicts.length, shown: Object.keys(A.ref.current).length };
      hold.release(); await p; await pp; if (rec.jobP) await rec.jobP; await ticks(A, 4);
      return { pend, adopted: rec.adopted.slice(), atDeadline, toasts: A.toasts.map(x => x[0]), conflicts: A.eng.status().conflicts.length, line: LV(A.sync), signOuts: A.signOuts };
    };
    const lc = await fencedLate((J) => J.clear()), lr = await fencedLate((J) => J.reset());
    const lp = await fencedLate((J) => J.accept({ [X[0]]: wkX("s4", ["s1", "s2", "s3", "s5", "s6"]) })), lv = await fencedLate((J) => J.restore(SN, { blob: { numWeeks: 20 } }));
    check("SE-X17 (review r3, G1) …the same jobs QUEUED at the sign-out and STILL queued when their deadline passes (the slow save's request still out) — a clear, a factory reset, a publish, a restore: nothing said on the sign-in screen, then or after; no 'replaced by someone else's change' entries left for the next session; nothing of the old screen put back; nothing of the restore's setup adopted",
      [lc, lr, lp, lv].every(x => !!x.pend && x.atDeadline.toasts.length === 0 && x.atDeadline.conflicts === 0 && x.atDeadline.shown === 0 && x.toasts.length === 0 && x.conflicts === 0 && !/^conflicts/.test(x.line) && x.signOuts === 1) && lv.adopted.length === 0,
      JSON.stringify({ clear: lc, reset: lr, publish: lp, restore: lv }));
  });

  // SE-X18 — G2 (review r3 regress-3, RR-A5..A9): a clear / factory reset / restore / Generate & Publish / Accept &
  // Publish never runs as the next account. Each takes the session's identity at its tap (sessionEpochRef, bumped by
  // the real sessionBoundary) and, after every await, goes no further once it moved — silently: no write under the
  // next account's token, nothing adopted, no toast, no notice or e-mail. The session ends either way: "Sign in
  // again" lands on another account (the real reauthLanded), or the real handleSignOut and then B's sign-in on the
  // sign-in screen (B's session stored, the real load). Also: a job STARTED before the change and still running at its
  // deadline says no "taking longer than expected" there (19/n open item 1); and a restore queued behind a slow save
  // never reverts the setup B read and changed (G1's belt, r3-regress-1).
  await run("SE-X18", async () => {
    if (!gotG("SE-X18 20/n G2", ["runAuth", "clear", "reset", "restore", "finish", "genCommit", "notify", "boundary", "reauth", "commit", "autosave", "bundle"])) return;
    const spin = async (n) => { for (let j = 0; j < (n || 20); j++) await null; };
    const cross = async (A, c, how) => {
      if (how === "other") { await otherAccount(A, c); await spin(6); await ticks(A, 2); return; }
      await G.boundary(bEnv(A, c)).handleSignOut(); await spin(6); await ticks(A, 2);
      A.token = "TOK_B";                                           // B signs in on the sign-in screen: B's session stored…
      const L = loadRig(A, c, { blob: { data: { numWeeks: 30 }, updated_at: "2026-10-14T11:00:00+00:00" } }); await L.loaded; await ticks(A, 2); // …and the load (reloadTrigger)
    };
    const asB = (t, from) => writesOf(t, from, "TOK_B").map(e => e.method + " " + e.url.replace(/^.*schedule_weeks/, "").split("&")[0]);
    const quiet = (A) => A.toasts.map(x => x[0]);
    const WEEKS = () => ({ [X[0]]: wkX("s4", ["s1", "s2", "s3", "s5", "s6"]), [X[1]]: wkX("s3", ["s1", "s2", "s4", "s5", "s6"]) });
    const SNAPX = { [X[0]]: wkX("s6", ["s1", "s2", "s3", "s4", "s5"]) };   // ONE week: a restore deletes the other three
    const gated = () => { let open; const gate = new Promise(r => { open = r; }); return { gate, open }; };
    // (a) clear: the session changes during its snapshot
    const clearX = async (how) => {
      const { t, A } = await pair(); await ticks(A); const c = mkComp(A); c.render(); await c.fire(); A.toasts.length = 0; c.upserts.length = 0;
      const g = gated(), rec = mkRec(), J = appJobs(A, rec, { captureGate: g.gate });
      const p = J.clear(); await spin();                           // confirmed; its snapshot being written (slow)
      await cross(A, c, how); A.toasts.length = 0;
      const from = t.log.length;
      g.open(); await p; await ticks(A, 3); await nap(5); await ticks(A, 2);
      return { wB: asB(t, from), rows: t.rows().length, toasts: quiet(A), status: rec.status.slice(), ups: rec.upsertsAs.slice(), history: A.history.length, confirms: rec.confirms };
    };
    const ca = await clearX("other"), cs = await clearX("signout");
    check("SE-X18 G2 (RR-A7, RR-A9) the real clearSchedule, the session ending during its snapshot ('Sign in again' on another account; or a sign-out and B's sign-in): it goes no further — nothing deleted as B, no Undo step, no setup save, no status, no toast",
      [ca, cs].every(x => x.confirms === 1 && x.wB.length === 0 && x.rows === 4 && x.toasts.length === 0 && x.status.length === 0 && x.ups.length === 0 && x.history === 0), JSON.stringify({ ca, cs }));
    // (b) clear: its setup save fails across a sign-out
    { const { t, A } = await pair(); await ticks(A); const c = mkComp(A); c.render(); await c.fire(); A.toasts.length = 0;
      const g = gated(), errs = [];
      const rec = mkRec(), J = appJobs(A, rec, { upsertGate: g.gate, upsertFails: { call_schedule_data: "HTTP 503 upstream" }, env: { console: { error: (...x) => errs.push(x.map(String).join(" ")), warn: noopX } } });
      const p = J.clear();
      for (let i = 0; i < 60 && !rec.upserts.length; i++) await ticks(A);   // the job landed; its setup save on the wire
      const onWire = rec.upserts.slice();
      await cross(A, c, "signout"); A.toasts.length = 0;
      g.open(); await p; await ticks(A, 2);
      check("SE-X18 G2 …the clear's own setup save failing after a sign-out during it: no 'Couldn't save the cleared state' on the next screen (the failure logged)",
        onWire.join() === "call_schedule_data" && t.rows().length === 0 && quiet(A).length === 0 && errs.length === 1 && /Immediate save failed/.test(errs[0]), JSON.stringify({ onWire, toasts: quiet(A), errs }));
    }
    // (c) factory reset: during its snapshot / its setup clear / its APP-shifts clear
    const resetX = async (at, how) => {
      const { t, A } = await pair(); await ticks(A); const c = mkComp(A); c.render(); await c.fire(); A.toasts.length = 0;
      const g = gated(), rec = mkRec();
      const J = appJobs(A, rec, at === "snap" ? { captureGate: g.gate } : at === "setup" ? { upsertGate: g.gate } : { upsertGate2: g.gate });
      const p = J.reset(); await spin(60);
      await cross(A, c, how); A.toasts.length = 0;
      const from = t.log.length;
      g.open(); await p; if (rec.jobP) await rec.jobP; await ticks(A, 3); await nap(5); await ticks(A, 2);
      return { wB: asB(t, from), rows: t.rows().length, toasts: quiet(A), ups: rec.upsertsAs.slice(), setup: rec.setupReset, timeOff: rec.timeOff, job: rec.jobP !== null, status: rec.status.slice() };
    };
    const rs = await resetX("snap", "other"), rs2 = await resetX("snap", "signout"), rb = await resetX("setup", "other"), rp = await resetX("app", "other");
    check("SE-X18 G2 (RR-A6) the real resetAllData, the session ending during its snapshot: nothing cleared or written (as B or anyone), nothing reset on the next screen, no weeks job, no status or toast",
      [rs, rs2].every(x => x.ups.length === 0 && x.setup === 0 && x.timeOff === 0 && !x.job && x.wB.length === 0 && x.rows === 4 && x.toasts.length === 0 && x.status.length === 0), JSON.stringify({ rs, rs2 }));
    check("SE-X18 G2 …during its setup clear (sent as A): the APP shifts are NOT then cleared as B, nothing reset on the next screen, no weeks job, nothing said",
      rb.ups.join() === "call_schedule_data:TOK_A" && rb.setup === 0 && rb.timeOff === 0 && !rb.job && rb.wB.length === 0 && rb.rows === 4 && rb.toasts.length === 0, JSON.stringify(rb));
    check("SE-X18 G2 …during its APP-shifts clear (both sent as A): no weeks job as B — nothing deleted under B's token — nothing reset on the next screen, nothing said",
      rp.ups.join() === "call_schedule_data:TOK_A,app_shifts_data:TOK_A" && rp.setup === 0 && rp.timeOff === 0 && !rp.job && rp.wB.length === 0 && rp.rows === 4 && rp.toasts.length === 0, JSON.stringify(rp));
    // (d) restore: during its snapshot read (before its question) / its before_restore snapshot / its blob write (RR-A5)
    const restoreX = async (at, how) => {
      const { t, A } = await pair(); await ticks(A); const c = mkComp(A); c.render(); await c.fire(); A.toasts.length = 0; c.upserts.length = 0;
      const g = gated(), rec = mkRec(), J = appJobs(A, rec, { env: { setNumWeeks: c.set("numWeeks"), lastSyncRef: c.lastSyncRef, everHadRealDataRef: c.everRef } });
      const so = { blob: { numWeeks: 20 } }; so[at] = g.gate;
      const p = J.restore(SNAPX, so); await spin(30);
      await cross(A, c, how); A.toasts.length = 0; c.upserts.length = 0;
      const nwB = c.st.numWeeks, from = t.log.length;
      g.open(); await p; await ticks(A, 3); await nap(5); await ticks(A, 2);
      c.loadedAtRef.current = 1; await c.fire();                   // B's setup autosave
      return { wB: asB(t, from), table: dc(tableOf(t)), toasts: quiet(A), confirms: rec.confirms, blobWrites: rec.blobWrites, adopted: rec.adopted.slice(), nwB, numWeeks: c.st.numWeeks, blobsB: c.blobs().map(b => b.as + ":" + b.numWeeks), status: rec.status.slice() };
    };
    const vc = await restoreX("beforeConfirm", "other"), vb = await restoreX("beforeBlob", "other"), va = await restoreX("beforeApply", "other"), va2 = await restoreX("beforeApply", "signout");
    const untouched = (x) => x.wB.length === 0 && x.adopted.length === 0 && x.toasts.length === 0 && x.numWeeks === x.nwB && !x.blobsB.includes("TOK_B:20") && x.table.split(" ").length === 4;
    check("SE-X18 G2 the real restoreSnapshot, the session ending while the snapshot is read (before its question): nothing asked on the next screen, no blob written, no weeks job, nothing adopted or said",
      vc.confirms === 0 && vc.blobWrites === 0 && untouched(vc), JSON.stringify(vc));
    check("SE-X18 G2 …while its before_restore snapshot is written (after the question): the blob is NOT then written (opts.proceed — as the next account), no weeks job, nothing adopted or said",
      vb.confirms === 1 && vb.blobWrites === 0 && untouched(vb), JSON.stringify(vb));
    check("SE-X18 G2 (RR-A5) …while its blob is written (sent as A): its weeks job never runs as B — nothing written under B's token — and A's restored setup (numWeeks 20) is NOT adopted on B's screen, nor written by B's autosave; nothing said",
      [va, va2].every(x => x.confirms === 1 && x.blobWrites === 1 && untouched(x)), JSON.stringify({ va, va2 }));
    // (e) G1's belt (r3-regress-1, RR-V1e): A's restore QUEUED behind a slow save, "Sign in again" lands on B, B reads
    // its setup (the shared row: A's restored numWeeks 20) and changes it (25); then A's job's deadline passes
    { const t = mkT(), A = mkApp(t, { timeouts: { deadline: 40 } }); await A.eng.load(); await ticks(A);
      const c = mkComp(A); c.render(); await c.fire(); c.upserts.length = 0; A.toasts.length = 0;
      const rec = mkRec(), J = appJobs(A, rec, { env: { setNumWeeks: c.set("numWeeks"), lastSyncRef: c.lastSyncRef, everHadRealDataRef: c.everRef } });
      const hold = t.control.pause({ method: "PATCH", count: 1 });
      A.edit(X[3], w => (w.dayCall = "s7", w)); const pp = A.eng.push(); await hold.arrived;
      const p = J.restore(SNAPX, { blob: { numWeeks: 20 } }); await spin(30);
      await otherAccount(A, c); await spin(6);
      loadRig(A, c, { blob: { data: { numWeeks: 20 }, updated_at: "2026-10-14T10:00:00Z" } }); await spin(30); await c.fire(); c.upserts.length = 0;
      c.set("numWeeks")(25); await spin(6); c.loadedAtRef.current = 1; await c.fire();   // B changes its setup: written as B (25)
      const bEdit = c.blobs().map(b => b.as + ":" + b.numWeeks);
      c.upserts.length = 0; A.toasts.length = 0;
      await p; await spin(30);                                     // A's restore: its deadline passes (still queued)
      const at = { toasts: quiet(A), numWeeks: c.st.numWeeks, adopted: rec.adopted.slice() };
      c.loadedAtRef.current = 1; await c.fire();
      const blobs = c.blobs().map(b => b.as + ":" + b.numWeeks);
      hold.release(); await pp; await ticks(A, 3); await nap(5); await ticks(A, 2);
      check("SE-X18 G1 (r3-regress-1, RR-V1e) A's restore queued behind a slow save; 'Sign in again' lands on B, who reads the setup and changes it (25, written as B); at A's deadline nothing of A's restore is adopted on B's screen — B's 25 stands, never written back as 20 under B's token — and nothing is said",
        bEdit.includes("TOK_B:25") && at.numWeeks === 25 && at.adopted.length === 0 && !blobs.includes("TOK_B:20") && !at.toasts.some(m => /Restore/.test(m)), JSON.stringify({ bEdit, at, blobs }));
    }
    // (f) Generate & Publish (finishGenerate): the session ends during its snapshot (RR-A8)
    { const { t, A } = await pair(); await ticks(A); const c = mkComp(A); c.render(); await c.fire(); A.toasts.length = 0;
      const g = gated(), rec = mkRec(), J = appJobs(A, rec, { captureGate: g.gate });
      const p = J.finish(WEEKS()); await spin();
      await cross(A, c, "other"); A.toasts.length = 0;
      g.open(); const out = await p; await ticks(A, 2);
      check("SE-X18 G2 (RR-A8) the real finishGenerate (Generate & Publish), the session ending during its snapshot: nothing published as the next session, its 'Saving backup snapshot…' cleared, nothing said",
        out === "refused" && rec.published === 0 && quiet(A).length === 0 && rec.status[0] === "Saving backup snapshot…" && rec.status[rec.status.length - 1] === "", JSON.stringify({ out, published: rec.published, status: rec.status, toasts: quiet(A) }));
    }
    // (g) Generate & Publish's commit (commitGenerated): its setup save failing after a sign-out during it
    { const { t, A } = await pair(); await ticks(A); const c = mkComp(A); c.render(); await c.fire(); A.toasts.length = 0;
      const g = gated(), errs = [], status = [];
      const p = G.genCommit({ publishWeeks: (w) => { A.pushUndo(); A.commitSchedule(Object.assign({}, A.ref.current, w)); return { merged: A.ref.current, prior: {}, y1: {} }; },
        numWeeks: 2, MO: HX.MO, startMonth: 0, startYear: 2030, runPublish: F.runPublish({ schedSyncRef: A.schedSyncRef }), setPreviewSchedule: noopX, setShowPreview: noopX, setSaveStatus: (s) => status.push(s), lastSyncRef: { current: null },
        buildStateBundle: (x) => Object.assign({}, x), supabase: { from: () => ({ upsert: async () => { await g.gate; return { error: "HTTP 503 upstream" }; } }) },
        console: { error: (...x) => errs.push(x.map(String).join(" ")), warn: noopX }, showToast: A.showToast, setTimeout: () => 0, publishNotLanded: F.notLanded({ showToast: A.showToast }), sessionEpochRef: A.sessionEpochRef })(WEEKS());
      await spin();
      await cross(A, c, "signout"); A.toasts.length = 0;
      g.open(); const out = await p; await ticks(A, 3);
      check("SE-X18 G2 …Generate & Publish's own setup save failing after a sign-out during it: no 'Couldn't save the regenerated schedule' and no 'Regenerated on this screen…' on the next screen; not 'published' (no notice, no e-mail)",
        !!out && out.ok === false && quiet(A).length === 0 && errs.length === 1 && /Immediate save failed/.test(errs[0]) && !status.includes("Regenerated!"), JSON.stringify({ out, toasts: quiet(A), errs, status }));
    }
    // (h) the notice and the e-mail (doGenerateAndNotify): a sign-out while the notice is written
    { const notifyRun = async (signOut) => {
        const { A } = await pair(); const c = mkComp(A); c.render(); await c.fire();
        const g = gated(), sent = { notes: 0, emails: 0 };
        const p = G.notify({ schedSyncRef: A.schedSyncRef, doGenerate: async () => "published", addNotification: async () => { sent.notes++; await g.gate; }, sendEmailNotif: () => { sent.emails++; },
          MO: HX.MO, startMonth: 0, endMoIdx: 2, startYear: 2030 })();
        await spin();
        if (signOut) { await G.boundary(bEnv(A, c)).handleSignOut(); await spin(6); }
        g.open(); await p;
        return sent;
      };
      const no = await notifyRun(false), so = await notifyRun(true);
      check("SE-X18 G2 the real doGenerateAndNotify: published → the notice, then the e-mail (control); a sign-out while the notice is written → NO e-mail from the next session",
        no.notes === 1 && no.emails === 1 && so.notes === 1 && so.emails === 0, JSON.stringify({ no, so }));
    }
    // (i) Accept & Publish: the session ends during its snapshot
    { const { t, A } = await pair(); await ticks(A); const c = mkComp(A); c.render(); await c.fire(); A.toasts.length = 0;
      const g = gated(), rec = mkRec(), J = appJobs(A, rec, { captureGate: g.gate });
      const p = J.accept(WEEKS()); await spin();
      await cross(A, c, "other"); A.toasts.length = 0;
      const from = t.log.length;
      g.open(); await p; await ticks(A, 3);
      check("SE-X18 G2 the real acceptPreview, the session ending during its snapshot: nothing published as the next session (no write under B's token), its status cleared, nothing said",
        rec.published === 0 && asB(t, from).length === 0 && quiet(A).length === 0 && rec.status[rec.status.length - 1] === "" && t.get(X[0]).data.dayCall === "s1", JSON.stringify({ published: rec.published, wB: asB(t, from), status: rec.status, toasts: quiet(A) }));
    }
    // (j) the 19/n open item: a job STARTED before a sign-out, still running at its deadline
    const lateRun = async (start, wire) => {
      const t = mkT(), A = mkApp(t, { timeouts: { deadline: 20 } }); await A.eng.load(); await ticks(A);
      const c = mkComp(A); c.render(); await c.fire(); A.toasts.length = 0;
      const rec = mkRec(), J = appJobs(A, rec);
      const hold = t.control.pause({ method: wire, count: 1 });   // the job's first write on the wire: it RUNS
      const p = start(J); await hold.arrived;
      await G.boundary(bEnv(A, c)).handleSignOut(); await spin(6);
      await nap(35);                                               // its deadline passes, the write still out
      const atDeadline = quiet(A);
      hold.release(); await p; if (rec.jobP) await rec.jobP; await ticks(A, 3); await nap(5); await ticks(A);
      return { atDeadline, toasts: quiet(A), adopted: rec.adopted.slice() };
    };
    const jr = await lateRun((J) => J.reset(), "DELETE"), jv = await lateRun((J) => J.restore(SNAPX, { blob: { numWeeks: 20 } }), "PATCH"), jp = await lateRun((J) => J.accept(WEEKS()), "PATCH");
    check("SE-X18 G2 (19/n open item 1) a factory reset / restore / publish STARTED before a sign-out and still running at its deadline: nothing on the sign-in screen — no 'taking longer than expected', no 'The roster and setup are restored', no 'Published on this screen' — then or when it ends; nothing of the restore adopted",
      [jr, jv, jp].every(x => x.atDeadline.length === 0 && x.toasts.length === 0) && jv.adopted.length === 0, JSON.stringify({ reset: jr, restore: jv, publish: jp }));
    // (k) r4-fix-6 (R4-D7): the snapshot capture FAILS across a session change — its insert went out with no session,
    // RLS refused it — for each of the four callers: nothing said on the next session's screen, no status left there.
    // Control: the same failure in one session is told.
    const failX = async (start, how) => {
      const { t, A } = await pair(); await ticks(A); const c = mkComp(A); c.render(); await c.fire(); A.toasts.length = 0;
      const g = gated(), rec = mkRec(), J = appJobs(A, rec, { captureGate: g.gate, captureFails: true });
      const p = start(J); await spin();
      if (how) { await cross(A, c, how); A.toasts.length = 0; }
      const from = t.log.length;
      g.open(); const out = await p; await ticks(A, 2);
      return { out, toasts: quiet(A), status: rec.status.slice(), published: rec.published, wB: asB(t, from), rows: t.rows().length, ups: rec.upserts.length };
    };
    const fc = await failX((J) => J.clear(), "signout"), fr = await failX((J) => J.reset(), "other"), ff = await failX((J) => J.finish(WEEKS()), "signout"), fa = await failX((J) => J.accept(WEEKS()), "other");
    const fc0 = await failX((J) => J.clear(), null), ff0 = await failX((J) => J.finish(WEEKS()), null);
    const silentEnd = (x) => x.toasts.length === 0 && (x.status.length === 0 || x.status[x.status.length - 1] === "") && x.published === 0 && x.wB.length === 0 && x.rows === 4 && x.ups === 0;
    check("SE-X18 G2 (k) (r4-fix-6, R4-D7) the snapshot capture FAILING after a session change during it (a sign-out, or another account) — the real clearSchedule, resetAllData, finishGenerate (Generate & Publish) and acceptPreview (Accept & Publish): nothing said on the next session's screen (no 'Couldn't save a backup snapshot…'), no status left there, nothing cleared or published; control: in one session the failure is told",
      [fc, fr, ff, fa].every(silentEnd) && fc0.toasts.join() === "Couldn't save a backup snapshot — clear cancelled. Schedule unchanged." && ff0.toasts.join() === "Couldn't save a backup snapshot — regenerate cancelled. Schedule unchanged.",
      JSON.stringify({ fc, fr, ff, fa, fc0: fc0.toasts, ff0: ff0.toasts }));
  });

  // SE-X19 — G3 (review r3 fixes-2): a factory reset whose stored-data clears half-land tells the truth. The setup
  // (the blob) is cleared first, the APP shifts only once it has; when the second fails after the first landed, the
  // message says exactly what was reset and what wasn't — never "Nothing was changed" — and the screen takes the
  // reset's setup (it matches the server; no later autosave writes the old one back); the APP shifts, time off and
  // weeks are left as they are. When the first fails, the second is never sent: refused → "Nothing was changed"; no
  // answer → it may have landed, said so.
  await run("SE-X19", async () => {
    if (!gotG("SE-X19 20/n G3", ["runAuth", "reset"])) return;
    const HALF = "Factory reset: the setup was reset, but clearing the APP shifts failed — so the time off and the schedule weeks were left as they are. Run the reset again, or restore the \"Before factory reset\" snapshot.";
    const NONE = "Couldn't clear the stored data — reset cancelled. Nothing was changed.";
    const UNKNOWN = "Couldn't clear the stored data — reset cancelled. The server didn't answer, so the setup may have been reset; nothing else was. Run the reset again, or restore the \"Before factory reset\" snapshot.";
    const half = async (fails) => {
      const { t, A } = await pair(); await ticks(A);
      const errs = [], server = { call_schedule_data: { numWeeks: 13 }, app_shifts_data: { "2030-01-08": "a1" } }, refs = { allow: { current: false }, ever: { current: true } };
      let appShiftsCleared = 0;
      const rec = mkRec(), J = appJobs(A, rec, { upsertFails: fails, server, env: { console: { error: (...x) => errs.push(x.map(String).join(" ")), warn: noopX },
        allowWipeSaveRef: refs.allow, everHadRealDataRef: refs.ever, setAppShifts: () => { appShiftsCleared++; } } });
      await J.reset(); if (rec.jobP) await rec.jobP; await ticks(A, 3);
      return { toasts: A.toasts.map(x => x[0] + " :" + x[1]), ups: rec.upserts.slice(), server, setup: rec.setupReset, timeOff: rec.timeOff, job: rec.jobP !== null, rows: t.rows().length, shown: Object.keys(A.ref.current).length,
        appShiftsCleared, status: rec.status.slice(), errs: errs.length, allow: refs.allow.current, ever: refs.ever.current };
    };
    const ha = await half({ app_shifts_data: "HTTP 503 upstream" }), ht = await half({ app_shifts_data: "throw" });
    check("SE-X19 G3 (p-reset-partial) the setup clear LANDS and the APP-shifts clear fails (an HTTP error, or no answer): exactly '" + HALF + "' — never 'Nothing was changed' — the server's setup cleared, its APP shifts untouched; on this screen the reset's setup (matching the server) while the APP shifts, time off and weeks stay as they are (no weeks job); the guard refs back; no 'Reset complete'",
      [ha, ht].every(x => x.toasts.join("|") === HALF + " :error" && x.ups.join() === "call_schedule_data,app_shifts_data" && x.server.call_schedule_data._intentionalClear === true && x.server.app_shifts_data["2030-01-08"] === "a1"
        && x.setup === 1 && x.timeOff === 0 && x.appShiftsCleared === 0 && !x.job && x.rows === 4 && x.shown === 4 && x.errs === 1 && x.allow === false && x.ever === true && !x.status.includes("Reset complete")),
      JSON.stringify({ ha, ht }));
    const hb = await half({ call_schedule_data: "HTTP 503" }), hu = await half({ call_schedule_data: "throw" });
    check("SE-X19 G3 (p-reset-partial2) the setup clear FAILS: the APP-shifts clear is never sent — the server's APP shifts untouched — nothing reset here, no weeks job; refused (HTTP): '" + NONE + "'; no answer: '" + UNKNOWN + "'; 'Reset cancelled', the guard refs back",
      [hb, hu].every(x => x.ups.join() === "call_schedule_data" && x.server.app_shifts_data["2030-01-08"] === "a1" && x.server.call_schedule_data.numWeeks === 13 && x.setup === 0 && x.timeOff === 0 && x.appShiftsCleared === 0 && !x.job && x.rows === 4
        && x.status.includes("Reset cancelled") && x.errs === 1 && x.allow === false && x.ever === true) && hb.toasts.join("|") === NONE + " :error" && hu.toasts.join("|") === UNKNOWN + " :error",
      JSON.stringify({ hb, hu }));
  });

  // SE-X20 — H2 (review r4 branch-2) and H7 (fixes-3): a trade's accept / decline, and every notice path, never act
  // in the NEXT session. The REAL acceptTradeRequest and declineTradeRequest, the real sessionBoundary / handleSignOut
  // / reauthLanded, on the app's engine; the REAL addNotification, sendPushNotif and sendEmailNotif under the real
  // doGenerateAndNotify and swapShift. The session changes while a request is out — "Sign in again" lands on another
  // account (B), or a sign-out: (a) during the accept's status PATCH, B's table already loaded — A's trade is NOT
  // applied in B's session (no schedule write as B, no Undo step there, no notice or e-mail), its status set back to
  // pending WITH THE TAP'S HEADERS (A's token), nothing said; (b) the same before B's table has loaded (no "This trade
  // was not applied" on B's screen); (c) the set-back failing: logged, an audit line written AS A, still nothing said;
  // (d) during its first notice: no more notices, no e-mail. (e) the control: in one session it all lands. (f) the
  // decline: nothing more after its status write. (g) Generate & Publish's notice: no device push, no e-mail, no toast
  // from the next session — the notice's insert held across the boundary (and failing after it); the push's and the
  // e-mail's own requests failing after a boundary: nothing said. (h) the swap tool's notices the same.
  await run("SE-X20", async () => {
    if (!gotG("SE-X20 21/n H2 / H7", ["boundary", "reauth", "commit", "autosave", "bundle", "decline", "addNote", "pushNote", "email", "notify"])) return;
    const REQ = { id: 42, from_surgeon_id: "s1", to_surgeon_id: "s2", from_surgeon_name: "AAA", to_surgeon_name: "BBB", week_monday: X[0], shift_key: "dayCall", shift_label: "Service Week",
      return_week: X[1], return_shift: "dayCall", status: "pending" };
    const detect = F.cascades({ surgeons: S7, SHIFT_LABELS: HX.SHIFT_LABELS });
    const resp = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json) });
    const spin = async (n) => { for (let j = 0; j < (n || 20); j++) await null; };
    const cross = async (A, c, how) => { if (how === "other") await otherAccount(A, c); else await G.boundary(bEnv(A, c)).handleSignOut(); };
    const ours = (ts) => ts.filter(m => !/^Signed in as a different account than before/.test(m)); // (the switch's own message, from reauthLanded — not the job's)
    const hdr = (A) => () => ({ apikey: "ANON", Authorization: "Bearer " + (A.token || "ANON") });
    const acceptRun = async (o) => {
      const { t, A, P } = await pair(); await ticks(A); const c = mkComp(A); c.render(); await c.fire(); A.toasts.length = 0;
      const rec = { reqs: [], audits: [], notes: [], emails: [], list: [Object.assign({}, REQ)], errors: [] };
      const holdL = o.loadHeld ? t.control.pause({ method: "GET", count: 1 }) : null;   // (b): the next session's table read held
      const from = t.log.length;
      let crossed = null;
      await F.accept({ fmt: HX.fmt, shiftStartDate: HX.shiftStartDate, SHIFT_LABELS: HX.SHIFT_LABELS, tradeAcceptMsg: HX.tradeAcceptMsg, cascadeMsg: HX.cascadeMsg,
        showToast: A.showToast, schedEditable: A.schedEditable, scheduleRef: A.ref, surgeons: S7, schedule: {}, detectCascadeChanges: detect,
        silvisActive: false, silvisBlock: () => null, silvisRefuse: () => false, confirm: () => true,
        SUPABASE_URL: BASE, dbAuthHeaders: hdr(A), console: { error: (...x) => rec.errors.push(x.map(String).join(" ")), warn: noopX, log: noopX },
        setTradeRequests: (f) => { rec.list = f(rec.list); }, logAudit: (action, summary, details, hdrs) => rec.audits.push(action + "@" + (hdrs ? hdrs.Authorization : "now:" + (A.token || "ANON"))),
        pushUndo: A.pushUndo, updateSchedule: A.updateSchedule, schedulerAdminIds: ["s7"], sessionEpochRef: A.sessionEpochRef,
        addNotification: async (type) => { rec.notes.push(type + "@" + (A.token || "ANON")); if (o.at === "notice" + rec.notes.length) { await cross(A, c, o.how); await spin(6); } },
        sendEmailNotif: (type) => { rec.emails.push(type + "@" + (A.token || "ANON")); },
        fetch: async (url, init) => {
          const u = String(url).replace(/^.*\/rest\/v1\//, "");
          rec.reqs.push(((init && init.method) || "GET") + " " + u + " " + (init && init.headers && init.headers.Authorization));
          if (/status=eq\.pending$/.test(u)) {
            if (o.change) { await P.eng.pull(); P.edit(X[1], w => (w.nights.tue = "s7", w)); await P.eng.push(); await A.eng.pull(); } // someone changes a cascade slot meanwhile: the trade no longer holds
            if (o.at === "status") { await cross(A, c, o.how); if (!o.loadHeld) await A.settle(); await spin(6); crossed = { epoch: A.sessionEpochRef.current, seeded: A.eng.isSeeded(), weeks: Object.keys(A.ref.current).length }; }
            return resp(200, [Object.assign({}, REQ, { status: "accepted" })]);
          }
          if (/status=eq\.accepted$/.test(u)) {
            if (o.at === "back") { await cross(A, c, o.how); await spin(6); }
            return o.backFails ? resp(500, { message: "upstream" }) : resp(200, [Object.assign({}, REQ, { status: "pending", reviewed_at: null })]);
          }
          throw new Error("unrouted: " + u);
        } })(Object.assign({}, REQ));
      if (holdL) holdL.release();
      await A.eng.push(); await ticks(A, 2);
      return { crossed, reqs: rec.reqs, audits: rec.audits, notes: rec.notes, emails: rec.emails, list: rec.list.map(r => r.status), errors: rec.errors.length, toasts: ours(A.toasts.map(x => x[0])),
        undo: A.history.length, w: writesOf(t, from).length, wB: writesOf(t, from, "TOK_B").length, x0: t.get(X[0]).data.dayCall };
    };
    const BACK_A = "PATCH shift_trade_requests?id=eq.42&status=eq.accepted Bearer TOK_A";
    const abandoned = (x) => x.w === 0 && x.wB === 0 && x.undo === 0 && x.notes.length === 0 && x.emails.length === 0 && x.toasts.length === 0 && x.x0 === "s1"
      && x.reqs[0] === "PATCH shift_trade_requests?id=eq.42&status=eq.pending Bearer TOK_A" && x.reqs[1] === BACK_A && x.reqs.length === 2;
    const ao = await acceptRun({ at: "status", how: "other" }), as = await acceptRun({ at: "status", how: "signout" });
    check("SE-X20 H2 (a) (R4-TRADE) the real acceptTradeRequest, the session changing during its status PATCH ('Sign in again' on another account, B's table loaded; or a sign-out): A's trade is NOT applied in the next session — no schedule write (none as B), no Undo step there, no notice or e-mail — and its status is set back to pending with the TAP's headers (A's token); nothing said on the next screen",
      ao.crossed && ao.crossed.seeded && ao.crossed.weeks === 4 && abandoned(ao) && abandoned(as), JSON.stringify({ ao, as }));
    const al = await acceptRun({ at: "status", how: "other", loadHeld: true });
    check("SE-X20 H2 (b) …the same when B's table hasn't loaded yet (its screen empty, the trade not 'holding' there): set back with A's token by the abandoned tap — not by the 'not applied' path as B — and no 'This trade was not applied…' on B's screen",
      al.crossed && al.crossed.seeded === false && abandoned(al) && al.audits.length === 0, JSON.stringify(al));
    const af = await acceptRun({ at: "status", how: "other", backFails: true });
    check("SE-X20 H2 (c) …the set-back FAILING: logged (console) and an audit line written AS A (the tap's headers — 'trade.accept_unapplied', for a manual fix), and still nothing said on the next screen",
      af.w === 0 && af.notes.length === 0 && af.emails.length === 0 && af.toasts.length === 0 && af.reqs[1] === BACK_A && af.errors === 1 && af.audits.join() === "trade.accept_unapplied@Bearer TOK_A", JSON.stringify(af));
    const an = await acceptRun({ at: "notice1", how: "other" }), an2 = await acceptRun({ at: "notice2", how: "other" });
    check("SE-X20 H2 (d) …the session changing during the trade's FIRST notice (the trade applied in A's session): no more notices (no cascade notices) and no e-mail from the next session, nothing said; during the FIRST CASCADE's notice: that cascade's e-mail and the second cascade's notice never go out",
      an.notes.join() === "trade_accepted@TOK_A" && an.emails.length === 0 && an.toasts.length === 0 && an.wB === 0
        && an2.notes.join() === "trade_accepted@TOK_A,schedule_changed@TOK_A" && an2.emails.join() === "trade_accepted@TOK_A" && an2.toasts.length === 0 && an2.wB === 0, JSON.stringify({ an, an2 }));
    const ab = await acceptRun({ change: true, at: "back", how: "other" });
    check("SE-X20 H2 (i) …the trade NOT holding at commit (a cascade slot changed while its status PATCH was out), and the session changing while its set-back to pending is out: no 'This trade was not applied' on the next screen; its audit line written as A (the tap's headers)",
      ab.reqs.length === 2 && /status=eq\.accepted Bearer TOK_A$/.test(ab.reqs[1]) && ab.toasts.length === 0 && ab.notes.length === 0 && ab.emails.length === 0 && ab.w === 1 && ab.x0 === "s1" && ab.audits.join() === "trade.accept_unapplied@Bearer TOK_A", JSON.stringify(ab)); // (w: the peer's own edit, nothing else)
    const ac = await acceptRun({});
    check("SE-X20 H2 (e) control: in one session the trade lands — its status accepted (sent as A), both weeks written as A, one Undo step, the trade notice and both cascade notices, three e-mails, no set-back",
      ac.list.join() === "accepted" && ac.w === 2 && ac.wB === 0 && ac.x0 === "s2" && ac.undo === 1 && ac.notes.join() === "trade_accepted@TOK_A,schedule_changed@TOK_A,schedule_changed@TOK_A"
        && ac.emails.length === 3 && !ac.reqs.includes(BACK_A) && ac.toasts.length === 0, JSON.stringify(ac));
    // (f) the decline
    const declineRun = async (at) => {
      const { t, A } = await pair(); await ticks(A); const c = mkComp(A); c.render(); await c.fire(); A.toasts.length = 0;
      const rec = { reqs: [], notes: [], emails: [], list: [Object.assign({}, REQ)] };
      await G.decline({ SUPABASE_URL: BASE, dbAuthHeaders: hdr(A), console: { error: noopX, warn: noopX, log: noopX }, showToast: A.showToast, setTradeRequests: (f) => { rec.list = f(rec.list); },
        tradeDeclineMsg: HX.tradeDeclineMsg, logAudit: noopX, sessionEpochRef: A.sessionEpochRef, sendEmailNotif: (type) => { rec.emails.push(type); },
        addNotification: async (type) => { rec.notes.push(type); if (at === "notice") { await cross(A, c, "other"); await spin(6); } },
        fetch: async (url, init) => { rec.reqs.push(init.method + " " + init.headers.Authorization); if (at === "status") { await cross(A, c, "other"); await spin(6); } return resp(200, [Object.assign({}, REQ, { status: "declined" })]); } })(Object.assign({}, REQ));
      await ticks(A);
      return { reqs: rec.reqs, notes: rec.notes, emails: rec.emails, list: rec.list.map(r => r.status), toasts: ours(A.toasts.map(x => x[0])) };
    };
    const dx = await declineRun("status"), dn = await declineRun("notice"), dc0 = await declineRun(null);
    check("SE-X20 H2 (f) the real declineTradeRequest, the session changing during its status PATCH (sent as A): nothing more of it in the next session — no list update, no notice, no e-mail, no toast; during its notice: no e-mail; control: in one session its notice and e-mail go out",
      dx.reqs.join() === "PATCH Bearer TOK_A" && dx.list.join() === "pending" && dx.notes.length === 0 && dx.emails.length === 0 && dx.toasts.length === 0
        && dn.notes.join() === "trade_declined" && dn.emails.length === 0 && dn.toasts.length === 0
        && dc0.list.join() === "declined" && dc0.notes.join() === "trade_declined" && dc0.emails.join() === "trade_declined", JSON.stringify({ dx, dn, dc0 }));
    // (g) the REAL notice chain under the real doGenerateAndNotify
    const EDGE = "https://fn.test/functions/v1/send-notification";
    const chain = (A, sent, o) => {
      const quiet = { error: noopX, warn: noopX, log: noopX };
      const net = async (url, init) => {
        const kind = /send-push$/.test(url) ? "push" : "email";
        sent[kind].push(init.headers.Authorization);
        if (o.hold && o.hold[kind]) await o.hold[kind];
        if (o.fail && o.fail[kind]) { if (kind === "push") throw new TypeError("Failed to fetch"); return resp(500, { failed: 1 }); }
        return resp(200, { failed: 0 });
      };
      const push = G.pushNote({ edgeFunctionUrl: EDGE, fetch: net, dbAuthHeaders: hdr(A), console: quiet, showToast: A.showToast, sessionEpochRef: A.sessionEpochRef });
      const email = G.email({ edgeFunctionUrl: EDGE, fetch: net, dbAuthHeaders: hdr(A), console: quiet, showToast: A.showToast, sessionEpochRef: A.sessionEpochRef });
      const note = G.addNote({ db: { insert: async (tb, row) => { sent.inserts.push(tb + ":" + (A.token || "ANON")); if (o.hold && o.hold.insert) await o.hold.insert; return o.fail && o.fail.insert ? { data: null, error: "TypeError: Failed to fetch" } : { data: row, error: null }; } },
        showToast: A.showToast, setNotifications: () => { sent.listed++; }, buildDeepLink: () => "#", filterPushTargetsByType: (ty, ids) => ids, sendPushNotif: push, console: quiet, sessionEpochRef: A.sessionEpochRef });
      return { push, email, note };
    };
    const gated = () => { let open; const gate = new Promise(r => { open = r; }); return { gate, open }; };
    const notifyRun = async (how, at, fail) => {
      const { A } = await pair(); await ticks(A); const c = mkComp(A); c.render(); await c.fire(); A.toasts.length = 0;
      const sent = { inserts: [], push: [], email: [], listed: 0 }, g = gated(), hold = at ? { [at]: g.gate } : null;
      const ch = chain(A, sent, { hold, fail });
      const p = G.notify({ schedSyncRef: A.schedSyncRef, sessionEpochRef: A.sessionEpochRef, doGenerate: async () => "published", addNotification: ch.note, sendEmailNotif: ch.email, MO: HX.MO, startMonth: 0, endMoIdx: 2, startYear: 2030 })();
      await spin(30);
      if (how) { await cross(A, c, how); await spin(6); }
      g.open(); await p; await spin(30);
      return { sent, toasts: ours(A.toasts.map(x => x[0])) };
    };
    const n0 = await notifyRun(null, null), nso = await notifyRun("signout", "insert"), nob = await notifyRun("other", "insert");
    check("SE-X20 H7 (g) (R4-N1) the real doGenerateAndNotify with the REAL addNotification / sendPushNotif / sendEmailNotif: control — the notice inserted, its device push and the e-mail sent as A; a sign-out, or another account, while the notice's insert is out: NO device push and no e-mail from the next session, nothing put in its list, nothing said",
      n0.sent.inserts.join() === "notifications:TOK_A" && n0.sent.push.join() === "Bearer TOK_A" && n0.sent.email.join() === "Bearer TOK_A" && n0.toasts.length === 0
        && [nso, nob].every(x => x.sent.inserts.join() === "notifications:TOK_A" && x.sent.push.length === 0 && x.sent.email.length === 0 && x.sent.listed === 0 && x.toasts.length === 0), JSON.stringify({ n0, nso, nob }));
    const nf0 = await notifyRun(null, "insert", { insert: true }), nf = await notifyRun("signout", "insert", { insert: true });
    const pf = await notifyRun("signout", "push", { push: true }), ef = await notifyRun("other", "email", { email: true });
    check("SE-X20 H7 (g) (V3N) …the notice's insert FAILING after the sign-out during it: nothing said on the sign-in screen (in one session: 'Couldn't save that notification.'); the push's own request failing after a boundary during it, and the e-mail's: nothing said either",
      nf0.toasts.join("|") === "Couldn't save that notification." && nf.toasts.length === 0 && nf.sent.push.length === 0
        && pf.sent.push.join() === "Bearer TOK_A" && pf.toasts.length === 0 && ef.sent.email.join() === "Bearer TOK_A" && ef.toasts.length === 0, JSON.stringify({ nf0, nf, pf, ef }));
    // (h) the swap tool (swapShift): its notices fenced the same way
    { const { A } = await pair(); await ticks(A); const c = mkComp(A); c.render(); await c.fire(); A.toasts.length = 0;
      const sent = { inserts: [], push: [], email: [], listed: 0 }, gi = gated(), ge = gated();
      const ch = chain(A, sent, { hold: { insert: gi.gate, email: ge.gate }, fail: { email: true } });
      F.swapOne({ fmt: HX.fmt, shiftStartDate: HX.shiftStartDate, swapMsg: HX.swapMsg, SHIFT_LABELS: HX.SHIFT_LABELS, schedEditable: A.schedEditable, schedule: A.ref.current, scheduleRef: A.ref, showToast: A.showToast,
        silvisActive: false, silvisBlock: () => null, silvisRefuse: () => false, pushUndo: A.pushUndo, updateSchedule: A.updateSchedule, surgeons: S7, setEditShift: noopX, setEditingWeek: noopX,
        setSwapSuggestions: noopX, setSwapTarget: noopX, sMap: S7MAP, schedulerAdminIds: ["s7"], addNotification: ch.note, sendEmailNotif: ch.email })(X[2], "wed", "s7");
      await spin(20);
      await cross(A, c, "signout"); await spin(6);
      gi.open(); ge.open(); await spin(40);
      check("SE-X20 H7 (h) the real swapShift's notices (the real addNotification and sendEmailNotif): a sign-out while the notice's insert and the e-mail are out — no device push from the next session, and the e-mail's failure isn't said on the sign-in screen",
        sent.inserts.join() === "notifications:TOK_A" && sent.email.join() === "Bearer TOK_A" && sent.push.length === 0 && ours(A.toasts.map(x => x[0])).length === 0, JSON.stringify({ sent, toasts: A.toasts }));
    }
  });

  // SE-X21 — H6 (review r4 fixes-2 / fixes-10) and r4-fix-5: the factory reset's THIRD stored-data clear, the time
  // off, is an awaited, checked step of its chain (setup → APP shifts → time off → the weeks job), through the REAL
  // toClearAll and deleteTimeOff. (a) Its DELETE answers 503: exactly what was reset and what wasn't — one toast —
  // no "Reset complete", the server's time off unchanged and still on this screen, no weeks job; (b) no answer: it
  // may have been cleared, said so; (c) the control: it lands — "Reset complete", the time off cleared there and on
  // screen; (d) the session changing during it: no weeks job, nothing said, the guard refs back; (e) the "delete all
  // vacations" button's own toast never on the next session's screen. (f) r4-fix-5: every path that resets the setup
  // here resets the counts too (prior, year-1) and the period — the full reset, the half-landed one (G3), the one
  // whose time off failed. (g) r4-fix-10: the REAL snapshots.capture whose time_off read fails, throws or hangs past
  // its timeout, for the reset (reason reset_all_data): the capture fails closed, so the reset is refused — nothing
  // cleared, no time_off DELETE sent.
  await run("SE-X21", async () => {
    if (!gotG("SE-X21 21/n H6", ["runAuth", "reset", "delTO", "clearTO", "boundary", "reauth", "commit", "autosave", "bundle"])) return;
    const REFUSED = "Factory reset: the setup and the APP shifts were reset, but clearing the time off failed — so the time off and the schedule weeks were left as they are. Run the reset again, or restore the \"Before factory reset\" snapshot.";
    const UNANSWERED = "Factory reset: the setup and the APP shifts were reset, but the time-off clear got no answer — so the time off may have been cleared, and the schedule weeks were left as they are. Run the reset again, or restore the \"Before factory reset\" snapshot.";
    const spin = async (n) => { for (let j = 0; j < (n || 20); j++) await null; };
    const ours = (ts) => ts.filter(m => !/^Signed in as a different account than before/.test(m));
    const quiet = { error: noopX, warn: noopX, log: noopX };
    const go = async (o) => {
      const { t, A } = await pair(); await ticks(A);
      const c = o.cross ? mkComp(A) : null; if (c) { c.render(); await c.fire(); }
      A.toasts.length = 0;
      const sent = [], server = { call_schedule_data: { numWeeks: 13 }, app_shifts_data: { "2030-01-08": "a1" }, time_off: 3 };
      const screen = { vac: { s2: [["2030-01-08", "2030-01-10", 1]] }, nc: { s3: [["2030-01-09", "2030-01-09", 2]] }, appShifts: null, counts: { prior: [], y1: [], m: [], y: [] } };
      const refs = { allow: { current: false }, ever: { current: true } };
      const del = G.delTO({ SUPABASE_URL: BASE, dbAuthHeaders: () => ({ Authorization: "Bearer " + (A.token || "ANON") }), console: quiet, showToast: A.showToast, sessionEpochRef: A.sessionEpochRef,
        fetch: async (url, init) => {
          sent.push(init.method + " " + String(url).replace(/^.*rest\/v1\//, "") + " " + init.headers.Authorization);
          if (o.cross) { await (o.cross === "other" ? otherAccount(A, c) : G.boundary(bEnv(A, c)).handleSignOut()); await spin(6); }
          if (o.del === "throw") throw new TypeError("Failed to fetch");
          if (o.del >= 200 && o.del < 300) server.time_off = 0;
          return { ok: o.del >= 200 && o.del < 300, status: o.del, text: async () => "upstream connect error" };
        } });
      const tca = G.clearTO({ setVacations: (v) => { screen.vac = v; }, setNoCallDays: (v) => { screen.nc = v; }, logAudit: noopX, USE_TIME_OFF: true, deleteTimeOff: del });
      if (o.button) { await tca("vacation"); await spin(6); return { toasts: ours(A.toasts.map(x => x[0])), sent, vac: Object.keys(screen.vac).length, nc: Object.keys(screen.nc).length }; }
      const rec = mkRec(), J = appJobs(A, rec, { server, upsertFails: o.upsertFails, env: Object.assign({ toClearAll: tca, console: quiet, allowWipeSaveRef: refs.allow, everHadRealDataRef: refs.ever,
        setAppShifts: (v) => { screen.appShifts = v; }, setPriorCounts: (v) => screen.counts.prior.push(JSON.stringify(v)), setYear1Counts: (v) => screen.counts.y1.push(JSON.stringify(v)),
        setStartMonth: (v) => screen.counts.m.push(v), setStartYear: (v) => screen.counts.y.push(v) }, o.env || {}) });
      await J.reset(); if (rec.jobP) await rec.jobP; await ticks(A, 3); await nap(5); await ticks(A, 2);
      return { toasts: ours(A.toasts.map(x => x[0] + " :" + x[1])), status: rec.status.slice(), sent, server: clone(server), rows: t.rows().length, vac: Object.keys(screen.vac).length, nc: Object.keys(screen.nc).length,
        appShifts: screen.appShifts, counts: screen.counts, job: rec.jobP !== null, setup: rec.setupReset, ups: rec.upserts.slice(), allow: refs.allow.current, ever: refs.ever.current };
    };
    const stopped = (x) => x.ups.join() === "call_schedule_data,app_shifts_data" && x.server.time_off === 3 && x.vac === 1 && x.nc === 1 && !x.job && x.rows === 4 && x.setup === 1
      && JSON.stringify(x.appShifts) === "{}" && !x.status.includes("Reset complete") && x.allow === false && x.ever === true && x.sent.length === 1 && /^DELETE time_off\?id=not\.is\.null Bearer TOK_A$/.test(x.sent[0]);
    const f5 = await go({ del: 503 }), ft = await go({ del: "throw" }), ok = await go({ del: 204 });
    check("SE-X21 H6 (a) (R4-T1) the real resetAllData + toClearAll + deleteTimeOff, the time_off DELETE answering 503 after the setup and APP shifts were cleared: exactly '" + REFUSED + "' — ONE toast (not deleteTimeOff's generic one beside it), no 'Reset complete'; the server's time off unchanged, and still on this screen (vacations and no-call); no weeks job (the weeks stay); this screen takes the reset's setup and APP shifts; the guard refs back",
      stopped(f5) && f5.toasts.join("|") === REFUSED + " :error", JSON.stringify(f5));
    check("SE-X21 H6 (b) …the DELETE getting NO answer (thrown): '" + UNANSWERED + "' (it may have landed — said so), the rest as (a)",
      stopped(ft) && ft.toasts.join("|") === UNANSWERED + " :error", JSON.stringify(ft));
    check("SE-X21 H6 (c) control: the time_off DELETE lands — the time off cleared on the server and on this screen, the weeks job runs (every week deleted), 'Reset complete', no toast",
      ok.server.time_off === 0 && ok.vac === 0 && ok.nc === 0 && ok.job && ok.rows === 0 && ok.status.includes("Reset complete") && ok.toasts.length === 0, JSON.stringify(ok));
    const xo = await go({ del: 503, cross: "other" }), xs = await go({ del: 204, cross: "signout" });
    check("SE-X21 H6 (d) …the session changing while the time_off DELETE is out (another account; a sign-out): the reset goes no further — no weeks job as the next account, nothing said (none of its messages, not deleteTimeOff's), no 'Reset complete'; the guard refs back",
      [xo, xs].every(x => !x.job && x.toasts.length === 0 && !x.status.includes("Reset complete") && x.rows === 4 && x.allow === false && x.ever === true), JSON.stringify({ xo, xs }));
    const bx = await go({ button: true, del: 503, cross: "other" }), b0 = await go({ button: true, del: 503 });
    check("SE-X21 H6 (e) the 'delete all vacations' button (toClearAll('vacation')), its DELETE failing: in one session 'Couldn't remove that — check your connection and try again.' and the vacations still shown; after a session change during it, nothing said on the next screen",
      b0.toasts.join("|") === "Couldn't remove that — check your connection and try again." && b0.vac === 1 && bx.toasts.length === 0, JSON.stringify({ b0, bx }));
    const half = await go({ del: 204, upsertFails: { app_shifts_data: "HTTP 503 upstream" } });
    const reset = (x) => x.counts.prior.includes("{}") && x.counts.y1.includes("{}") && x.counts.m.includes(4) && x.counts.y.includes(2026);
    check("SE-X21 r4-fix-5 every path that resets the setup on this screen resets the counts (prior and year-1: {}) and the period (April 2026): the full reset, the half-landed one (the APP-shifts clear failed — G3), the one whose time-off clear failed",
      reset(ok) && reset(half) && reset(f5) && half.toasts.length === 1 && /clearing the APP shifts failed/.test(half.toasts[0]), JSON.stringify({ ok: ok.counts, half: half.counts, f5: f5.counts }));
    // (g) r4-fix-10: the REAL snapshots.capture (config.js), its time_off read failing for reset_all_data
    const cfgOf = (net) => {
      const g = { console: { log() {}, warn() {}, error() {}, info() {} }, window: {}, document: undefined, navigator: { userAgent: "node-test" }, setTimeout, clearTimeout, AbortController,
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, fetch: net, atob: (s) => Buffer.from(s, "base64").toString("binary") };
      g.globalThis = g; vm.createContext(g);
      for (const f of ["helpers.js", "config.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), g, { filename: f });
      return vm.runInContext("snapshots", g);
    };
    const capRun = async (mode) => {
      const ok1 = (json) => Promise.resolve({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
      const calls = [];
      const snaps = cfgOf((url, init = {}) => {
        const u = String(url), m = (init.method || "GET").toUpperCase(); calls.push(m + " " + u.replace(/^.*\/rest\/v1\//, "").split("?")[0]);
        if (m === "POST") return Promise.resolve({ ok: true, status: 201, json: async () => [], text: async () => "" });
        if (/call_schedule_data/.test(u)) return ok1([{ data: { surgeons: S7, numWeeks: 13 }, updated_at: "2026-10-14T08:00:00Z" }]);
        if (/schedule_weeks/.test(u)) return ok1(ROWS().map(r => ({ week_monday: r.week_monday, data: r.data })));
        if (mode === "ok") return ok1([{ id: 1, person_id: "s2", kind: "vacation", start_date: "2030-01-08", end_date: "2030-01-10" }]);
        if (mode === "503") return Promise.resolve({ ok: false, status: 503, json: async () => ({}), text: async () => "upstream" });
        if (mode === "throw") return Promise.reject(new TypeError("Failed to fetch"));
        return new Promise((_, rej) => { if (init.signal) init.signal.addEventListener("abort", () => rej(new Error("AbortError"))); });   // hang: until its timeout aborts it
      });
      snaps.timeoutMs = 30;
      const x = await go({ del: 204, env: { snapshots: snaps } });
      return Object.assign(x, { calls });
    };
    const c503 = await capRun("503"), cth = await capRun("throw"), chg = await capRun("hang"), cok = await capRun("ok");
    const refused = (x) => x.toasts.join("|") === "Couldn't save a backup snapshot — reset cancelled. Nothing was deleted. :error" && x.status.includes("Reset cancelled") && x.ups.length === 0 && x.sent.length === 0
      && x.server.time_off === 3 && !x.job && x.rows === 4 && x.setup === 0 && !x.calls.some(c => c.startsWith("POST"));
    check("SE-X21 r4-fix-10 the REAL snapshots.capture for the factory reset (reset_all_data), its time_off read answering 503, throwing, or hanging past its timeout: it fails closed — no snapshot without the time off it is about to delete — so the reset is refused ('Couldn't save a backup snapshot — reset cancelled. Nothing was deleted.'): nothing cleared, no time_off DELETE sent, the weeks untouched; control: the read answers — the snapshot inserted (with the vacations) and the reset runs",
      refused(c503) && refused(cth) && refused(chg) && cok.calls.filter(c => c.startsWith("POST")).length === 1 && cok.status.includes("Reset complete"), JSON.stringify({ c503, cth, chg, cok: { status: cok.status, calls: cok.calls } }));
  });

  // SE-X22 — H4 (review r4 branch-4): a tab never writes with another account's token. Two tabs of ONE browser — each
  // its own REAL config.js (its own auth, its own binding), sharing one localStorage — and tab 2's app wired with its
  // real auth and headers on the real engine. Tab 2 is A's, with an unsaved week (A's token refused: "Sign in again").
  // Tab 1 signs out and signs in as B. (a) Tab 2's next pull sends NOTHING as B (nor anything at all): it reads the
  // stored session as no session — the header says "Sign in again"; (b) it hears the change at once (the storage
  // event): the engine reports, the banner shows; (c) a setup change in tab 2 is never written (said: not saved —
  // signed out), a time-off edit and every direct write (dbAuthHeaders) go out as anon — never as B; (d) its "Sign
  // in again" renews the STORED session — B's — and lands as another account: the real boundary runs, A's unsaved
  // week discarded and said so, the tab bound to B from then on. (e) The sign-in form and the Face ID unlock bind the
  // tab to their account (another account's token stored after that is no session there).
  await run("SE-X22", async () => {
    if (!gotG("SE-X22 21/n H4", ["boundary", "reauth", "commit", "autosave", "bundle", "raSync", "authSubmit", "bioUnlock"])) return;
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const jwt = (sub, n) => "eyJhbGciOiJIUzI1NiJ9." + b64({ sub, exp: Math.floor(Date.now() / 1000) + 3600, n }) + ".sig";
    const subOf = (tok) => { try { return JSON.parse(Buffer.from(String(tok).split(".")[1], "base64").toString()).sub; } catch (e) { return null; } };
    const JA = jwt("auth-a", 1), JB = jwt("auth-b", 1), JB2 = jwt("auth-b", 2), JC = jwt("auth-c", 1);
    const store = new Map();
    const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } };
    const calls = [];
    const net = async (url, init = {}) => {   // the auth server, and the tables these tabs write directly (time off, notices…)
      const u = String(url), body = init.body ? JSON.parse(init.body) : null, au = (init.headers && init.headers.Authorization) || "-";
      calls.push((init.method || "GET") + " " + u.replace(/^https:\/\/[^/]+/, "").split("?")[0] + (u.includes("grant_type=") ? "?" + u.split("grant_type=")[1] : "") + " " + au + (body && body.refresh_token ? " rt=" + body.refresh_token : ""));
      const resp = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json) });
      if (/grant_type=password/.test(u)) return resp(200, { access_token: JB, refresh_token: "RB", user: { id: "auth-b", email: "b@dsg.test" } });
      if (/grant_type=refresh_token/.test(u)) return body && body.refresh_token === "RB" ? resp(200, { access_token: JB2, refresh_token: "RB2", user: { id: "auth-b", email: "b@dsg.test" } }) : resp(400, { error: "invalid_grant" });
      if (/\/auth\/v1\/logout/.test(u)) return resp(204, null);
      if (/\/auth\/v1\/user/.test(u)) return resp(200, { id: subOf(au.replace(/^Bearer /, "")) });
      if (/user_profiles/.test(u)) return resp(200, []);
      return resp(201, [Object.assign({ id: 9 }, body)]);
    };
    const tabCfg = () => {
      const g = { console: { log() {}, warn() {}, error() {}, info() {} }, window: {}, document: undefined, navigator: { userAgent: "node-test" }, setTimeout, clearTimeout, AbortController,
        localStorage: ls, fetch: net, atob: (s) => Buffer.from(s, "base64").toString("binary") };
      g.globalThis = g; vm.createContext(g);
      for (const f of ["helpers.js", "config.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), g, { filename: f });
      return vm.runInContext("({ auth, dbAuthHeaders, dbReadHeaders, dbHeaders, db, SUPABASE_ANON_KEY })", g);
    };
    const bind = (cfg, id) => { if (typeof cfg.auth.bindUser === "function") cfg.auth.bindUser(id); };
    const boundOf = (cfg) => (typeof cfg.auth.boundUser === "function" ? cfg.auth.boundUser() : "no boundUser()");
    const tab1 = tabCfg(), tab2 = tabCfg(), ANONH = "Bearer " + tab2.SUPABASE_ANON_KEY;
    const t = createFakeWeeksTable({ baseUrl: BASE, anonKey: tab2.SUPABASE_ANON_KEY, users: { [JA]: "user-a", [JB]: "user-b", [JB2]: "user-b" }, rows: ROWS(), clock: () => new Date(xms += 1000).toISOString() });
    ls.setItem("dsg-auth-token", JA); ls.setItem("dsg-auth-refresh", "RA");                   // A is signed in, in both tabs
    bind(tab1, "auth-a"); bind(tab2, "auth-a");
    const T2 = mkApp(t, { cfg: tab2 }); await T2.eng.load(); await ticks(T2);
    const c = mkComp(T2); c.render(); await c.fire();                                          // tab 2's component (its setup autosave, as A)
    t.control.expiredTokens.add(JA);                                                           // A's token refused by the server…
    T2.edit(X[0], w => (w.dayCall = "s7", w)); await T2.eng.push(); await ticks(T2);          // …tab 2's edit waits: "Sign in again"
    const setup = T2.eng.status().authNeeded && T2.eng.pending().join() === X[0];
    await tab1.auth.signOut(); bind(tab1, null);                                              // tab 1: signs out…
    const si = await tab1.auth.signIn("b@dsg.test", "pw"); bind(tab1, si.user.id);           // …and in as B: B's session stored
    const storedB = ls.getItem("dsg-auth-token") === JB;
    // (b) the storage event in tab 2
    const fx = { reauth: [], reports: 0 }; let listener = null;
    if (G.storageFx) G.storageFx({ authUser: { id: "auth-a" }, window: { addEventListener: (k, f) => { if (k === "storage") listener = f; }, removeEventListener: noopX },
      schedSyncRef: { current: { report: () => { fx.reports++; T2.eng.report(); } } }, auth: tab2.auth, setReauthNeeded: (v) => fx.reauth.push(v) })();
    if (listener) listener({ key: "dsg-auth-token" });
    const heard = { listener: !!listener, reports: fx.reports, reauth: fx.reauth.slice(), line: LV(T2.sync) };
    // (a) tab 2's 60-s pull
    const from = t.log.length;
    await T2.eng.pull(); await ticks(T2);
    const pulled = { wB: writesOf(t, from, JB).length + writesOf(t, from, JB2).length, w: writesOf(t, from).length, authNeeded: T2.eng.status().authNeeded, line: LV(T2.sync), pending: T2.eng.pending().join() };
    check("SE-X22 H4 (a) (p3) two tabs share the stored session: tab 1 signs out and signs in as B; tab 2 (A's, a week unsaved) pulls — it sends NOTHING as B (nor anything else): another account's stored session is no session in a tab bound to A — the week still pending, the header 'Sign in again'",
      setup && storedB && pulled.wB === 0 && pulled.w === 0 && pulled.authNeeded === true && pulled.line === "auth:1" && pulled.pending === X[0], JSON.stringify({ setup, storedB, pulled }));
    check("SE-X22 H4 (b) …and tab 2 hears the change at once (the storage event on the session's key): the engine reports — 'Sign in again' — and the banner is raised, before any pull",
      heard.listener && heard.reports === 1 && heard.reauth.includes(true) && heard.line === "auth:1", JSON.stringify(heard));
    // (c) a setup change and a time-off edit in the stale tab
    c.upserts.length = 0; c.status.length = 0;
    c.set("numWeeks")(20); await ticks(T2); await c.fire();
    const setupRes = { ups: c.upserts.map(u => u.tb + ":" + u.as), said: c.status.includes("⚠ Not saved — you're signed out. Sign in again") };
    calls.length = 0;
    await tab2.db.insert("time_off", { person_id: "s1", kind: "vacation", start_date: "2030-01-08", end_date: "2030-01-09" });
    const toCall = calls.slice(), hdrs = { write: tab2.dbAuthHeaders().Authorization, read: tab2.dbReadHeaders().Authorization, session: tab2.auth.getSession() };
    check("SE-X22 H4 (c) …a setup change in tab 2 is never written (the autosave sees no session: '⚠ Not saved — you're signed out. Sign in again'), and a time-off edit — like every direct write (trade requests, notices, APP shifts: dbAuthHeaders) — goes out as anon, never with B's token; its reads as anon too",
      setupRes.ups.length === 0 && setupRes.said && toCall.length === 1 && toCall[0].endsWith(ANONH) && hdrs.write === ANONH && hdrs.read === ANONH && hdrs.session === null, JSON.stringify({ setupRes, toCall, hdrs }));
    // (d) "Sign in again" in tab 2
    calls.length = 0; T2.toasts.length = 0;
    const env = Object.assign(bEnv(T2, c), { authUser: { id: "auth-a", email: "a@dsg.test" }, showToast: T2.showToast, dbAuth: { getProfile: async () => ({ person_id: "s2", role: "scheduler" }) }, setReloadTrigger: () => { c.reloads++; },
      auth: tab2.auth, reauthBusy: false, setReauthBusy: noopX, setReauthPassword: noopX, setReauthError: noopX, setReauthSheet: (v) => { c.sheet = v; } });
    env.sessionBoundary = G.boundary(env).sessionBoundary;
    env.reauthLanded = G.reauth(env);
    await G.raSync(env)(); await ticks(T2, 2);
    const renewed = { calls: calls.slice(), bound: boundOf(tab2), toasts: T2.toasts.map(x => x[0]), epoch: T2.sessionEpochRef.current, pending: T2.eng.pending(), table: t.get(X[0]).data.dayCall, now: tab2.dbAuthHeaders().Authorization };
    check("SE-X22 H4 (d) …tab 2's 'Sign in again' renews the STORED session (B's refresh token) and lands as ANOTHER account: the real session boundary runs, A's unsaved week is discarded — 'Signed in as a different account than before — the 1 week not saved was discarded.' — never sent; from then on the tab is B's (bound to B, its writes as B)",
      renewed.calls.some(x => x === "POST /auth/v1/token?refresh_token - rt=RB") && renewed.bound === "auth-b" && renewed.epoch === 1 && renewed.pending.length === 0
        && renewed.toasts.includes("Signed in as a different account than before — the 1 week not saved was discarded.") && renewed.table === "s1" && renewed.now === "Bearer " + JB2, JSON.stringify(renewed));
    // (f) a sign-out in a tab bound to A while ANOTHER account's session is stored (another tab's): that session is
    // neither logged out on the server (a request as B) nor cleared — and the tab is unbound after it (signed out)
    const tab5 = tabCfg(); bind(tab5, "auth-a");                                              // (JB2 — B's renewed session — is what's stored now)
    calls.length = 0;
    await G.boundary(Object.assign(bEnv(T2, c), { auth: tab5.auth })).handleSignOut();
    const so = { calls: calls.slice(), stored: ls.getItem("dsg-auth-token") === JB2, bound: boundOf(tab5) };
    check("SE-X22 H4 (f) the real handleSignOut in a tab bound to A while another account's session (B's, stored by another tab) is in the shared storage: no server logout as B, B's session left in place — and the tab unbound after its sign-out (the sign-in form's requests run as nobody's)",
      !so.calls.some(x => /auth\/v1\/logout/.test(x)) && so.stored && so.bound === null, JSON.stringify(so));
    // (e) the sign-in form's submit and the Face ID unlock bind the tab
    const tab3 = tabCfg(); ls.removeItem("dsg-auth-token"); ls.removeItem("dsg-auth-refresh");
    const rec3 = { user: null };
    await G.authSubmit({ setAuthError: noopX, setAuthBusy: noopX, authMode: "login", signupPersonId: "", dbAuth: { getProfile: async () => ({ person_id: "s2", role: "member" }) }, auth: tab3.auth, authEmail: "b@dsg.test", authPassword: "pw", allPeople: [],
      setAuthUser: (u) => { rec3.user = u; }, setUserProfile: noopX, setMySurgeon: noopX, setNeedsProfile: noopX, setIsScheduler: noopX, setReloadTrigger: noopX, setAuthEmail: noopX, setAuthPassword: noopX,
      fetch: net, SUPABASE_URL: BASE, dbAuthHeaders: tab3.dbAuthHeaders, saveNotifPref: noopX, showToast: noopX, console: { error: noopX, warn: noopX, log: noopX } })();
    const afterSignIn = { bound: boundOf(tab3), user: rec3.user && rec3.user.id, own: tab3.dbAuthHeaders().Authorization };
    ls.setItem("dsg-auth-token", JC);                                                          // another tab stores account C's session
    const foreign3 = tab3.dbAuthHeaders().Authorization;
    const tab4 = tabCfg(); ls.setItem("dsg-auth-token", JB2); ls.setItem("dsg-auth-refresh", "RB2");
    await G.bioUnlock({ setAuthError: noopX, setAuthBusy: noopX, biometric: { authenticate: async () => ({ success: true }) }, auth: tab4.auth, setAuthUser: noopX, dbAuth: { getProfile: async () => null },
      setUserProfile: noopX, setMySurgeon: noopX, setNeedsProfile: noopX, setBiometricPending: noopX, setReloadTrigger: noopX })();
    const afterBio = boundOf(tab4); ls.setItem("dsg-auth-token", JC); const foreign4 = tab4.dbAuthHeaders().Authorization;
    check("SE-X22 H4 (e) the sign-in form's submit (its own request unbound) binds the tab to the account it signed in — its own token used, another account's stored after that is no session there (anon); the Face ID unlock the same",
      afterSignIn.bound === "auth-b" && afterSignIn.user === "auth-b" && afterSignIn.own === "Bearer " + JB && foreign3 === ANONH && afterBio === "auth-b" && foreign4 === ANONH, JSON.stringify({ afterSignIn, foreign3, afterBio, foreign4 }));
  });

  // SE-X-I — the harness rule (A17(c)).
  const bad = apps.reduce((acc, a) => acc.concat(a.unexpected()), []).concat(xcon);
  check("SE-X-I no unexpected error in any run: no console.error (the app's catch blocks; the engine's internal errors, as the app wires them), no caught callback error ('… threw'), nothing on a context's global console",
    bad.length === 0, bad.slice(0, 3).join(" | "));
}

// For the app-wiring tests in sync-guards (SE-A): the same extraction and the
// same bare compile, so they drive the real engine too — and the week
// editor's pure merge (mergeEditorEdits, A17(a)), which sits inside the same
// anchors, compiled the same way in an EMPTY context (it needs nothing).
module.exports.extractEngine = extractEngine;
module.exports.compileEngine = compile;
module.exports.compileMerge = compileMerge;
// A17(c) for those harnesses: a console that records into an array, and the
// engine `log` dep that records a caught callback error.
module.exports.recConsole = recConsole;
module.exports.caughtLog = caughtLog;

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
