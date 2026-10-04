import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { DEFAULT_RUNNER_CONFIG } from '../../jobs-claimer.service';
import type { ScheduleClaim } from '../../interfaces';
import {
  jobs as pgJobs,
  jobSchedules as pgJobSchedules,
  PostgresJobStore,
  PostgresScheduleStore,
} from '../../dialects/postgres';

// Gated end-to-end test against a REAL Postgres. It skips unless
// JOBS_POSTGRES_URL is set, so `npm test` / `test:cov` stay hermetic and 100%.
// CI runs it in the integration job with a `postgres:17-alpine` service (see
// .github/workflows/ci.yml). PGlite, which the hermetic suite uses, is a single
// connection, so only a real server can show what concurrent claims do.

const POSTGRES_URL = process.env.JOBS_POSTGRES_URL;
const cfg = { ...DEFAULT_RUNNER_CONFIG, batchSize: 50, stuckTimeoutMs: 1_000 };

// The shipped schema, indexes included: the plan decides which rows a
// statement reads and locks.
const PG_DDL = [
  'DROP TABLE IF EXISTS jobs',
  'DROP TABLE IF EXISTS job_schedules',
  `CREATE TABLE jobs (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, payload JSONB NOT NULL, status TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 10,
     unique_key TEXT, priority INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL,
     claimed_at TEXT, claimed_by TEXT, processed_at TEXT, last_error TEXT, created_at TEXT NOT NULL)`,
  'CREATE UNIQUE INDEX jobs_name_unique_key_unique ON jobs (name, unique_key)',
  'CREATE INDEX jobs_status_available_idx ON jobs (status, available_at)',
  `CREATE TABLE job_schedules (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, job_name TEXT NOT NULL, payload JSONB NOT NULL,
     cron TEXT NOT NULL, timezone TEXT, enabled BOOLEAN NOT NULL DEFAULT true, next_run_at TEXT,
     max_attempts INTEGER, priority INTEGER, unique_key TEXT, last_enqueued_at TEXT,
     last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  'CREATE UNIQUE INDEX job_schedules_name_unique ON job_schedules (name)',
  'CREATE INDEX job_schedules_enabled_next_run_idx ON job_schedules (enabled, next_run_at)',
];

const sortedIds = (rows: { id: string }[]): string[] => rows.map((r) => r.id).sort();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `promise`'s value, or 'blocked' when it has not settled within `ms`. */
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'blocked'> {
  let timer: NodeJS.Timeout | undefined;
  const blocked = new Promise<'blocked'>((resolve) => {
    timer = setTimeout(() => resolve('blocked'), ms);
  });
  try {
    return await Promise.race([promise, blocked]);
  } finally {
    clearTimeout(timer);
  }
}

describe('Postgres round-trip (real service)', { skip: !POSTGRES_URL }, () => {
  let pool: import('pg').Pool;
  let db: Awaited<ReturnType<typeof buildPgDb>>;
  const store = new PostgresJobStore();
  const scheduleStore = new PostgresScheduleStore();

  async function buildPgDb(client: unknown) {
    const { drizzle } = await import('drizzle-orm/node-postgres');
    return drizzle(client as never);
  }

  before(async () => {
    const pg = await import('pg');
    pool = new pg.Pool({ connectionString: POSTGRES_URL });
    // node-postgres requires an `error` listener on every pool (the stores warn without one).
    pool.on('error', () => undefined);
    for (const stmt of PG_DDL) await pool.query(stmt);
    db = await buildPgDb(pool);
  });

  after(async () => {
    await pool?.end();
  });

  async function seed(count: number) {
    await pool.query('DELETE FROM jobs');
    const rows: { id: string }[] = [];
    for (let i = 0; i < count; i += 1) {
      rows.push(await store.enqueue(db, { name: 'claims', payload: { i }, runAt: new Date(Date.now() - 1_000) }));
    }
    return rows;
  }

  // Opens two pooled connections up front, so two claims really overlap
  // instead of the second one starting after the first has committed.
  const warm = (target: import('pg').Pool) => Promise.all([target.query('SELECT 1'), target.query('SELECT 1')]);

  async function dueSchedule(): Promise<ScheduleClaim> {
    await pool.query('DELETE FROM job_schedules');
    const nowIso = new Date().toISOString();
    await db.insert(pgJobSchedules).values({
      id: 'schedule-1',
      name: 'nightly',
      jobName: 'report.build',
      payload: {},
      cron: '0 3 * * *',
      enabled: true,
      nextRunAt: '2020-01-01T00:00:00.000Z',
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    return {
      id: 'schedule-1',
      expectedNextRunAt: '2020-01-01T00:00:00.000Z',
      nextRunAt: '2999-01-01T00:00:00.000Z',
      nowIso,
      input: { name: 'report.build', payload: {} },
    };
  }

  test('enqueue -> claim (ordered) -> complete, with a JSONB payload', async () => {
    await pool.query('DELETE FROM jobs');
    const low = await store.enqueue(db, { name: 'report', payload: { pages: 3 }, runAt: new Date(Date.now() - 3_000) });
    const high = await store.enqueue(db, { name: 'email', payload: { to: 'a@b.c' }, priority: 5 });
    const claimed = await store.claimBatch(db, cfg);
    assert.deepEqual(claimed.map((r) => r.id), [high.id, low.id]);
    assert.deepEqual(claimed[1]?.payload, { pages: 3 });
    await store.markCompleted(db, high.id);
    const [done] = await db.select().from(pgJobs).where(eq(pgJobs.id, high.id));
    assert.equal(done?.status, 'completed');
  });

  test('a claim skips jobs another claim holds instead of taking them too', async () => {
    const rows = await seed(10);
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM jobs WHERE id = ANY($1) FOR UPDATE', [rows.slice(0, 5).map((r) => r.id)]);
    const claim = store.claimBatch(db, cfg);
    try {
      const claimed = await settleWithin(claim, 2_000);
      assert.notEqual(claimed, 'blocked', 'the claim waited on jobs another claim holds');
      assert.deepEqual(sortedIds(claimed as { id: string }[]), sortedIds(rows.slice(5)));
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await claim;
    }
  });

  test('two concurrent claimers never claim the same job', async () => {
    for (let round = 0; round < 5; round += 1) {
      await seed(10);
      await warm(pool);
      const [a, b] = await Promise.all([
        store.claimBatch(db, { ...cfg, workerInstanceId: 'worker-A' }),
        store.claimBatch(db, { ...cfg, workerInstanceId: 'worker-B' }),
      ]);
      const ids = [...a, ...b].map((r) => r.id);
      assert.equal(ids.length, 10, `round ${round}: every job claimed`);
      assert.equal(new Set(ids).size, 10, `round ${round}: a job was claimed twice`);
    }
  });

  test('two concurrent claims of one due schedule enqueue its occurrence once', async () => {
    await pool.query('DELETE FROM jobs');
    const claim = await dueSchedule();
    await warm(pool);
    const results = await Promise.all([
      scheduleStore.claimAndEnqueue(db, claim),
      scheduleStore.claimAndEnqueue(db, claim),
    ]);
    assert.deepEqual(results.map((r) => r.claimed).sort(), [false, true]);
    const { rows } = await pool.query("SELECT count(*)::int AS c FROM jobs WHERE name = 'report.build'");
    assert.equal((rows as { c: number }[])[0].c, 1);
  });

  // The backend running `pattern` once it is waiting on a lock.
  async function lockWaiter(pattern: string): Promise<number> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { rows } = await pool.query(
        "SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE $1",
        [pattern],
      );
      if (rows.length > 0) return (rows as { pid: number }[])[0].pid;
      await sleep(20);
    }
    throw new Error(`no backend waiting on a lock for ${pattern}`);
  }

  // A failover or pg_terminate_backend while a claim waits on a lock. drizzle's
  // transaction() left that client without an `error` listener, which crashed
  // the process; the call must reject instead, and the pool must drop the
  // broken client.
  async function survivesConnectionLoss(
    block: (holder: import('pg').PoolClient) => Promise<unknown>,
    run: (target: typeof db) => Promise<unknown>,
    waiting: string,
  ): Promise<void> {
    const pg = await import('pg');
    const doomed = new pg.Pool({ connectionString: POSTGRES_URL });
    doomed.on('error', () => undefined);
    const doomedDb = await buildPgDb(doomed);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await block(holder);
      const pending = run(doomedDb);
      pending.catch(() => undefined);
      const pid = await lockWaiter(waiting);
      await pool.query('SELECT pg_terminate_backend($1)', [pid]);
      await assert.rejects(pending);
      assert.equal(doomed.totalCount, 0, 'the broken client was discarded');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await doomed.end();
    }
  }

  test('a connection lost mid-claim rejects instead of crashing the process', async () => {
    await seed(1);
    await survivesConnectionLoss(
      // The claim's locking scan takes ROW SHARE on the table, which EXCLUSIVE blocks.
      (holder) => holder.query('LOCK TABLE jobs IN EXCLUSIVE MODE'),
      (target) => store.claimBatch(target, cfg),
      'select "id" from "jobs"%',
    );
  });

  test('a connection lost mid-schedule-claim rejects instead of crashing the process', async () => {
    const claim = await dueSchedule();
    await survivesConnectionLoss(
      (holder) => holder.query('SELECT id FROM job_schedules WHERE id = $1 FOR UPDATE', [claim.id]),
      (target) => scheduleStore.claimAndEnqueue(target, claim),
      'update "job_schedules"%',
    );
  });
});
