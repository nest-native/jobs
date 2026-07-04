import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { resolveAvailableAt } from '../../enqueue-input';
import type {
  EnqueueJobInput,
  JobRow,
  JobStore,
  ResolvedRunnerConfig,
} from '../../interfaces';
import { jobs } from './schema';

type Db = BetterSQLite3Database<Record<string, never>>;

/**
 * better-sqlite3 surfaces a unique-constraint violation as a `SqliteError` with
 * `code === 'SQLITE_CONSTRAINT_UNIQUE'`. Match on the code (stable across driver
 * versions), not the message. Drizzle may wrap driver errors in a
 * `DrizzleQueryError`, so the code may instead sit on `error.cause` — check both.
 */
export function isSqliteUniqueViolation(error: unknown): boolean {
  const code = 'SQLITE_CONSTRAINT_UNIQUE';
  return hasCode(error, code) || hasCode((error as { cause?: unknown })?.cause, code);
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * SQLite (better-sqlite3) job store. Every method runs **synchronously** —
 * `enqueue` returns the row directly so it composes inside a synchronous
 * `@Transactional` body, and the rest wrap their synchronous result in a
 * resolved Promise for the engine to await from outside the transaction.
 *
 * A `(name, unique_key)` unique violation on `enqueue` is the active-dedup
 * no-op: the store returns the EXISTING active row instead of inserting.
 */
export class SqliteJobStore implements JobStore {
  enqueue(db: unknown, input: EnqueueJobInput<object>): JobRow {
    const availableAt = resolveAvailableAt(input).toISOString();
    try {
      return (db as Db)
        .insert(jobs)
        .values({
          id: randomUUID(),
          name: input.name,
          // The one place the structural input payload widens to the stored shape.
          payload: input.payload as Record<string, unknown>,
          status: 'pending',
          maxAttempts: input.maxAttempts ?? 10,
          uniqueKey: input.uniqueKey ?? null,
          priority: input.priority ?? 0,
          availableAt,
          createdAt: new Date().toISOString(),
        })
        .returning()
        .get();
    } catch (error) {
      const existing = this.findActiveDuplicate(db, input, error);
      if (!existing) throw error;
      return existing;
    }
  }

  /**
   * On a unique violation with a `uniqueKey`, the ACTIVE row that owns the
   * `(name, uniqueKey)` pair — terminal rows cannot own it (their key is
   * cleared to NULL). Any other error, or a vanished row (the owner completed
   * between the insert and this read), returns undefined so the caller
   * rethrows the original error.
   */
  private findActiveDuplicate(
    db: unknown,
    input: EnqueueJobInput<object>,
    error: unknown,
  ): JobRow | undefined {
    if (!isSqliteUniqueViolation(error) || input.uniqueKey == null) {
      return undefined;
    }
    return (db as Db)
      .select()
      .from(jobs)
      .where(and(eq(jobs.name, input.name), eq(jobs.uniqueKey, input.uniqueKey)))
      .get();
  }

  claimBatch(db: unknown, cfg: ResolvedRunnerConfig): Promise<JobRow[]> {
    const now = new Date();
    const nowIso = now.toISOString();
    const stuckCutoff = new Date(now.getTime() - cfg.stuckTimeoutMs).toISOString();
    const rows = (db as Db).transaction((tx) => {
      const candidates = tx
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
        .all();
      if (candidates.length === 0) return [];
      const ids = candidates.map((c) => c.id);
      tx.update(jobs)
        .set({ status: 'processing', claimedAt: nowIso, claimedBy: cfg.workerInstanceId })
        .where(inArray(jobs.id, ids))
        .run();
      return tx
        .select()
        .from(jobs)
        .where(inArray(jobs.id, ids))
        .orderBy(desc(jobs.priority), asc(jobs.availableAt))
        .all();
    });
    return Promise.resolve(rows);
  }

  markCompleted(db: unknown, id: string): Promise<void> {
    (db as Db)
      .update(jobs)
      .set({
        status: 'completed',
        processedAt: new Date().toISOString(),
        lastError: null,
        // Terminal → release the active-dedup key.
        uniqueKey: null,
      })
      .where(eq(jobs.id, id))
      .run();
    return Promise.resolve();
  }

  retry(db: unknown, id: string, delayMs: number, lastError?: string): Promise<void> {
    const nextAvailable = new Date(Date.now() + delayMs).toISOString();
    (db as Db)
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
      .where(eq(jobs.id, id))
      .run();
    return Promise.resolve();
  }

  markFailed(db: unknown, id: string, reason: string): Promise<void> {
    (db as Db)
      .update(jobs)
      .set({
        status: 'failed',
        attempts: sql`${jobs.attempts} + 1`,
        lastError: reason,
        processedAt: new Date().toISOString(),
        // Terminal → release the active-dedup key.
        uniqueKey: null,
      })
      .where(eq(jobs.id, id))
      .run();
    return Promise.resolve();
  }
}
