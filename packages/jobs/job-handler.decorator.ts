import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { JobContext } from './interfaces';

/** Metadata key carrying the job name a `@JobHandler` class handles. */
export const JOB_HANDLER_NAME = Symbol.for('@nest-native/jobs:job-handler-name');

/**
 * The contract a `@JobHandler(name)` class fulfils. Handlers run in the
 * claimer's poll loop, OUTSIDE any business transaction, and delivery is
 * at-least-once — make them idempotent or key side effects on `ctx.jobId`.
 * Throw {@link RetryableError} / {@link PermanentError} to steer retries; any
 * other throw retries with backoff until `maxAttempts`, then fails.
 *
 * The interface and the decorator below share the name deliberately (one lives
 * in the type space, the other in the value space), so a handler reads:
 *
 * ```ts
 * @JobHandler('email.welcome')
 * @Injectable()
 * export class WelcomeEmailHandler implements JobHandler { ... }
 * ```
 */
export interface JobHandler {
  handle(payload: Record<string, unknown>, ctx: JobContext): void | Promise<void>;
}

/**
 * Marks a provider class as the handler for jobs enqueued under `name`.
 *
 * Register the class as a provider in any module; {@link JobsHandlerExplorer}
 * discovers it at application bootstrap. Exactly one handler per name —
 * duplicates throw at startup.
 */
export function JobHandler(name: string): CustomDecorator<symbol> {
  return SetMetadata(JOB_HANDLER_NAME, name);
}
