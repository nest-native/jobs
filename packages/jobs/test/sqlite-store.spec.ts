import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { DEFAULT_RUNNER_CONFIG } from '../jobs-claimer.service';
import type { JobClaim, JobRow } from '../interfaces';
import { isSqliteUniqueViolation, jobs, SqliteJobStore } from '../dialects/sqlite';

const DDL = `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 10,
  unique_key TEXT, priority INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL,
  claimed_at TEXT, claimed_by TEXT, processed_at TEXT, last_error TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX jobs_name_unique_key_unique ON jobs (name, unique_key);
CREATE INDEX jobs_status_available_idx ON jobs (status, available_at);
`;

let db: BetterSQLite3Database<Record<string, never>>;
const cfg = { ...DEFAULT_RUNNER_CONFIG, batchSize: 10, stuckTimeoutMs: 1_000 };
const store = new SqliteJobStore();

beforeEach(() => {
  const sqlite = new Database(':memory:');
  sqlite.exec(DDL);
  db = drizzle(sqlite);
});

/** Claims the due jobs and returns `row`'s claim, as the claimer would hold it. */
async function claim(row: JobRow, workerInstanceId = cfg.workerInstanceId): Promise<JobClaim> {
  const mine = (await store.claimBatch(db, { ...cfg, workerInstanceId })).find((r) => r.id === row.id);
  assert.ok(mine, `job ${row.id} was not claimed`);
  return { id: mine.id, claimedBy: mine.claimedBy!, claimedAt: mine.claimedAt! };
}

/**
 * Turns `held` into a claim made long ago, past the stuck timeout, so the next
 * claim takes the job over; returns that stale claim.
 */
function stall(held: JobClaim): JobClaim {
  const claimedAt = new Date(Date.now() - 10 * cfg.stuckTimeoutMs).toISOString();
  db.update(jobs).set({ claimedAt }).where(eq(jobs.id, held.id)).run();
  return { ...held, claimedAt };
}

describe('SqliteJobStore enqueue', () => {
  test('inserts a pending row and returns it synchronously', () => {
    const row = store.enqueue(db, {
      name: 'email.send',
      payload: { to: 'a@b.c' },
      uniqueKey: 'k1',
    });
    assert.equal(row.status, 'pending');
    assert.equal(row.name, 'email.send');
    assert.equal(row.uniqueKey, 'k1');
    assert.deepEqual(row.payload, { to: 'a@b.c' });
    assert.equal(row.attempts, 0);
    assert.equal(row.maxAttempts, 10);
    assert.equal(row.priority, 0);
  });

  test('accepts a payload typed as a plain interface — no cast', () => {
    // Compile-level regression: an interface has no index signature, so it is
    // not assignable to Record<string, unknown>; the store seam takes
    // EnqueueJobInput<object> and widens the stored payload internally.
    interface ReportRequested {
      reportId: string;
      pages: number;
    }
    const payload: ReportRequested = { reportId: 'r-1', pages: 2 };
    const row = store.enqueue(db, { name: 'report.generate', payload });
    assert.deepEqual(row.payload, { reportId: 'r-1', pages: 2 });
  });

  test('honours runAt, maxAttempts, and priority; null uniqueKey by default', () => {
    const at = new Date(Date.now() + 60_000);
    const row = store.enqueue(db, {
      name: 't',
      payload: {},
      runAt: at,
      maxAttempts: 3,
      priority: 7,
    });
    assert.equal(row.availableAt, at.toISOString());
    assert.equal(row.maxAttempts, 3);
    assert.equal(row.priority, 7);
    assert.equal(row.uniqueKey, null);
  });

  test('honours delayMs relative to now', () => {
    const before = Date.now();
    const row = store.enqueue(db, { name: 't', payload: {}, delayMs: 30_000 });
    const due = new Date(row.availableAt).getTime();
    assert.ok(due >= before + 30_000);
    assert.ok(due <= Date.now() + 30_000);
  });

  test('rejects runAt combined with delayMs', () => {
    assert.throws(
      () => store.enqueue(db, { name: 't', payload: {}, runAt: new Date(), delayMs: 5 }),
      /mutually exclusive/,
    );
    assert.equal(db.select().from(jobs).all().length, 0);
  });
});

