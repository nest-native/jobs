import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { InvalidScheduleError, RetryableError } from '../errors';
import type { ScheduleRow, ScheduleStore } from '../interfaces';
import type { JobHandler as JobHandlerContract } from '../job-handler.decorator';
import { JobSchedulesService } from '../job-schedules.service';
import { DEFAULT_RUNNER_CONFIG, JobsClaimer } from '../jobs-claimer.service';
import type { JobsHandlerExplorer } from '../jobs-handler.explorer';
import { assertValidSchedule, nextOccurrence } from '../schedule-planner';
import {
  jobs,
  jobSchedules,
  SqliteJobStore,
  SqliteScheduleStore,
} from '../dialects/sqlite';

const DDL = `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 10,
  unique_key TEXT, priority INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL,
  claimed_at TEXT, claimed_by TEXT, processed_at TEXT, last_error TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX jobs_name_unique_key_unique ON jobs (name, unique_key);
CREATE TABLE job_schedules (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, job_name TEXT NOT NULL, payload TEXT NOT NULL,
  cron TEXT NOT NULL, timezone TEXT, enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT,
  max_attempts INTEGER, priority INTEGER, unique_key TEXT, last_enqueued_at TEXT,
  last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX job_schedules_name_unique ON job_schedules (name);
CREATE INDEX job_schedules_enabled_next_run_idx ON job_schedules (enabled, next_run_at);
`;

type Db = BetterSQLite3Database<Record<string, never>>;

const PAST = '2020-01-01T00:00:00.000Z';
const cfg = { ...DEFAULT_RUNNER_CONFIG, batchSize: 10 };

let db: Db;
const store = new SqliteScheduleStore();
const jobStore = new SqliteJobStore();

beforeEach(() => {
  const sqlite = new Database(':memory:');
  sqlite.exec(DDL);
  db = drizzle(sqlite);
});

/** A service bound to the test db — schedules CRUD without a Nest app. */
const service = () => new JobSchedulesService(db, store);

const rewind = (name: string, to = PAST) =>
  db
    .update(jobSchedules)
    .set({ nextRunAt: to })
    .where(eq(jobSchedules.name, name))
    .run();

const scheduleByName = (name: string) =>
  db.select().from(jobSchedules).where(eq(jobSchedules.name, name)).get()!;

const jobsNamed = (name: string) =>
  db.select().from(jobs).where(eq(jobs.name, name)).all();

describe('schedule planner', () => {
  test('nextOccurrence defaults to UTC and is deterministic', () => {
    const next = nextOccurrence('0 3 * * *', null, new Date('2026-01-01T00:00:00.000Z'));
    assert.equal(next, '2026-01-01T03:00:00.000Z');
  });

  test('nextOccurrence honours an IANA timezone', () => {
    // America/Sao_Paulo is UTC-3 year-round: 03:00 local = 06:00Z.
    const next = nextOccurrence(
      '0 3 * * *',
      'America/Sao_Paulo',
      new Date('2026-01-01T00:00:00.000Z'),
    );
    assert.equal(next, '2026-01-01T06:00:00.000Z');
  });

  test('nextOccurrence is strictly after `after`', () => {
    const at = new Date('2026-01-01T03:00:00.000Z');
    const next = nextOccurrence('0 3 * * *', null, at);
    assert.equal(next, '2026-01-02T03:00:00.000Z');
  });

  test('nextOccurrence is null when the expression never fires again', () => {
    // February 30th never comes.
    assert.equal(nextOccurrence('0 0 30 2 *', null, new Date()), null);
  });

  test('invalid pattern throws InvalidScheduleError (no timezone in message)', () => {
    assert.throws(
      () => assertValidSchedule('not-a-cron'),
      (error: unknown) =>
        error instanceof InvalidScheduleError &&
        error.message.includes('"not-a-cron"') &&
        !error.message.includes('timezone'),
    );
  });

  test('invalid timezone throws InvalidScheduleError naming the timezone', () => {
    assert.throws(
      () => assertValidSchedule('0 0 * * *', 'Not/AZone'),
      (error: unknown) =>
        error instanceof InvalidScheduleError &&
        error.message.includes('timezone "Not/AZone"'),
    );
  });

  test('assertValidSchedule accepts a valid pattern + timezone', () => {
    assertValidSchedule('*/5 * * * *', 'America/Sao_Paulo');
  });
});

