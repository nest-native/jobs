import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { PermanentError, RetryableError } from '../errors';
import { resolveAvailableAt } from '../enqueue-input';
import type { JobsClaimer, TickReport } from '../jobs-claimer.service';
import { drainJobs, RecordingJobHandler } from '../testing';

describe('retry vocabulary', () => {
  test('RetryableError carries name and optional delay', () => {
    const e = new RetryableError('soon', 250);
    assert.equal(e.name, 'RetryableError');
    assert.equal(e.message, 'soon');
    assert.equal(e.delayMs, 250);
    assert.equal(new RetryableError('no delay').delayMs, undefined);
    assert.ok(e instanceof Error);
  });

  test('PermanentError carries name', () => {
    const e = new PermanentError('nope');
    assert.equal(e.name, 'PermanentError');
    assert.equal(e.message, 'nope');
    assert.ok(e instanceof Error);
  });
});

describe('resolveAvailableAt (runAt XOR delayMs)', () => {
  test('both runAt and delayMs set → throws', () => {
    assert.throws(
      () => resolveAvailableAt({ runAt: new Date(), delayMs: 1_000 }),
      /mutually exclusive/,
    );
  });

  test('runAt wins as the absolute due time', () => {
    const at = new Date('2027-01-01T00:00:00.000Z');
    assert.equal(resolveAvailableAt({ runAt: at }), at);
  });

  test('delayMs counts from now (delay 0 is valid: due immediately)', () => {
    const before = Date.now();
    const resolved = resolveAvailableAt({ delayMs: 60_000 }).getTime();
    assert.ok(resolved >= before + 60_000);
    assert.ok(resolved <= Date.now() + 60_000);

    const immediate = resolveAvailableAt({ delayMs: 0 }).getTime();
    assert.ok(immediate <= Date.now());
  });

  test('neither set → due immediately', () => {
    const before = Date.now();
    const resolved = resolveAvailableAt({}).getTime();
    assert.ok(resolved >= before && resolved <= Date.now());
  });
});

describe('drainJobs', () => {
  const report = (claimed: number, completed = claimed): TickReport => ({
    claimed,
    completed,
    retried: 0,
    failed: 0,
  });
  const fakeClaimer = (reports: TickReport[]): JobsClaimer =>
    ({ tick: async () => reports.shift() ?? report(0) }) as unknown as JobsClaimer;

  test('ticks until a tick claims nothing and aggregates the reports', async () => {
    const claimer = fakeClaimer([
      { claimed: 2, completed: 1, retried: 1, failed: 0 },
      { claimed: 1, completed: 0, retried: 0, failed: 1 },
    ]);
    const total = await drainJobs(claimer);
    assert.deepEqual(total, { claimed: 3, completed: 1, retried: 1, failed: 1 });
  });

  test('passes runner overrides through to every tick', async () => {
    const seen: unknown[] = [];
    const claimer = {
      tick: async (overrides: unknown) => {
        seen.push(overrides);
        return report(0);
      },
    } as unknown as JobsClaimer;
    await drainJobs(claimer, { runner: { batchSize: 3 } });
    assert.deepEqual(seen, [{ batchSize: 3 }]);
  });

  test('throws after maxTicks when the queue never settles', async () => {
    const claimer = { tick: async () => report(1) } as unknown as JobsClaimer;
    await assert.rejects(
      () => drainJobs(claimer, { maxTicks: 3 }),
      /did not settle after 3 ticks/,
    );
  });
});

describe('RecordingJobHandler', () => {
  const ctx = (attempt: number) => ({ jobId: 'j-1', attempt });

  test('records every execution in order, with payload and ctx', () => {
    const handler = new RecordingJobHandler();
    handler.handle({ n: 1 }, ctx(1));
    handler.handle({ n: 2 }, ctx(2));
    assert.equal(handler.executions().length, 2);
    assert.deepEqual(handler.executions()[0]?.payload, { n: 1 });
    assert.equal(handler.executions()[1]?.ctx.attempt, 2);
  });

  test('failNextWith throws once (after recording), then succeeds', () => {
    const handler = new RecordingJobHandler();
    handler.failNextWith(new RetryableError('flaky'));
    assert.throws(() => handler.handle({}, ctx(1)), RetryableError);
    handler.handle({}, ctx(2));
    assert.equal(handler.executions().length, 2);
  });

  test('failWith throws persistently until cleared', () => {
    const handler = new RecordingJobHandler();
    handler.failWith(new PermanentError('dead'));
    assert.throws(() => handler.handle({}, ctx(1)), PermanentError);
    assert.throws(() => handler.handle({}, ctx(2)), PermanentError);
    handler.clearFailure();
    handler.handle({}, ctx(3));
    assert.equal(handler.executions().length, 3);
  });

  test('one-shot failures take precedence over the persistent one', () => {
    const handler = new RecordingJobHandler();
    handler.failWith(new Error('persistent'));
    handler.failNextWith(new Error('one-shot'));
    assert.throws(() => handler.handle({}, ctx(1)), /one-shot/);
    assert.throws(() => handler.handle({}, ctx(2)), /persistent/);
  });

  test('reset clears executions and armed failures', () => {
    const handler = new RecordingJobHandler();
    handler.failNextWith(new Error('armed'));
    handler.reset();
    handler.handle({ fresh: true }, ctx(1));
    assert.equal(handler.executions().length, 1);
  });
});
