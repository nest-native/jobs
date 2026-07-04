import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { DynamicModule, INestApplicationContext } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, Reflector } from '@nestjs/core';
import {
  ClsPluginTransactional,
  InjectTransaction,
  Transactional,
} from '@nestjs-cls/transactional';
import { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { ClsModule } from 'nestjs-cls';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, sql } from 'drizzle-orm';
import {
  JobHandler,
  JobsClaimer,
  JobsHandlerExplorer,
  JobsModule,
  JobsService,
  type JobRow,
  PermanentError,
  RetryableError,
} from '../index';
import { jobs, SqliteJobStore } from '../dialects/sqlite';
import { drainJobs, RecordingJobHandler } from '../testing';

const DDL = `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 10,
  unique_key TEXT, priority INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL,
  claimed_at TEXT, claimed_by TEXT, processed_at TEXT, last_error TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX jobs_name_unique_key_unique ON jobs (name, unique_key);
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL);
`;

const DRIZZLE = Symbol('test-drizzle');
type Db = BetterSQLite3Database<Record<string, never>>;

// Compile-level regression for EnqueueJobInput<TPayload>: a payload typed as a
// plain interface (NO index signature, so NOT assignable to
// Record<string, unknown>) must be accepted by enqueue without any cast.
interface WelcomeEmailPayload {
  email: string;
}

@JobHandler('email.welcome')
@Injectable()
class WelcomeEmailHandler extends RecordingJobHandler {}

@Injectable()
class UserService {
  constructor(
    @InjectTransaction() private readonly db: Db,
    private readonly jobs: JobsService<SqliteJobStore>,
  ) {}

  // Synchronous @Transactional body (better-sqlite3): enqueue + business write
  // commit atomically; a throw rolls both back.
  @Transactional()
  register(email: string, fail = false): Promise<JobRow> {
    const payload: WelcomeEmailPayload = { email };
    const row = this.jobs.enqueue({
      name: 'email.welcome',
      payload,
      uniqueKey: `welcome:${email}`,
    });
    this.db.run(sql`INSERT INTO users (email) VALUES (${email})`);
    if (fail) throw new Error('rollback');
    return row as unknown as Promise<JobRow>;
  }
}

// The Drizzle instance is provided by a global module, mirroring how a real app
// registers it (e.g. @nest-native/drizzle is global) — so both the CLS adapter
// and JobsModule resolve the token without an explicit import.
@Module({})
class DbModule {}
const dbImport = (db: Db): DynamicModule => ({
  module: DbModule,
  global: true,
  providers: [{ provide: DRIZZLE, useValue: db }],
  exports: [DRIZZLE],
});

const clsImport = () =>
  ClsModule.forRoot({
    global: true,
    plugins: [
      new ClsPluginTransactional({
        adapter: new TransactionalAdapterDrizzleOrm({
          drizzleInstanceToken: DRIZZLE,
        }),
        enableTransactionProxy: true,
      }),
    ],
  });

@Module({})
class FixtureModule {
  static register(db: Db, extraProviders: any[] = []): DynamicModule {
    return {
      module: FixtureModule,
      imports: [
        dbImport(db),
        clsImport(),
        JobsModule.forRoot({
          drizzleInstanceToken: DRIZZLE,
          store: new SqliteJobStore(),
        }),
      ],
      providers: [UserService, WelcomeEmailHandler, ...extraProviders],
      exports: [UserService],
    };
  }
}

let app: INestApplicationContext;
let db: Db;
let raw: Database.Database;

