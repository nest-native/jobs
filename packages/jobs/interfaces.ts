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

/**
 * The dialect-agnostic shape of a `job_schedules` row. Like {@link JobRow},
 * timestamps are ISO-8601 strings on every dialect (lexicographic comparison
 * is what `listDue` relies on). `nextRunAt` is `null` only when the schedule
 * has no future occurrence (the claimer also disables it then).
 */
export interface ScheduleRow {
  id: string;
  /** Unique schedule identity — upserts key on it. */
  name: string;
  /** The `@JobHandler` name each occurrence enqueues. */
  jobName: string;
  payload: Record<string, unknown>;
  /** Cron expression (croner syntax). */
  cron: string;
  /** IANA timezone; `null` means UTC. */
  timezone: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  /** Occurrence enqueue overrides; `null` falls back to the store default. */
  maxAttempts: number | null;
  priority: number | null;
  /**
   * When set, every occurrence enqueues with this `uniqueKey` — so while one
   * occurrence is still ACTIVE the next is a dedup no-op (the overlap guard),
   * reusing the jobs uniqueKey contract verbatim.
   */
  uniqueKey: string | null;
  lastEnqueuedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What a caller supplies to {@link JobSchedulesService.upsert}. */
export interface UpsertScheduleInput<
  TPayload extends object = Record<string, unknown>,
> {
  /** Unique schedule identity — upserting an existing name updates it. */
  name: string;
  /** The `@JobHandler` name each occurrence enqueues. */
  jobName: string;
  payload?: TPayload;
  /** Cron expression (croner syntax); validated at call time — expressions with no future occurrence are rejected. */
  cron: string;
  /** IANA timezone (default UTC). */
  timezone?: string;
  /**
   * OMITTING this is not the same as `true`: an omitted `enabled` defaults to
   * true on INSERT but PRESERVES the stored value on update — so a boot-time
   * upsert never resurrects a schedule that ops disabled at runtime with
   * `setEnabled(name, false)`.
   */
  enabled?: boolean;
  maxAttempts?: number;
  priority?: number;
  /** Occurrence dedup key — the overlap guard (see {@link ScheduleRow.uniqueKey}). */
  uniqueKey?: string;
}

/** The fully-resolved row content the service hands `ScheduleStore.upsert`. */
export interface ResolvedScheduleUpsert {
  name: string;
  jobName: string;
  payload: Record<string, unknown>;
  cron: string;
  timezone: string | null;
  /** `null` = the caller omitted it: default true on insert, PRESERVE the stored value on update. */
  enabled: boolean | null;
  /**
   * The freshly-armed due time. On a conflict-update the store only applies
   * it when `cron`/`timezone` changed or the stored `nextRunAt` is null —
   * otherwise the stored due time is preserved, so a redeploy's boot upsert
   * neither skips a pending catch-up nor perturbs the rhythm.
   */
  nextRunAt: string;
  maxAttempts: number | null;
  priority: number | null;
  uniqueKey: string | null;
}

/** One due-schedule claim attempt (see {@link ScheduleStore.claimAndEnqueue}). */
export interface ScheduleClaim {
  id: string;
  /** CAS guard: the `nextRunAt` this claimer read — the claim wins only if it is unchanged. */
  expectedNextRunAt: string;
  /** The new `nextRunAt`; `null` disables the schedule (no future occurrence). */
  nextRunAt: string | null;
  nowIso: string;
  /** The occurrence to enqueue when the claim wins. */
  input: EnqueueJobInput<object>;
}

export interface ScheduleClaimResult {
  /** True when THIS claimer won the compare-and-swap (the row advanced). */
  claimed: boolean;
  /**
   * The occurrence job inserted by THIS claim. `null` when the claim lost,
   * or when the overlap guard suppressed the insert (an occurrence with the
   * schedule's `(name, uniqueKey)` is still active) — in the latter case the
   * schedule still advanced.
   */
  job: JobRow | null;
}

/**
 * The transactional persistence seam for schedules — same design as
 * {@link JobStore}: dialect-specific, owns its Drizzle table and transactions,
 * `db` is opaque to the engine. `upsert` returns the store's native shape
 * (synchronous on sqlite, a `Promise` on pg/mysql) so it composes inside the
 * caller's `@Transactional` body.
 *
 * `claimAndEnqueue` is the exactly-once occurrence handoff: in ONE store
 * transaction it (1) compare-and-swaps the row's `nextRunAt` from
 * `expectedNextRunAt` to the new value (losing the race returns
 * `{ claimed: false }` with nothing written) and (2) inserts the occurrence
 * job conflict-tolerantly (a `(name, unique_key)` duplicate is the overlap
 * guard, not an error — the schedule still advances).
 */
export interface ScheduleStore {
  upsert(
    db: unknown,
    input: ResolvedScheduleUpsert,
  ): ScheduleRow | Promise<ScheduleRow>;
  get(db: unknown, name: string): Promise<ScheduleRow | undefined>;
  list(db: unknown): Promise<ScheduleRow[]>;
  /** Resolves true when a row was deleted. */
  remove(db: unknown, name: string): Promise<boolean>;
  /**
   * Flips `enabled` and overwrites `nextRunAt`; resolves the updated row, or
   * undefined when the name is unknown OR `expectedUpdatedAt` was supplied
   * and no longer matches (optimistic-concurrency guard — the caller re-reads
   * and retries).
   */
  setEnabled(
    db: unknown,
    name: string,
    enabled: boolean,
    nextRunAt: string | null,
    expectedUpdatedAt?: string,
  ): Promise<ScheduleRow | undefined>;
  /** Enabled rows with a non-null `nextRunAt <= nowIso`, oldest due first. */
  listDue(db: unknown, nowIso: string, limit: number): Promise<ScheduleRow[]>;
  claimAndEnqueue(db: unknown, claim: ScheduleClaim): Promise<ScheduleClaimResult>;
  /** Disables a corrupted schedule (invalid cron found at claim time) recording `lastError`. */
  disable(db: unknown, id: string, lastError: string): Promise<void>;
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
   * The dialect-specific schedule store. OPT-IN: without it the claimer never
   * touches schedules and `JobSchedulesService` throws on use — 0.1 behavior
   * is unchanged.
   */
  scheduleStore?: ScheduleStore;
  /**
   * Modules that provide (and export) the `drizzleInstanceToken`. Required when
   * that token is not registered by a global module — `JobsModule` imports
   * these so it can resolve the Drizzle instance.
   */
  imports?: ModuleMetadata['imports'];
  /** Register the module globally (default: true). */
  isGlobal?: boolean;
}