describe('SqliteScheduleStore CRUD', () => {
  test('upsert inserts with generated id and clean bookkeeping', () => {
    const row = service().upsert({ name: 'nightly', jobName: 'report.build', cron: '0 3 * * *' });
    assert.ok(row.id.length > 0);
    assert.equal(row.name, 'nightly');
    assert.equal(row.jobName, 'report.build');
    assert.deepEqual(row.payload, {});
    assert.equal(row.timezone, null);
    assert.equal(row.enabled, true);
    assert.ok((row.nextRunAt as string) > new Date(Date.now() - 1000).toISOString());
    assert.equal(row.maxAttempts, null);
    assert.equal(row.priority, null);
    assert.equal(row.uniqueKey, null);
    assert.equal(row.lastEnqueuedAt, null);
    assert.equal(row.lastError, null);
    assert.equal(row.createdAt, row.updatedAt);
  });

  test('upsert by name updates in place, preserving id/createdAt and clearing lastError', () => {
    const first = service().upsert({ name: 's', jobName: 'a', cron: '0 3 * * *' });
    db.update(jobSchedules)
      .set({ lastError: 'stale claim-time error', lastEnqueuedAt: PAST })
      .where(eq(jobSchedules.name, 's'))
      .run();
    const second = service().upsert({
      name: 's',
      jobName: 'b',
      payload: { n: 1 },
      cron: '30 4 * * *',
      timezone: 'America/Sao_Paulo',
      enabled: false,
      maxAttempts: 3,
      priority: 7,
      uniqueKey: 'k',
    });
    assert.equal(second.id, first.id);
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(second.jobName, 'b');
    assert.deepEqual(second.payload, { n: 1 });
    assert.equal(second.timezone, 'America/Sao_Paulo');
    assert.equal(second.enabled, false);
    assert.equal(second.maxAttempts, 3);
    assert.equal(second.priority, 7);
    assert.equal(second.uniqueKey, 'k');
    assert.equal(second.lastError, null);
    // lastEnqueuedAt survives updates — it is claim-time bookkeeping.
    assert.equal(second.lastEnqueuedAt, PAST);
    assert.equal(db.select().from(jobSchedules).all().length, 1);
  });

  test('get resolves the row, or undefined for an unknown name', async () => {
    service().upsert({ name: 's', jobName: 'a', cron: '0 3 * * *' });
    assert.equal((await store.get(db, 's'))?.name, 's');
    assert.equal(await store.get(db, 'nope'), undefined);
  });

  test('list resolves all schedules ordered by name', async () => {
    service().upsert({ name: 'b', jobName: 'x', cron: '0 3 * * *' });
    service().upsert({ name: 'a', jobName: 'x', cron: '0 3 * * *' });
    assert.deepEqual((await service().list()).map((s) => s.name), ['a', 'b']);
  });

  test('remove resolves true when deleted, false for an unknown name', async () => {
    service().upsert({ name: 's', jobName: 'a', cron: '0 3 * * *' });
    assert.equal(await service().remove('s'), true);
    assert.equal(await service().remove('s'), false);
  });

  test('listDue returns only enabled, armed, due rows — oldest first, limited', async () => {
    const svc = service();
    for (const name of ['due-late', 'due-early', 'future', 'disabled', 'dormant']) {
      svc.upsert({ name, jobName: 'x', cron: '0 3 * * *' });
    }
    rewind('due-late', '2020-01-02T00:00:00.000Z');
    rewind('due-early', '2020-01-01T00:00:00.000Z');
    await svc.setEnabled('disabled', false);
    db.update(jobSchedules)
      .set({ nextRunAt: null })
      .where(eq(jobSchedules.name, 'dormant'))
      .run();

    const due = await store.listDue(db, new Date().toISOString(), 10);
    assert.deepEqual(due.map((s) => s.name), ['due-early', 'due-late']);
    const limited = await store.listDue(db, new Date().toISOString(), 1);
    assert.deepEqual(limited.map((s) => s.name), ['due-early']);
  });
});

