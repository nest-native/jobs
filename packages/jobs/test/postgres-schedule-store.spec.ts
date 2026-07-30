import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { JobSchedulesService } from '../job-schedules.service';
import {
  jobs,
  jobSchedules,
  PostgresJobStore,
  PostgresScheduleStore,
} from '../dialects/postgres';

// Same rationale as postgres-store.spec.ts: pglite runs the real pg-core SQL
// in-process (jsonb, ON CONFLICT arbiter inference, async transactions), so
// the store's actual Postgres paths are exercised without a service.
const DDL = `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, payload JSONB NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 10,
  unique_key TEXT, priority INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL,
  claimed_at TEXT, claimed_by TEXT, processed_at TEXT, last_error TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX jobs_name_unique_key_unique ON jobs (name, unique_key);
CREATE TABLE job_schedules (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, job_name TEXT NOT NULL, payload JSONB NOT NULL,
  cron TEXT NOT NULL, timezone TEXT, enabled BOOLEAN NOT NULL DEFAULT true, next_run_at TEXT,
  max_attempts INTEGER, priority INTEGER, unique_key TEXT, last_enqueued_at TEXT,
  last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX job_schedules_name_unique ON job_schedules (name);
CREATE INDEX job_schedules_enabled_next_run_idx ON job_schedules (enabled, next_run_at);
`;

type Db = PgliteDatabase<Record<string, never>>;

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

let db: Db;
const store = new PostgresScheduleStore();
const jobStore = new PostgresJobStore();
const service = () => new JobSchedulesService(db, store);

beforeEach(async () => {
  const pglite = new PGlite();
  await pglite.exec(DDL);
  db = drizzle(pglite);
});

const rewind = (name: string, to = PAST) =>
  db.update(jobSchedules).set({ nextRunAt: to }).where(eq(jobSchedules.name, name));

const scheduleByName = async (name: string) =>
  (await db.select().from(jobSchedules).where(eq(jobSchedules.name, name)))[0];

const jobsNamed = (name: string) =>
  db.select().from(jobs).where(eq(jobs.name, name));

describe('PostgresScheduleStore CRUD', () => {
  test('upsert inserts, then updates in place preserving id/createdAt', async () => {
    const first = await service().upsert({ name: 's', jobName: 'a', cron: '0 3 * * *' });
    assert.ok(first.id.length > 0);
    assert.equal(first.enabled, true);
    assert.deepEqual(first.payload, {});
    assert.equal(first.lastError, null);

    await db
      .update(jobSchedules)
      .set({ lastError: 'stale', lastEnqueuedAt: PAST })
      .where(eq(jobSchedules.name, 's'));
    const second = await service().upsert({
      name: 's',
      jobName: 'b',
      payload: { n: 1 },
      cron: '30 4 * * *',
      timezone: 'America/Sao_Paulo',
      maxAttempts: 3,
      priority: 7,
      uniqueKey: 'k',
    });
    assert.equal(second.id, first.id);
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(second.jobName, 'b');
    assert.equal(second.timezone, 'America/Sao_Paulo');
    assert.equal(second.lastError, null);
    assert.equal(second.lastEnqueuedAt, PAST);
    assert.equal((await db.select().from(jobSchedules)).length, 1);
  });

  test('get, list ordering, remove true/false', async () => {
    await service().upsert({ name: 'b', jobName: 'x', cron: '0 3 * * *' });
    await service().upsert({ name: 'a', jobName: 'x', cron: '0 3 * * *' });
    assert.equal((await store.get(db, 'a'))?.name, 'a');
    assert.equal(await store.get(db, 'nope'), undefined);
    assert.deepEqual((await store.list(db)).map((s) => s.name), ['a', 'b']);
    assert.equal(await store.remove(db, 'a'), true);
    assert.equal(await store.remove(db, 'a'), false);
  });

  test('setEnabled updates the row; unknown names resolve undefined', async () => {
    await service().upsert({ name: 's', jobName: 'x', cron: '0 3 * * *' });
    const off = await store.setEnabled(db, 's', false, null);
    assert.equal(off?.enabled, false);
    assert.equal(off?.nextRunAt, null);
    const on = await store.setEnabled(db, 's', true, FUTURE);
    assert.equal(on?.enabled, true);
    assert.equal(on?.nextRunAt, FUTURE);
    assert.equal(await store.setEnabled(db, 'nope', true, null), undefined);
  });

  test('listDue filters disabled/dormant/future rows and honours the limit', async () => {
    const svc = service();
    for (const name of ['due-late', 'due-early', 'future', 'disabled', 'dormant']) {
      await svc.upsert({ name, jobName: 'x', cron: '0 3 * * *' });
    }
    await rewind('due-late', '2020-01-02T00:00:00.000Z');
    await rewind('due-early', '2020-01-01T00:00:00.000Z');
    await store.setEnabled(db, 'disabled', false, PAST);
    await db.update(jobSchedules).set({ nextRunAt: null }).where(eq(jobSchedules.name, 'dormant'));

    const due = await store.listDue(db, new Date().toISOString(), 10);
    assert.deepEqual(due.map((s) => s.name), ['due-early', 'due-late']);
    assert.equal((await store.listDue(db, new Date().toISOString(), 1)).length, 1);
  });
});

