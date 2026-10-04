# Changelog

All notable user-facing changes to `@nest-native/jobs` are tracked here.

This project follows semantic versioning for the published package. Sample,
documentation, and CI-only changes may remain unreleased until the next
package release is useful for users.

## Unreleased

## 0.5.1

- **A failed transition no longer strands the rest of the batch.** When
  recording an outcome fails (the database went away mid-batch), the tick
  throws, and the batch's jobs that had not run yet used to wait out
  `stuckTimeoutMs` before any worker could take them. The claimer now hands
  them back first, best effort, through the new optional `JobStore.release`:
  `pending` and unclaimed, attempts, due time and `uniqueKey` unchanged, fenced
  on the claim like every transition. After a transient error the next claim
  takes them at once; if the database is still down the hand-back fails too
  and they wait as before. The job whose outcome failed to record stays
  claimed, since it ran. The shipped stores implement `release`; a custom store
  without it behaves as before.
- **A claim is stamped once its connection is checked out.** The Postgres and
  MySQL claims took `claimedAt` before waiting for a pooled connection, so a
  slow checkout made the claim look older than it was, and other workers
  treated its jobs as stuck that much sooner. The stamp is now taken inside
  the claim's transaction.
- **A dropped MySQL connection is now pinned by real-database specs.** Killing
  the connection mid-claim or mid-transition rejects the call without crashing
  the process, and the pool replaces the connection: mysql2's pooled
  connections listen for their own errors, unlike node-postgres clients.

## 0.5.0

- **A worker whose claim was taken over can no longer record the job's
  outcome.** Transitions matched on the job's id alone: a worker that stalled
  past `stuckTimeoutMs` (a long handler, a GC pause, a lost network) could still
  mark completed, retried or failed a job another worker had reclaimed and was
  running, overwriting the new owner's outcome. A completion that landed first
  also released the job's `uniqueKey` while the new owner still ran it.
  - Every transition now applies only while the job is still `processing`
    under the exact claim that took it: its `claimedBy` and `claimedAt`. This
    holds even when two loops share a `workerInstanceId`. A transition that
    loses this race writes nothing.
  - On Postgres each transition runs in its own READ COMMITTED transaction,
    on the same store-managed client as the claim. Under a SERIALIZABLE server
    default, two workers' transitions would otherwise abort each other while
    both claims still held their jobs; under REPEATABLE READ, a concurrent
    write to the job would fail its transition.
  - Once a batch has been held longer than `stuckTimeoutMs`, the worker skips
    its remaining jobs instead of running them too. The first job of a batch
    always runs, so a slow claim still makes progress.
  - A transition that lost its claim and a job skipped from an expired batch
    both count in the new `TickReport.lost`, and each logs a warning, with the
    handler's error when there was one. A steady non-zero count means batches
    take longer than `stuckTimeoutMs`: raise it or lower `batchSize`.
  - Delivery stays at-least-once: a handler that outlived its claim has
    already run when the new owner runs the job again.
- **Upgrade every worker on a table together.** These guarantees hold once
  every worker draining a table runs this version: a 0.4.x worker's
  transitions match on the id alone, so it can still complete, retry or fail a
  job another worker holds. Stop the 0.4.x workers before starting the new
  ones, or expect `lost` warnings while both run. The schema is unchanged.
- **Failing to record a completion no longer counts as a failed run.** A
  database error from `markCompleted` was handled like a handler failure: it
  spent an attempt, and on the last one marked a job that had run failed.
  `tick()` now throws, and the job runs again once its claim goes stale.
- **A `RunnerConfig` field set to `undefined` keeps its default.**
  `{ workerInstanceId: process.env.WORKER_ID }` with the variable unset used to
  claim jobs under no owner; with fenced transitions, no outcome could ever be
  recorded for them. `resolveRunnerConfig()` is exported, so a worker can check
  its config at startup.
  - **Breaking:** invalid values now throw, numeric strings included: an empty
    `workerInstanceId`, a `batchSize` that is not a positive integer, a
    `stuckTimeoutMs` that is not a positive number, or a negative backoff.
    Pass numbers, and leave a field `undefined` to keep its default:
    `batchSize: env.BATCH_SIZE ? Number(env.BATCH_SIZE) : undefined`.
  - **Breaking:** `runWorkerLoop` rejects at once on an invalid `runner` config
    instead of failing every tick. Keep its promise and handle that rejection:
    discarded with `void`, it ends the process as an unhandled rejection,
    without reaching `onError`.
