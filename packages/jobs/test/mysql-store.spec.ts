import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { DEFAULT_RUNNER_CONFIG } from '../jobs-claimer.service';
import { isMysqlUniqueViolation, MysqlJobStore } from '../dialects/mysql';
import type { JobRow } from '../interfaces';

// There is no in-process MySQL (the pglite equivalent does not exist), so the
// store methods are exercised against a recording stand-in for a mysql2 Drizzle
// database: each builder call runs the store's real code path and records the
// values it would send, while canned rows drive the return-value assertions.
// This reaches 100% coverage of the store files hermetically; genuine
// end-to-end behaviour (json round-trip, errno 1062 dedup, transactions) is
// proven by the gated real-MySQL integration test in `test/integration/`.

const cfg = { ...DEFAULT_RUNNER_CONFIG, batchSize: 10, stuckTimeoutMs: 1_000 };
const store = new MysqlJobStore();

function row(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'row-1',
    name: 't',
    payload: { a: 1 },
    status: 'pending',
    attempts: 0,
    maxAttempts: 10,
    uniqueKey: null,
    priority: 0,
    availableAt: '2026-01-01T00:00:00.000Z',
    claimedAt: null,
    claimedBy: null,
    processedAt: null,
    lastError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface JobsMockOptions {
  selectRows?: JobRow[];
  candidates?: { id: string }[];
  insertError?: unknown;
}

function jobsMock(options: JobsMockOptions = {}) {
  const captured: {
    insert?: Record<string, unknown>;
    set?: Record<string, unknown>;
  } = {};
  const selectRows = options.selectRows ?? [];
  // A projected `select({ id })` is the claimer's candidate query (terminated
  // by `.orderBy().limit()`); a bare `select()` is the enqueue read-back /
  // dedup lookup (awaited directly — Drizzle builders are thenables) or the
  // claim re-read (ordered, then awaited).
  const buildSelect = (projection?: unknown) => ({
    from: () => ({
      where: () => {
        const plain = Promise.resolve(selectRows);
        return {
          orderBy: () =>
            projection
              ? { limit: () => Promise.resolve(options.candidates ?? []) }
              : Promise.resolve(selectRows),
          then: (
            onFulfilled?: (value: JobRow[]) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) => plain.then(onFulfilled, onRejected),
        };
      },
    }),
  });
  const db: any = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        captured.insert = values;
        return options.insertError
          ? Promise.reject(options.insertError)
          : Promise.resolve([{}]);
      },
    }),
    select: (projection?: unknown) => buildSelect(projection),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        captured.set = values;
        return { where: () => Promise.resolve([{}]) };
      },
    }),
    transaction: (run: (tx: unknown) => unknown) => run(db),
  };
  return { db: db as unknown, captured };
}

describe('MysqlJobStore enqueue', () => {
  test('inserts a pending row then reads it back by id (no RETURNING)', async () => {
    const persisted = row({ id: 'generated', uniqueKey: 'k1', maxAttempts: 3, priority: 4 });
    const { db, captured } = jobsMock({ selectRows: [persisted] });

    const result = await store.enqueue(db, {
      name: 't',
      payload: { a: 1 },
      uniqueKey: 'k1',
      maxAttempts: 3,
      priority: 4,
      runAt: new Date('2026-02-02T00:00:00.000Z'),
    });

    assert.equal(result, persisted);
    assert.equal(captured.insert?.name, 't');
    assert.deepEqual(captured.insert?.payload, { a: 1 });
    assert.equal(captured.insert?.status, 'pending');
    assert.equal(captured.insert?.uniqueKey, 'k1');
    assert.equal(captured.insert?.maxAttempts, 3);
    assert.equal(captured.insert?.priority, 4);
    assert.equal(captured.insert?.availableAt, '2026-02-02T00:00:00.000Z');
    assert.ok(typeof captured.insert?.id === 'string' && captured.insert.id.length > 0);
  });

  test('defaults: null uniqueKey, priority 0, maxAttempts 10, availableAt now', async () => {
    const { db, captured } = jobsMock({ selectRows: [row()] });

    await store.enqueue(db, { name: 't', payload: {} });

    assert.equal(captured.insert?.uniqueKey, null);
    assert.equal(captured.insert?.priority, 0);
    assert.equal(captured.insert?.maxAttempts, 10);
    assert.ok(typeof captured.insert?.availableAt === 'string');
  });

  test('honours delayMs; runAt combined with delayMs rejects before inserting', async () => {
    const { db, captured } = jobsMock({ selectRows: [row()] });
    const before = Date.now();
    await store.enqueue(db, { name: 't', payload: {}, delayMs: 30_000 });
    const due = new Date(captured.insert?.availableAt as string).getTime();
    assert.ok(due >= before + 30_000);

    const rejecting = jobsMock();
    await assert.rejects(
      () => store.enqueue(rejecting.db, { name: 't', payload: {}, runAt: new Date(), delayMs: 5 }),
      /mutually exclusive/,
    );
    assert.equal(rejecting.captured.insert, undefined);
  });

  test('errno 1062 with a uniqueKey returns the EXISTING active row', async () => {
    const existing = row({ id: 'active-owner', uniqueKey: 'k' });
    const { db } = jobsMock({
      insertError: { code: 'ER_DUP_ENTRY', errno: 1062 },
      selectRows: [existing],
    });
    const result = await store.enqueue(db, { name: 't', payload: {}, uniqueKey: 'k' });
    assert.equal(result, existing);
  });

  test('errno 1062 with a vanished duplicate rethrows the original error', async () => {
    const { db } = jobsMock({
      insertError: { code: 'ER_DUP_ENTRY', errno: 1062 },
      selectRows: [],
    });
    await assert.rejects(
      () => store.enqueue(db, { name: 't', payload: {}, uniqueKey: 'k' }),
      (error: unknown) => (error as { errno?: number }).errno === 1062,
    );
  });

  test('errno 1062 without a uniqueKey on the input is rethrown', async () => {
    const { db } = jobsMock({ insertError: { errno: 1062 } });
    await assert.rejects(
      () => store.enqueue(db, { name: 't', payload: {} }),
      (error: unknown) => (error as { errno?: number }).errno === 1062,
    );
  });

  test('a non-unique INSERT error is rethrown (not treated as a duplicate)', async () => {
    const { db } = jobsMock({ insertError: new Error('connection lost') });
    await assert.rejects(
      () => store.enqueue(db, { name: 't', payload: {}, uniqueKey: 'k' }),
      /connection lost/,
    );
  });
});

