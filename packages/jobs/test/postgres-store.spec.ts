import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { before, beforeEach, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { DEFAULT_RUNNER_CONFIG } from '../jobs-claimer.service';
import { isPgUniqueViolation, jobs, PostgresJobStore } from '../dialects/postgres';

// The store casts `db as NodePgDatabase` at runtime; pglite's PgliteDatabase
// runs the same pg-core SQL in-process, so it exercises the real Postgres paths
// (jsonb, 23505 unique violations, async transactions) without a service.
const DDL = `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, payload JSONB NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 10,
  unique_key TEXT, priority INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL,
  claimed_at TEXT, claimed_by TEXT, processed_at TEXT, last_error TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX jobs_name_unique_key_unique ON jobs (name, unique_key);
CREATE INDEX jobs_status_available_idx ON jobs (status, available_at);
`;

let db: PgliteDatabase<Record<string, never>>;
const cfg = { ...DEFAULT_RUNNER_CONFIG, batchSize: 10, stuckTimeoutMs: 1_000 };
const store = new PostgresJobStore();

const fetchRow = async (id: string) => {
  const rows = await db.select().from(jobs).where(eq(jobs.id, id));
  return rows[0];
};

before(() => {
  // Surface a clear message if the optional native dep failed to load.
  assert.ok(PGlite, 'pglite must be installed for the postgres store suite');
});

beforeEach(async () => {
  const client = new PGlite();
  db = drizzle(client);
  for (const stmt of DDL.split(';')) {
    const trimmed = stmt.trim();
    if (trimmed) await db.execute(trimmed);
  }
});

describe('PostgresJobStore enqueue', () => {
  test('inserts a pending row (await) and stores a jsonb payload', async () => {
    const row = await store.enqueue(db, {
      name: 'email.send',
      payload: { to: 'a@b.c' },
      uniqueKey: 'k1',
      priority: 2,
    });
    assert.equal(row.status, 'pending');
    assert.deepEqual(row.payload, { to: 'a@b.c' });
    assert.equal(row.uniqueKey, 'k1');
    assert.equal(row.priority, 2);
    assert.equal(row.maxAttempts, 10);
  });

  test('defaults: null uniqueKey, priority 0, maxAttempts override', async () => {
    const row = await store.enqueue(db, { name: 't', payload: {}, maxAttempts: 2 });
    assert.equal(row.uniqueKey, null);
    assert.equal(row.priority, 0);
    assert.equal(row.maxAttempts, 2);
  });

  test('honours runAt and delayMs; both → rejects', async () => {
    const at = new Date(Date.now() + 60_000);
    const scheduled = await store.enqueue(db, { name: 't', payload: {}, runAt: at });
    assert.equal(scheduled.availableAt, at.toISOString());

    const before = Date.now();
    const delayed = await store.enqueue(db, { name: 't', payload: {}, delayMs: 30_000 });
    assert.ok(new Date(delayed.availableAt).getTime() >= before + 30_000);

    await assert.rejects(
      () => store.enqueue(db, { name: 't', payload: {}, runAt: at, delayMs: 5 }),
      /mutually exclusive/,
    );
  });
});

describe('PostgresJobStore uniqueKey contract (real 23505)', () => {
  test('duplicate (name, uniqueKey) enqueue returns the EXISTING row', async () => {
    const first = await store.enqueue(db, { name: 't', payload: { n: 1 }, uniqueKey: 'k' });
    const second = await store.enqueue(db, { name: 't', payload: { n: 2 }, uniqueKey: 'k' });
    assert.equal(second.id, first.id);
    assert.deepEqual(second.payload, { n: 1 });
    assert.equal((await db.select().from(jobs)).length, 1);
  });

  test('the same uniqueKey under a different name does not collide', async () => {
    const a = await store.enqueue(db, { name: 'a', payload: {}, uniqueKey: 'k' });
    const b = await store.enqueue(db, { name: 'b', payload: {}, uniqueKey: 'k' });
    assert.notEqual(a.id, b.id);
  });

  test('multiple NULL uniqueKeys never collide', async () => {
    await store.enqueue(db, { name: 't', payload: {} });
    await store.enqueue(db, { name: 't', payload: {} });
    assert.equal((await db.select().from(jobs)).length, 2);
  });

  test('terminal transitions release the key; retry keeps it', async () => {
    const first = await store.enqueue(db, { name: 't', payload: {}, uniqueKey: 'k' });
    await store.retry(db, first.id, 5_000, 'flaky');
    assert.equal((await fetchRow(first.id))?.uniqueKey, 'k');
    // Dedup still applies while the retry is pending.
    assert.equal((await store.enqueue(db, { name: 't', payload: {}, uniqueKey: 'k' })).id, first.id);

    await store.markCompleted(db, first.id);
    assert.equal((await fetchRow(first.id))?.uniqueKey, null);
    const second = await store.enqueue(db, { name: 't', payload: {}, uniqueKey: 'k' });
    assert.notEqual(second.id, first.id);

    await store.markFailed(db, second.id, 'dead');
    assert.equal((await fetchRow(second.id))?.uniqueKey, null);
    const third = await store.enqueue(db, { name: 't', payload: {}, uniqueKey: 'k' });
    assert.notEqual(third.id, second.id);
  });

  test('a unique violation without a uniqueKey on the input is rethrown', async () => {
    const failingDb = {
      insert: () => ({
        values: () => ({ returning: () => Promise.reject({ code: '23505' }) }),
      }),
    };
    await assert.rejects(
      () => store.enqueue(failingDb, { name: 't', payload: {} }),
      (error: unknown) => (error as { code?: string }).code === '23505',
    );
  });

  test('a vanished duplicate (key released mid-race) rethrows the original error', async () => {
    const failingDb = {
      insert: () => ({
        values: () => ({ returning: () => Promise.reject({ code: '23505' }) }),
      }),
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    };
    await assert.rejects(
      () => store.enqueue(failingDb, { name: 't', payload: {}, uniqueKey: 'k' }),
      (error: unknown) => (error as { code?: string }).code === '23505',
    );
  });

  test('a non-unique INSERT error is rethrown (not treated as a duplicate)', async () => {
    const failingDb = {
      insert: () => ({
        values: () => ({ returning: () => Promise.reject(new Error('connection lost')) }),
      }),
    };
    await assert.rejects(
      () => store.enqueue(failingDb, { name: 't', payload: {}, uniqueKey: 'k' }),
      /connection lost/,
    );
  });
});

describe('PostgresJobStore claimBatch', () => {
  test('claims due jobs; empty when none due; reclaims stuck', async () => {
    await store.enqueue(db, { name: 't', payload: {} });
    const claimed = await store.claimBatch(db, cfg);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.status, 'processing');
    assert.equal(claimed[0]?.claimedBy, cfg.workerInstanceId);

    assert.deepEqual(await store.claimBatch(db, cfg), []);

    const stale = new Date(Date.now() - 10_000).toISOString();
    await db
      .update(jobs)
      .set({ status: 'processing', claimedAt: stale, claimedBy: 'dead-worker' })
      .where(eq(jobs.id, claimed[0]!.id));
    const reclaimed = await store.claimBatch(db, cfg);
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0]?.claimedBy, cfg.workerInstanceId);
  });

  test('orders by priority DESC, then availableAt ASC; respects batchSize', async () => {
    const now = Date.now();
    const oldLow = await store.enqueue(db, {
      name: 'low-old', payload: {}, priority: 0, runAt: new Date(now - 3_000),
    });
    const newLow = await store.enqueue(db, {
      name: 'low-new', payload: {}, priority: 0, runAt: new Date(now - 1_000),
    });
    const high = await store.enqueue(db, {
      name: 'high', payload: {}, priority: 5, runAt: new Date(now - 2_000),
    });

    const firstTwo = await store.claimBatch(db, { ...cfg, batchSize: 2 });
    assert.deepEqual(
      firstTwo.map((j) => j.id),
      [high.id, oldLow.id],
    );
    const rest = await store.claimBatch(db, cfg);
    assert.deepEqual(
      rest.map((j) => j.id),
      [newLow.id],
    );
  });

  test('a future-scheduled job is not claimable', async () => {
    await store.enqueue(db, { name: 't', payload: {}, delayMs: 60_000 });
    assert.deepEqual(await store.claimBatch(db, cfg), []);
  });
});