- **Breaking for TypeScript code that constructs `TickReport` values:** add
  `lost: 0`. `drainJobs` sums it.
- **Breaking for custom `JobStore` implementations.**
  - `markCompleted`, `retry` and `markFailed` take the job's claim (`JobClaim`:
    `{ id, claimedBy, claimedAt }`) instead of its id.
  - They resolve `true` when they wrote the job and `false` when the claim no
    longer held it. A database error rejects; it never reads as `false`.
  - `claimBatch` must never return one job to two concurrent callers, and must
    return every job as its claiming UPDATE left it, with the `claimedBy` and
    `claimedAt` it wrote. The claimer refuses a job without a string stamp,
    counting it as lost with an error, but it cannot tell a stale stamp from a
    fresh one: a store that returns jobs as read before its UPDATE gets each
    reclaimed job run again after every stuck timeout.
  - The shipped stores are updated.

## 0.4.0

- **Concurrent workers no longer run the same job twice.** On Postgres and
  MySQL the claim selected due jobs without locking them, then updated them
  by id, so two workers claiming at the same moment could both take, and both
  run, the same jobs.
  - The claim now locks its candidates with `FOR UPDATE SKIP LOCKED` inside a
    READ COMMITTED transaction, so concurrent claims split the backlog.
    READ COMMITTED also keeps InnoDB's REPEATABLE READ gap locks from making
    every concurrent enqueue wait.
  - New real-Postgres specs (CI now runs a Postgres service next to MySQL) and
    new real-MySQL specs hold jobs from a second connection and run two
    claimers on warmed pools; both fail on the previous claim.
  - A worker that stalls past `stuckTimeoutMs` can still record an outcome
    after another worker took the job over: that takeover is the documented
    at-least-once delivery. Give every worker the same `stuckTimeoutMs`,
    longer than the slowest handler.
- **Breaking: MySQL 8.0.1 or later is now required**, for `SKIP LOCKED`. With
  binary logging on, `binlog_format` must also be ROW (the MySQL 8 default) or
  MIXED: InnoDB refuses writes from the claim's READ COMMITTED transaction
  under `binlog_format=STATEMENT`.
- **A dropped Postgres connection no longer crashes the worker.** The job claim
  and the schedule claim ran through drizzle's `transaction()`, which leaves
  the checked-out client without an `error` listener and sends BEGIN outside
  its cleanup: a failover, a restart or `pg_terminate_backend` during a claim
  killed the process, and a connection lost at BEGIN was never returned to the
  pool. On a node-postgres `Pool` both claims now run on a client the store
  checks out itself: it listens for errors while the client is out, rolls back
  without hiding the original error, and returns a broken client with its
  error so the pool discards it. The tick rejects instead, and
  `runWorkerLoop` reports it through `onError`. Give the pool an `error`
  listener, as node-postgres requires: the stores log a warning once when it
  has none. Your own `@Transactional` bodies still go through drizzle's
  `transaction()`; a per-client listener
  (`pool.on('connect', (client) => client.on('error', handle))`) keeps a
  dropped connection there from crashing the process too.
- **`@nestjs-cls/transactional` 4 is supported.** The peer range is now
  `^3.0.0 || ^4.0.0`; transactional 4 needs `nestjs-cls` 7 and, for Drizzle,
  `@nestjs-cls/transactional-adapter-drizzle-orm` 2. Their only breaking change
  is an `exports` map that exposes just each package root, and this package
  imports nothing deeper. A CI leg runs the suite, the build and the sample on
  that set; the devDependencies stay on transactional 3.

