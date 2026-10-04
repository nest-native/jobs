import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { before, beforeEach, describe, test } from 'node:test';
import { Logger } from '@nestjs/common';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { DEFAULT_RUNNER_CONFIG } from '../jobs-claimer.service';
import type { ScheduleClaim } from '../interfaces';
import { jobSchedules, PostgresJobStore, PostgresScheduleStore } from '../dialects/postgres';

// The claims' transactions, as the Postgres stores run them: READ COMMITTED
// whatever the server default, and, on a node-postgres Pool, on a client the
// store checks out itself (see dialects/postgres/transaction.ts).
const DDL = `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, payload JSONB NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 10,
  unique_key TEXT, priority INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL,
  claimed_at TEXT, claimed_by TEXT, processed_at TEXT, last_error TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX jobs_name_unique_key_unique ON jobs (name, unique_key);
CREATE INDEX jobs_status_available_idx ON jobs (status, available_at);
CREATE TABLE job_schedules (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, job_name TEXT NOT NULL, payload JSONB NOT NULL,
  cron TEXT NOT NULL, timezone TEXT, enabled BOOLEAN NOT NULL DEFAULT true, next_run_at TEXT,
  max_attempts INTEGER, priority INTEGER, unique_key TEXT, last_enqueued_at TEXT,
  last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX job_schedules_name_unique ON job_schedules (name);
`;

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

let pglite: PGlite;
let db: PgliteDatabase<Record<string, never>>;
const cfg = { ...DEFAULT_RUNNER_CONFIG, batchSize: 10, stuckTimeoutMs: 1_000 };
const jobStore = new PostgresJobStore();
const scheduleStore = new PostgresScheduleStore();

before(() => {
  assert.ok(PGlite, 'pglite must be installed for the postgres store suite');
});

beforeEach(async () => {
  pglite = new PGlite();
  db = drizzle(pglite);
  for (const stmt of DDL.split(';')) {
    const trimmed = stmt.trim();
    if (trimmed) await db.execute(trimmed);
  }
});

/**
 * A node-postgres Pool as the stores see it (`connect()` and `totalCount`),
 * whose one client runs every statement on the in-process PGlite and records
 * the statements and how it was released. `failOn` makes a statement fail.
 */
function pglitePool() {
  const statements: string[] = [];
  const releases: (Error | undefined)[] = [];
  let failing: (text: string) => Error | undefined = () => undefined;
  const client = Object.assign(new EventEmitter(), {
    async query(config: string | { text: string; rowMode?: 'array' }, values?: unknown[]) {
      const text = typeof config === 'string' ? config : config.text;
      statements.push(text);
      const failure = failing(text);
      if (failure) throw failure;
      const rowMode = typeof config === 'string' ? undefined : config.rowMode;
      const result = await pglite.query(text, values, { rowMode: rowMode ?? 'object' });
      return { rows: result.rows, rowCount: result.affectedRows ?? 0, fields: result.fields };
    },
    release(error?: Error) {
      releases.push(error);
    },
  });
  const pool = { totalCount: 1, connect: () => Promise.resolve(client) };
  return {
    db: drizzleNodePg(pool as never),
    pool,
    client,
    statements,
    releases,
    transactionStatements: () => statements.filter((t) => /^(begin|commit|rollback)\b/.test(t)),
    failOn(predicate: (text: string) => Error | undefined) {
      failing = predicate;
    },
  };
}

const enqueue = () => jobStore.enqueue(db, { name: 'report.build', payload: {} });

