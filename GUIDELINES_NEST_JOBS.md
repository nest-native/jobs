# GUIDELINES_NEST_JOBS.md
## Core Philosophy — this library MUST feel native in NestJS + Drizzle projects

`@nest-native/jobs` implements **background jobs in the database you already
have**, nothing more. It is decorator-first, DI-first, and integrates with
`@nestjs-cls/transactional` so the enqueue shares the user's business
transaction. It is **not** a BullMQ replacement, a cron scheduler, or a
distributed workflow engine.

### 1. Architecture assumptions (never break these)
- **Dialect-agnostic core, dialect-specific stores.** The engine (`JobsService`
  producer, `JobsClaimer` + worker loop, `@JobHandler` discovery, `JobsModule`)
  knows nothing about the SQL dialect. All transactional persistence lives
  behind the `JobStore` interface. Ship **better-sqlite3** (sync), **Postgres**
  (async), and **MySQL** (async) stores; users may provide their own.
- **The Store owns the transactional methods** (`enqueue`, `claimBatch`,
  `mark*`, `retry`). The engine only *calls* them and awaits results from
  outside their transactions — safe on sync and async drivers alike. `enqueue`
  returns the store's native shape (a synchronous `JobRow` on sqlite, a
  `Promise` on pg/mysql) so it composes inside the caller's `@Transactional`
  body on every driver.
- **The uniqueKey contract is identical on all three dialects**: a FULL unique
  index on `(name, unique_key)`; terminal transitions (`markCompleted`,
  `markFailed`) clear `unique_key` to `NULL`, releasing the key. So "unique
  among active jobs" holds everywhere without partial indexes, and a duplicate
  enqueue returns the existing active row (dedup no-op). Never let a dialect
  diverge from this semantic.
- **Polling claimer, not push.** Delivery is a poll loop with batch claiming,
  priority + due-time ordering, and stuck-job reclaim. LISTEN/NOTIFY-style push
  is out of scope for the 0.x line.
- Support line: Node `>=20`, NestJS `11.x`, Drizzle `0.44`/`0.45`,
  `@nestjs-cls/transactional` `3.x`.

### 2. Public API
- `JobsModule.forRoot({ drizzleInstanceToken, store })` / `forRootAsync(...)`.
- `JobsService.enqueue(...)` — called inside the user's `@Transactional`.
  Returns the store's native shape (sync `JobRow` on sqlite, `Promise` on
  pg/mysql). `runAt` XOR `delayMs`; both set → throw.
- `@JobHandler(name)` class decorator + the `JobHandler` interface
  (`handle(payload, ctx)`); handlers are discovered from the Nest container at
  bootstrap, duplicate names throw at startup.
- `JobsClaimer.tick()` + the `runWorkerLoop` helper; `RetryableError` /
  `PermanentError` drive the retry vocabulary.
- Exported per-dialect `jobs` table definitions; consumers add them to their
  schema and generate migrations with drizzle-kit.
- Subpaths: `.` (core), `./sqlite`, `./postgres`, `./mysql`, `./testing`.

### 3. Implementation rules
- The published `packages/jobs/package.json` keeps an explicit empty
  `"dependencies": {}` block; runtime integrations are `peerDependencies`
  (`better-sqlite3`, `pg`, `mysql2` optional).
- **Handler rule:** handlers run in the claimer's poll loop, OUTSIDE any
  business transaction. Delivery is at-least-once — a handler must be
  idempotent or key its side effects on `ctx.jobId`. Document this on every
  public surface.
- Keep the retry mapping a single code path: `PermanentError` → failed now,
  `RetryableError` → retried honouring `delayMs`, anything else → retried with
  jittered exponential backoff until `maxAttempts`, then failed.

### 4. Non-negotiable style
- NestJS naming + DI conventions; discovery via `DiscoveryService`, tokens via
  `Symbol.for`.
- 100% test coverage (branches/functions/lines/statements) on the core package;
  SonarJS cognitive complexity ≤ 15 per function.
- Tests cover all three dialects hermetically (sqlite in-memory, pglite
  in-process, mysql mock-db) plus a gated real-MySQL integration spec
  (`JOBS_MYSQL_URL`).

### 5. Security Review Requirements (MANDATORY)
- Every PR includes an explicit supply-chain + application-security pass.
- **Audit scope.** The `security:audit` release gate audits the *published*
  surface — `audit-production-surface.mjs` packs the tarball and audits its
  production closure. Since the package publishes `"dependencies": {}`, this is
  exactly what consumers install. Advisories confined to dev/peer/build tooling
  or the docs `website/` are tracked by Dependabot but do not block releases.
- **Strictness scope.** The non-negotiables (100% coverage, complexity ≤ 15,
  zero published runtime deps, isolated major-version review) govern the *core*
  package (`packages/jobs`). Non-core code — `sample/*`, the `website/`, dev
  tooling — uses lighter rules: dependency updates there (including majors) may
  merge on green CI without the core's major-isolation ceremony.
- No secret leakage in code, tests, samples, logs, or docs.

### 6. Release version synchronization (MANDATORY)
- When bumping `packages/jobs/package.json` version, update every
  `sample/*/package.json` `@nest-native/jobs` pin to the exact version, run
  `npm install`, and `npm run release:check`. Publish via a `vX.Y.Z` tag →
  `release.yml` (provenance + the `NPM_TOKEN` secret).

## Local Full-Mode Verification (optional infra + mutation testing)

Everything in this section is **opt-in and local-only**. Plain `npm test` and
`test:cov` run without Docker and skip the gated spec (CI covers it in a
dedicated job with its own MySQL service); forks work out of the box.
**CI never runs mutation testing** — it is an on-demand, local-only gate.

### Gated I/O spec (real MySQL)

- `npm run infra:up` — a disposable container from `compose.yaml`
  (MySQL on `127.0.0.1:33063`). Needs Docker.
- `npm run test:full` — the hermetic suite plus the gated MySQL round-trip
  spec against that container (`JOBS_MYSQL_URL` is set inline to the compose
  URL).
- `npm run infra:down` — removes the container and its volume.
- Using your own database instead: export `JOBS_MYSQL_URL` and run
  `npm run test:integration` — the spec gates purely on the env var.

**AI agents working on this repo**: when Docker is available, run
`npm run infra:up && npm run test:full` before opening a PR that touches
package source, and report the result (including the gated spec) in the PR
body. When Docker is not available, run `npm test` and state that the gated
spec was skipped. Never wire any of this into CI.

### Mutation testing (Stryker — local only, never in CI)

- `npm run test:mutation` — **incremental** run (cache:
  `reports/stryker-incremental.json`; only re-tests what changed). This is the
  pre-PR ritual for changes to package source.
- `npm run test:mutation:full` — every mutant from scratch (`--force`).
- `STRYKER_MUTATE='packages/jobs/dialects/**,packages/jobs/tokens.ts'` —
  comma-separated globs to scope a run to the files a change touched.
- `STRYKER_WITH_INFRA=1` — each mutant also runs the gated MySQL spec
  (`npm run test:mutant:full` per mutant, concurrency forced to 1 because the
  spec shares one database; run `npm run infra:up` first). Slow by design; use
  it when a change touches store-adjacent code.
- Report: `reports/mutation/mutation.html`. Thresholds are advisory
  (`break: null`) — the signal is *which mutants survive*, not the score.

Pre-PR ritual: run `npm run test:mutation` (scope with `STRYKER_MUTATE` when
the change is small), look at surviving mutants, and mention the outcome in
the PR body. Keep CI fast and mutation-free — that is a deliberate contract.