describe('SqliteScheduleStore claimAndEnqueue', () => {
  const claimNow = (row: ScheduleRow, next: string | null) =>
    store.claimAndEnqueue(db, {
      id: row.id,
      expectedNextRunAt: row.nextRunAt as string,
      nextRunAt: next,
      nowIso: new Date().toISOString(),
      input: { name: row.jobName, payload: row.payload },
    });

  test('a winning claim advances the schedule and inserts the due occurrence', async () => {
    service().upsert({ name: 's', jobName: 'report.build', payload: {}, cron: '0 3 * * *' });
    rewind('s');
    const row = scheduleByName('s');
    const future = '2999-01-01T00:00:00.000Z';

    const result = await claimNow(row, future);
    assert.equal(result.claimed, true);
    assert.equal(result.job?.name, 'report.build');
    assert.equal(result.job?.status, 'pending');
    assert.equal(result.job?.maxAttempts, 10);
    assert.equal(result.job?.priority, 0);
    assert.equal(result.job?.uniqueKey, null);
    assert.ok(result.job!.availableAt <= new Date().toISOString());

    const after = scheduleByName('s');
    assert.equal(after.nextRunAt, future);
    assert.equal(after.enabled, true);
    assert.ok(after.lastEnqueuedAt !== null);
  });

  test('occurrence overrides flow through: maxAttempts, priority, uniqueKey', async () => {
    const result = await (async () => {
      service().upsert({ name: 's', jobName: 'j', cron: '0 3 * * *' });
      rewind('s');
      const row = scheduleByName('s');
      return store.claimAndEnqueue(db, {
        id: row.id,
        expectedNextRunAt: row.nextRunAt as string,
        nextRunAt: '2999-01-01T00:00:00.000Z',
        nowIso: new Date().toISOString(),
        input: { name: 'j', payload: { a: 1 }, maxAttempts: 2, priority: 5, uniqueKey: 'k' },
      });
    })();
    assert.equal(result.job?.maxAttempts, 2);
    assert.equal(result.job?.priority, 5);
    assert.equal(result.job?.uniqueKey, 'k');
    assert.deepEqual(result.job?.payload, { a: 1 });
  });

  test('a lost compare-and-swap writes nothing', async () => {
    service().upsert({ name: 's', jobName: 'j', cron: '0 3 * * *' });
    rewind('s');
    const row = scheduleByName('s');

    const result = await store.claimAndEnqueue(db, {
      id: row.id,
      expectedNextRunAt: '1999-01-01T00:00:00.000Z', // stale — another instance advanced it
      nextRunAt: '2999-01-01T00:00:00.000Z',
      nowIso: new Date().toISOString(),
      input: { name: 'j', payload: {} },
    });
    assert.deepEqual(result, { claimed: false, job: null });
    assert.equal(jobsNamed('j').length, 0);
    assert.equal(scheduleByName('s').nextRunAt, PAST);
  });

  test('a schedule with no future occurrence disables itself but still fires', async () => {
    service().upsert({ name: 's', jobName: 'j', cron: '0 3 * * *' });
    rewind('s');
    const result = await claimNow(scheduleByName('s'), null);
    assert.equal(result.claimed, true);
    assert.equal(result.job?.name, 'j');
    const after = scheduleByName('s');
    assert.equal(after.enabled, false);
    assert.equal(after.nextRunAt, null);
  });

  test('the overlap guard suppresses the insert while an occurrence is active', async () => {
    jobStore.enqueue(db, { name: 'j', payload: {}, uniqueKey: 'k' });
    service().upsert({ name: 's', jobName: 'j', cron: '0 3 * * *', uniqueKey: 'k' });
    rewind('s');
    const row = scheduleByName('s');

    const result = await store.claimAndEnqueue(db, {
      id: row.id,
      expectedNextRunAt: row.nextRunAt as string,
      nextRunAt: '2999-01-01T00:00:00.000Z',
      nowIso: new Date().toISOString(),
      input: { name: 'j', payload: {}, uniqueKey: 'k' },
    });
    assert.equal(result.claimed, true);
    assert.equal(result.job, null);
    assert.equal(jobsNamed('j').length, 1);
    assert.equal(scheduleByName('s').nextRunAt, '2999-01-01T00:00:00.000Z');
  });

  test('disable records the error and stops the schedule', async () => {
    service().upsert({ name: 's', jobName: 'j', cron: '0 3 * * *' });
    await store.disable(db, scheduleByName('s').id, 'boom');
    const after = scheduleByName('s');
    assert.equal(after.enabled, false);
    assert.equal(after.lastError, 'boom');
  });
});