describe('SqliteJobStore uniqueKey contract', () => {
  test('duplicate (name, uniqueKey) enqueue is a no-op returning the EXISTING row', () => {
    const first = store.enqueue(db, { name: 'email.send', payload: { n: 1 }, uniqueKey: 'k' });
    const second = store.enqueue(db, { name: 'email.send', payload: { n: 2 }, uniqueKey: 'k' });
    assert.equal(second.id, first.id);
    assert.deepEqual(second.payload, { n: 1 });
    assert.equal(db.select().from(jobs).all().length, 1);
  });

  test('the same uniqueKey under a different name does not collide', () => {
    const a = store.enqueue(db, { name: 'a', payload: {}, uniqueKey: 'k' });
    const b = store.enqueue(db, { name: 'b', payload: {}, uniqueKey: 'k' });
    assert.notEqual(a.id, b.id);
    assert.equal(db.select().from(jobs).all().length, 2);
  });

  test('multiple NULL uniqueKeys never collide', () => {
    store.enqueue(db, { name: 't', payload: {} });
    store.enqueue(db, { name: 't', payload: {} });
    assert.equal(db.select().from(jobs).all().length, 2);
  });

  test('markCompleted releases the key: a fresh job can be enqueued', async () => {
    const first = store.enqueue(db, { name: 't', payload: {}, uniqueKey: 'k' });
    assert.equal(await store.markCompleted(db, await claim(first)), true);
    const completed = db.select().from(jobs).where(eq(jobs.id, first.id)).get();
    assert.equal(completed?.uniqueKey, null);

    const second = store.enqueue(db, { name: 't', payload: {}, uniqueKey: 'k' });
    assert.notEqual(second.id, first.id);
    assert.equal(db.select().from(jobs).all().length, 2);
  });

  test('markFailed releases the key too', async () => {
    const first = store.enqueue(db, { name: 't', payload: {}, uniqueKey: 'k' });
    assert.equal(await store.markFailed(db, await claim(first), 'dead'), true);
    const failed = db.select().from(jobs).where(eq(jobs.id, first.id)).get();
    assert.equal(failed?.uniqueKey, null);

    const second = store.enqueue(db, { name: 't', payload: {}, uniqueKey: 'k' });
    assert.notEqual(second.id, first.id);
  });

  test('retry keeps the key claimed (the job is still active)', async () => {
    const row = store.enqueue(db, { name: 't', payload: {}, uniqueKey: 'k' });
    assert.equal(await store.retry(db, await claim(row), 5_000, 'flaky'), true);
    const retried = db.select().from(jobs).where(eq(jobs.id, row.id)).get();
    assert.equal(retried?.uniqueKey, 'k');
    // Dedup still applies while the retry is pending.
    assert.equal(store.enqueue(db, { name: 't', payload: {}, uniqueKey: 'k' }).id, row.id);
  });

  test('a unique violation without a uniqueKey on the input is rethrown', () => {
    // Reachable only through another unique constraint (e.g. a hand-added one),
    // simulated here with a stub db whose insert throws the sqlite unique code.
    const failingDb = {
      insert: () => ({
        values: () => ({
          returning: () => ({
            get: () => {
              throw Object.assign(new Error('unique'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
            },
          }),
        }),
      }),
    };
    assert.throws(() => store.enqueue(failingDb, { name: 't', payload: {} }), /unique/);
  });

  test('a vanished duplicate (key released mid-race) rethrows the original error', () => {
    // The insert hits the unique index, but by the time the dedup read runs the
    // active owner has completed (key cleared) — the store rethrows.
    const failingDb = {
      insert: () => ({
        values: () => ({
          returning: () => ({
            get: () => {
              throw Object.assign(new Error('race'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
            },
          }),
        }),
      }),
      select: () => ({ from: () => ({ where: () => ({ get: () => undefined }) }) }),
    };
    assert.throws(
      () => store.enqueue(failingDb, { name: 't', payload: {}, uniqueKey: 'k' }),
      /race/,
    );
  });

  test('a non-unique INSERT error is rethrown (not treated as a duplicate)', () => {
    const failingDb = {
      insert: () => ({
        values: () => ({
          returning: () => ({
            get: () => {
              throw new Error('disk full');
            },
          }),
        }),
      }),
    };
    assert.throws(
      () => store.enqueue(failingDb, { name: 't', payload: {}, uniqueKey: 'k' }),
      /disk full/,
    );
  });
});

describe('SqliteJobStore claimBatch', () => {
  test('claims due pending jobs and marks them processing', async () => {
    store.enqueue(db, { name: 't', payload: {} });
    store.enqueue(db, { name: 't', payload: {}, runAt: new Date(Date.now() + 60_000) });
    const claimed = await store.claimBatch(db, cfg);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.status, 'processing');
    assert.equal(claimed[0]?.claimedBy, cfg.workerInstanceId);
    assert.ok(claimed[0]?.claimedAt);
  });

  test('returns empty when nothing is due', async () => {
    store.enqueue(db, { name: 't', payload: {}, runAt: new Date(Date.now() + 60_000) });
    assert.deepEqual(await store.claimBatch(db, cfg), []);
  });

  test('orders by priority DESC, then availableAt ASC', async () => {
    const now = Date.now();
    const oldLow = store.enqueue(db, {
      name: 'low-old', payload: {}, priority: 0, runAt: new Date(now - 3_000),
    });
    const newLow = store.enqueue(db, {
      name: 'low-new', payload: {}, priority: 0, runAt: new Date(now - 1_000),
    });
    const high = store.enqueue(db, {
      name: 'high', payload: {}, priority: 5, runAt: new Date(now - 2_000),
    });
    const claimed = await store.claimBatch(db, cfg);
    assert.deepEqual(
      claimed.map((j) => j.id),
      [high.id, oldLow.id, newLow.id],
    );
  });

  test('respects batchSize (highest-priority jobs win the batch)', async () => {
    store.enqueue(db, { name: 'a', payload: {}, priority: 1 });
    store.enqueue(db, { name: 'b', payload: {}, priority: 3 });
    store.enqueue(db, { name: 'c', payload: {}, priority: 2 });
    const claimed = await store.claimBatch(db, { ...cfg, batchSize: 2 });
    assert.deepEqual(
      claimed.map((j) => j.name),
      ['b', 'c'],
    );
  });

  test('reclaims a stuck processing job past the timeout', async () => {
    const row = store.enqueue(db, { name: 't', payload: {} });
    const stale = new Date(Date.now() - 10_000).toISOString();
    db.update(jobs)
      .set({ status: 'processing', claimedAt: stale, claimedBy: 'dead-worker' })
      .where(eq(jobs.id, row.id))
      .run();
    const claimed = await store.claimBatch(db, cfg);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.claimedBy, cfg.workerInstanceId);
  });

  test('leaves fresh processing jobs alone (not yet stuck)', async () => {
    const row = store.enqueue(db, { name: 't', payload: {} });
    db.update(jobs)
      .set({ status: 'processing', claimedAt: new Date().toISOString(), claimedBy: 'live' })
      .where(eq(jobs.id, row.id))
      .run();
    assert.deepEqual(await store.claimBatch(db, cfg), []);
  });
});

describe('SqliteJobStore transitions', () => {
  test('markCompleted, retry, markFailed transition the row', async () => {
    const done = store.enqueue(db, { name: 'done', payload: {} });
    assert.equal(await store.markCompleted(db, await claim(done)), true);
    let after = db.select().from(jobs).where(eq(jobs.id, done.id)).get();
    assert.equal(after?.status, 'completed');
    assert.ok(after?.processedAt);

    const row = store.enqueue(db, { name: 't', payload: {} });
    assert.equal(await store.retry(db, await claim(row), 0, 'boom'), true);
    after = db.select().from(jobs).where(eq(jobs.id, row.id)).get();
    assert.equal(after?.status, 'pending');
    assert.equal(after?.attempts, 1);
    assert.equal(after?.lastError, 'boom');
    assert.equal(after?.claimedAt, null);
    assert.equal(after?.claimedBy, null);

    assert.equal(await store.retry(db, await claim(row), 0), true);
    after = db.select().from(jobs).where(eq(jobs.id, row.id)).get();
    assert.equal(after?.attempts, 2);
    assert.equal(after?.lastError, null);

    assert.equal(await store.markFailed(db, await claim(row), 'dead'), true);
    after = db.select().from(jobs).where(eq(jobs.id, row.id)).get();
    assert.equal(after?.status, 'failed');
    assert.equal(after?.lastError, 'dead');
    assert.equal(after?.attempts, 3);
  });

  test('retry re-arms availableAt into the future', async () => {
    const row = store.enqueue(db, { name: 't', payload: {} });
    const held = await claim(row);
    const before = Date.now();
    await store.retry(db, held, 30_000);
    const after = db.select().from(jobs).where(eq(jobs.id, row.id)).get();
    assert.ok(new Date(after!.availableAt).getTime() >= before + 30_000);
    // Not due → not claimable.
    assert.deepEqual(await store.claimBatch(db, cfg), []);
  });
});

describe('SqliteJobStore fenced transitions', () => {
  test('release hands a held job back pending and unclaimed, attempts untouched', async () => {
    const row = store.enqueue(db, { name: 't', payload: {}, uniqueKey: 'k' });
    const held = await claim(row);
    assert.equal(await store.release(db, held), true);
    const after = db.select().from(jobs).where(eq(jobs.id, row.id)).get();
    assert.equal(after?.status, 'pending');
    assert.equal(after?.claimedBy, null);
    assert.equal(after?.claimedAt, null);
    assert.equal(after?.attempts, 0);
    assert.equal(after?.availableAt, row.availableAt);
    assert.equal(after?.uniqueKey, 'k');
    assert.equal(await store.release(db, held), false);
  });

  test('a worker whose stuck claim was taken over cannot move the job', async () => {
    const row = store.enqueue(db, { name: 't', payload: {}, uniqueKey: 'k' });
    const mine = stall(await claim(row, 'worker-A'));
    const theirs = await claim(row, 'worker-B');
    assert.equal(await store.release(db, mine), false);
    assert.equal(await store.markCompleted(db, mine), false);
    assert.equal(await store.retry(db, mine, 0, 'late'), false);
    assert.equal(await store.markFailed(db, mine, 'late'), false);
    const owned = db.select().from(jobs).where(eq(jobs.id, row.id)).get();
    assert.equal(owned?.status, 'processing');
    assert.equal(owned?.claimedBy, 'worker-B');
    assert.equal(owned?.attempts, 0);
    assert.equal(owned?.uniqueKey, 'k');
    assert.equal(await store.markCompleted(db, theirs), true);
  });

  test('a later claim under the same workerInstanceId fences out the earlier one', async () => {
    const row = store.enqueue(db, { name: 't', payload: {} });
    const first = stall(await claim(row));
    const second = await claim(row);
    assert.equal(second.claimedBy, first.claimedBy);
    assert.notEqual(second.claimedAt, first.claimedAt);
    assert.equal(await store.markCompleted(db, first), false);
    assert.equal(await store.markCompleted(db, second), true);
  });

  test('a job that is no longer processing matches no claim', async () => {
    const row = store.enqueue(db, { name: 't', payload: {} });
    const held = await claim(row);
    assert.equal(await store.markCompleted(db, held), true);
    assert.equal(await store.markCompleted(db, held), false);
    assert.equal(await store.retry(db, held, 0), false);
    assert.equal(db.select().from(jobs).where(eq(jobs.id, row.id)).get()?.status, 'completed');
  });
});

describe('isSqliteUniqueViolation', () => {
  test('matches the unique code (direct or wrapped in cause), rejects others', () => {
    assert.equal(isSqliteUniqueViolation({ code: 'SQLITE_CONSTRAINT_UNIQUE' }), true);
    assert.equal(
      isSqliteUniqueViolation({ cause: { code: 'SQLITE_CONSTRAINT_UNIQUE' } }),
      true,
    );
    assert.equal(isSqliteUniqueViolation({ code: 'SQLITE_BUSY' }), false);
    assert.equal(isSqliteUniqueViolation(new Error('x')), false);
    assert.equal(isSqliteUniqueViolation(null), false);
    assert.equal(isSqliteUniqueViolation('nope'), false);
  });
});
