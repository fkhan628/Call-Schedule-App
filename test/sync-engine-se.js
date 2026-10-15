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

module.exports = async function runSE({ src, check }) {
  console.log("\nSE. sync engine v2 (the real createSchedSync on an emulated schedule_weeks)");
  const engSrc = extractEngine(src);
  check("SE0 createSchedSync is extractable by its anchors (exactly one definition)", !!engSrc);
  if (!engSrc) return;
  let createSchedSync, merge;
  try { createSchedSync = compile(engSrc); merge = compileMerge(engSrc); }
  catch (ex) { check("SE0 createSchedSync compiles standalone", false, String(ex)); return; }
  await scenarios(createSchedSync, check);
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
      if (!m.app) await scenarios(mutant, quiet);
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
    from: "        p.then(r => lateOutcome(owner.what, r));\n", to: "" },
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
    from: "const refuse = (out) => { if (!keys && gen === g) showKnown(startShown); return out; };", to: "const refuse = (out) => out;" },
  { id: "M69", what: "putting the screen back overwrites a week edited after the tap",
    from: "      if (shownNow !== startShown[k]) return;\n      const want = known[k] ? known[k].canon : DEL;\n      if (shownNow !== want) { changed = true;", to: "      const want = known[k] ? known[k].canon : DEL;\n      if (shownNow !== want) { changed = true;" },
  { id: "M70", what: "a clear cancelled at its deadline leaves its target on screen",
    from: "owner.release(); if (!keys) showKnown(startShown); report(); return { ok: false, wrote: false, reason: \"timeout\"", to: "owner.release(); report(); return { ok: false, wrote: false, reason: \"timeout\"" },
  { id: "M71", what: "a refused publish takes its generated weeks off screen (they'd never be retried — A14)",
    from: "const refuse = (out) => { if (!keys && gen === g) showKnown(startShown); return out; };", to: "const refuse = (out) => { if (gen === g) showKnown(startShown); return out; };" },
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
    from: "        confirm(k, row);\n        // The server stored something other", to: "        confirm(k, row && Object.assign({}, row, { updated_at: ts }));\n        // The server stored something other" },
  { id: "M79", what: "the keepalive's CAS on the version alone (a stalled one lands on a week re-created at v1 — A2/A9)",
    from: 'return { url: `${base()}?week_monday=eq.${k}&${cas(kn)}`, init: { method: "PATCH", keepalive: true', to: 'return { url: `${base()}?week_monday=eq.${k}&version=eq.${kn.version}`, init: { method: "PATCH", keepalive: true' },
  { id: "M80", what: "a 404 PGRST205 is a client error (no read-back; 'reload/update the app' — A4: unknown)",
    from: "if ([404, 408, 413, 429].includes(r.status)", to: "if ([408, 413, 429].includes(r.status)" },
  { id: "M81", what: "the same data under a new token is someone else's (an old build's unchanged re-send costs the edit — A2)",
    from: '    if (kn && row && c === kn.canon) return "refreshed";\n', to: "" },
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
];

