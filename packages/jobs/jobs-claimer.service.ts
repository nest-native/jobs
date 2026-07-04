import { hostname } from 'node:os';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PermanentError, RetryableError } from './errors';
import type {
  JobRow,
  JobStore,
  ResolvedRunnerConfig,
  RunnerConfig,
} from './interfaces';
import { JobsHandlerExplorer } from './jobs-handler.explorer';
import { JOBS_DRIZZLE, JOBS_STORE } from './tokens';

export const DEFAULT_RUNNER_CONFIG: ResolvedRunnerConfig = {
  workerInstanceId: `${hostname()}-${process.pid}`,
  stuckTimeoutMs: 60_000,
  batchSize: 32,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
};

export interface TickReport {
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
  ) {}

  async tick(overrides: RunnerConfig = {}): Promise<TickReport> {
    const cfg = { ...DEFAULT_RUNNER_CONFIG, ...overrides };
    const claimed = await this.store.claimBatch(this.db, cfg);
    const report: TickReport = {
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
