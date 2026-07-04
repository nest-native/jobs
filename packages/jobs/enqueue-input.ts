// Shared enqueue-input resolution, used by every dialect store so the
// runAt/delayMs contract is identical no matter which store executes it.

/**
 * Resolves when an enqueued job becomes due.
 *
 * - `runAt` and `delayMs` are **mutually exclusive** — both set throws, so a
 *   silent precedence rule can never mask a caller bug.
 * - `runAt` wins as the absolute time; `delayMs` counts from now; neither
 *   means "due immediately".
 */
export function resolveAvailableAt(input: { runAt?: Date; delayMs?: number }): Date {
  if (input.runAt !== undefined && input.delayMs !== undefined) {
    throw new Error(
      'EnqueueJobInput: runAt and delayMs are mutually exclusive — set at most one.',
    );
  }
  if (input.runAt !== undefined) {
    return input.runAt;
  }
  if (input.delayMs !== undefined) {
    return new Date(Date.now() + input.delayMs);
  }
  return new Date();
}