const store = new SqliteJobStore();
const count = (table: string): number =>
  (raw.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c;
const jobRow = (id: string) =>
  db.select().from(jobs).where(eq(jobs.id, id)).get();
const welcome = () => app.get(WelcomeEmailHandler);

async function boot(extraProviders: any[] = []) {
  raw = new Database(':memory:');
  raw.exec(DDL);
  db = drizzle(raw);
  app = await NestFactory.createApplicationContext(
    FixtureModule.register(db, extraProviders),
    { logger: false, abortOnError: false },
  );
}

afterEach(async () => {
  await app?.close();
  raw?.close();
});

describe('JobsService (atomic enqueue)', () => {
  beforeEach(() => boot());

  test('enqueue commits the job row with the business write', async () => {
    const row = await app.get(UserService).register('a@example.com');
    assert.equal(row.name, 'email.welcome');
    assert.equal(row.uniqueKey, 'welcome:a@example.com');
    assert.equal(jobRow(row.id)?.status, 'pending');
    assert.equal(count('users'), 1);
  });

  test('a throw rolls back BOTH the job row and the business write', async () => {
    await assert.rejects(() => app.get(UserService).register('b@example.com', true), /rollback/);
    assert.equal(db.select().from(jobs).all().length, 0);
    assert.equal(count('users'), 0);
  });

  test('outside a transaction, enqueue falls back to the base instance', async () => {
    // enableTransactionProxy resolves @InjectTransaction() to the base Drizzle
    // instance when no transaction is active — enqueue simply writes directly.
    const svc = app.get(JobsService<SqliteJobStore>);
    const row = svc.enqueue({ name: 'email.welcome', payload: { email: 'x' } });
    assert.equal(jobRow(row.id)?.status, 'pending');
  });

  test('double-enqueue with the same uniqueKey returns the existing active row', async () => {
    const first = await app.get(UserService).register('dup@example.com');
    const svc = app.get(JobsService<SqliteJobStore>);
    const second = svc.enqueue({
      name: 'email.welcome',
      payload: { email: 'dup@example.com' },
      uniqueKey: 'welcome:dup@example.com',
    });
    assert.equal(second.id, first.id);
    assert.equal(db.select().from(jobs).all().length, 1);
  });
});

describe('JobsClaimer (handler outcomes)', () => {
  beforeEach(() => boot());

  test('tick runs a pending job through its @JobHandler and completes it', async () => {
    const row = await app.get(UserService).register('c@example.com');
    const report = await app.get(JobsClaimer).tick();
    assert.deepEqual(report, { claimed: 1, completed: 1, retried: 0, failed: 0 });
    const executions = welcome().executions();
    assert.equal(executions.length, 1);
    assert.deepEqual(executions[0]?.payload, { email: 'c@example.com' });
    assert.deepEqual(executions[0]?.ctx, { jobId: row.id, attempt: 1 });
    const after = jobRow(row.id);
    assert.equal(after?.status, 'completed');
    assert.equal(after?.uniqueKey, null);
  });

  test('a PermanentError fails the job immediately', async () => {
    await app.get(UserService).register('p@example.com');
    welcome().failWith(new PermanentError('malformed payload'));
    const report = await app.get(JobsClaimer).tick();
    assert.equal(report.failed, 1);
    const after = db.select().from(jobs).all()[0];
    assert.equal(after?.status, 'failed');
    assert.equal(after?.lastError, 'malformed payload');
  });

  test('a job with no registered handler fails immediately', async () => {
    store.enqueue(db, { name: 'nobody.listens', payload: {} });
    const report = await app.get(JobsClaimer).tick();
    assert.deepEqual(report, { claimed: 1, completed: 0, retried: 0, failed: 1 });
    const after = db.select().from(jobs).all()[0];
    assert.equal(after?.status, 'failed');
    assert.match(after?.lastError ?? '', /No @JobHandler registered for job "nobody.listens"/);
  });

  test('a RetryableError reschedules, honouring its delayMs', async () => {
    const row = await app.get(UserService).register('r@example.com');
    welcome().failWith(new RetryableError('later', 60_000));
    const report = await app.get(JobsClaimer).tick();
    assert.equal(report.retried, 1);
    const after = jobRow(row.id);
    assert.equal(after?.status, 'pending');
    assert.equal(after?.attempts, 1);
    assert.equal(after?.lastError, 'later');
    // Rescheduled a minute out → not claimable now.
    assert.equal((await app.get(JobsClaimer).tick()).claimed, 0);
  });

  test('a RetryableError without delay reschedules with backoff', async () => {
    await app.get(UserService).register('r2@example.com');
    welcome().failWith(new RetryableError('later'));
    assert.equal((await app.get(JobsClaimer).tick()).retried, 1);
  });

  test('a throw-once handler completes on the retry (attempt 2)', async () => {
    welcome().failNextWith(new RetryableError('flaky', 0));
    const row = await app.get(UserService).register('f@example.com');
    // delayMs 0 → the retry is due immediately, so one drain settles it.
    const report = await drainJobs(app.get(JobsClaimer));
    assert.deepEqual(report, { claimed: 2, completed: 1, retried: 1, failed: 0 });
    const executions = welcome().executions();
    assert.equal(executions.length, 2);
    assert.deepEqual(executions[1]?.ctx, { jobId: row.id, attempt: 2 });
    assert.equal(jobRow(row.id)?.status, 'completed');
  });

  test('a generic error retries while attempts remain', async () => {
    await app.get(UserService).register('g@example.com');
    welcome().failWith(new Error('flaky'));
    assert.equal((await app.get(JobsClaimer).tick()).retried, 1);
  });

  test('a generic error fails once attempts are exhausted (maxAttempts=1)', async () => {
    store.enqueue(db, { name: 'email.welcome', payload: {}, maxAttempts: 1 });
    welcome().failWith(new Error('flaky'));
    const report = await app.get(JobsClaimer).tick();
    assert.equal(report.failed, 1);
    assert.equal(db.select().from(jobs).all()[0]?.status, 'failed');
  });

  test('a non-Error throw is stringified into lastError', async () => {
    await app.get(UserService).register('s@example.com');
    // failWith stores any thrown value; throw a plain string to exercise the
    // String(error) branch of the claimer's error mapping.
    welcome().failWith('plain string failure' as unknown as Error);
    assert.equal((await app.get(JobsClaimer).tick()).retried, 1);
    assert.equal(db.select().from(jobs).all()[0]?.lastError, 'plain string failure');
  });

  test('a delayed job is not claimed before its due time; a past runAt is', async () => {
    store.enqueue(db, { name: 'email.welcome', payload: {}, delayMs: 60_000 });
    assert.equal((await app.get(JobsClaimer).tick()).claimed, 0);

    store.enqueue(db, { name: 'email.welcome', payload: {}, runAt: new Date(Date.now() - 1_000) });
    assert.equal((await app.get(JobsClaimer).tick()).completed, 1);
  });
});

describe('JobsHandlerExplorer', () => {
  test('two handler classes claiming the same name fail the app at startup', async () => {
    @JobHandler('email.welcome')
    @Injectable()
    class ShadowingHandler extends RecordingJobHandler {}

    await assert.rejects(
      () => boot([ShadowingHandler]),
      /Duplicate @JobHandler\("email.welcome"\)/,
    );
    raw?.close();
  });

  test('registers handlers by name and exposes them', async () => {
    await boot();
    const explorer = app.get(JobsHandlerExplorer);
    assert.deepEqual(explorer.names(), ['email.welcome']);
    assert.equal(explorer.get('email.welcome'), welcome());
    assert.equal(explorer.get('unknown'), undefined);
  });

  test('skips wrappers without an instance or metatype; re-scan is idempotent', () => {
    @JobHandler('direct.handler')
    class DirectHandler extends RecordingJobHandler {}
    const instance = new DirectHandler();
    const wrappers = [
      { instance: undefined, metatype: DirectHandler },
      { instance: {}, metatype: undefined },
      { instance: {}, metatype: class NotAHandler {} },
      { instance, metatype: DirectHandler },
    ];
    const explorer = new JobsHandlerExplorer(
      { getProviders: () => wrappers } as unknown as DiscoveryService,
      new Reflector(),
    );
    explorer.onApplicationBootstrap();
    // The same provider scanned again (e.g. a second bootstrap) is a no-op,
    // not a duplicate: the registered instance is identical.
    explorer.onApplicationBootstrap();
    assert.deepEqual(explorer.names(), ['direct.handler']);
    assert.equal(explorer.get('direct.handler'), instance);
  });
});

describe('JobsModule wiring', () => {
  test('forRootAsync builds the store via a DI factory', async () => {
    raw = new Database(':memory:');
    raw.exec(DDL);
    db = drizzle(raw);

    const STORE_CONFIG = Symbol('store-config');

    @Module({})
    class AsyncFixture {}
    @Module({})
    class StoreConfigModule {}
    const storeConfig: DynamicModule = {
      module: StoreConfigModule,
      providers: [{ provide: STORE_CONFIG, useValue: new SqliteJobStore() }],
      exports: [STORE_CONFIG],
    };

    app = await NestFactory.createApplicationContext(
      {
        module: AsyncFixture,
        imports: [
          dbImport(db),
          clsImport(),
          JobsModule.forRootAsync({
            isGlobal: false,
            drizzleInstanceToken: DRIZZLE,
            imports: [storeConfig],
            inject: [STORE_CONFIG],
            // Idiomatic typed factory — assignable because useStore mirrors
            // Nest's `(...args: any[]) => T` factory shape.
            useStore: (configured: SqliteJobStore) => configured,
          }),
        ],
        providers: [WelcomeEmailHandler],
      },
      { logger: false, abortOnError: false },
    );

    store.enqueue(db, { name: 'email.welcome', payload: { n: 1 } });
    assert.equal((await app.get(JobsClaimer).tick()).completed, 1);
    assert.equal(app.get(WelcomeEmailHandler).executions().length, 1);
  });

  test('forRootAsync applies defaults when isGlobal/imports/inject are omitted', () => {
    // Calling the factory evaluates the `?? true` / `?? []` fallbacks; inspect
    // the returned DynamicModule directly (no DI bootstrap needed).
    const mod = JobsModule.forRootAsync({
      drizzleInstanceToken: DRIZZLE,
      useStore: () => new SqliteJobStore(),
    });
    assert.equal(mod.global, true);
    assert.deepEqual(mod.imports, [DiscoveryModule]);
    assert.ok(mod.exports?.includes(JobsClaimer));
    assert.ok(mod.exports?.includes(JobsService));
    assert.ok(mod.exports?.includes(JobsHandlerExplorer));
    const storeProvider = (mod.providers ?? []).find(
      (p) => typeof p === 'object' && p !== null && 'useFactory' in p,
    ) as { inject?: unknown[] } | undefined;
    assert.deepEqual(storeProvider?.inject, []);
  });

  test('forRoot honours explicit isGlobal/imports', () => {
    @Module({})
    class ExtraModule {}
    const mod = JobsModule.forRoot({
      drizzleInstanceToken: DRIZZLE,
      store: new SqliteJobStore(),
      isGlobal: false,
      imports: [ExtraModule],
    });
    assert.equal(mod.global, false);
    assert.deepEqual(mod.imports, [DiscoveryModule, ExtraModule]);
    assert.ok(mod.providers?.some((p) => p === JobsService));
  });
});
