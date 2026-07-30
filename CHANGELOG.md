# Changelog

All notable user-facing changes to `@nest-native/jobs` are tracked here.

This project follows semantic versioning for the published package. Sample,
documentation, and CI-only changes may remain unreleased until the next
package release is useful for users.

## Unreleased

## 0.2.0

- **DB-stored cron schedules** — the django-celery-beat pattern on the
  existing claimer substrate, and a deliberate reversal of the 0.1 "not a
  cron scheduler" non-goal (amended in the guidelines first): a
  `job_schedules` row drives recurring enqueue; survives restarts, safe
  across instances, runtime-editable via the injectable
  `JobSchedulesService` (no REST controller, no UI). Firing is an atomic
  compare-and-swap on `next_run_at` plus the occurrence insert in ONE store
  transaction on all three dialects. Fixed misfire policy: skip missed
  occurrences, at most one catch-up. A schedule `uniqueKey` reuses the
  active-dedup contract as an overlap guard. Occurrence retry exhaustion
  never touches the schedule row (pinned by test). `TickReport` gains a
  `scheduled` count.
- **`croner` becomes the single runtime dependency** (cron parsing,
  timezones, DST; default timezone UTC) — the "zero runtime dependencies"
  claim is retired honestly in the README comparison. Everything else stays
  a peer dependency.
- New exports: `JobSchedulesService`, `ScheduleStore`/`ScheduleRow` types,
  `InvalidScheduleError`, `assertValidSchedule`/`nextOccurrence`, per-dialect
  `jobSchedules` tables + `SqliteScheduleStore`/`PostgresScheduleStore`/
  `MysqlScheduleStore`. Schedules are strictly opt-in — without a
  `scheduleStore` the claimer never touches them.

- Tests: the worker loop now asserts its core timing contract — a non-empty
  batch re-ticks immediately (drains the backlog) while an empty batch waits
  the poll interval. The existing tests checked the reports but not the
  drain-vs-idle timing, so a mutant inverting that branch survived; the two new
  timing tests kill it. Docs: reframed the mutation-testing guidance as an
  occasional, scoped audit (not a per-PR gate) with hand-verification, matching
  how it is actually used.
- Local full-mode verification and mutation testing (repo tooling; nothing
  ships in the package): `compose.yaml` + `npm run infra:up`/`infra:down`
  start a disposable MySQL container, `npm run test:full` runs the gated
  MySQL round-trip spec against it, and Stryker mutation testing is available
  via `npm run test:mutation` (incremental) / `test:mutation:full` with
  `STRYKER_MUTATE` scoping and `STRYKER_WITH_INFRA=1` for I/O-inclusive runs.
  All of it is opt-in and local-only — CI is unchanged and never runs
  mutation testing. See the new "Local Full-Mode Verification" section in
  GUIDELINES_NEST_JOBS.md.

## 0.1.0 - 2026-07-04

The first release — background jobs without Redis, in the Drizzle database
your NestJS app already has.

### Added

- **Core engine** (`@nest-native/jobs`): the dialect-agnostic `JobsService`
  producer (transactional enqueue via `@nestjs-cls/transactional`),
  `JobsClaimer` + `runWorkerLoop`, the `@JobHandler(name)` class decorator with
  container discovery (`JobsHandlerExplorer`, duplicate names throw at
  startup), `RetryableError`/`PermanentError`, the `JobStore` seam, and
  `JobsModule.forRoot`/`forRootAsync`.
- **Scheduling controls** on `enqueue`: `runAt` XOR `delayMs` (both → throw),
  `priority` (higher first), `maxAttempts`, and `uniqueKey`.
- **The uniqueKey contract** — identical on every dialect: a FULL unique index
  on `(name, unique_key)`; completing or failing a job clears its key, so
  "unique among **active** jobs" holds without partial indexes. A duplicate
  enqueue is a no-op that returns the existing active row.
- **Drizzle stores + table definitions** for three dialects:
  `@nest-native/jobs/sqlite` (better-sqlite3, synchronous),
  `@nest-native/jobs/postgres` (node-postgres, async), and
  `@nest-native/jobs/mysql` (mysql2, async — insert + select-back, no
  RETURNING). Claiming orders by `priority DESC, available_at ASC` and reclaims
  jobs stuck in `processing` past `stuckTimeoutMs`.
- **Testing harness** (`@nest-native/jobs/testing`): `drainJobs(claimer)` ticks
  until the queue is empty and aggregates the reports; `RecordingJobHandler`
  records executions and injects one-shot or persistent failures.
- A **gated real-MySQL integration spec** (runs when `JOBS_MYSQL_URL` is set,
  skips otherwise) keeping the default suite hermetic.