describe('MysqlJobStore claimBatch', () => {
  test('marks candidates processing and returns the ordered re-read rows', async () => {
    const claimed = row({ id: 'a', status: 'processing' });
    const { db, captured } = jobsMock({ candidates: [{ id: 'a' }], selectRows: [claimed] });

    const result = await store.claimBatch(db, cfg);

    assert.deepEqual(result, [claimed]);
    assert.equal(captured.set?.status, 'processing');
    assert.equal(captured.set?.claimedBy, cfg.workerInstanceId);
    assert.ok(typeof captured.set?.claimedAt === 'string');
  });

  test('returns [] with no update when nothing is due', async () => {
    const { db, captured } = jobsMock({ candidates: [] });

    assert.deepEqual(await store.claimBatch(db, cfg), []);
    assert.equal(captured.set, undefined);
  });
});

describe('MysqlJobStore transitions', () => {
  test('markCompleted transitions the row and releases the uniqueKey', async () => {
    const { db, captured } = jobsMock();
    await store.markCompleted(db, 'id-1');
    assert.equal(captured.set?.status, 'completed');
    assert.equal(captured.set?.lastError, null);
    assert.equal(captured.set?.uniqueKey, null);
    assert.ok(typeof captured.set?.processedAt === 'string');
  });

  test('retry re-arms the row, carrying or clearing lastError, keeping the key', async () => {
    const withError = jobsMock();
    await store.retry(withError.db, 'id-1', 5_000, 'boom');
    assert.equal(withError.captured.set?.status, 'pending');
    assert.equal(withError.captured.set?.lastError, 'boom');
    assert.equal(withError.captured.set?.claimedAt, null);
    assert.equal(withError.captured.set?.claimedBy, null);
    // Still active → retry must NOT touch the uniqueKey.
    assert.equal('uniqueKey' in (withError.captured.set ?? {}), false);

    const noError = jobsMock();
    await store.retry(noError.db, 'id-1', 1_000);
    assert.equal(noError.captured.set?.lastError, null);
  });

  test('markFailed records the reason and releases the uniqueKey', async () => {
    const { db, captured } = jobsMock();
    await store.markFailed(db, 'id-1', 'dead');
    assert.equal(captured.set?.status, 'failed');
    assert.equal(captured.set?.lastError, 'dead');
    assert.equal(captured.set?.uniqueKey, null);
    assert.ok(typeof captured.set?.processedAt === 'string');
  });
});

describe('isMysqlUniqueViolation', () => {
  test('matches ER_DUP_ENTRY / errno 1062 (direct or wrapped in cause)', () => {
    assert.equal(isMysqlUniqueViolation({ code: 'ER_DUP_ENTRY' }), true);
    assert.equal(isMysqlUniqueViolation({ errno: 1062 }), true);
    assert.equal(isMysqlUniqueViolation({ cause: { code: 'ER_DUP_ENTRY' } }), true);
    assert.equal(isMysqlUniqueViolation({ cause: { errno: 1062 } }), true);
  });

  test('rejects other errors and non-objects', () => {
    assert.equal(isMysqlUniqueViolation({ code: 'ER_NO_SUCH_TABLE' }), false);
    assert.equal(isMysqlUniqueViolation({ errno: 1146 }), false);
    assert.equal(isMysqlUniqueViolation(new Error('x')), false);
    assert.equal(isMysqlUniqueViolation(null), false);
    assert.equal(isMysqlUniqueViolation(42), false);
  });
});