async function dueSchedule(): Promise<ScheduleClaim> {
  const nowIso = new Date().toISOString();
  await db.insert(jobSchedules).values({
    id: 'schedule-1',
    name: 'nightly',
    jobName: 'report.build',
    payload: {},
    cron: '0 3 * * *',
    enabled: true,
    nextRunAt: PAST,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  return {
    id: 'schedule-1',
    expectedNextRunAt: PAST,
    nextRunAt: FUTURE,
    nowIso,
    input: { name: 'report.build', payload: {} },
  };
}

describe('Postgres claims', () => {
  test('the job claim locks its candidates with FOR UPDATE SKIP LOCKED', async () => {
    // Two workers claiming at once must split the backlog instead of both
    // taking, and running, the same jobs.
    const logged: string[] = [];
    const loggedDb = drizzle(pglite, { logger: { logQuery: (query: string) => logged.push(query) } });
    await enqueue();
    assert.equal((await jobStore.claimBatch(loggedDb, cfg)).length, 1);
    assert.ok(logged.some((q) => q.includes('for update skip locked')), logged.join('\n'));
  });

  test('each claim runs in its own READ COMMITTED transaction whatever the database default', async () => {
    // Neither a missing client, a null one, nor a single node-postgres Client
    // (connect() but no pool counters) is a pool the stores manage themselves.
    const configs: unknown[] = [];
    const recording = ($client?: unknown) => ({
      $client,
      transaction: (...args: Parameters<typeof db.transaction>) => {
        configs.push(args[1]);
        return db.transaction(...args);
      },
    });
    await enqueue();
    assert.equal((await jobStore.claimBatch(recording(), cfg)).length, 1);
    assert.equal((await scheduleStore.claimAndEnqueue(recording(null), await dueSchedule())).claimed, true);
    // The schedule claim's occurrence job is due at once.
    assert.equal((await jobStore.claimBatch(recording({ connect: () => undefined }), cfg)).length, 1);
    assert.deepEqual(configs, Array(3).fill({ isolationLevel: 'read committed' }));
  });

  test('on a node-postgres pool, both claims run on a client the store checks out itself', async () => {
    // drizzle's transaction() leaves the checked-out client without an `error`
    // listener and sends BEGIN outside its cleanup.
    const pg = pglitePool();
    const job = await enqueue();
    const [claimed] = await jobStore.claimBatch(pg.db, cfg);
    assert.equal(claimed?.id, job.id);
    const result = await scheduleStore.claimAndEnqueue(pg.db, await dueSchedule());
    assert.equal(result.claimed, true);
    assert.equal(result.job?.name, 'report.build');
    assert.deepEqual(pg.transactionStatements(), [
      'begin isolation level read committed',
      'commit',
      'begin isolation level read committed',
      'commit',
    ]);
    assert.deepEqual(pg.releases, [undefined, undefined]);
    assert.equal(pg.client.listenerCount('error'), 0);
  });

  test('on a node-postgres pool, a failed statement rolls back and the client goes back for reuse', async () => {
    const pg = pglitePool();
    await enqueue();
    const failure = new Error('statement failed');
    pg.failOn((text) => (text.startsWith('update') ? failure : undefined));
    // drizzle reports a failed statement as "Failed query: …", with the error as its cause.
    await assert.rejects(
      jobStore.claimBatch(pg.db, cfg),
      (error: Error & { cause?: unknown }) => error.cause === failure,
    );
    assert.deepEqual(pg.transactionStatements(), ['begin isolation level read committed', 'rollback']);
    assert.deepEqual(pg.releases, [undefined]);
  });

  test('on a node-postgres pool, a connection lost mid-transaction rejects and the client is discarded', async () => {
    // The server drops the connection while the transaction is open: the client
    // emits `error` between statements, and every later statement fails. Without
    // a listener that `error` crashes the process.
    const pg = pglitePool();
    await enqueue();
    const lost = new Error('Connection terminated unexpectedly');
    const notQueryable = new Error('Client has encountered a connection error and is not queryable');
    const rollbackFailed = new Error('rollback failed too');
    pg.failOn((text) => {
      if (text.startsWith('update')) {
        pg.client.emit('error', lost);
        return undefined;
      }
      if (text === 'commit') return notQueryable;
      return text === 'rollback' ? rollbackFailed : undefined;
    });
    // The statement's error reaches the caller, not the failed ROLLBACK's.
    await assert.rejects(jobStore.claimBatch(pg.db, cfg), (error) => error === notQueryable);
    // Released with the connection's error, so the pool discards the client.
    assert.deepEqual(pg.releases, [lost]);
    assert.equal(pg.client.listenerCount('error'), 0);
  });

  test('on a node-postgres pool, a BEGIN that fails still returns the client', async () => {
    const pg = pglitePool();
    const reset = new Error('Connection reset');
    const rollbackFailed = new Error('rollback failed too');
    pg.failOn((text) => {
      if (text.startsWith('begin')) return reset;
      return text === 'rollback' ? rollbackFailed : undefined;
    });
    await assert.rejects(scheduleStore.claimAndEnqueue(pg.db, await dueSchedule()), (error) => error === reset);
    // Released with the failed ROLLBACK's error: the connection is unusable.
    assert.deepEqual(pg.releases, [rollbackFailed]);
  });

  test("on a node-postgres pool, the claims go through the application's drizzle logger", async () => {
    const pg = pglitePool();
    const logged: string[] = [];
    const loggedDb = drizzleNodePg(pg.pool as never, { logger: { logQuery: (query: string) => logged.push(query) } });
    await enqueue();
    assert.equal((await jobStore.claimBatch(loggedDb, cfg)).length, 1);
    assert.ok(logged.some((q) => q.includes('for update skip locked')), logged.join('\n'));
  });

  test('on a node-postgres pool, a handle without drizzle internals still works', async () => {
    // Only `$client` is read off the handle; the logger is a convenience.
    const pg = pglitePool();
    const job = await enqueue();
    const [claimed] = await jobStore.claimBatch({ $client: pg.pool }, cfg);
    assert.equal(claimed?.id, job.id);
  });

  test("on a node-postgres pool without an 'error' listener, the stores warn once", async () => {
    // node-postgres reports a connection an idle client loses as the pool's
    // `error` event, which crashes the process when nothing listens.
    const warns: string[] = [];
    Logger.overrideLogger({
      log: () => {},
      error: () => {},
      warn: (message: unknown) => warns.push(String(message)),
      debug: () => {},
      verbose: () => {},
    });
    try {
      const unguarded = Object.assign(new EventEmitter(), pglitePool().pool);
      const guarded = Object.assign(new EventEmitter(), pglitePool().pool).on('error', () => undefined);
      for (const pool of [unguarded, unguarded, guarded]) {
        const job = await enqueue();
        const [claimed] = await jobStore.claimBatch(drizzleNodePg(pool as never), cfg);
        assert.equal(claimed?.id, job.id);
      }
    } finally {
      Logger.overrideLogger(false);
    }
    assert.equal(warns.length, 1, warns.join('\n'));
    assert.match(warns[0] ?? '', /no 'error' listener/);
  });
});