describe('PostgresJobStore transitions', () => {
  test('markCompleted / retry / markFailed transition the row', async () => {
    const row = await store.enqueue(db, { name: 't', payload: {} });
    await store.markCompleted(db, row.id);
    let after = await fetchRow(row.id);
    assert.equal(after?.status, 'completed');
    assert.ok(after?.processedAt);

    await store.retry(db, row.id, 5_000, 'boom');
    after = await fetchRow(row.id);
    assert.equal(after?.status, 'pending');
    assert.equal(after?.attempts, 1);
    assert.equal(after?.lastError, 'boom');
    assert.equal(after?.claimedAt, null);

    await store.retry(db, row.id, 1_000);
    after = await fetchRow(row.id);
    assert.equal(after?.attempts, 2);
    assert.equal(after?.lastError, null);

    await store.markFailed(db, row.id, 'dead');
    after = await fetchRow(row.id);
    assert.equal(after?.status, 'failed');
    assert.equal(after?.attempts, 3);
    assert.equal(after?.lastError, 'dead');
  });
});

describe('isPgUniqueViolation', () => {
  test('matches 23505 (direct or wrapped in cause), rejects others', () => {
    assert.equal(isPgUniqueViolation({ code: '23505' }), true);
    assert.equal(isPgUniqueViolation({ cause: { code: '23505' } }), true);
    assert.equal(isPgUniqueViolation({ code: '23503' }), false);
    assert.equal(isPgUniqueViolation(new Error('x')), false);
    assert.equal(isPgUniqueViolation(null), false);
    assert.equal(isPgUniqueViolation(42), false);
  });
});
