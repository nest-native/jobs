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
}
```

Both register and export `JobsService`, `JobsClaimer`, and
`JobsHandlerExplorer` (plus Nest's `DiscoveryModule` internally).

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

Backoff: `min(baseBackoffMs * 2^attempts, maxBackoffMs) + jitter(0..baseBackoffMs)`.

## JobsClaimer + runWorkerLoop

```ts
class JobsClaimer {
  tick(overrides?: RunnerConfig): Promise<TickReport>;
}

interface TickReport { claimed: number; completed: number; retried: number; failed: number }

interface ResolvedRunnerConfig {
  workerInstanceId: string; // default `${hostname()}-${pid}`
  stuckTimeoutMs: number;   // default 60_000 — reclaim processing jobs older than this
  batchSize: number;        // default 32
  baseBackoffMs: number;    // default 1_000
  maxBackoffMs: number;     // default 60_000
}
type RunnerConfig = Partial<ResolvedRunnerConfig>;
```

`tick()` claims one batch (the store opens its own transaction; ordering is
`priority DESC, available_at ASC`; `processing` rows older than
`stuckTimeoutMs` are reclaimed) and dispatches each job to its handler.

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

## The JobStore seam

```ts
interface JobStore {
  enqueue(db: unknown, input: EnqueueJobInput<object>): JobRow | Promise<JobRow>;
  claimBatch(db: unknown, cfg: ResolvedRunnerConfig): Promise<JobRow[]>;
  markCompleted(db: unknown, id: string): Promise<void>;             // terminal, clears uniqueKey
  retry(db: unknown, id: string, delayMs: number, lastError?: string): Promise<void>; // keeps uniqueKey
  markFailed(db: unknown, id: string, reason: string): Promise<void>; // terminal, clears uniqueKey
}
```

The engine never touches SQL — implement this seam to bring your own dialect.
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

## Tokens & helpers

- `JOBS_STORE`, `JOBS_DRIZZLE`, `JOBS_OPTIONS` — the module's DI tokens.
- `DEFAULT_RUNNER_CONFIG` — the resolved defaults `tick()` merges overrides into.
- `resolveAvailableAt({ runAt?, delayMs? }): Date` — the shared scheduling
  resolution (throws when both are set); every store funnels through it.
- `JOB_HANDLER_NAME` — the metadata key `@JobHandler` writes, if you need to
  introspect handlers yourself.
