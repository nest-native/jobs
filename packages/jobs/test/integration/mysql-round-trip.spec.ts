import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { DEFAULT_RUNNER_CONFIG } from '../../jobs-claimer.service';
import {
  jobs as mysqlJobs,
  MysqlJobStore,
} from '../../dialects/mysql';

// Gated end-to-end test against a REAL MySQL. It skips unless JOBS_MYSQL_URL
// is set, so `npm test` / `test:cov` stay hermetic and 100%. CI runs it in a
// dedicated job with a `mysql:8.4` service (see .github/workflows/ci.yml). The
// store is driven directly (no Nest) — a genuine enqueue -> claim -> complete
// round-trip that exercises the real driver: JSON payloads, errno 1062 unique
// violations (the active-dedup contract), ordering, and the async transaction
// in `claimBatch`.

const MYSQL_URL = process.env.JOBS_MYSQL_URL;
const cfg = { ...DEFAULT_RUNNER_CONFIG, batchSize: 50, stuckTimeoutMs: 1_000 };

const MYSQL_DDL = [
  'DROP TABLE IF EXISTS jobs',
  `CREATE TABLE jobs (
     id VARCHAR(191) PRIMARY KEY, name VARCHAR(255) NOT NULL, payload JSON NOT NULL,
     status VARCHAR(32) NOT NULL, attempts INT NOT NULL DEFAULT 0, max_attempts INT NOT NULL DEFAULT 10,
     unique_key VARCHAR(191), priority INT NOT NULL DEFAULT 0, available_at VARCHAR(32) NOT NULL,
     claimed_at VARCHAR(32), claimed_by VARCHAR(191), processed_at VARCHAR(32), last_error TEXT,
     created_at VARCHAR(32) NOT NULL,
     UNIQUE KEY jobs_name_unique_key_unique (name, unique_key),
     KEY jobs_status_available_idx (status, available_at))`,
];

describe('MySQL round-trip (real service)', { skip: !MYSQL_URL }, () => {
  let connection: Awaited<ReturnType<typeof import('mysql2/promise').createConnection>>;
  let db: Awaited<ReturnType<typeof buildMysqlDb>>;
  const store = new MysqlJobStore();

  async function buildMysqlDb(conn: unknown) {
    const { drizzle } = await import('drizzle-orm/mysql2');
    return drizzle(conn as never, { mode: 'default' });
  }

  before(async () => {
    const mysql = await import('mysql2/promise');
    connection = await mysql.createConnection(MYSQL_URL as string);
    for (const stmt of MYSQL_DDL) await connection.query(stmt);
    db = await buildMysqlDb(connection);
  });

  after(async () => {
    await connection?.end();
  });

  test('enqueue -> claim (ordered) -> complete, with JSON payload', async () => {
    const now = Date.now();
    const low = await store.enqueue(db, {
      name: 'report.generate',
      payload: { reportId: 'r-1', pages: 3 },
      priority: 0,
      runAt: new Date(now - 3_000),
    });
    const high = await store.enqueue(db, {
      name: 'email.welcome',
      payload: { email: 'a@b.c' },
      priority: 5,
      runAt: new Date(now - 1_000),
    });
    assert.equal(low.status, 'pending');
    assert.deepEqual(low.payload, { reportId: 'r-1', pages: 3 });

    const claimed = await store.claimBatch(db, cfg);
    assert.deepEqual(
      claimed.map((j) => j.id),
      [high.id, low.id],
      'priority DESC then availableAt ASC',
    );
    assert.ok(claimed.every((j) => j.status === 'processing'));

    await store.markCompleted(db, high.id);
    const [completed] = await db
      .select()
      .from(mysqlJobs)
      .where(eq(mysqlJobs.id, high.id));
    assert.equal(completed.status, 'completed');
    assert.equal(completed.uniqueKey, null);
  });

  test('uniqueKey contract: errno 1062 dedup returns the existing active row; terminal releases', async () => {
    const first = await store.enqueue(db, {
      name: 'email.digest',
      payload: { n: 1 },
      uniqueKey: 'digest:u1',
    });
    // Duplicate while active → dedup no-op returning the SAME row.
    const second = await store.enqueue(db, {
      name: 'email.digest',
      payload: { n: 2 },
      uniqueKey: 'digest:u1',
    });
    assert.equal(second.id, first.id);
    assert.deepEqual(second.payload, { n: 1 });

    // NULL keys never collide; the same key under another name is fine.
    await store.enqueue(db, { name: 'email.digest', payload: {} });
    await store.enqueue(db, { name: 'email.digest', payload: {} });
    const other = await store.enqueue(db, { name: 'other.job', payload: {}, uniqueKey: 'digest:u1' });
    assert.notEqual(other.id, first.id);

    // retry keeps the key claimed…
    await store.retry(db, first.id, 60_000, 'flaky');
    const stillActive = await store.enqueue(db, {
      name: 'email.digest',
      payload: {},
      uniqueKey: 'digest:u1',
    });
    assert.equal(stillActive.id, first.id);

    // …and failing releases it, so a fresh job can claim the key.
    await store.markFailed(db, first.id, 'gave up');
    const [failed] = await db.select().from(mysqlJobs).where(eq(mysqlJobs.id, first.id));
    assert.equal(failed.status, 'failed');
    assert.equal(failed.uniqueKey, null);
    const fresh = await store.enqueue(db, {
      name: 'email.digest',
      payload: {},
      uniqueKey: 'digest:u1',
    });
    assert.notEqual(fresh.id, first.id);
  });

  test('stuck processing jobs are reclaimed past the timeout', async () => {
    const job = await store.enqueue(db, { name: 'stuck.job', payload: {} });
    const stale = new Date(Date.now() - 10_000).toISOString();
    await db
      .update(mysqlJobs)
      .set({ status: 'processing', claimedAt: stale, claimedBy: 'dead-worker' })
      .where(eq(mysqlJobs.id, job.id));

    const claimed = await store.claimBatch(db, cfg);
    const reclaimed = claimed.find((j) => j.id === job.id);
    assert.ok(reclaimed, 'stuck job reclaimed');
    assert.equal(reclaimed?.claimedBy, cfg.workerInstanceId);
  });
});