async function scenarios(createSchedSync, check) {
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
      fetch: (u, i) => table.fetch(u, i),
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
    holdP.release(); const r2 = await rp;
    const reps2 = P.statuses.slice(from1), lastPub = reps2.map(s => s.busy).lastIndexOf("publish"), endRep = reps2[lastPub + 1] || {};
    check("SE58 …a publish: mid-job only the edit OUTSIDE its period is pending (the period's weeks — one failed, one on the wire — are its own), pending() still names all three",
      midP.st.pendingKeys.join() === W[4] && midP.st.busy === "publish" && midP.raw.join() === [W[1], W[2], W[4]].join(), JSON.stringify(midP));
    check("SE58 …and the report it makes as it ends hands them back: busy cleared, the week it couldn't write pending (and failing) again beside the outside edit",
      r2.ok === false && lastPub >= 0 && endRep.busy === null && (endRep.pendingKeys || []).join() === [W[1], W[4]].join() && endRep.failing === 1, JSON.stringify({ lastPub, endRep, reps2: reps2.map(s => [s.busy, (s.pendingKeys || []).join("|")]) }));
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
  HELPERS = vm.runInContext("({ fmt, parse, addD, shiftStartDate, SHIFT_LABELS, swapMsg, cascadeMsg, tradeAcceptMsg, MO })", g);
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
  const HX = appHelpers();
  const F = {
    wire: fnX("isPublicMode, userProfile, showToast, setEditWeekModal, swapSuggestions, swapTarget, setSwapSuggestions, setSwapTarget, schedSyncBridgeRef, useRef, createSchedSync, scheduleRef, commitSchedule, fetch, SUPABASE_URL, dbAuthHeaders, dbReadHeaders, dbHeaders, auth, setSchedSync, console",
      wrap("(() => { schedSyncBridgeRef.current = { canWrite:", after("  schedSyncBridgeRef.current = { canWrite:", "\n\n  // The edit gates"), "\n  return schedSyncRef; })()")),
    gate: fnX("schedSyncRef, showToast, setReauthNeeded", wrap("() => {", after("  const schedEditable = () => {", "\n  };\n"), "\n  }")),
    pushUndo: fnX("scheduleRef, schedSyncRef, setScheduleHistory", wrap("(counts) => {", after("  const pushUndo = useCallback((counts) => {", "\n  }, []);"), "\n  }")),
    update: fnX("scheduleRef, commitSchedule", wrap("(fn) => {", after("  const updateSchedule = useCallback((fn) => {", "\n  }, [commitSchedule]);"), "\n  }")),
    undo: fnX("scheduleHistory, schedEditable, schedSyncRef, showToast, commitSchedule, setPriorCounts, setYear1Counts, setScheduleHistory", wrap("() => {", after("  const undoLastChange = () => {", "\n  };\n"), "\n  }")),
    unload: fnX("isPublicMode, dayOffDirtyRef, dayOffSaveTimerRef, clearTimeout, dayOffEnqueueRef, console, schedSyncRef, fetch, document, window",
      wrap("() => {\n    // (The blob keepalive is gone", after("  useEffect(() => {\n    // (The blob keepalive is gone", "\n  }, []);"), "\n  }")),
    load: fnX("loadFailedRef, supabase, lastSyncRef, setSurgeons, setApps, USE_TIME_OFF, setVacations, setNoCallDays, setBackupMondaySet, setFierceBackupSet, setAppShifts, setPriorCounts, setYear1Counts, setStartMonth, setStartYear, setNumWeeks, setStartMondayOverride, setHolidayAssignments, setPendingLocks, setSilvisRule, sfRule, setDismissedWarnings, everHadRealDataRef, setEdgeFunctionUrl, console, setAppShiftsLoaded, appOffVisible, adoptDayOffRow, db, setVacRequests, setTradeRequests, setNotifications, showToast, schedSyncRef, scheduleRef, loadTimeOff, loadSilvisFeed, refreshSilvisFeed, setLoaded, loadedAtRef, getSupabaseRT, window, setTimeout, setInterval, clearInterval",
      wrap("() => {", after("  // ─── Supabase: Load on mount + real-time sync ───\n  useEffect(() => {", "\n  }, [reloadTrigger]);"), "\n  }")),
    swapOne: fnX("fmt, shiftStartDate, swapMsg, SHIFT_LABELS, schedEditable, schedule, scheduleRef, showToast, silvisActive, silvisBlock, silvisRefuse, pushUndo, updateSchedule, surgeons, setEditShift, setEditingWeek, setSwapSuggestions, setSwapTarget, sMap, schedulerAdminIds, addNotification, sendEmailNotif",
      wrap("", after("  const swapShift = ", "\n  };\n"), "\n  }")),
    swapTwo: fnX("fmt, shiftStartDate, swapMsg, SHIFT_LABELS, schedEditable, schedule, scheduleRef, showToast, silvisActive, silvisBlock, silvisRefuse, pushUndo, updateSchedule, surgeons, setEditShift, setEditingWeek, setSwapSuggestions, setSwapTarget, sMap, schedulerAdminIds, addNotification, sendEmailNotif",
      wrap("", after("  const executeTwoWaySwap = useCallback(", "\n  }, [surgeons, sMap, addNotification, sendEmailNotif, schedulerAdminIds, silvisActive, silvisBlock, silvisRefuse]);"), "\n  }")),
    accept: fnX("fmt, shiftStartDate, showToast, schedEditable, scheduleRef, detectCascadeChanges, surgeons, silvisActive, silvisBlock, silvisRefuse, confirm, fetch, SUPABASE_URL, dbAuthHeaders, console, setTradeRequests, tradeAcceptMsg, logAudit, pushUndo, updateSchedule, addNotification, sendEmailNotif, SHIFT_LABELS, schedulerAdminIds, cascadeMsg, schedule",
      wrap("async (req) => {", after("  const acceptTradeRequest = useCallback(async (req) => {", "\n  }, [schedule, surgeons, pushUndo, addNotification, sendEmailNotif, detectCascadeChanges, schedulerAdminIds, silvisActive, silvisBlock, silvisRefuse]);"), "\n  }")),
    cascades: fnX("surgeons, SHIFT_LABELS", wrap("(sched, req) => {", after("  const detectCascadeChanges = useCallback((sched, req) => {", "\n  }, [surgeons]);"), "\n  }")),
    openEditor: fnX("scheduleRef, parse, addD, fmt, appShifts, appShiftsLoaded, setEditWeekModal, schedSyncRef", wrap("(mondayStr) => {", after("  const openWeekEditor = useCallback((mondayStr) => {", "\n  }, [appShifts, appShiftsLoaded]);"), "\n  }")),
    saveEditor: fnX("editWeekModal, schedule, appShifts, appShiftsLoaded, openWeekEditor, setEditWeekModal, silvisActive, silvisFakId, silvisDays, silvisBlock, silvisRefuse, sfSlotDays, confirm, pushUndo, updateSchedule, scheduleRef, schedEditable, schedSyncRef, mergeEditorEdits, SHIFT_LABELS, backupMondaySet, fierceBackupSet, surgeons, showToast, APP_SHIFTS_NOT_LOADED, setAppShifts, saveAppShifts, logAudit, nameOf, aMap, sMap, schedulerAdminIds, addNotification, sendEmailNotif, setTimeout",
      wrap("(openAfter) => {", after("  const saveWeekEdits = useCallback((openAfter) => {", "\n  }, [editWeekModal,"), "\n  }")),
    acceptPreview: fnX("publishSearchRunning, showToast, cancelSearch, previewSchedule, previewNeedsOk, previewAck, publishingRef, schedEditable, schedSyncRef, previewEpochRef, previewOrigin, startMonth, startYear, numWeeks, setPublishing, setSaveStatus, snapshots, previewSchedRef, publishWeeks, MO, runPublish, setPreviewSchedule, setShowPreview, setCalMonth, setCalYear, setView, setTimeout, publishNotLanded",
      wrap("async () => {", after("  const acceptPreview = async () => {", "\n  };\n"), "\n  }")),
    notLanded: fnX("showToast", wrap("(pr, what) => {", after("  const publishNotLanded = (pr, what) => {", "\n  };\n"), "\n  }")),
    runPublish: fnX("schedSyncRef", after("  const runPublish = ", ";\n")),
  };
  const missing = Object.keys(F).filter(k => typeof F[k] !== "function");
  check("SE-X the component slices are extractable by their anchors and compile in a fresh context", missing.length === 0, missing.join(", "));
  if (missing.length) return;

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
  // One app session: the mirror and its one writer, the undo history, ONE
  // toast slot (the engine's onToast is the app's showToast, as wired), the
  // app's own engine construction, the real gate / pushUndo / updateSchedule.
  const mkApp = (t, o = {}) => {
    const a = { t, token: o.token || "TOK_A", toasts: [], errors: [], warns: [], history: [], ref: { current: {} }, modal: null, sync: null, reauth: 0, sug: null, target: null };
    const text = (x) => x.map(v => (v && v.stack ? String(v.message) : String(v))).join(" ");
    a.console = { error: (...x) => a.errors.push(text(x)), warn: (...x) => a.warns.push(text(x)), log: () => {}, info: () => {} };
    a.commitSchedule = (n) => { a.ref.current = n; };
    a.showToast = (m, tone) => a.toasts.push([String(m), tone || "info"]);
    a.setModal = (x) => { a.modal = typeof x === "function" ? x(a.modal) : x; };
    const hdr = () => ({ apikey: "ANON", Authorization: "Bearer " + (a.token || "ANON") });
    const engRef = { current: null };
    a.bridge = { current: null };
    a.schedSyncRef = F.wire({ isPublicMode: false, userProfile: { person_id: o.person || "s1" }, showToast: a.showToast, setEditWeekModal: a.setModal,
      swapSuggestions: null, swapTarget: null, setSwapSuggestions: (v) => { a.sug = v; }, setSwapTarget: (v) => { a.target = v; },
      schedSyncBridgeRef: a.bridge, useRef: () => engRef, createSchedSync, scheduleRef: a.ref, commitSchedule: a.commitSchedule, fetch: (u, i) => t.fetch(u, i), SUPABASE_URL: BASE,
      dbAuthHeaders: hdr, dbReadHeaders: hdr, dbHeaders: { apikey: "ANON", Authorization: "Bearer ANON", "Content-Type": "application/json" },
      auth: { getSession: () => (a.token ? { access_token: a.token } : null) }, setSchedSync: (f) => { a.sync = typeof f === "function" ? f(a.sync) : f; }, console: a.console });
    a.eng = a.schedSyncRef.current;
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
      F.load({ loadFailedRef: { current: false }, supabase: { from: () => ({ select: () => ({ eq: () => ({ single }) }) }) }, lastSyncRef: { current: null },
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
