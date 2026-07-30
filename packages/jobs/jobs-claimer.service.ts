import { hostname } from 'node:os';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PermanentError, RetryableError } from './errors';
import type {
  EnqueueJobInput,
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

export interface TickReport {
  /** Schedule occurrences THIS tick enqueued (won claims; dedup-suppressed occurrences still count as claimed). */
  scheduled: number;
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
}

type ProcessOutcome = 'completed' | 'retried' | 'failed';

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
    const cfg = { ...DEFAULT_RUNNER_CONFIG, ...overrides };
    // Due schedules fire first, so their occurrences (due immediately) are
    // claimable by this very tick's batch claim.
    const scheduled = this.scheduleStore ? await this.drainSchedules(cfg) : 0;
    const claimed = await this.store.claimBatch(this.db, cfg);
    const report: TickReport = {
      scheduled,
      claimed: claimed.length,
      completed: 0,
      retried: 0,
      failed: 0,
    };
    for (const job of claimed) {
      const outcome = await this.processOne(job, cfg);
      report[outcome] += 1;
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
      await this.store.markCompleted(this.db, job.id);
      return 'completed';
    } catch (error) {
      return this.onHandlerError(job, cfg, error);
    }
  }

  private async onHandlerError(
    job: JobRow,
    cfg: ResolvedRunnerConfig,
    error: unknown,
  ): Promise<ProcessOutcome> {
    const message = error instanceof Error ? error.message : String(error);
    // Permanent: retrying can never succeed — fail now instead of burning attempts.
    if (error instanceof PermanentError) {
      return this.fail(job, message);
    }
    // Retryable: schedule another attempt, honouring a handler-supplied delay.
    if (error instanceof RetryableError) {
      const delay = error.delayMs ?? this.backoff(job.attempts, cfg);
      await this.store.retry(this.db, job.id, delay, message);
      return 'retried';
    }
    // Anything else: retry with backoff until maxAttempts, then fail.
    if (job.attempts + 1 >= job.maxAttempts) {
      return this.fail(job, message);
    }
    await this.store.retry(
      this.db,
      job.id,
      this.backoff(job.attempts, cfg),
      message,
    );
    return 'retried';
  }

  private async fail(job: JobRow, reason: string): Promise<'failed'> {
    this.logger.warn(`job ${job.id} ("${job.name}") failed: ${reason}`);
    await this.store.markFailed(this.db, job.id, reason);
    return 'failed';
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
