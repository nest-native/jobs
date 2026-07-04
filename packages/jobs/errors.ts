// The retry vocabulary handlers use to steer the claimer. It is deliberately
// dependency-free (no Nest, no Drizzle) so handlers, stores, and tests can all
// throw these without importing anything heavier than this module.

/**
 * Signals a transient failure: the job could not complete now but a later
 * attempt may succeed. `delayMs`, when set, overrides the claimer's jittered
 * exponential backoff for the next attempt (e.g. a handler-supplied
 * retry-after).
 */
export class RetryableError extends Error {
  constructor(
    message: string,
    readonly delayMs?: number,
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

/**
 * Signals a non-recoverable failure: retrying can never succeed (e.g. no
 * handler registered for the job name, or a malformed payload). The claimer
 * marks the job failed immediately rather than burning retry attempts.
 */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}
