import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { MysqlScheduleStore } from '../dialects/mysql';
import type { ScheduleRow } from '../interfaces';

// Same approach as mysql-store.spec.ts: no in-process MySQL exists, so the
// store runs against a recording stand-in that drives its real code paths and
// captures what it would send. Genuine end-to-end behaviour (ON DUPLICATE KEY
// no-op, affectedRows semantics, transactions) is proven by the gated
// real-MySQL integration test in `test/integration/`.

const store = new MysqlScheduleStore();

function scheduleRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sched-1',
    name: 's',
    jobName: 'j',
    payload: {},
    cron: '0 3 * * *',
    timezone: null,
    enabled: true,
    nextRunAt: '2020-01-01T00:00:00.000Z',
    maxAttempts: null,
    priority: null,
    uniqueKey: null,
    lastEnqueuedAt: null,
    lastError: null,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface MockOptions {
  /** Queue: each `select()` call resolves the next entry (default []). */
  selects?: unknown[][];
  /** Queue of affectedRows for successive update calls (default 1). */
  updateAffected?: number[];
  deleteAffected?: number;
}

function mockDb(options: MockOptions = {}) {
  const captured: {
    inserts: Record<string, unknown>[];
    dupSets: Record<string, unknown>[];
    sets: Record<string, unknown>[];
  } = { inserts: [], dupSets: [], sets: [] };
  const selects = [...(options.selects ?? [])];
  const updates = [...(options.updateAffected ?? [])];

  const selectChain = () => {
    const resolved = Promise.resolve(selects.shift() ?? []);
    const chain: Record<string, unknown> = {};
    for (const step of ['from', 'where', 'orderBy', 'limit']) {
      chain[step] = () => chain;
    }
    chain.then = (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => resolved.then(onFulfilled, onRejected);
    return chain;
  };

  const db: Record<string, unknown> = {
    select: () => selectChain(),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        captured.inserts.push(values);
        return {
          onDuplicateKeyUpdate: (update: { set: Record<string, unknown> }) => {
            captured.dupSets.push(update.set);
            return Promise.resolve([{}]);
          },
        };
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        captured.sets.push(values);
        return {
          where: () =>
            Promise.resolve([{ affectedRows: updates.shift() ?? 1 }]),
        };
      },
    }),
    delete: () => ({
      where: () =>
        Promise.resolve([{ affectedRows: options.deleteAffected ?? 1 }]),
    }),
    transaction: (run: (tx: unknown) => unknown) => run(db),
  };
  return { db: db as unknown, captured };
}

describe('MysqlScheduleStore CRUD', () => {
  test('upsert inserts with bookkeeping, no-ops identity on duplicate, reads back', async () => {
    const persisted = scheduleRow();
    const { db, captured } = mockDb({ selects: [[persisted]] });

    const result = await store.upsert(db, {
      name: 's',
      jobName: 'j',
      payload: { n: 1 },
      cron: '0 3 * * *',
      timezone: null,
      enabled: true,
      nextRunAt: '2026-01-01T03:00:00.000Z',
      maxAttempts: null,
      priority: null,
      uniqueKey: null,
    });
    assert.equal(result, persisted);

    const insert = captured.inserts[0];
    assert.ok(typeof insert.id === 'string' && insert.id.length > 0);
    assert.equal(insert.lastError, null);
    assert.equal(insert.lastEnqueuedAt, null);
    assert.equal(insert.createdAt, insert.updatedAt);

    // The duplicate-key update must not touch identity or claim bookkeeping.
    const dup = captured.dupSets[0];
    assert.ok(!('id' in dup));
    assert.ok(!('name' in dup));
    assert.ok(!('createdAt' in dup));
    assert.ok(!('lastEnqueuedAt' in dup));
    assert.equal(dup.lastError, null);
    assert.equal(dup.jobName, 'j');
  });

  test('get resolves the row or undefined', async () => {
    const row = scheduleRow();
    assert.equal(await store.get(mockDb({ selects: [[row]] }).db, 's'), row);
    assert.equal(await store.get(mockDb().db, 's'), undefined);
  });

  test('list resolves the select result', async () => {
    const rows = [scheduleRow({ name: 'a' }), scheduleRow({ name: 'b' })];
    assert.deepEqual(await store.list(mockDb({ selects: [rows] }).db), rows);
  });

  test('remove maps affectedRows to a boolean', async () => {
    assert.equal(await store.remove(mockDb({ deleteAffected: 1 }).db, 's'), true);
    assert.equal(await store.remove(mockDb({ deleteAffected: 0 }).db, 's'), false);
  });

  test('setEnabled writes the flip and reads the row back', async () => {
    const row = scheduleRow({ enabled: false, nextRunAt: null });
    const { db, captured } = mockDb({ selects: [[row]] });
    assert.equal(await store.setEnabled(db, 's', false, null), row);
    assert.equal(captured.sets[0].enabled, false);
    assert.equal(captured.sets[0].nextRunAt, null);
    assert.equal(await store.setEnabled(mockDb().db, 'nope', true, null), undefined);
  });

  test('listDue resolves the select result', async () => {
    const rows = [scheduleRow()];
    assert.deepEqual(
      await store.listDue(mockDb({ selects: [rows] }).db, new Date().toISOString(), 5),
      rows,
    );
  });

  test('disable records the error', async () => {
    const { db, captured } = mockDb();
    await store.disable(db, 'sched-1', 'boom');
    assert.equal(captured.sets[0].enabled, false);
    assert.equal(captured.sets[0].lastError, 'boom');
  });
});