describe('JobSchedulesService', () => {
  test('upsert validates the cron before touching the store', () => {
    assert.throws(() => service().upsert({ name: 's', jobName: 'j', cron: 'garbage' }), InvalidScheduleError);
    assert.equal(db.select().from(jobSchedules).all().length, 0);
  });

  test('upsert with an impossible cron arms a dormant schedule (null nextRunAt)', () => {
    const row = service().upsert({ name: 's', jobName: 'j', cron: '0 0 30 2 *' });
    assert.equal(row.nextRunAt, null);
    assert.equal(row.enabled, true);
  });

  test('setEnabled(false) clears nextRunAt; setEnabled(true) re-arms from now', async () => {
    const svc = service();
    svc.upsert({ name: 's', jobName: 'j', cron: '0 3 * * *' });
    const disabled = await svc.setEnabled('s', false);
    assert.equal(disabled?.enabled, false);
    assert.equal(disabled?.nextRunAt, null);

    const enabled = await svc.setEnabled('s', true);
    assert.equal(enabled?.enabled, true);
    // Re-armed from *now* — the skip-missed policy means no catch-up burst.
    assert.ok((enabled?.nextRunAt as string) > new Date(Date.now() - 1000).toISOString());
  });

  test('setEnabled resolves undefined for an unknown name (both directions)', async () => {
    assert.equal(await service().setEnabled('nope', true), undefined);
    assert.equal(await service().setEnabled('nope', false), undefined);
  });

  test('setEnabled(true) refuses to arm a hand-corrupted cron', async () => {
    const svc = service();
    svc.upsert({ name: 's', jobName: 'j', cron: '0 3 * * *' });
    db.update(jobSchedules).set({ cron: 'garbage' }).where(eq(jobSchedules.name, 's')).run();
    await assert.rejects(svc.setEnabled('s', true), InvalidScheduleError);
  });

  test('every method throws a configuration error without a scheduleStore', async () => {
    const bare = new JobSchedulesService(db, null);
    const expected = /configured without a scheduleStore/;
    assert.throws(() => bare.upsert({ name: 's', jobName: 'j', cron: '0 3 * * *' }), expected);
    await assert.rejects(bare.get('s'), expected);
    await assert.rejects(bare.list(), expected);
    await assert.rejects(bare.remove('s'), expected);
    await assert.rejects(bare.setEnabled('s', true), expected);
  });
});

/** Minimal explorer stand-in: a fixed name → handler map. */
function explorerOf(handlers: Record<string, JobHandlerContract>): JobsHandlerExplorer {
  return { get: (name: string) => handlers[name] } as JobsHandlerExplorer;
}

