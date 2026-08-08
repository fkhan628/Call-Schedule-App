// Pure consistency check between the two representations of "backup week":
// the blob-level Monday lists (backupMondays / fierceBackup arrays, edited in
// Settings) and the per-week schedule flags (isBackup / isFierceBackup,
// stamped by the generator at generation time and — since the 2026-08 fix —
// kept in step by the Settings handlers). Divergence is the 9/14→9/28 trade
// bug class: badges, exports, stats, and the billing skip each key off
// whichever representation they happen to read.
//
// Contract (generator-regression's only-unambiguous-violations rule):
//  - A Monday in a list whose week EXISTS with flag !== true → violation.
//  - A week with flag === true whose Monday is NOT in the list → violation.
//  - A Monday in a list with NO schedule week at all is NOT a violation: it
//    is the legitimate "marked, applies at next generation" state (live lists
//    extend past the generated window). Returned in `pending` for audits.
//
// Pure data-shape logic — no app modules, no I/O — so it is requireable from
// the CI harness (sync-guards section H) and from a live-dump audit
// (test/audit-live-backup-flags.js) alike.
function checkBackupFlagConsistency(schedule, backupMondays, fierceBackup) {
  const violations = [];
  const pending = [];
  const sched = schedule || {};
  const pairs = [
    ["backupMondays", new Set(backupMondays || []), "isBackup"],
    ["fierceBackup", new Set(fierceBackup || []), "isFierceBackup"],
  ];
  for (const [listName, set, flag] of pairs) {
    for (const m of [...set].sort()) {
      const wk = sched[m];
      if (!wk) { pending.push(`${m}: in ${listName}, no schedule week yet`); continue; }
      if (wk[flag] !== true) violations.push(`${m}: in ${listName} but ${flag} is ${JSON.stringify(wk[flag])}`);
    }
    for (const [m, wk] of Object.entries(sched).sort()) {
      if (wk && wk[flag] === true && !set.has(m)) violations.push(`${m}: ${flag} true but Monday not in ${listName}`);
    }
  }
  return { violations, pending };
}

module.exports = { checkBackupFlagConsistency };