describe('MysqlScheduleStore claimAndEnqueue', () => {
  const claim = {
    id: 'sched-1',
    expectedNextRunAt: '2020-01-01T00:00:00.000Z',
    nextRunAt: '2999-01-01T00:00:00.000Z',
    nowIso: '2026-01-01T00:00:00.000Z',
    input: { name: 'j', payload: { n: 1 } as object, maxAttempts: 2, priority: 5, uniqueKey: 'k' },
  };

  test('a lost compare-and-swap attempts no insert', async () => {
    const { db, captured } = mockDb({ updateAffected: [0] });
    const result = await store.claimAndEnqueue(db, claim);
    assert.deepEqual(result, { claimed: false, job: null });
    assert.equal(captured.inserts.length, 0);
  });

  test('a winning claim inserts the occurrence and returns the read-back row', async () => {
    const jobRow = { id: 'job-1', name: 'j' };
    const { db, captured } = mockDb({ updateAffected: [1], selects: [[jobRow]] });
    const result = await store.claimAndEnqueue(db, claim);
    assert.equal(result.claimed, true);
    assert.equal(result.job, jobRow);

    assert.equal(captured.sets[0].nextRunAt, claim.nextRunAt);
    assert.equal(captured.sets[0].enabled, true);
    assert.equal(captured.sets[0].lastEnqueuedAt, claim.nowIso);
    const insert = captured.inserts[0];
    assert.equal(insert.name, 'j');
    assert.equal(insert.status, 'pending');
    assert.equal(insert.maxAttempts, 2);
    assert.equal(insert.priority, 5);
    assert.equal(insert.uniqueKey, 'k');
    assert.equal(insert.availableAt, claim.nowIso);
    assert.equal(insert.createdAt, claim.nowIso);
  });

  test('claim defaults: maxAttempts 10, priority 0, null uniqueKey', async () => {
    const { db, captured } = mockDb({ updateAffected: [1], selects: [[{ id: 'job-1' }]] });
    await store.claimAndEnqueue(db, { ...claim, input: { name: 'j', payload: {} } });
    const insert = captured.inserts[0];
    assert.equal(insert.maxAttempts, 10);
    assert.equal(insert.priority, 0);
    assert.equal(insert.uniqueKey, null);
  });

  test('a suppressed insert (duplicate no-op) resolves job null but stays claimed', async () => {
    const { db } = mockDb({ updateAffected: [1], selects: [[]] });
    const result = await store.claimAndEnqueue(db, claim);
    assert.equal(result.claimed, true);
    assert.equal(result.job, null);
  });

  test('a schedule with no future occurrence flips enabled off in the CAS write', async () => {
    const { db, captured } = mockDb({ updateAffected: [1], selects: [[{ id: 'job-1' }]] });
    await store.claimAndEnqueue(db, { ...claim, nextRunAt: null });
    assert.equal(captured.sets[0].enabled, false);
    assert.equal(captured.sets[0].nextRunAt, null);
  });
});
