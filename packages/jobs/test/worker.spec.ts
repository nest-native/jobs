import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import type { JobsClaimer, TickReport } from '../jobs-claimer.service';
import { runWorkerLoop } from '../jobs-worker';

const report = (claimed: number): TickReport => ({
  claimed,
  completed: claimed,
  retried: 0,
  failed: 0,
});

/** Build a fake claimer from a tick implementation (the loop only calls tick). */
function fakeClaimer(tick: () => Promise<TickReport>): JobsClaimer {
  return { tick } as unknown as JobsClaimer;
}

describe('runWorkerLoop', () => {
  test('drains a backlog, then idles, then stops on abort', async () => {
    const controller = new AbortController();
    const reports: TickReport[] = [];
    let call = 0;
    const claimer = fakeClaimer(async () => {
      call += 1;
      return report(call === 1 ? 2 : 0);
    });
    await runWorkerLoop(claimer, {
      pollIntervalMs: 5,
      signal: controller.signal,
      onTick: (r) => {
        reports.push(r);
        if (reports.length === 3) controller.abort();
      },
    });
    assert.equal(reports.length, 3);
    assert.equal(reports[0]?.claimed, 2);
    assert.equal(reports[1]?.claimed, 0);
  });

  test('reports a throwing tick via onError and continues', async () => {
    const controller = new AbortController();
    const errors: unknown[] = [];
    let call = 0;
    const claimer = fakeClaimer(async () => {
      call += 1;
      if (call === 1) throw new Error('boom');
      controller.abort();
      return report(0);
    });
    await runWorkerLoop(claimer, {
      pollIntervalMs: 5,
      signal: controller.signal,
      onError: (e) => errors.push(e),
    });
    assert.equal(errors.length, 1);
    assert.match((errors[0] as Error).message, /boom/);
  });

  test('returns immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await runWorkerLoop(
      fakeClaimer(async () => {
        called = true;
        return report(0);
      }),
      { signal: controller.signal },
    );
    assert.equal(called, false);
  });

  test('aborting during a tick short-circuits the idle sleep', async () => {
    // tick aborts synchronously and returns an empty batch, so sleep is entered
    // with an already-aborted signal (its early-return path), then the loop exits.
    const controller = new AbortController();
    let calls = 0;
    await runWorkerLoop(
      fakeClaimer(async () => {
        calls += 1;
        controller.abort();
        return report(0);
      }),
      { pollIntervalMs: 5, signal: controller.signal },
    );
    assert.equal(calls, 1);
  });

  test('uses the default poll interval and is abortable mid-sleep', async () => {
    const controller = new AbortController();
    await runWorkerLoop(
      fakeClaimer(async () => {
        // Abort after this tick so the default 2s sleep is cut short by the
        // abort listener rather than the timer.
        queueMicrotask(() => controller.abort());
        return report(0);
      }),
      { signal: controller.signal },
    );
    assert.ok(controller.signal.aborted);
  });

  test('forwards runner overrides to every tick', async () => {
    const controller = new AbortController();
    const seen: unknown[] = [];
    const claimer = {
      tick: async (overrides: unknown) => {
        seen.push(overrides);
        controller.abort();
        return report(0);
      },
    } as unknown as JobsClaimer;
    await runWorkerLoop(claimer, {
      pollIntervalMs: 5,
      signal: controller.signal,
      runner: { batchSize: 7 },
    });
    assert.deepEqual(seen, [{ batchSize: 7 }]);
  });

  test('a non-empty batch loops immediately, without the idle poll wait', async () => {
    // The whole point of the loop: when a tick claims work it re-ticks at once
    // to drain the backlog, and only waits when there is nothing to claim.
    // Three back-to-back claiming ticks finish far inside a 1s interval — a loop
    // that waited on a non-empty batch (inverting or forcing the sleep branch)
    // could not.
    const controller = new AbortController();
    let calls = 0;
    const start = Date.now();
    await runWorkerLoop(
      fakeClaimer(async () => {
        calls += 1;
        if (calls === 3) controller.abort();
        return report(1);
      }),
      { pollIntervalMs: 1_000, signal: controller.signal },
    );
    assert.equal(calls, 3);
    assert.ok(
      Date.now() - start < 250,
      'a non-empty batch must not wait the poll interval',
    );
  });

  test('an empty batch waits the poll interval between ticks', async () => {
    // The mirror of the above: with nothing to claim the loop must space ticks
    // by pollIntervalMs, not spin. Three idle ticks at a 20ms interval take at
    // least ~40ms of real waiting (two full inter-tick sleeps); a loop that
    // skipped the wait branch would burn through them in ~0ms.
    const controller = new AbortController();
    let calls = 0;
    const start = Date.now();
    await runWorkerLoop(
      fakeClaimer(async () => {
        calls += 1;
        if (calls === 3) controller.abort();
        return report(0);
      }),
      { pollIntervalMs: 20, signal: controller.signal },
    );
    assert.equal(calls, 3);
    assert.ok(
      Date.now() - start >= 35,
      'an empty batch must wait between ticks',
    );
  });
});
