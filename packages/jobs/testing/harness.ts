// Broker-free, DB-agnostic helpers for testing job flows. Kept out of the
// package root so test scaffolding never enters a consumer's production
// import surface (import from `@nest-native/jobs/testing`).
import type { JobContext } from '../interfaces';
import type { JobHandler } from '../job-handler.decorator';
import type { JobsClaimer, TickReport } from '../jobs-claimer.service';
import type { RunnerConfig } from '../interfaces';

export interface DrainJobsOptions {
  /** Runner overrides applied to every tick. */
  runner?: RunnerConfig;
  /**
   * Safety valve: maximum ticks before giving up (default 100). Prevents a
   * test from spinning forever when a job keeps retrying with no delay.
   */
  maxTicks?: number;
}

/**
 * Ticks the claimer until a tick claims nothing, aggregating the reports —
 * "run everything that is currently due" in one await:
 *
 * ```ts
 * const report = await drainJobs(app.get(JobsClaimer));
 * assert.equal(report.completed, 3);
 * ```
 *
 * Note: jobs a tick reschedules into the future (retry backoff, delayMs) are
 * not due, so a drain settles even while retries are pending — advance time
 * (or wait) and drain again to run them.
 */
export async function drainJobs(
  claimer: JobsClaimer,
  options: DrainJobsOptions = {},
): Promise<TickReport> {
  const maxTicks = options.maxTicks ?? 100;
  const total: TickReport = { claimed: 0, completed: 0, retried: 0, failed: 0 };
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const report = await claimer.tick(options.runner);
    total.claimed += report.claimed;
    total.completed += report.completed;
    total.retried += report.retried;
    total.failed += report.failed;
    if (report.claimed === 0) {
      return total;
    }
  }
  throw new Error(
    `drainJobs did not settle after ${maxTicks} ticks — a job is likely being ` +
      'retried with no delay. Raise maxTicks or fix the handler.',
  );
}

/** One recorded handler execution. */
export interface RecordedJobExecution {
  payload: Record<string, unknown>;
  ctx: JobContext;
}

/**
 * A {@link JobHandler} implementation that records every execution and can be
 * armed to fail — once (`failNextWith`, ideal for throw-then-succeed retry
 * tests) or persistently (`failWith`). Executions are recorded BEFORE the
 * failure is thrown, so `executions()` reflects every attempt the claimer made.
 *
 * Subclass it to attach the decorator:
 *
 * ```ts
 * @JobHandler('email.welcome')
 * class WelcomeHandler extends RecordingJobHandler {}
 * ```
 */
export class RecordingJobHandler implements JobHandler {
  private readonly records: RecordedJobExecution[] = [];
  private readonly oneShotFailures: Error[] = [];
  private failure: Error | undefined;

  handle(payload: Record<string, unknown>, ctx: JobContext): void {
    this.records.push({ payload, ctx });
    const oneShot = this.oneShotFailures.shift();
    if (oneShot) {
      throw oneShot;
    }
    if (this.failure) {
      throw this.failure;
    }
  }

  /** Queue `error` to be thrown by the NEXT execution only. */
  failNextWith(error: Error): void {
    this.oneShotFailures.push(error);
  }

  /** Make every subsequent execution throw `error` until cleared. */
  failWith(error: Error): void {
    this.failure = error;
  }

  /** Stop failing; subsequent executions succeed again. */
  clearFailure(): void {
    this.failure = undefined;
    this.oneShotFailures.length = 0;
  }

  /** Every execution so far, in order. */
  executions(): readonly RecordedJobExecution[] {
    return this.records;
  }

  /** Clear recorded executions and any armed failures. */
  reset(): void {
    this.records.length = 0;
    this.clearFailure();
  }
}
