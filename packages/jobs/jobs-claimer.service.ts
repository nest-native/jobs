import { hostname } from 'node:os';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PermanentError, RetryableError } from './errors';
import type {
  EnqueueJobInput,
  JobClaim,
  JobRow,
  JobStore,
  ResolvedRunnerConfig,
  RunnerConfig,
  ScheduleRow,
  ScheduleStore,
} from './interfaces';
import { JobsHandlerExplorer } from './jobs-handler.explorer';
import { nextOccurrence } from './schedule-planner';
import { JOBS_DRIZZLE, JOBS_SCHEDULE_STORE, JOBS_STORE } from './tokens';

export const DEFAULT_RUNNER_CONFIG: ResolvedRunnerConfig = {
  workerInstanceId: `${hostname()}-${process.pid}`,
  stuckTimeoutMs: 60_000,
  batchSize: 32,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
};

// The furthest a Date can sit from the epoch: a stuck cutoff beyond it is an
// invalid date, and every claim would throw.
const MAX_DATE_OFFSET_MS = 8.64e15;

// A stamp value for a log line: a string quoted, anything else by its type, so
// a Date does not pass for a valid stamp and a BigInt cannot throw.
const stampShown = (value: unknown): string =>
  typeof value === 'string' ? JSON.stringify(value) : Object.prototype.toString.call(value).slice(8, -1);

// A rejected value as the caller wrote it: a string from an env-backed config
// keeps its quotes, so `"60000" (string)` does not pass for the number 60000.
const shown = (value: unknown): string =>
  typeof value === 'number' ? String(value) : `${JSON.stringify(value)} (${typeof value})`;

/**
 * Applies `overrides` over {@link DEFAULT_RUNNER_CONFIG}, as `tick()` does. A
 * key set to `undefined` keeps its default: `{ workerInstanceId:
 * process.env.WORKER_ID }` with the variable unset must not claim jobs under no
 * owner, which no transition could then match. A value that would break
 * claiming throws, so a worker can call this at startup to check its config.
 */
export function resolveRunnerConfig(
  overrides: RunnerConfig | null = {},
): ResolvedRunnerConfig {
  const defined = Object.fromEntries(
    Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined),
  ) as RunnerConfig;
  const cfg: ResolvedRunnerConfig = { ...DEFAULT_RUNNER_CONFIG, ...defined };
  if (typeof cfg.workerInstanceId !== 'string' || cfg.workerInstanceId.trim() === '') {
    throw new TypeError(
      `runner workerInstanceId must be a non-empty string, got ${shown(cfg.workerInstanceId)}`,
    );
  }
  if (!Number.isInteger(cfg.batchSize) || cfg.batchSize < 1) {
    throw new RangeError(`runner batchSize must be a positive integer, got ${shown(cfg.batchSize)}`);
  }
  // At zero every processing job is stuck the moment it is claimed, so two
  // workers would run the same job side by side.
  const stuck = cfg.stuckTimeoutMs;
  if (!(typeof stuck === 'number' && stuck > 0 && stuck <= MAX_DATE_OFFSET_MS)) {
    throw new RangeError(
      `runner stuckTimeoutMs must be a positive number of milliseconds within Date's range, got ${shown(stuck)}`,
    );
  }
  for (const key of ['baseBackoffMs', 'maxBackoffMs'] as const) {
    if (!(Number.isFinite(cfg[key]) && cfg[key] >= 0)) {
      throw new RangeError(`runner ${key} must be a non-negative number, got ${shown(cfg[key])}`);
    }
  }
  return cfg;
}

export interface TickReport {
  /** Schedule occurrences THIS tick enqueued (won claims; dedup-suppressed occurrences still count as claimed). */
  scheduled: number;
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  /**
   * Claimed jobs this worker let go without recording an outcome. Either the
   * batch had been held longer than `stuckTimeoutMs` by the time the job's turn
   * came, so it never ran here, or another claim took the job over before the
   * outcome could be recorded; whoever claims such a job next runs it, and a
   * steady non-zero count means batches take longer than `stuckTimeoutMs`. A
   * job the store returned without its claim's stamp counts here too, logged
   * as an error.
   */
  lost: number;
}

type ProcessOutcome = 'completed' | 'retried' | 'failed' | 'lost';

