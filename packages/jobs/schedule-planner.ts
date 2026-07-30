import { Cron } from 'croner';
import { InvalidScheduleError } from './errors';

/**
 * The one place cron math happens. Parsing, next-occurrence computation,
 * timezones, and DST semantics are all delegated to `croner` (the package's
 * single runtime dependency) — hand-rolling cron is forbidden by the
 * guidelines. The default timezone is **UTC**, not server-local, so a
 * schedule means the same thing on every instance.
 */

/**
 * Validates a cron expression + optional IANA timezone. Croner reports a bad
 * pattern at construction but a bad timezone only when computing a run, so
 * validation computes one occurrence. Throws {@link InvalidScheduleError}
 * with the underlying message on failure.
 */
export function assertValidSchedule(
  cron: string,
  timezone?: string | null,
): void {
  nextOccurrence(cron, timezone ?? null, new Date());
}

/**
 * The next occurrence STRICTLY AFTER `after`, as an ISO-8601 string, or
 * `null` when the expression has no future occurrence (e.g. `0 0 30 2 *` —
 * February 30th never comes; the claimer disables such schedules).
 *
 * Always advancing from *now* — never from the previously stored due time —
 * is the misfire policy: missed occurrences are skipped, and a schedule that
 * was down for a week fires at most one catch-up.
 */
export function nextOccurrence(
  cron: string,
  timezone: string | null,
  after: Date,
): string | null {
  const parsed = wrap(cron, timezone, () => new Cron(cron, { timezone: timezone ?? 'UTC' }));
  return wrap(cron, timezone, () => parsed.nextRun(after)?.toISOString() ?? null);
}

function wrap<T>(cron: string, timezone: string | null, run: () => T): T {
  try {
    return run();
  } catch (error) {
    // Croner throws Error subclasses (TypeError for bad patterns/timezones).
    const tz = timezone ? ` (timezone "${timezone}")` : '';
    throw new InvalidScheduleError(
      `Invalid cron schedule "${cron}"${tz}: ${(error as Error).message}`,
    );
  }
}