- **Both ends of the NestJS peer range are now CI legs.** The single
  `nestjs-latest-major` job that installed `^12` is replaced by a
  `nestjs-compat` matrix: an `11 floor` leg pinned exactly to `11.0.0` (the
  oldest graph the published range can produce, with the reason next to the
  pin) and a `12` leg on `^12.0.0`. Each leg runs
  `scripts/check-nestjs-resolution.mjs` (replacing
  `check-resolved-nestjs-major.mjs`), which proves the exact version from
  inside every workspace and checks every peer range in the NestJS ecosystem
  against the final tree (npm overrides a peer conflict it can override with
  a warning and exit 0). The same script runs against the lockfile in
  `release:check`. No published range changed.

## 0.3.0

- **NestJS 12 is now an allowed peer** (`@nestjs/common` / `@nestjs/core`
  `^11.0.0 || ^12.0.0`). Nothing in the package changed: the whole suite, 100%
  coverage, typecheck, build and the showcase sample run unmodified on 12.0.1.
  Isolated major-version review: 12 is ESM-only with an exports map that no
  longer resolves directory indexes — this package imports only from the
  `@nestjs/*` roots, so it is unaffected — and 12 runs lifecycle hooks by
  hierarchy level, an order this package never depended on. The 12 end of the
  range needs Node.js `>=22.12`, where `require(esm)` is no longer behind a
  flag; `engines` stays `>=22` because the 11 end does not need more. On 12 you
  also need the `nestjs-cls` family at `nestjs-cls` >= 6.3.0 /
  `@nestjs-cls/transactional` >= 3.3.0 / the drizzle adapter >= 1.5.0 — earlier
  minors declare `@nestjs/core >= 10 < 12` and npm refuses the tree. As with
  `better-sqlite3` 13, the range is widened, not moved: the devDependencies
  stay on 11 and a new CI leg (`nestjs-latest-major`) installs 12 on top and
  runs the suite and the samples against it, with a check that every
  workspace really resolved 12 rather than a nested 11.
- **Tooling: the cognitive complexity gate moved from ESLint to Biome.** No
  change to the published package — this repo only ever used ESLint for
  `sonarjs/cognitive-complexity`, and `@typescript-eslint/parser` was there
  purely to parse TypeScript. That parser hard-refuses TypeScript 7 at require
  time (`typescript-eslint` support is tracked upstream for TS >= 7.1), which
  meant a lint dependency was gating the compiler. Biome enforces the same
  ceiling of 15 with `complexity/noExcessiveCognitiveComplexity`, has no
  TypeScript dependency at all, and drops ~90 transitive dev dependencies.
  Biome's metric is its own implementation of the SonarSource definition and
  scores slightly higher (max function here 6 → 7, same code, still far under
  the ceiling), and it cannot report below complexity 2 — so
  `complexity:report` now lists non-trivial functions rather than all of them.

## 0.2.1

- **`better-sqlite3` 13 is now an allowed peer** (`^11 || ^12 || ^13`). Isolated
  major-version review: v13 is an N-API rewrite whose JavaScript surface is
  purely additive (`db.explain()`, `statement.toString()`) with no removals, and
  the `SqliteError.code` the active-dedup contract keys on
  (`SQLITE_CONSTRAINT_UNIQUE`) is unchanged. The whole suite, 100% coverage, and
  the showcase smoke were run against 13.0.2 before widening, and a new CI leg
  keeps running them there.
  Note that better-sqlite3 13 requires **Node >=22**, while this package still
  supports Node >=20 — so the range is widened, not moved: the devDependency
  stays on 12.x. Nothing in the package changed behaviorally; consumers on Node
  22+ can now upgrade their own `better-sqlite3` without an npm `ERESOLVE`.

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
  never touches the schedule row (pinned by test); transient store errors
  during a claim leave the schedule untouched and retry next tick — only an
  unevaluable cron disables it. Upserts are boot-safe: an omitted `enabled`
  preserves the stored flag on update (runtime kill switches survive
  redeploys) and the stored `next_run_at` survives while cron/timezone are
  unchanged (pending catch-ups survive restarts). Expressions with no future
  occurrence are rejected at upsert. `TickReport` gains a `scheduled` count —
  **breaking only for TypeScript code that CONSTRUCTS `TickReport` values**
  (fake claimers, report aggregators): add `scheduled: 0`; code that reads
  `tick()` results is unaffected.
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