describe('JobsClaimer schedule integration', () => {
  test('without a scheduleStore the tick reports scheduled 0 and touches nothing', async () => {
    const claimer = new JobsClaimer(db, jobStore, explorerOf({}));
    const report = await claimer.tick(cfg);
    assert.equal(report.scheduled, 0);
  });

  test('a due schedule fires and its occurrence is claimed in the SAME tick', async () => {
    const seen: unknown[] = [];
    const claimer = new JobsClaimer(
      db,
      jobStore,
      explorerOf({ 'report.build': { handle: async (payload) => void seen.push(payload) } }),
      store,
    );
    service().upsert({ name: 'nightly', jobName: 'report.build', payload: { day: 1 }, cron: '0 3 * * *' });
    rewind('nightly');

    const report = await claimer.tick(cfg);
    assert.equal(report.scheduled, 1);
    assert.equal(report.claimed, 1);
    assert.equal(report.completed, 1);
    assert.deepEqual(seen, [{ day: 1 }]);

    const after = scheduleByName('nightly');
    assert.ok((after.nextRunAt as string) > new Date().toISOString());
    assert.ok(after.lastEnqueuedAt !== null);
  });

  test('a schedule that is not due does not fire', async () => {
    const claimer = new JobsClaimer(db, jobStore, explorerOf({}), store);
    service().upsert({ name: 'later', jobName: 'j', cron: '0 3 * * *' });
    const report = await claimer.tick(cfg);
    assert.equal(report.scheduled, 0);
    assert.equal(report.claimed, 0);
  });

  test('retry exhaustion of an occurrence NEVER kills the schedule', async () => {
    const claimer = new JobsClaimer(
      db,
      jobStore,
      explorerOf({ doomed: { handle: async () => { throw new Error('always fails'); } } }),
      store,
    );
    service().upsert({ name: 's', jobName: 'doomed', cron: '0 3 * * *', maxAttempts: 1, priority: 2 });
    rewind('s');

    const first = await claimer.tick(cfg);
    assert.equal(first.scheduled, 1);
    assert.equal(first.failed, 1); // maxAttempts 1 → exhausted immediately
    assert.equal(jobsNamed('doomed')[0].status, 'failed');

    // The schedule row is the source of truth: it must still be armed…
    const between = scheduleByName('s');
    assert.equal(between.enabled, true);
    assert.ok(between.nextRunAt !== null);

    // …and a later due time must produce a brand-new occurrence.
    rewind('s');
    const second = await claimer.tick(cfg);
    assert.equal(second.scheduled, 1);
    assert.equal(jobsNamed('doomed').length, 2);
  });

  test('uniqueKey overlap guard: no occurrence pile-up while one is active', async () => {
    const claimer = new JobsClaimer(
      db,
      jobStore,
      explorerOf({ slow: { handle: async () => { throw new RetryableError('busy', 3_600_000); } } }),
      store,
    );
    service().upsert({ name: 's', jobName: 'slow', cron: '0 3 * * *', uniqueKey: 'singleton' });
    rewind('s');
    const first = await claimer.tick(cfg);
    assert.equal(first.retried, 1); // occurrence #1 is active (pending, far backoff)

    rewind('s');
    const second = await claimer.tick(cfg);
    assert.equal(second.scheduled, 1); // schedule advanced…
    assert.equal(jobsNamed('slow').length, 1); // …but no second occurrence
  });

  test('a hand-corrupted cron disables the schedule instead of crashing the tick', async () => {
    const claimer = new JobsClaimer(db, jobStore, explorerOf({}), store);
    service().upsert({ name: 's', jobName: 'j', cron: '0 3 * * *' });
    rewind('s');
    db.update(jobSchedules).set({ cron: 'garbage' }).where(eq(jobSchedules.name, 's')).run();

    const report = await claimer.tick(cfg);
    assert.equal(report.scheduled, 0);
    const after = scheduleByName('s');
    assert.equal(after.enabled, false);
    assert.match(after.lastError as string, /Invalid cron schedule "garbage"/);
  });

  test('a non-Error throw from the store is stringified into lastError', async () => {
    const disabled: string[] = [];
    const stub = {
      listDue: async () => [{ ...scheduleByName('s') }] as ScheduleRow[],
      claimAndEnqueue: async () => {
        throw 'string-boom';
      },
      disable: async (_db: unknown, id: string, lastError: string) =>
        void disabled.push(`${id}:${lastError}`),
    } as unknown as ScheduleStore;
    service().upsert({ name: 's', jobName: 'j', cron: '0 3 * * *' });
    rewind('s');
    const claimer = new JobsClaimer(db, jobStore, explorerOf({}), stub);
    const report = await claimer.tick(cfg);
    assert.equal(report.scheduled, 0);
    assert.equal(disabled.length, 1);
    assert.ok(disabled[0].endsWith(':string-boom'));
  });

  test('a lost claim is not counted as scheduled', async () => {
    const stub = {
      listDue: async () => [scheduleByName('s')],
      claimAndEnqueue: async () => ({ claimed: false, job: null }),
    } as unknown as ScheduleStore;
    service().upsert({ name: 's', jobName: 'j', cron: '0 3 * * *' });
    rewind('s');
    const claimer = new JobsClaimer(db, jobStore, explorerOf({}), stub);
    const report = await claimer.tick(cfg);
    assert.equal(report.scheduled, 0);
  });
});

