# Call-Schedule-App — Project Context for Claude Code

*Rewritten 2026-07-02. Supersedes the earlier CLAUDE.md (which had an identity-model
error, listed six edge functions instead of seven, and predated the backup/restore
system). Architecture deep-dive: `CALL-SCHEDULE-APP-REFERENCE.md`. Task queue +
state docs (SESSION-HANDOFF-STATE, PROTECTIONS, FACT-OWNERSHIP): canonical in the
PRIVATE repo `Call-Schedule-App-server/docs/` since 2026-08-08 — edit there,
commit, sync out; OneDrive copies are working copies. Edge-function
versions/state: the private repo's README version table.*

On-call schedule generator (React PWA) for a 7-surgeon general surgery group (DSG).
Frontend on GitHub Pages, backend on Supabase (project ref `xqongyahdnkozqunpwmu`).
Repo (public): `github.com/fkhan628/Call-Schedule-App`. Live:
`https://fkhan628.github.io/Call-Schedule-App/`. Faraz (FAK) is the scheduler,
admin, sole developer, and the user you're working with. 7 live users.

## Identity model — get this right

Roster entries are `{ id, name }`: ids are `s1`–`s7` (surgeons) / `a1`–`a5` (APPs);
the 3-letter code (DJA, MCC, RPC, KJH, REH, FAK, ARW) is the **`name`**. The
**schedule stores ids**, not codes. FAK = `s6`. The calendar-sync `?surgeon=<CODE>`
param matches the code against `name` (or id).

## Working locations — three, don't mix them up

1. **Git clone: `C:\Users\sofia\projects\Call-Schedule-App`** — the ONLY place to
   edit repo files. Git identity is configured repo-locally.
2. **OneDrive folder: `...\Life\Faraz\Genesis\Schedules\Call Schedule App`** —
   read-only mirror + non-repo material (Backups\, edge-functions\, xlsx/PDFs).
   After every push: `git pull` the clone (CI commits back), then run
   `sync-from-repo.ps1` (in the OneDrive folder) to refresh the mirror. Never
   edit app files there.
3. **Edge functions** — live in Supabase, NOT in the repo. Local backup copies +
   version table: OneDrive folder `edge-functions\` (see its README). A git push
   does NOT deploy functions.

## Deploy path 1 — repo (the PWA)

- Edit **only** `index-source.html` (one big `<script type="text/babel">` JSX
  block) and the plain-JS modules (`config.js`, `generator.js`, `helpers.js`,
  `app-styles.js`).
- **NEVER hand-edit `index.html` or `APP_VERSION`** — CI transpiles and bumps on
  push to main, commits back with `[skip ci]`, Pages redeploys.
- Before ANY push: `node build.js` locally; all gates must pass (one babel block,
  classic React runtime, zero injected imports, no jsx-runtime artifacts). It
  writes `index.html` locally as a byproduct — `git restore index.html` before
  committing (CI owns it).
- Branch + PR for anything touching destructive paths, sync/state, or many call
  sites; trivial/cosmetic changes may go straight to main. **A push to main is a
  live deploy to 7 users.**
- CI runs NO tests — only the transpile. (A generator regression harness is
  planned: REMAINING-WORK.md N3.)

## Deploy path 2 — edge functions (6 of them)

`calendar-sync`, `daily-reminder`, `send-notification`, `send-push`,
`office-notifications`, `vacation-deadline-reminder`.
(A seventh, `ai-scan`, was decommissioned 2026-07-03 — unused schedule-scanner
proxy; function deleted, `ANTHROPIC_API_KEY` unset, client removed in PR #7.)

- Supabase CLI is installed (scoop) and logged in; its linked workdir is
  `C:\Users\sofia` (NOT the project). Deploy:
  copy the file to `C:\Users\sofia\supabase\functions\<slug>\index.ts`, then
  `supabase functions deploy <slug> --project-ref xqongyahdnkozqunpwmu --no-verify-jwt`.
- `--no-verify-jwt` preserves each function's gateway state (all are
  verify_jwt=false except `send-push`, which is true — keep it that way).
- **calendar-sync gotcha:** a DASHBOARD deploy re-enables "Verify JWT" and breaks
  calendar subscriptions (clients send no auth header) — re-toggle OFF and verify
  with an unauthenticated GET → expect 200 + `BEGIN:VCALENDAR`.
- Convention: before overwriting a deployed function, back up its current source
  to `edge-functions\deployed-backup-<date>\`; after deploying, re-download,
  byte-diff against the local file, and update `edge-functions\README.md`.
- Verification caution: invoking `daily-reminder` / `office-notifications` /
  `vacation-deadline-reminder` can send REAL pushes/emails. Check first whether
  an invoke is side-effect-free (e.g. daily-reminder sends nothing when nobody's
  reminder hour matches the current Central hour).

## Data layer — key facts

- **Schedule → `schedule_weeks`** (one row per week: `week_monday`, `data`,
  `version` with compare-and-swap). The blob's `data.schedule` is RETIRED; all
  four schedule-reading functions read `schedule_weeks` with blob fallback.
  **Do not touch those reads — done and verified.**
- **Roster/config → `call_schedule_data`** row `id="main"` (blob). Vacations/no-call
  → `time_off` table (normalized, the generator's source). APP shifts →
  `app_shifts_data`.
- Two client auth paths in `config.js`: `dbHeaders` (anon) vs `dbAuthHeaders()`
  (user JWT when logged in). Mutations must use `dbAuthHeaders()`.
- **RLS:** RLS-blocked reads return `[]` with HTTP 200 — **silent**. Reads
  must distinguish failure from empty; mutations must use `dbAuthHeaders()`.
  **The service-role key is server-side only — never in client code or a
  URL.** RLS changes apply to the live DB instantly (no deploy gate) —
  always report-first with blast radius. The per-table anon-readability map
  lives in the PRIVATE docs (`FACT-OWNERSHIP.md`).
- Data-loss safeguards (two historical wipe incidents): `payloadLooksWiped`,
  `intentionalScheduleWipeRef` (one-shot wipe authorization), snapshots to
  `call_schedule_snapshots` (before destructive actions + once per session if
  newest >6h, capture-failure BLOCKS the destructive action), scheduler/admin
  restore UI in Settings. Preserve all of it.

## Known quirks (documented, don't "discover" them again)

- Three DIFFERENT weighting schemes exist on purpose: generator fairness tiebreak
  (SW×6 / wknd×2 / night×1), historical burden (dc*7 + nights + wknd*3), billing
  (SW=7 / night=1 / wknd=3). They are not meant to match.
- Failures across the app are mostly console-only (~28 empty catch blocks) —
  systemic fix planned: REMAINING-WORK N2.

## Session ground rules (non-negotiable)

- ONE task at a time; stop and wait for go-ahead between tasks. For tasks marked
  **report-first**, report findings and WAIT for approval before editing.
- Show every edit and every command before running it. No auto-accept.
- Verify by OBSERVING behavior (a passing test, a real email, a green CI run,
  a byte-diff), never by assuming success — silent failures are this app's
  signature bug class.
- Don't redo completed work — see REMAINING-WORK.md "✅ Done".
- CLAUDE.md is TRACKED in this (public) repo since 2026-08-08 — it stays at
  the path Claude Code reads it from, and stays limited to conventions and
  build rules. Anything security-posture or operational belongs in the
  PRIVATE repo's `docs\` (SESSION-HANDOFF-STATE, PROTECTIONS,
  FACT-OWNERSHIP, the tracker) — their single canonical home — with CLAUDE.md
  pointing at it, never carrying it.
