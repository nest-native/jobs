import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type {
  ResolvedScheduleUpsert,
  ScheduleClaim,
  ScheduleClaimResult,
  ScheduleRow,
  ScheduleStore,
} from '../../interfaces';
import { jobs, jobSchedules } from './schema';

type Db = BetterSQLite3Database<Record<string, never>>;

/**
 * SQLite (better-sqlite3) schedule store. Like {@link SqliteJobStore}, every
 * method runs **synchronously** — `upsert` returns the row directly so it
 * composes inside a synchronous `@Transactional` body; the rest wrap their
 * synchronous result in a resolved Promise.
 *
 * `claimAndEnqueue` runs the compare-and-swap on `next_run_at` and the
 * occurrence insert in ONE synchronous transaction. The insert uses
 * `ON CONFLICT DO NOTHING` on `(name, unique_key)` so an active occurrence
 * with the schedule's `uniqueKey` suppresses the new one (the overlap guard)
 * without poisoning the transaction — the schedule row still advances.
 */
export class SqliteScheduleStore implements ScheduleStore {
  upsert(db: unknown, input: ResolvedScheduleUpsert): ScheduleRow {
    const nowIso = new Date().toISOString();
    return (db as Db)
      .insert(jobSchedules)
      .values({
        id: randomUUID(),
        ...input,
        enabled: input.enabled ?? true,
        lastEnqueuedAt: null,
        lastError: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .onConflictDoUpdate({
        target: jobSchedules.name,
        // Updates keep id / createdAt / lastEnqueuedAt; a successful upsert
        // clears any stale claim-time error. Two deliberate preservations
        // make boot-time upserts safe: an omitted `enabled` (null) keeps the
        // stored flag (ops kill switches survive redeploys), and the stored
        // `next_run_at` survives while cron/timezone are unchanged (a pending
        // catch-up is not skipped; the rhythm is not perturbed). `IS` is
        // SQLite's null-safe equality.
        set: {
          nextRunAt: sql`CASE WHEN ${jobSchedules.cron} = excluded.cron AND ${jobSchedules.timezone} IS excluded.timezone AND ${jobSchedules.nextRunAt} IS NOT NULL THEN ${jobSchedules.nextRunAt} ELSE excluded.next_run_at END`,
          jobName: input.jobName,
          payload: input.payload,
          cron: input.cron,
          timezone: input.timezone,
          maxAttempts: input.maxAttempts,
          priority: input.priority,
          uniqueKey: input.uniqueKey,
          lastError: null,
          updatedAt: nowIso,
          ...(input.enabled !== null && { enabled: input.enabled }),
        },
      })
      .returning()
      .get();
  }

  get(db: unknown, name: string): Promise<ScheduleRow | undefined> {
    const row = (db as Db)
      .select()
      .from(jobSchedules)
      .where(eq(jobSchedules.name, name))
      .get();
    return Promise.resolve(row);
  }

  list(db: unknown): Promise<ScheduleRow[]> {
    return Promise.resolve(
      (db as Db)
        .select()
        .from(jobSchedules)
        .orderBy(asc(jobSchedules.name))
        .all(),
    );
  }

  remove(db: unknown, name: string): Promise<boolean> {
    const result = (db as Db)
      .delete(jobSchedules)
      .where(eq(jobSchedules.name, name))
      .run();
    return Promise.resolve(result.changes > 0);
  }

  setEnabled(
    db: unknown,
    name: string,
    enabled: boolean,
    nextRunAt: string | null,
    expectedUpdatedAt?: string,
  ): Promise<ScheduleRow | undefined> {
    const rows = (db as Db)
      .update(jobSchedules)
      .set({ enabled, nextRunAt, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(jobSchedules.name, name),
          // Optimistic guard: only write over the row version the caller read.
          ...(expectedUpdatedAt === undefined
            ? []
            : [eq(jobSchedules.updatedAt, expectedUpdatedAt)]),
        ),
      )
      .returning()
      .all();
    return Promise.resolve(rows[0]);
  }

  listDue(db: unknown, nowIso: string, limit: number): Promise<ScheduleRow[]> {
    return Promise.resolve(
      (db as Db)
        .select()
        .from(jobSchedules)
        .where(
          and(
            eq(jobSchedules.enabled, true),
            isNotNull(jobSchedules.nextRunAt),
            lte(jobSchedules.nextRunAt, nowIso),
          ),
        )
        .orderBy(asc(jobSchedules.nextRunAt))
        .limit(limit)
        .all(),
    );
  }

  claimAndEnqueue(db: unknown, claim: ScheduleClaim): Promise<ScheduleClaimResult> {
    const result = (db as Db).transaction((tx): ScheduleClaimResult => {
      const cas = tx
        .update(jobSchedules)
        .set({
          nextRunAt: claim.nextRunAt,
          // A schedule with no future occurrence disables itself.
          enabled: claim.nextRunAt !== null,
          lastEnqueuedAt: claim.nowIso,
          lastError: null,
          updatedAt: claim.nowIso,
        })
        .where(
          and(
            eq(jobSchedules.id, claim.id),
            eq(jobSchedules.nextRunAt, claim.expectedNextRunAt),
            eq(jobSchedules.enabled, true),
          ),
        )
        .run();
      if (cas.changes === 0) {
        return { claimed: false, job: null };
      }
      const inserted = tx
        .insert(jobs)
        .values({
          id: randomUUID(),
          name: claim.input.name,
          payload: claim.input.payload as Record<string, unknown>,
          status: 'pending',
          maxAttempts: claim.input.maxAttempts ?? 10,
          uniqueKey: claim.input.uniqueKey ?? null,
          priority: claim.input.priority ?? 0,
          availableAt: claim.nowIso,
          createdAt: claim.nowIso,
        })
        .onConflictDoNothing({ target: [jobs.name, jobs.uniqueKey] })
        .returning()
        .all();
      // An empty RETURNING means the overlap guard suppressed the insert (an
      // occurrence with this (name, unique_key) is still active) — the
      // schedule still advanced; there is just no new job.
      return { claimed: true, job: inserted.length > 0 ? inserted[0] : null };
    });
    return Promise.resolve(result);
  }

  disable(db: unknown, id: string, lastError: string): Promise<void> {
    (db as Db)
      .update(jobSchedules)
      .set({ enabled: false, lastError, updatedAt: new Date().toISOString() })
      .where(eq(jobSchedules.id, id))
      .run();
    return Promise.resolve();
  }
}