// ---------------------------------------------------------------------------
// Module wiring: the schedule store is a first-class, optional module option.
// ---------------------------------------------------------------------------
import type { Provider } from '@nestjs/common';
import { JobsModule } from '../jobs.module';
import { JOBS_SCHEDULE_STORE } from '../tokens';
import { JobsService } from '../jobs.service';

const scheduleProvider = (providers: Provider[] | undefined) =>
  (providers ?? []).find(
    (p): p is Extract<Provider, { provide: unknown }> =>
      typeof p === 'object' && p !== null && 'provide' in p && p.provide === JOBS_SCHEDULE_STORE,
  ) as { useValue?: unknown; useFactory?: unknown; inject?: unknown[] } | undefined;

describe('JobsModule schedules wiring', () => {
  const DRIZZLE = Symbol('wiring-drizzle');

  test('forRoot without a scheduleStore provides null (schedules stay off)', () => {
    const mod = JobsModule.forRoot({ drizzleInstanceToken: DRIZZLE, store: jobStore });
    assert.equal(scheduleProvider(mod.providers)?.useValue, null);
    assert.ok(mod.exports?.includes(JobSchedulesService));
    assert.ok(mod.exports?.includes(JobsService));
  });

  test('forRoot passes the scheduleStore instance through', () => {
    const mod = JobsModule.forRoot({
      drizzleInstanceToken: DRIZZLE,
      store: jobStore,
      scheduleStore: store,
    });
    assert.equal(scheduleProvider(mod.providers)?.useValue, store);
  });

  test('forRootAsync wires useScheduleStore as a factory sharing inject', () => {
    const TOKEN = Symbol('cfg');
    const mod = JobsModule.forRootAsync({
      drizzleInstanceToken: DRIZZLE,
      inject: [TOKEN],
      useStore: () => jobStore,
      useScheduleStore: () => store,
    });
    const provider = scheduleProvider(mod.providers);
    assert.equal(typeof provider?.useFactory, 'function');
    assert.deepEqual(provider?.inject, [TOKEN]);
  });

  test('forRootAsync with useScheduleStore but no inject defaults to []', () => {
    const mod = JobsModule.forRootAsync({
      drizzleInstanceToken: DRIZZLE,
      useStore: () => jobStore,
      useScheduleStore: () => store,
    });
    assert.deepEqual(scheduleProvider(mod.providers)?.inject, []);
  });

  test('forRootAsync without useScheduleStore provides null (inject defaulted)', () => {
    const mod = JobsModule.forRootAsync({
      drizzleInstanceToken: DRIZZLE,
      useStore: () => jobStore,
    });
    const provider = scheduleProvider(mod.providers);
    assert.equal(provider?.useValue, null);
    assert.equal(provider?.useFactory, undefined);
  });
});
