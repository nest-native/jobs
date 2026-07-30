import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import type {
  ResolvedScheduleUpsert,
  ScheduleClaim,
  ScheduleClaimResult,
  ScheduleRow,
  ScheduleStore,
} from '../../interfaces';
import { jobs, jobSchedules } from './schema';

type Db = MySql2Database<Record<string, never>>;

/**
 * MySQL (mysql2) schedule store. Every method is **asynchronous**, mirroring
 * {@link MysqlJobStore}. MySQL's `INSERT` has no `RETURNING`, so writes use
 * client-generated UUID ids and read the canonical row back by id/name.
 *
 * `claimAndEnqueue` runs the compare-and-swap on `next_run_at` and the
 * occurrence insert in ONE transaction. The insert is made conflict-tolerant
 * with the `ON DUPLICATE KEY UPDATE id = id` no-op idiom: an active occurrence
 * holding the schedule's `(name, unique_key)` suppresses the new one (the
 * overlap guard) without raising, and the schedule row still advances.
 * Whether the insert happened is detected by reading our generated id back.
 */
export class MysqlScheduleStore implements ScheduleStore {
  async upsert(db: unknown, input: ResolvedScheduleUpsert): Promise<ScheduleRow> {
    const nowIso = new Date().toISOString();
    await (db as Db)
      .insert(jobSchedules)
      .values({
        id: randomUUID(),
        ...input,
        lastEnqueuedAt: null,
        lastError: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .onDuplicateKeyUpdate({
        // Updates keep id / createdAt / lastEnqueuedAt; a successful upsert
        // clears any stale claim-time error.
        set: {
          jobName: input.jobName,
          payload: input.payload,
          cron: input.cron,
          timezone: input.timezone,
          enabled: input.enabled,
          nextRunAt: input.nextRunAt,
          maxAttempts: input.maxAttempts,
          priority: input.priority,
          uniqueKey: input.uniqueKey,
          lastError: null,
          updatedAt: nowIso,
        },
      });
    const [row] = await (db as Db)
      .select()
      .from(jobSchedules)
      .where(eq(jobSchedules.name, input.name));
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
    const [result] = await (db as Db)
      .delete(jobSchedules)
      .where(eq(jobSchedules.name, name));
    return result.affectedRows > 0;
  }

  async setEnabled(
    db: unknown,
    name: string,
    enabled: boolean,
    nextRunAt: string | null,
  ): Promise<ScheduleRow | undefined> {
    await (db as Db)
      .update(jobSchedules)
      .set({ enabled, nextRunAt, updatedAt: new Date().toISOString() })
      .where(eq(jobSchedules.name, name));
    return this.get(db, name);
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
      const [cas] = await tx
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
        );
      if (cas.affectedRows === 0) {
        return { claimed: false, job: null };
      }
      const jobId = randomUUID();
      await tx
        .insert(jobs)
        .values({
          id: jobId,
          name: claim.input.name,
          payload: claim.input.payload as Record<string, unknown>,
          status: 'pending',
          maxAttempts: claim.input.maxAttempts ?? 10,
          uniqueKey: claim.input.uniqueKey ?? null,
          priority: claim.input.priority ?? 0,
          availableAt: claim.nowIso,
          createdAt: claim.nowIso,
        })
        // The classic MySQL "insert unless duplicate" no-op: on a
        // (name, unique_key) collision nothing changes and nothing raises.
        .onDuplicateKeyUpdate({ set: { id: sql`${jobs.id}` } });
      // Detect whether the insert happened by reading our id back: absent
      // means the overlap guard suppressed it (an occurrence with this
      // (name, unique_key) is still active) — the schedule still advanced.
      const insertedRows = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.id, jobId));
      return {
        claimed: true,
        job: insertedRows.length > 0 ? insertedRows[0] : null,
      };
    });
  }

  async disable(db: unknown, id: string, lastError: string): Promise<void> {
    await (db as Db)
      .update(jobSchedules)
      .set({ enabled: false, lastError, updatedAt: new Date().toISOString() })
      .where(eq(jobSchedules.id, id));
  }
}