/**
 * Executes committed jobs. `tick()` claims a batch of due jobs (the store opens
 * its own transaction; priority first, oldest due first, reclaiming jobs stuck
 * in `processing`), dispatches each to the `@JobHandler` registered for its
 * name, and records the outcome:
 *
 *   - handler returns          → `markCompleted` (key released)
 *   - {@link PermanentError}   → `markFailed` immediately (no point retrying)
 *   - {@link RetryableError}   → `retry`, honouring its `delayMs` if given
 *   - any other throw          → `retry` with jittered exponential backoff
 *                                until `maxAttempts`, then `markFailed`
 *   - no handler registered    → `PermanentError` → `markFailed`
 *
 * Each outcome is recorded under the job's claim: once another worker has
 * taken the job over (its claim went stale after `stuckTimeoutMs`), the
 * transition writes nothing, and the job counts as `lost` instead.
 *
 * Runs in a background worker (see `runWorkerLoop`) — never inside a business
 * transaction — so it freely awaits the store and the handlers.
 */
@Injectable()
export class JobsClaimer {
  private readonly logger = new Logger(JobsClaimer.name);

  constructor(
    @Inject(JOBS_DRIZZLE) private readonly db: unknown,
    @Inject(JOBS_STORE) private readonly store: JobStore,
    private readonly explorer: JobsHandlerExplorer,
    @Optional()
    @Inject(JOBS_SCHEDULE_STORE)
    private readonly scheduleStore: ScheduleStore | null = null,
  ) {}

  async tick(overrides: RunnerConfig = {}): Promise<TickReport> {
    const cfg = resolveRunnerConfig(overrides);
    // Due schedules fire first, so their occurrences (due immediately) are
    // claimable by this very tick's batch claim.
    const scheduled = this.scheduleStore ? await this.drainSchedules(cfg) : 0;
    const claimed = await this.store.claimBatch(this.db, cfg);
    // Measured from the batch's arrival, so its first job always runs and a
    // claim that itself took longer than stuckTimeoutMs still makes progress.
    const heldSince = Date.now();
    const report: TickReport = {
      scheduled,
      claimed: claimed.length,
      completed: 0,
      retried: 0,
      failed: 0,
      lost: 0,
    };
    // Once the batch has been held past stuckTimeoutMs, another worker may
    // already have reclaimed its remaining jobs; running them here as well
    // would only run them twice.
    const expired: string[] = [];
    for (const job of claimed) {
      if (Date.now() - heldSince >= cfg.stuckTimeoutMs) {
        expired.push(job.id);
        continue;
      }
      report[await this.processOne(job, cfg)] += 1;
    }
    if (expired.length > 0) {
      report.lost += expired.length;
      this.logger.warn(
        `skipped ${expired.length} claimed job(s) [${expired.join(', ')}]: the batch was held longer than stuckTimeoutMs (${cfg.stuckTimeoutMs} ms), so another worker may own them now; raise stuckTimeoutMs or lower batchSize`,
      );
    }
    return report;
  }

  /**
   * Fires every due schedule at most once. Per schedule: compute the next
   * occurrence strictly after *now* (skip-missed policy — a schedule that was
   * down for a week gets at most this one catch-up), then let the store
   * compare-and-swap `nextRunAt` and insert the occurrence in ONE transaction.
   * A lost CAS means another instance fired it — not an error, not counted.
   * A schedule whose cron cannot be evaluated (hand-corrupted row) is disabled
   * with the error recorded, and the loop continues.
   */
  private async drainSchedules(cfg: ResolvedRunnerConfig): Promise<number> {
    const now = new Date();
    const due = await this.scheduleStore!.listDue(
      this.db,
      now.toISOString(),
      cfg.batchSize,
    );
    let scheduled = 0;
    for (const schedule of due) {
      scheduled += await this.fireSchedule(schedule, now);
    }
    return scheduled;
  }

