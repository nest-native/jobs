import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { DEFAULT_RUNNER_CONFIG } from '../../jobs-claimer.service';
import {
  jobs as mysqlJobs,
  jobSchedules as mysqlJobSchedules,
  MysqlJobStore,
  MysqlScheduleStore,
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
  'DROP TABLE IF EXISTS job_schedules',
  `CREATE TABLE job_schedules (
     id VARCHAR(191) PRIMARY KEY, name VARCHAR(191) NOT NULL, job_name VARCHAR(255) NOT NULL,
     payload JSON NOT NULL, cron VARCHAR(255) NOT NULL, timezone VARCHAR(64),
     enabled BOOLEAN NOT NULL DEFAULT true, next_run_at VARCHAR(32), max_attempts INT,
     priority INT, unique_key VARCHAR(191), last_enqueued_at VARCHAR(32), last_error TEXT,
     created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL,
     UNIQUE KEY job_schedules_name_unique (name),
     KEY job_schedules_enabled_next_run_idx (enabled, next_run_at))`,
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

  test('schedules: upsert -> claim (CAS + occurrence insert) -> overlap no-op, on real MySQL', async () => {
    const schedules = new MysqlScheduleStore();
    const past = '2020-01-01T00:00:00.000Z';
    const future = '2999-01-01T00:00:00.000Z';

    const created = await schedules.upsert(db, {
      name: 'nightly-report',
      jobName: 'report.scheduled',
      payload: { kind: 'daily' },
      cron: '0 3 * * *',
      timezone: null,
      enabled: true,
      nextRunAt: past,
      maxAttempts: null,
      priority: null,
      uniqueKey: 'nightly',
    });
    assert.equal(created.enabled, true);
    assert.deepEqual(created.payload, { kind: 'daily' });

    // Winning claim: CAS advances the row and the occurrence lands, atomically.
    const won = await schedules.claimAndEnqueue(db, {
      id: created.id,
      expectedNextRunAt: past,
      nextRunAt: future,
      nowIso: new Date().toISOString(),
      input: { name: 'report.scheduled', payload: { kind: 'daily' }, uniqueKey: 'nightly' },
    });
    assert.equal(won.claimed, true);
    assert.equal(won.job?.name, 'report.scheduled');
    const [advanced] = await db
      .select()
      .from(mysqlJobSchedules)
      .where(eq(mysqlJobSchedules.name, 'nightly-report'));
    assert.equal(advanced.nextRunAt, future);
    assert.equal(advanced.enabled, true);

    // A stale CAS (someone else already advanced it) writes nothing.
    const lost = await schedules.claimAndEnqueue(db, {
      id: created.id,
      expectedNextRunAt: past,
      nextRunAt: '3000-01-01T00:00:00.000Z',
      nowIso: new Date().toISOString(),
      input: { name: 'report.scheduled', payload: {} },
    });
    assert.deepEqual(lost, { claimed: false, job: null });

    // Overlap guard on real MySQL: the previous occurrence is still active
    // (pending), so ON DUPLICATE KEY no-ops the insert — claimed, job null.
    const suppressed = await schedules.claimAndEnqueue(db, {
      id: created.id,
      expectedNextRunAt: future,
      nextRunAt: '3000-01-01T00:00:00.000Z',
      nowIso: new Date().toISOString(),
      input: { name: 'report.scheduled', payload: {}, uniqueKey: 'nightly' },
    });
    assert.equal(suppressed.claimed, true);
    assert.equal(suppressed.job, null);
    const occurrences = await db
      .select()
      .from(mysqlJobs)
      .where(eq(mysqlJobs.name, 'report.scheduled'));
    assert.equal(occurrences.length, 1);
  });
});
