// Live-data audit for backup-flag consistency. NOT wired into CI — a manual
// tool. Feed it ONE JSON file shaped like the app payload / a snapshot body:
//   { schedule: { "YYYY-MM-DD": weekObj, ... },
//     backupMondays: ["YYYY-MM-DD", ...], fierceBackup: [...] }
// call_schedule_snapshots.data is exactly this shape; or fold schedule_weeks
// rows into `schedule` yourself as { [row.week_monday]: row.data }.
// File-fed on purpose: no keys, no network. Exits 1 on violations.
//
// ─── PROBE RULE (2026-09-07) — applies to EVERY diagnostic read in this
// project, not just this file. An anon SELECT against an RLS-gated table
// returns HTTP 200 + [] — an RLS DENIAL is indistinguishable from an empty
// table. Such a read PROVES NOTHING ABOUT CONTENTS, in either direction.
// ANY conclusion of emptiness ("no rows exist", "nothing to reconcile",
// "never happened") requires a read at the privilege level the policy
// actually grants — the linked Supabase CLI, the SQL editor, or a session
// holding a JWT the policy admits. This is the same lesson the DATA LAYER
// learned in June (RLS-blocked reads return [] with a green check), now
// binding on the TOOLS THAT CHECK the data layer. It has already cost once:
// a 2026-07-18 "shift_trade_requests is EMPTY" note was recorded as fact
// from a read that could not have known, and survived until 2026-09-07,
// when the same method returned [] for a table holding a live pending
// trade. If a probe cannot name the privilege level it read at, its
// negative results are not findings.
// Any live violation is REPORT-FIRST to the scheduler — a flag can be a
// deliberate hand-set state; only the divergence itself is the finding.
const fs = require("fs");
const { checkBackupFlagConsistency } = require("./consistency-checks");

const file = process.argv[2];
if (!file) {
  console.error("usage: node test/audit-live-backup-flags.js <payload.json>");
  process.exit(2);
}
const d = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
const { violations, pending } = checkBackupFlagConsistency(d.schedule, d.backupMondays, d.fierceBackup);
console.log(`weeks: ${Object.keys(d.schedule || {}).length} · backupMondays: ${(d.backupMondays || []).length} · fierceBackup: ${(d.fierceBackup || []).length}`);
if (pending.length) {
  console.log("\nPending (listed, no generated week — not drift):");
  pending.forEach(p => console.log("  · " + p));
}
if (violations.length) {
  console.log("\nVIOLATIONS (set vs week-flag divergence):");
  violations.forEach(v => console.log("  ✗ " + v));
  process.exit(1);
}
console.log("\nNo divergence — the two representations agree.");