  private async fireSchedule(schedule: ScheduleRow, now: Date): Promise<number> {
    let nextRunAt: string | null;
    try {
      nextRunAt = nextOccurrence(schedule.cron, schedule.timezone, now);
    } catch (error) {
      // Only InvalidScheduleError (an Error subclass) escapes nextOccurrence —
      // the hand-corrupted row case. THAT alone disables a schedule.
      const message = (error as Error).message;
      this.logger.warn(
        `schedule ${schedule.id} ("${schedule.name}") disabled: ${message}`,
      );
      await this.scheduleStore!.disable(this.db, schedule.id, message);
      return 0;
    }
    try {
      const result = await this.scheduleStore!.claimAndEnqueue(this.db, {
        id: schedule.id,
        // listDue only returns rows with a non-null nextRunAt.
        expectedNextRunAt: schedule.nextRunAt as string,
        nextRunAt,
        nowIso: now.toISOString(),
        input: occurrenceInput(schedule),
      });
      return result.claimed ? 1 : 0;
    } catch (error) {
      // A transient store error (connection drop, lock timeout, serialization
      // failure) must NOT kill the schedule: nothing was written, the row is
      // still due, and the next tick retries it naturally.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `schedule ${schedule.id} ("${schedule.name}") claim failed, will retry next tick: ${message}`,
      );
      return 0;
    }
  }

  private async processOne(
    job: JobRow,
    cfg: ResolvedRunnerConfig,
  ): Promise<ProcessOutcome> {
    const claim = this.claimOf(job);
    if (claim === undefined) return 'lost';
    try {
      const handler = this.explorer.get(job.name);
      if (!handler) {
        throw new PermanentError(
          `No @JobHandler registered for job "${job.name}"`,
        );
      }
      await handler.handle(job.payload, {
        jobId: job.id,
        attempt: job.attempts + 1,
      });
    } catch (error) {
      return this.onHandlerError(job, claim, cfg, error);
    }
    // Outside the try: failing to record a completion is not a failed run.
    // Treating it as one spent an attempt and could mark a job that ran failed.
    // The tick throws instead, and the job, still claimed, runs again once its
    // claim goes stale.
    return this.settle(job, await this.store.markCompleted(this.db, claim), 'completed');
  }

  /**
   * The claim to run under, or `undefined` when `claimedBy` or `claimedAt` is
   * not a string: run without a usable stamp, the job would execute with no
   * transition able to record it, and again after every stuck timeout. Whether
   * a string stamp is the one the claim wrote cannot be told apart here; that
   * is the store's contract.
   */
  private claimOf(job: JobRow): JobClaim | undefined {
    const { id, claimedBy, claimedAt } = job;
    if (typeof claimedBy === 'string' && typeof claimedAt === 'string') {
      return { id, claimedBy, claimedAt };
    }
    this.logger.error(
      `job ${id} came back from claimBatch without a string claim stamp (claimedBy ${stampShown(claimedBy)}, claimedAt ${stampShown(claimedAt)}); a store must return every job it claims as its claiming UPDATE left it, with claimedBy and claimedAt as strings`,
    );
    return undefined;
  }

  /**
   * `outcome` when the transition applied; otherwise another claim took the
   * job over first. `reason` is the handler's error, for the outcomes it caused.
   */
  private settle(
    job: JobRow,
    applied: boolean,
    outcome: Exclude<ProcessOutcome, 'lost'>,
    reason?: string,
  ): ProcessOutcome {
    if (applied) return outcome;
    this.logger.warn(
      reason === undefined
        ? `job ${job.id} ("${job.name}") ran, but another claim took it over before it was marked completed; the new owner records its outcome and may run it again`
        : `job ${job.id} ("${job.name}") failed (${reason}), but another claim took it over before it was marked ${outcome}; leaving it to the new owner`,
    );
    return 'lost';
  }

  private async onHandlerError(
    job: JobRow,
    claim: JobClaim,
    cfg: ResolvedRunnerConfig,
    error: unknown,
  ): Promise<ProcessOutcome> {
    const message = error instanceof Error ? error.message : String(error);
    // Permanent: retrying can never succeed — fail now instead of burning attempts.
    if (error instanceof PermanentError) {
      return this.fail(job, claim, message);
    }
    // Retryable: schedule another attempt, honouring a handler-supplied delay.
    if (error instanceof RetryableError) {
      const delay = error.delayMs ?? this.backoff(job.attempts, cfg);
      return this.settle(job, await this.store.retry(this.db, claim, delay, message), 'retried', message);
    }
    // Anything else: retry with backoff until maxAttempts, then fail.
    if (job.attempts + 1 >= job.maxAttempts) {
      return this.fail(job, claim, message);
    }
    const delay = this.backoff(job.attempts, cfg);
    return this.settle(job, await this.store.retry(this.db, claim, delay, message), 'retried', message);
  }

  private async fail(job: JobRow, claim: JobClaim, reason: string): Promise<ProcessOutcome> {
    const applied = await this.store.markFailed(this.db, claim, reason);
    if (applied) this.logger.warn(`job ${job.id} ("${job.name}") failed: ${reason}`);
    return this.settle(job, applied, 'failed', reason);
  }

  private backoff(attempts: number, cfg: ResolvedRunnerConfig): number {
    const base = cfg.baseBackoffMs * 2 ** attempts;
    const capped = Math.min(base, cfg.maxBackoffMs);
    return capped + Math.floor(Math.random() * cfg.baseBackoffMs);
  }
}

/** The occurrence a schedule enqueues: due immediately, overrides only when set. */
function occurrenceInput(schedule: ScheduleRow): EnqueueJobInput<object> {
  return {
    name: schedule.jobName,
    payload: schedule.payload,
    ...(schedule.maxAttempts !== null && { maxAttempts: schedule.maxAttempts }),
    ...(schedule.priority !== null && { priority: schedule.priority }),
    ...(schedule.uniqueKey !== null && { uniqueKey: schedule.uniqueKey }),
  };
}
