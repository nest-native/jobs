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
 * The next occurrence STRICTLY AFTER `after`, as an ISO-8601 string, or
 * `null` when the expression has no future occurrence. Used by the claimer,
 * where `null` means the schedule just fired for the last time and disables
 * itself.
 *
 * Always advancing from *now* — never from the previously stored due time —
 * is the misfire policy: missed occurrences are skipped, and a schedule that
 * was down for a week fires at most one catch-up.
 *
 * Throws {@link InvalidScheduleError} when the expression (or timezone)
 * cannot be evaluated. Croner reports a bad pattern at construction but a bad
 * timezone only when computing a run, so both surface here.
 */
export function nextOccurrence(
  cron: string,
  timezone: string | null,
  after: Date,
): string | null {
  const parsed = wrap(cron, timezone, () => new Cron(cron, { timezone: timezone ?? 'UTC' }));
  return wrap(cron, timezone, () => parsed.nextRun(after)?.toISOString() ?? null);
}

/**
 * Like {@link nextOccurrence}, but for ARMING a schedule (upsert /
 * `setEnabled(true)`): an expression with no future occurrence at all (e.g.
 * `0 0 30 2 *` — February 30th never comes) is rejected with
 * {@link InvalidScheduleError} instead of creating a schedule that can never
 * fire.
 */
export function armSchedule(
  cron: string,
  timezone: string | null,
  after: Date,
): string {
  const next = nextOccurrence(cron, timezone, after);
  if (next === null) {
    throw new InvalidScheduleError(
      `Invalid cron schedule "${cron}"${tzSuffix(timezone)}: it has no future occurrence`,
    );
  }
  return next;
}

function wrap<T>(cron: string, timezone: string | null, run: () => T): T {
  try {
    return run();
  } catch (error) {
    // Croner throws Error subclasses (TypeError for bad patterns/timezones).
    throw new InvalidScheduleError(
      `Invalid cron schedule "${cron}"${tzSuffix(timezone)}: ${(error as Error).message}`,
    );
  }
}

function tzSuffix(timezone: string | null): string {
  return timezone ? ` (timezone "${timezone}")` : '';
}
