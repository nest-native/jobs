# Changelog

All notable user-facing changes to `@nest-native/jobs` are tracked here.

This project follows semantic versioning for the published package. Sample,
documentation, and CI-only changes may remain unreleased until the next
package release is useful for users.

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
