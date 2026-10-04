import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { resolveAvailableAt } from '../../enqueue-input';
import type {
  EnqueueJobInput,
  JobClaim,
  JobRow,
  JobStore,
  ResolvedRunnerConfig,
} from '../../interfaces';
import { jobs } from './schema';
import { readCommitted } from './transaction';

type Db = NodePgDatabase<Record<string, never>>;

/**
 * Postgres surfaces a unique-constraint violation with SQLSTATE `23505`
 * (`unique_violation`). node-postgres exposes it as `error.code === '23505'`;
 * Drizzle wraps driver errors in a `DrizzleQueryError`, so the code may instead
 * sit on `error.cause`. Check both so the predicate is robust to wrapping.
 */
export function isPgUniqueViolation(error: unknown): boolean {
  return hasCode(error, '23505') || hasCode((error as { cause?: unknown })?.cause, '23505');
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
 * Runs one fenced transition and reports whether it wrote the job. Each runs in
 * its own READ COMMITTED transaction, like the claim: under a SERIALIZABLE
 * server default the fenced UPDATE's scan (on the status index, in steady state)
 * makes two workers' transitions abort each other (40001) while both claims
 * still hold their jobs. Under READ COMMITTED an UPDATE that waited on a
 * reclaim re-checks the fence against the committed row instead, so `false`
 * means the claim really was taken over, and any error is a real one.
 */
const fenced = (
  db: unknown,
  update: (tx: Db) => PromiseLike<{ id: string }[]>,
): Promise<boolean> => readCommitted(db, async (tx) => (await update(tx)).length > 0);

/**
 * Postgres (node-postgres) job store. Every method is **asynchronous** —
 * `enqueue` awaits the insert (call it with `await` inside an async
 * `@Transactional` body), and the claimer's batch claim runs in an async
 * transaction.
 *
 * A `(name, unique_key)` unique violation on `enqueue` is the active-dedup
 * no-op: the store returns the EXISTING active row instead of inserting.
 */
export class PostgresJobStore implements JobStore {
  async enqueue(db: unknown, input: EnqueueJobInput<object>): Promise<JobRow> {
    const availableAt = resolveAvailableAt(input).toISOString();
    try {
      const [row] = await (db as Db)
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
        .returning();
      return row;
    } catch (error) {
      const existing = await this.findActiveDuplicate(db, input, error);
      if (!existing) throw error;
      return existing;
    }
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
    if (!isPgUniqueViolation(error) || input.uniqueKey == null) {
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
    // FOR UPDATE SKIP LOCKED: two workers claiming at once split the backlog
    // instead of both taking (and running) the same jobs.
    return readCommitted(db, async (tx) => {
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
    });
  }

  async markCompleted(db: unknown, claim: JobClaim): Promise<boolean> {
    return fenced(db, (tx) =>
      tx
        .update(jobs)
        .set({
          status: 'completed',
          processedAt: new Date().toISOString(),
          lastError: null,
          // Terminal → release the active-dedup key.
          uniqueKey: null,
        })
        .where(heldBy(claim))
        .returning({ id: jobs.id }),
    );
  }

  async retry(
    db: unknown,
    claim: JobClaim,
    delayMs: number,
    lastError?: string,
  ): Promise<boolean> {
    const nextAvailable = new Date(Date.now() + delayMs).toISOString();
    return fenced(db, (tx) =>
      tx
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
        .where(heldBy(claim))
        .returning({ id: jobs.id }),
    );
  }

  async markFailed(db: unknown, claim: JobClaim, reason: string): Promise<boolean> {
    return fenced(db, (tx) =>
      tx
        .update(jobs)
        .set({
          status: 'failed',
          attempts: sql`${jobs.attempts} + 1`,
          lastError: reason,
          processedAt: new Date().toISOString(),
          // Terminal → release the active-dedup key.
          uniqueKey: null,
        })
        .where(heldBy(claim))
        .returning({ id: jobs.id }),
    );
  }
}