describe('PostgresScheduleStore claimAndEnqueue', () => {
  test('a winning claim advances the row and inserts the occurrence atomically', async () => {
    await service().upsert({ name: 's', jobName: 'report.build', cron: '0 3 * * *' });
    await rewind('s');
    const row = await scheduleByName('s');

    const result = await store.claimAndEnqueue(db, {
      id: row.id,
      expectedNextRunAt: row.nextRunAt as string,
      nextRunAt: FUTURE,
      nowIso: new Date().toISOString(),
      input: { name: 'report.build', payload: { day: 1 }, maxAttempts: 2, priority: 5 },
    });
    assert.equal(result.claimed, true);
    assert.equal(result.job?.name, 'report.build');
    assert.deepEqual(result.job?.payload, { day: 1 });
    assert.equal(result.job?.maxAttempts, 2);
    assert.equal(result.job?.priority, 5);
    assert.equal(result.job?.uniqueKey, null);

    const after = await scheduleByName('s');
    assert.equal(after.nextRunAt, FUTURE);
    assert.equal(after.enabled, true);
    assert.ok(after.lastEnqueuedAt !== null);
  });

  test('a lost compare-and-swap writes nothing', async () => {
    await service().upsert({ name: 's', jobName: 'j', cron: '0 3 * * *' });
    await rewind('s');
    const row = await scheduleByName('s');

    const result = await store.claimAndEnqueue(db, {
      id: row.id,
      expectedNextRunAt: '1999-01-01T00:00:00.000Z',
      nextRunAt: FUTURE,
      nowIso: new Date().toISOString(),
      input: { name: 'j', payload: {} },
    });
    assert.deepEqual(result, { claimed: false, job: null });
    assert.equal((await jobsNamed('j')).length, 0);
    assert.equal((await scheduleByName('s')).nextRunAt, PAST);
  });

  test('a schedule with no future occurrence disables itself but still fires', async () => {
    await service().upsert({ name: 's', jobName: 'j', cron: '0 3 * * *' });
    await rewind('s');
    const row = await scheduleByName('s');
    const result = await store.claimAndEnqueue(db, {
      id: row.id,
      expectedNextRunAt: row.nextRunAt as string,
      nextRunAt: null,
      nowIso: new Date().toISOString(),
      input: { name: 'j', payload: {} },
    });
    assert.equal(result.claimed, true);
    assert.equal(result.job?.name, 'j');
    const after = await scheduleByName('s');
    assert.equal(after.enabled, false);
    assert.equal(after.nextRunAt, null);
  });

  test('the overlap guard suppresses the insert WITHOUT poisoning the transaction', async () => {
    await jobStore.enqueue(db, { name: 'j', payload: {}, uniqueKey: 'k' });
    await service().upsert({ name: 's', jobName: 'j', cron: '0 3 * * *', uniqueKey: 'k' });
    await rewind('s');
    const row = await scheduleByName('s');

    const result = await store.claimAndEnqueue(db, {
      id: row.id,
      expectedNextRunAt: row.nextRunAt as string,
      nextRunAt: FUTURE,
      nowIso: new Date().toISOString(),
      input: { name: 'j', payload: {}, uniqueKey: 'k' },
    });
    assert.equal(result.claimed, true);
    assert.equal(result.job, null);
    assert.equal((await jobsNamed('j')).length, 1);
    // The CAS committed even though the insert was suppressed — the whole
    // point of ON CONFLICT DO NOTHING on Postgres (no 25P02 poisoned tx).
    assert.equal((await scheduleByName('s')).nextRunAt, FUTURE);
  });

  test('disable records the error', async () => {
    await service().upsert({ name: 's', jobName: 'j', cron: '0 3 * * *' });
    await store.disable(db, (await scheduleByName('s')).id, 'boom');
    const after = await scheduleByName('s');
    assert.equal(after.enabled, false);
    assert.equal(after.lastError, 'boom');
  });
});
