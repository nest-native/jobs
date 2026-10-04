---
sidebar_position: 3
title: API Reference
---

# API Reference

Everything ships from five entry points: `@nest-native/jobs` (the
dialect-agnostic engine), one module per dialect (`/sqlite`, `/postgres`,
`/mysql`), and `/testing`.

## JobsModule

```ts
JobsModule.forRoot(options: JobsModuleOptions): DynamicModule

interface JobsModuleOptions {
  drizzleInstanceToken: symbol | string; // the base (non-transactional) Drizzle instance
  store: JobStore;                       // the dialect store
  scheduleStore?: ScheduleStore;         // opt-in: DB-stored cron schedules (0.2+)
  imports?: ModuleMetadata['imports'];   // modules exporting the token (if not global)
  isGlobal?: boolean;                    // default: true
}
```

`drizzleInstanceToken` must be the same token the
`TransactionalAdapterDrizzleOrm` is configured with — the claimer uses it to
open its own claim transactions, outside any request context.

```ts
JobsModule.forRootAsync(options: JobsModuleAsyncOptions): DynamicModule

interface JobsModuleAsyncOptions {
  isGlobal?: boolean;
  drizzleInstanceToken: symbol | string;
  imports?: ModuleMetadata['imports'];
  inject?: (InjectionToken | OptionalFactoryDependency)[];
  useStore: (...args: any[]) => JobStore | Promise<JobStore>;
  // Optional schedules opt-in; shares `inject` with `useStore`.
  useScheduleStore?: (...args: any[]) => ScheduleStore | Promise<ScheduleStore>;
}
```

