// Live-data audit for backup-flag consistency. NOT wired into CI — a manual
// tool. Feed it ONE JSON file shaped like the app payload / a snapshot body:
//   { schedule: { "YYYY-MM-DD": weekObj, ... },
//     backupMondays: ["YYYY-MM-DD", ...], fierceBackup: [...] }
// call_schedule_snapshots.data is exactly this shape; or fold schedule_weeks
// rows into `schedule` yourself as { [row.week_monday]: row.data }.
// File-fed on purpose: no keys, no network. Exits 1 on violations.
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
