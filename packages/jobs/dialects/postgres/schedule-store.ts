import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNotNull, lte } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type {
  ResolvedScheduleUpsert,
  ScheduleClaim,
  ScheduleClaimResult,
  ScheduleRow,
  ScheduleStore,
} from '../../interfaces';
import { jobs, jobSchedules } from './schema';

type Db = NodePgDatabase<Record<string, never>>;

/**
 * Postgres (node-postgres) schedule store. Every method is **asynchronous**,
 * mirroring {@link PostgresJobStore}.
 *
 * `claimAndEnqueue` runs the compare-and-swap on `next_run_at` and the
 * occurrence insert in ONE transaction. The insert uses
 * `ON CONFLICT DO NOTHING` on `(name, unique_key)` — crucial on Postgres,
 * where a raised unique violation would poison the whole transaction; the
 * conflict-tolerant insert lets the schedule row advance even when the
 * overlap guard suppresses the occurrence.
 */
export class PostgresScheduleStore implements ScheduleStore {
  async upsert(db: unknown, input: ResolvedScheduleUpsert): Promise<ScheduleRow> {
    const nowIso = new Date().toISOString();
    const [row] = await (db as Db)
      .insert(jobSchedules)
      .values({
        id: randomUUID(),
        ...input,
        lastEnqueuedAt: null,
        lastError: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .onConflictDoUpdate({
        target: jobSchedules.name,
        // Updates keep id / createdAt / lastEnqueuedAt; a successful upsert
        // clears any stale claim-time error.
        set: { ...input, lastError: null, updatedAt: nowIso },
      })
      .returning();
    return row;
  }

  async get(db: unknown, name: string): Promise<ScheduleRow | undefined> {
    const rows = await (db as Db)
      .select()
      .from(jobSchedules)
      .where(eq(jobSchedules.name, name));
    return rows[0];
  }

  async list(db: unknown): Promise<ScheduleRow[]> {
    return (db as Db)
      .select()
      .from(jobSchedules)
      .orderBy(asc(jobSchedules.name));
  }

  async remove(db: unknown, name: string): Promise<boolean> {
    const rows = await (db as Db)
      .delete(jobSchedules)
      .where(eq(jobSchedules.name, name))
      .returning({ id: jobSchedules.id });
    return rows.length > 0;
  }

  async setEnabled(
    db: unknown,
    name: string,
    enabled: boolean,
    nextRunAt: string | null,
  ): Promise<ScheduleRow | undefined> {
    const rows = await (db as Db)
      .update(jobSchedules)
      .set({ enabled, nextRunAt, updatedAt: new Date().toISOString() })
      .where(eq(jobSchedules.name, name))
      .returning();
    return rows[0];
  }

  async listDue(
    db: unknown,
    nowIso: string,
    limit: number,
  ): Promise<ScheduleRow[]> {
    return (db as Db)
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
      .limit(limit);
  }

  async claimAndEnqueue(
    db: unknown,
    claim: ScheduleClaim,
  ): Promise<ScheduleClaimResult> {
    return (db as Db).transaction(async (tx): Promise<ScheduleClaimResult> => {
      const cas = await tx
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
        .returning({ id: jobSchedules.id });
      if (cas.length === 0) {
        return { claimed: false, job: null };
      }
      const inserted = await tx
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
        .returning();
      // An empty RETURNING means the overlap guard suppressed the insert (an
      // occurrence with this (name, unique_key) is still active) — the
      // schedule still advanced; there is just no new job.
      return { claimed: true, job: inserted.length > 0 ? inserted[0] : null };
    });
  }

  async disable(db: unknown, id: string, lastError: string): Promise<void> {
    await (db as Db)
      .update(jobSchedules)
      .set({ enabled: false, lastError, updatedAt: new Date().toISOString() })
      .where(eq(jobSchedules.id, id));
  }
}
