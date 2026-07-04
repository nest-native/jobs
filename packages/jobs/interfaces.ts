import type { ModuleMetadata } from '@nestjs/common';

export const JOB_STATUSES = [
  'pending',
  'processing',
  'completed',
  'failed',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * The dialect-agnostic shape of a job row as the engine reasons about it. All
 * three dialect stores map their Drizzle rows to this shape, so the claimer
 * never sees a dialect-specific type. Timestamps are ISO-8601 strings on every
 * dialect (they compare lexicographically, which the claimer's due-time query
 * relies on).
 */
export interface JobRow {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  /**
   * The active-dedup key. Uniqueness is enforced by a FULL unique index on
   * `(name, unique_key)` on every dialect, and terminal transitions
   * (`completed`/`failed`) clear it to `NULL` — so "unique among ACTIVE jobs"
   * holds everywhere without partial indexes. `NULL` keys never collide.
   */
  uniqueKey: string | null;
  /** Claim priority — higher runs first among due jobs. Default 0. */
  priority: number;
  availableAt: string;
  claimedAt: string | null;
  claimedBy: string | null;
  processedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

/**
 * What a caller supplies to enqueue a job.
 *
 * `runAt` and `delayMs` are **mutually exclusive** — supplying both throws.
 * Omitting both makes the job due immediately.
 *
 * `TPayload` keeps the payload **structural**: a value typed as a plain
 * interface (which has no index signature, so it is not assignable to
 * `Record<string, unknown>`) is accepted as-is — no `as unknown as
 * Record<string, unknown>` at every call site. The stored row shape stays
 * `Record<string, unknown>` (see {@link JobRow}); the dialect stores perform
 * that widening internally, exactly once.
 */
export interface EnqueueJobInput<TPayload extends object = Record<string, unknown>> {
  name: string;
  payload: TPayload;
  /** Absolute due time. Mutually exclusive with `delayMs`. */
  runAt?: Date;
  /** Relative due time in milliseconds from now. Mutually exclusive with `runAt`. */
  delayMs?: number;
  maxAttempts?: number;
  /**
   * Dedup among ACTIVE jobs with the same `name`: while a `(name, uniqueKey)`
   * job is pending/processing, enqueueing the same pair is a no-op that
   * returns the EXISTING row. Terminal jobs release the key.
   */
  uniqueKey?: string;
  /** Higher runs first among due jobs (default 0). */
  priority?: number;
}

/** Fully-resolved runner configuration (defaults applied). */
export interface ResolvedRunnerConfig {
  workerInstanceId: string;
  stuckTimeoutMs: number;
  batchSize: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}
export type RunnerConfig = Partial<ResolvedRunnerConfig>;

/** Execution context the claimer passes to a handler alongside the payload. */
export interface JobContext {
  /** The job row id — the natural idempotency key for handler side effects. */
  jobId: string;
  /** The 1-based attempt number of THIS execution (first run → 1). */
  attempt: number;
}

/**
 * The transactional persistence seam for the queue. Each implementation is
 * dialect-specific and owns its Drizzle table + the sync/async query execution;
 * `db` is passed per call (the tx-scoped instance for {@link enqueue}, the base
 * instance for the rest) and is intentionally opaque (`unknown`) to the engine.
 *
 * `enqueue` returns the store's native shape — the **sqlite** store returns a
 * synchronous `JobRow` (so it composes inside a synchronous `@Transactional`
 * body); the **postgres** and **mysql** stores return a `Promise`. On a
 * `(name, uniqueKey)` unique violation it returns the EXISTING active row
 * (dedup no-op). It accepts `EnqueueJobInput<object>` so any structurally-typed
 * payload flows through; the store widens the payload internally.
 *
 * `claimBatch` opens its own transaction, claims due `pending` jobs plus
 * `processing` jobs stuck past `stuckTimeoutMs`, ordered by `priority DESC,
 * available_at ASC`, and marks them `processing`.
 */
export interface JobStore {
  enqueue(db: unknown, input: EnqueueJobInput<object>): JobRow | Promise<JobRow>;
  claimBatch(db: unknown, cfg: ResolvedRunnerConfig): Promise<JobRow[]>;
  /** Terminal: sets `completed` and clears `uniqueKey` (releases the key). */
  markCompleted(db: unknown, id: string): Promise<void>;
  /** Re-arms the job: `pending`, attempts+1, due in `delayMs`. Keeps `uniqueKey`. */
  retry(db: unknown, id: string, delayMs: number, lastError?: string): Promise<void>;
  /** Terminal: sets `failed`, attempts+1, and clears `uniqueKey`. */
  markFailed(db: unknown, id: string, reason: string): Promise<void>;
}

/** Options for {@link JobsModule.forRoot}. */
export interface JobsModuleOptions {
  /**
   * Token of the base (non-transactional) Drizzle instance — the same instance
   * the `@nestjs-cls/transactional` Drizzle adapter is configured with. The
   * claimer uses it to open its own claim transaction.
   */
  drizzleInstanceToken: symbol | string;
  /** The dialect-specific job store. */
  store: JobStore;
  /**
   * Modules that provide (and export) the `drizzleInstanceToken`. Required when
   * that token is not registered by a global module — `JobsModule` imports
   * these so it can resolve the Drizzle instance.
   */
  imports?: ModuleMetadata['imports'];
  /** Register the module globally (default: true). */
  isGlobal?: boolean;
}
