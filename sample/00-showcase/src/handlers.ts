import { Inject, Injectable } from '@nestjs/common';
import {
  JobHandler,
  type JobContext,
  PermanentError,
  RetryableError,
} from '@nest-native/jobs';
import { type AppDatabase, DRIZZLE } from './database';
import { reports, sentEmails } from './schema';

/**
 * The happy path: runs in the claimer's poll loop with full DI. The side
 * effect is keyed on `ctx.jobId` (with ON CONFLICT DO NOTHING), so an
 * at-least-once redelivery can never double-send — the recommended idempotency
 * pattern for handlers.
 */
@JobHandler('email.welcome')
@Injectable()
export class WelcomeEmailHandler implements JobHandler {
  constructor(@Inject(DRIZZLE) private readonly db: AppDatabase) {}

  handle(payload: Record<string, unknown>, ctx: JobContext): void {
    this.db
      .insert(sentEmails)
      .values({ jobId: ctx.jobId, email: String(payload.email) })
      .onConflictDoNothing()
      .run();
  }
}

/**
 * The transient-failure path: the first attempt throws a RetryableError with
 * an explicit 25ms retry-after; the claimer re-arms the job and the second
 * attempt (ctx.attempt === 2) succeeds.
 */
@JobHandler('report.generate')
@Injectable()
export class ReportGenerateHandler implements JobHandler {
  constructor(@Inject(DRIZZLE) private readonly db: AppDatabase) {}

  handle(payload: Record<string, unknown>, ctx: JobContext): void {
    if (ctx.attempt === 1) {
      throw new RetryableError('report cache still cold — retry shortly', 25);
    }
    this.db
      .insert(reports)
      .values({ id: ctx.jobId, title: String(payload.title) })
      .run();
  }
}

/**
 * The non-recoverable path: retrying a permanently-declined card would just
 * burn attempts, so the handler throws PermanentError and the claimer fails
 * the job immediately.
 */
@JobHandler('billing.charge')
@Injectable()
export class BillingChargeHandler implements JobHandler {
  handle(payload: Record<string, unknown>): void {
    throw new PermanentError(
      `card declined for customer ${String(payload.customerId)} — do not retry`,
    );
  }
}