Both register and export `JobsService`, `JobSchedulesService`, `JobsClaimer`,
and `JobsHandlerExplorer` (plus Nest's `DiscoveryModule` internally). Without
a schedule store, `JobSchedulesService` throws on use and the claimer never
touches schedules.

## JobsService (enqueue)

```ts
class JobsService<TStore extends JobStore = JobStore> {
  enqueue<TPayload extends object>(
    input: EnqueueJobInput<TPayload>,
  ): ReturnType<TStore['enqueue']>;
}

interface EnqueueJobInput<TPayload extends object = Record<string, unknown>> {
  name: string;          // routes to the @JobHandler with this name
  payload: TPayload;     // structural — a plain interface needs no cast
  runAt?: Date;          // absolute due time (XOR with delayMs; both → throw)
  delayMs?: number;      // relative due time from now
  maxAttempts?: number;  // default 10
  uniqueKey?: string;    // dedup among ACTIVE jobs with the same name
  priority?: number;     // higher runs first among due jobs (default 0)
}
```

Called inside a `@Transactional()` body, the insert joins the caller's
transaction (via `@InjectTransaction()`); outside one, it writes directly.
The return type follows the store: the sqlite store returns `JobRow`
synchronously, Postgres/MySQL return `Promise<JobRow>` — type the service as
`JobsService<SqliteJobStore>` (etc.) to get the exact shape.

### The uniqueKey contract

`uniqueKey` means **unique among active jobs**, identically on all three
dialects:

- a FULL unique index on `(name, unique_key)` (no partial indexes — `NULL`
  keys never collide);
- terminal transitions (`completed`, `failed`) **clear the key to `NULL`**,
  releasing it;
- enqueueing a duplicate `(name, uniqueKey)` while a job is
  pending/processing is a **no-op returning the existing row** (the store
  catches the dialect's unique violation — `SQLITE_CONSTRAINT_UNIQUE`,
  SQLSTATE `23505`, errno `1062` — and selects the active owner back).

Once the active job finishes, the same key can be enqueued fresh.

## @JobHandler + the JobHandler interface

```ts
@JobHandler('email.welcome')  // the decorator (value space)
@Injectable()
class WelcomeEmailHandler implements JobHandler {  // the interface (type space)
  handle(payload: Record<string, unknown>, ctx: JobContext): void | Promise<void>;
}

interface JobContext {
  jobId: string;   // the job row id — the natural idempotency key
  attempt: number; // 1-based attempt number of THIS execution
}
```

Handlers are plain providers: constructor injection works, and
`JobsHandlerExplorer` builds the name → instance registry at application
bootstrap (`DiscoveryService` scan). Exactly one handler per name — a
duplicate throws at startup. Handlers run in the claimer's poll loop,
**outside any business transaction**, and delivery is at-least-once.

## Retry vocabulary

```ts
class RetryableError extends Error {
  constructor(message: string, readonly delayMs?: number);
}
class PermanentError extends Error {
  constructor(message: string);
}
```

| Handler outcome | Claimer action |
| --- | --- |
| returns | `completed` (uniqueKey released) |
| throws `PermanentError` | `failed` immediately |
| throws `RetryableError` | retried — after `delayMs` if given, else jittered backoff |
| throws anything else | retried with jittered backoff until `maxAttempts`, then `failed` |
| no handler registered for `name` | `failed` immediately (`PermanentError` internally) |
| another worker took the job over first | nothing recorded — counted as `lost` (see below) |

Backoff: `min(baseBackoffMs * 2^attempts, maxBackoffMs) + jitter(0..baseBackoffMs)`.

## JobsClaimer + runWorkerLoop

```ts
class JobsClaimer {
  tick(overrides?: RunnerConfig): Promise<TickReport>;
}

interface TickReport {
  scheduled: number; // schedule occurrences THIS tick enqueued (0.2+)
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  lost: number;      // claimed, but no outcome recorded here (0.5+, see below)
}

interface ResolvedRunnerConfig {
  workerInstanceId: string; // default `${hostname()}-${pid}`
  stuckTimeoutMs: number;   // default 60_000 — reclaim processing jobs older than this
  batchSize: number;        // default 32
  baseBackoffMs: number;    // default 1_000
  maxBackoffMs: number;     // default 60_000
}
type RunnerConfig = Partial<ResolvedRunnerConfig>;

// Applies overrides over the defaults, as tick() does, and throws on a value
// that would break claiming: call it at startup to check a worker's config.
function resolveRunnerConfig(overrides?: RunnerConfig | null): ResolvedRunnerConfig;
```

A `RunnerConfig` key set to `undefined` keeps its default, so
`{ workerInstanceId: process.env.WORKER_ID }` with the variable unset claims
under the default id. An invalid value throws: an empty `workerInstanceId`, a
`batchSize` that is not a positive integer, a `stuckTimeoutMs` that is not a
positive number, or a negative backoff. Numeric strings count as invalid.

`tick()` claims one batch (the store opens its own transaction; ordering is
`priority DESC, available_at ASC`; `processing` rows older than
`stuckTimeoutMs` are reclaimed) and dispatches each job to its handler.

**Running several workers.** Any number of workers can drain one table:

- **Claims are exclusive.** The Postgres and MySQL stores lock the jobs they
  claim with `FOR UPDATE SKIP LOCKED` at READ COMMITTED, so concurrent claims
  split the backlog instead of running the same job twice; SQLite runs one
  write transaction at a time.
- **A stalled claim is taken over.** A job still `processing` after
  `stuckTimeoutMs` is claimed again, so give every worker the same
  `stuckTimeoutMs`, longer than the slowest handler, and keep their clocks in
  sync. Each worker reclaims by its own clock and its own value, so the
  smallest value in the fleet is the one in force.
- **Outcomes are recorded under the claim (0.5+).** A job's outcome applies only
  while the job is still `processing` under the exact claim that took it: its
  `claimedBy` and `claimedAt`. A worker whose claim was taken over writes
  nothing; the job counts in `TickReport.lost`, with a warning, and its new
  owner runs it and records the outcome. A batch held longer than
  `stuckTimeoutMs` skips its remaining jobs, also as `lost`; the first job of a
  batch always runs. A steady non-zero `lost` means batches take longer than
  `stuckTimeoutMs`: raise it or lower `batchSize`.
- **Delivery stays at-least-once.** A handler that outlives its claim has
  already run when the new owner runs the job again. Make handlers idempotent,
  or key their side effects on `ctx.jobId`.
- **A failed completion write throws.** When the store cannot record a
  completion (the database went away), the tick throws instead of counting it
  as a failed run: the job, still claimed, runs again once its claim goes
  stale, and no attempt is spent.
- **On a node-postgres `Pool`**, the claims and every transition run on a
  client the store checks out itself, so a connection the database drops
  mid-statement (a failover, `pg_terminate_backend`) rejects the tick instead of
  crashing the process. Give the pool an `error` listener, as node-postgres
  requires: the store logs a warning once when it has none.

```ts
function runWorkerLoop(claimer: JobsClaimer, options?: WorkerLoopOptions): Promise<void>;

interface WorkerLoopOptions {
  pollIntervalMs?: number;              // idle wait, default 2_000
  runner?: RunnerConfig;                // overrides for every tick
  signal?: AbortSignal;                 // abort to stop the loop
  onTick?: (report: TickReport) => void;
  onError?: (error: unknown) => void;   // a throwing tick is reported, loop continues
}
```

The loop re-ticks immediately while batches are non-empty (drain-fast), idles
`pollIntervalMs` when the queue is empty, and resolves once `signal` aborts.
An invalid `runner` config rejects at once, before the first tick (0.5+): keep
the promise and handle that rejection — discarded with `void`, it ends the
process as an unhandled rejection without reaching `onError`.

## The JobStore seam

```ts
interface JobStore {
  enqueue(db: unknown, input: EnqueueJobInput<object>): JobRow | Promise<JobRow>;
  claimBatch(db: unknown, cfg: ResolvedRunnerConfig): Promise<JobRow[]>;
  markCompleted(db: unknown, claim: JobClaim): Promise<boolean>;             // terminal, clears uniqueKey
  retry(db: unknown, claim: JobClaim, delayMs: number, lastError?: string): Promise<boolean>; // keeps uniqueKey
  markFailed(db: unknown, claim: JobClaim, reason: string): Promise<boolean>; // terminal, clears uniqueKey
}

interface JobClaim {
  readonly id: string;
  readonly claimedBy: string;
  readonly claimedAt: string;
}
```

The engine never touches SQL — implement this seam to bring your own dialect.
A custom store owes the engine three things:

- `claimBatch` never returns one job to two concurrent callers, and returns
  every job as its claiming UPDATE left it, with the `claimedBy` and
  `claimedAt` it wrote. The claimer refuses a job without a string stamp
  (counted as `lost`, logged as an error), but it cannot tell a stale stamp
  from a fresh one: a store that returns jobs as read before its UPDATE runs
  each reclaimed job again after every stuck timeout.
- The three transitions apply only while the job is `processing` under exactly
  that `claimedBy` and `claimedAt`, and resolve `false`, writing nothing, once
  the claim has been taken over.
- A database error rejects; it never reads as `false`.
Ship stores:

| Store | Import | Execution |
| --- | --- | --- |
| `SqliteJobStore` | `@nest-native/jobs/sqlite` | synchronous (better-sqlite3); `enqueue` returns `JobRow` |
| `PostgresJobStore` | `@nest-native/jobs/postgres` | async (`pg`), `INSERT … RETURNING` |
| `MysqlJobStore` | `@nest-native/jobs/mysql` | async (`mysql2`), insert + select-back (no RETURNING) |

Each dialect module also exports its `jobs` Drizzle table definition and the
unique-violation predicate (`isSqliteUniqueViolation`, `isPgUniqueViolation`,
`isMysqlUniqueViolation`).

## JobRow

```ts
interface JobRow {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'completed' | 'failed'; // JOB_STATUSES
  attempts: number;        // completed attempts so far
  maxAttempts: number;
  uniqueKey: string | null;
  priority: number;
  availableAt: string;     // ISO-8601 — timestamps are text on every dialect
  claimedAt: string | null;
  claimedBy: string | null;
  processedAt: string | null;
  lastError: string | null;
  createdAt: string;
}
```

## JobSchedulesService + the ScheduleStore seam (0.2+)

```ts
class JobSchedulesService<TStore extends ScheduleStore = ScheduleStore> {
  upsert<TPayload extends object>(input: UpsertScheduleInput<TPayload>): ReturnType<TStore['upsert']>;
  get(name: string): Promise<ScheduleRow | undefined>;
  list(): Promise<ScheduleRow[]>;
  remove(name: string): Promise<boolean>;
  setEnabled(name: string, enabled: boolean): Promise<ScheduleRow | undefined>;
}
```

Injectable CRUD for schedules — no REST controller, no UI. `upsert` returns
the store's native shape (synchronous on sqlite) and validates the cron —
including rejecting expressions with **no future occurrence** — with
`InvalidScheduleError`. Boot-time upserts are safe by design: on an existing
row, an omitted `enabled` preserves the stored flag (an ops
`setEnabled(name, false)` survives redeploys) and the stored `next_run_at`
is preserved while `cron`/`timezone` are unchanged (a pending catch-up
survives restarts). See the [Cron Schedules](./cron-schedules.md) page for
semantics (misfire policy, overlap guard, failure isolation).

```ts
interface ScheduleStore {
  upsert(db, input: ResolvedScheduleUpsert): ScheduleRow | Promise<ScheduleRow>;
  get(db, name): Promise<ScheduleRow | undefined>;
  list(db): Promise<ScheduleRow[]>;
  remove(db, name): Promise<boolean>;
  setEnabled(db, name, enabled, nextRunAt, expectedUpdatedAt?): Promise<ScheduleRow | undefined>;
  listDue(db, nowIso, limit): Promise<ScheduleRow[]>;
  claimAndEnqueue(db, claim: ScheduleClaim): Promise<ScheduleClaimResult>;
  disable(db, id, lastError): Promise<void>;
}
```

Dialect implementations ship as `SqliteScheduleStore` / `PostgresScheduleStore`
/ `MysqlScheduleStore` next to their `jobSchedules` table definitions.
`claimAndEnqueue` is the exactly-once occurrence handoff: an atomic
compare-and-swap on `next_run_at` plus the occurrence insert in ONE store
transaction. The planner helpers `nextOccurrence(cron, timezone, after)` and
`armSchedule(cron, timezone, after)` (throws instead of returning null) are
exported too.

## Tokens & helpers

- `JOBS_STORE`, `JOBS_DRIZZLE`, `JOBS_OPTIONS`, `JOBS_SCHEDULE_STORE` — the
  module's DI tokens.
- `DEFAULT_RUNNER_CONFIG` — the resolved defaults `tick()` merges overrides into.
- `resolveAvailableAt({ runAt?, delayMs? }): Date` — the shared scheduling
  resolution (throws when both are set); every store funnels through it.
- `JOB_HANDLER_NAME` — the metadata key `@JobHandler` writes, if you need to
  introspect handlers yourself.
