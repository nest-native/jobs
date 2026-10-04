import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { resolveAvailableAt } from '../../enqueue-input';
import type {
  EnqueueJobInput,
  JobClaim,
  JobRow,
  JobStore,
  ResolvedRunnerConfig,
} from '../../interfaces';
import { jobs } from './schema';

type Db = MySql2Database<Record<string, never>>;

/**
 * Matches the job only while it is `processing` under exactly this claim, so a
 * transition from a worker whose claim was taken over after the stuck timeout
 * writes nothing, even when a later claim reused the same `workerInstanceId`.
 */
const heldBy = (claim: JobClaim) =>
  and(
    eq(jobs.id, claim.id),
    eq(jobs.status, 'processing'),
    eq(jobs.claimedBy, claim.claimedBy),
    eq(jobs.claimedAt, claim.claimedAt),
  );

/**
 * MySQL surfaces a unique-constraint violation as error code `ER_DUP_ENTRY`
 * (errno `1062`). mysql2 sets both `error.code === 'ER_DUP_ENTRY'` and
 * `error.errno === 1062`; Drizzle wraps driver errors in a `DrizzleQueryError`,
 * so the code/errno may instead sit on `error.cause`. Check the code **and**
 * the errno, on the error and on its `cause`, so the predicate is robust to
 * both the driver's shape and Drizzle's wrapping.
 */
export function isMysqlUniqueViolation(error: unknown): boolean {
  return isDuplicate(error) || isDuplicate((error as { cause?: unknown })?.cause);
}

function isDuplicate(error: unknown): boolean {
  return hasProp(error, 'code', 'ER_DUP_ENTRY') || hasProp(error, 'errno', 1062);
}

function hasProp(error: unknown, key: string, value: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    key in error &&
    (error as Record<string, unknown>)[key] === value
  );
}

/**
 * MySQL (mysql2) job store. Every method is **asynchronous** — `enqueue`
 * awaits the insert (call it with `await` inside an async `@Transactional`
 * body), and the claimer's batch claim runs in an async transaction.
 *
 * Unlike Postgres, MySQL's `INSERT` has no `RETURNING`, so `enqueue` inserts
 * the row (client-generated UUID id) and reads it back by id to return the
 * canonical {@link JobRow}. A `(name, unique_key)` unique violation is the
 * active-dedup no-op: the store returns the EXISTING active row instead.
 */
export class MysqlJobStore implements JobStore {
  async enqueue(db: unknown, input: EnqueueJobInput<object>): Promise<JobRow> {
    const id = randomUUID();
    const availableAt = resolveAvailableAt(input).toISOString();
    try {
      await (db as Db).insert(jobs).values({
        id,
        name: input.name,
        // The one place the structural input payload widens to the stored shape.
        payload: input.payload as Record<string, unknown>,
        status: 'pending',
        maxAttempts: input.maxAttempts ?? 10,
        uniqueKey: input.uniqueKey ?? null,
        priority: input.priority ?? 0,
        availableAt,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      const existing = await this.findActiveDuplicate(db, input, error);
      if (!existing) throw error;
      return existing;
    }
    const [row] = await (db as Db).select().from(jobs).where(eq(jobs.id, id));
    return row;
  }

  /**
   * On a unique violation with a `uniqueKey`, the ACTIVE row that owns the
   * `(name, uniqueKey)` pair — terminal rows cannot own it (their key is
   * cleared to NULL). Any other error, or a vanished row (the owner completed
   * between the insert and this read), resolves undefined so the caller
   * rethrows the original error.
   */
  private async findActiveDuplicate(
    db: unknown,
    input: EnqueueJobInput<object>,
    error: unknown,
  ): Promise<JobRow | undefined> {
    if (!isMysqlUniqueViolation(error) || input.uniqueKey == null) {
      return undefined;
    }
    const [existing] = await (db as Db)
      .select()
      .from(jobs)
      .where(and(eq(jobs.name, input.name), eq(jobs.uniqueKey, input.uniqueKey)));
    return existing;
  }

  async claimBatch(db: unknown, cfg: ResolvedRunnerConfig): Promise<JobRow[]> {
    const now = new Date();
    const nowIso = now.toISOString();
    const stuckCutoff = new Date(now.getTime() - cfg.stuckTimeoutMs).toISOString();
    return (db as Db).transaction(async (tx) => {
      const candidates = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          or(
            and(eq(jobs.status, 'pending'), lte(jobs.availableAt, nowIso)),
            and(eq(jobs.status, 'processing'), lte(jobs.claimedAt, stuckCutoff)),
          ),
        )
        .orderBy(desc(jobs.priority), asc(jobs.availableAt))
        .limit(cfg.batchSize)
        // FOR UPDATE SKIP LOCKED: two workers claiming at once split the
        // backlog instead of both taking (and running) the same jobs.
        .for('update', { skipLocked: true });
      if (candidates.length === 0) return [];
      const ids = candidates.map((c) => c.id);
      await tx
        .update(jobs)
        .set({ status: 'processing', claimedAt: nowIso, claimedBy: cfg.workerInstanceId })
        .where(inArray(jobs.id, ids));
      return tx
        .select()
        .from(jobs)
        .where(inArray(jobs.id, ids))
        .orderBy(desc(jobs.priority), asc(jobs.availableAt));
      // READ COMMITTED, not InnoDB's default REPEATABLE READ: there the locking
      // read also locks the gaps it scans, so every concurrent enqueue INSERT
      // would wait for the claim to commit.
    }, { isolationLevel: 'read committed' });
  }

  async markCompleted(db: unknown, claim: JobClaim): Promise<boolean> {
    const [result] = await (db as Db)
      .update(jobs)
      .set({
        status: 'completed',
        processedAt: new Date().toISOString(),
        lastError: null,
        // Terminal → release the active-dedup key.
        uniqueKey: null,
      })
      .where(heldBy(claim));
    return result.affectedRows > 0;
  }

  async retry(
    db: unknown,
    claim: JobClaim,
    delayMs: number,
    lastError?: string,
  ): Promise<boolean> {
    const nextAvailable = new Date(Date.now() + delayMs).toISOString();
    const [result] = await (db as Db)
      .update(jobs)
      .set({
        status: 'pending',
        attempts: sql`${jobs.attempts} + 1`,
        availableAt: nextAvailable,
        claimedAt: null,
        claimedBy: null,
        lastError: lastError ?? null,
        // Still active → the uniqueKey stays claimed.
      })
      .where(heldBy(claim));
    return result.affectedRows > 0;
  }

  async markFailed(db: unknown, claim: JobClaim, reason: string): Promise<boolean> {
    const [result] = await (db as Db)
      .update(jobs)
      .set({
        status: 'failed',
        attempts: sql`${jobs.attempts} + 1`,
        lastError: reason,
        processedAt: new Date().toISOString(),
        // Terminal → release the active-dedup key.
        uniqueKey: null,
      })
      .where(heldBy(claim));
    return result.affectedRows > 0;
  }
}
