import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import { Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { PermanentError, RetryableError } from '../errors';
import type { JobContext, JobRow, JobStore } from '../interfaces';
import type { JobHandler } from '../job-handler.decorator';
import {
  DEFAULT_RUNNER_CONFIG,
  JobsClaimer,
  resolveRunnerConfig,
} from '../jobs-claimer.service';
import type { JobsHandlerExplorer } from '../jobs-handler.explorer';
import { jobs, SqliteJobStore } from '../dialects/sqlite';

// Every outcome the claimer records is fenced on the claim it holds: a job
// another worker took over after the stuck timeout is reported lost, never
// overwritten (see JobClaim).
const DDL = `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 10,
  unique_key TEXT, priority INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL,
  claimed_at TEXT, claimed_by TEXT, processed_at TEXT, last_error TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX jobs_name_unique_key_unique ON jobs (name, unique_key);
`;

let db: BetterSQLite3Database<Record<string, never>>;
const real = new SqliteJobStore();
const runs: { id: string; attempt: number }[] = [];

beforeEach(() => {
  const sqlite = new Database(':memory:');
  sqlite.exec(DDL);
  db = drizzle(sqlite);
  runs.length = 0;
});

const fetchRow = (id: string) => db.select().from(jobs).where(eq(jobs.id, id)).get();
const enqueue = (name = 'work'): JobRow => real.enqueue(db, { name, payload: {} });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A claimer whose every job runs `handle` (recorded in `runs` first). */
function claimer(
  handle: (ctx: JobContext) => unknown = () => undefined,
  store: JobStore = real,
): JobsClaimer {
  const handler: JobHandler = {
    handle: async (_payload, ctx) => {
      runs.push({ id: ctx.jobId, attempt: ctx.attempt });
      await handle(ctx);
    },
  };
  const explorer = { get: () => handler } as unknown as JobsHandlerExplorer;
  return new JobsClaimer(db, store, explorer);
}

function captureLogs(): { warns: string[]; errors: string[]; restore: () => void } {
  const warns: string[] = [];
  const errors: string[] = [];
  Logger.overrideLogger({
    log: () => {},
    error: (message: unknown) => errors.push(String(message)),
    warn: (message: unknown) => warns.push(String(message)),
    debug: () => {},
    verbose: () => {},
  });
  return { warns, errors, restore: () => Logger.overrideLogger(false) };
}

describe('JobsClaimer (claims)', () => {
  // Every transition the claimer makes must carry the claim it holds, so each
  // outcome is driven under a non-default worker id.
  for (const [name, failure, status] of [
    ['completes', undefined, 'completed'],
    ['retries a RetryableError', new RetryableError('later'), 'pending'],
    ['retries a generic error', new Error('flaky'), 'pending'],
    ['fails a PermanentError', new PermanentError('malformed'), 'failed'],
  ] as const) {
    test(`a tick under its own workerInstanceId ${name}`, async () => {
      const row = enqueue();
      const logs = captureLogs();
      try {
        const report = await claimer(() => {
          if (failure) throw failure;
        }).tick({ workerInstanceId: 'pod-7' });
        assert.equal(report.lost, 0);
      } finally {
        logs.restore();
      }
      assert.equal(fetchRow(row.id)?.status, status);
    });
  }

  test('an undefined workerInstanceId override keeps the default instead of stranding the job', async () => {
    // e.g. `{ workerInstanceId: process.env.WORKER_ID }` with the variable
    // unset. Claimed under no owner, the job would match no transition, stay
    // processing, and run again after every stuck timeout.
    const row = enqueue();
    const jobsClaimer = claimer();
    const report = await jobsClaimer.tick({ workerInstanceId: undefined });
    assert.deepEqual(report, { scheduled: 0, claimed: 1, completed: 1, retried: 0, failed: 0, lost: 0 });
    assert.equal(fetchRow(row.id)?.claimedBy, DEFAULT_RUNNER_CONFIG.workerInstanceId);
    assert.equal((await jobsClaimer.tick({ workerInstanceId: undefined })).claimed, 0);
    assert.equal(runs.length, 1);
  });

  // Another worker reclaims the job while this one is running it (its claim
  // outlived stuckTimeoutMs), then the handler settles with `failure`.
  const reclaimDuringRun = (failure?: Error) => (ctx: JobContext) => {
    db.update(jobs)
      .set({ claimedBy: 'other-worker', claimedAt: new Date(Date.now() + 1).toISOString() })
      .where(eq(jobs.id, ctx.jobId))
      .run();
    if (failure) throw failure;
  };

  for (const [outcome, failure, warning] of [
    ['completed', undefined, 'ran, but another claim took it over before it was marked completed; the new owner records its outcome and may run it again'],
    ['retried', new RetryableError('later'), 'failed (later), but another claim took it over before it was marked retried; leaving it to the new owner'],
    ['failed', new PermanentError('malformed'), 'failed (malformed), but another claim took it over before it was marked failed; leaving it to the new owner'],
  ] as const) {
    test(`a claim taken over mid-run is reported lost, not ${outcome}`, async () => {
      const row = enqueue();
      const logs = captureLogs();
      try {
        const report = await claimer(reclaimDuringRun(failure)).tick();
        assert.deepEqual(report, { scheduled: 0, claimed: 1, completed: 0, retried: 0, failed: 0, lost: 1 });
      } finally {
        logs.restore();
      }
      // The new owner's claim is untouched, and nothing records a failure it did not see.
      const after = fetchRow(row.id);
      assert.equal(after?.status, 'processing');
      assert.equal(after?.claimedBy, 'other-worker');
      assert.equal(after?.attempts, 0);
      // The handler's error is kept even though no row recorded it.
      assert.deepEqual(logs.warns, [`job ${row.id} ("work") ${warning}`]);
    });
  }

  test('a generic error on the last attempt is fenced like any other failure', async () => {
    const row = real.enqueue(db, { name: 'work', payload: {}, maxAttempts: 1 });
    const logs = captureLogs();
    try {
      const report = await claimer(reclaimDuringRun(new Error('flaky'))).tick();
      assert.equal(report.lost, 1);
      assert.equal(report.failed, 0);
    } finally {
      logs.restore();
    }
    assert.equal(fetchRow(row.id)?.status, 'processing');
    // Only the settle warning: no "failed" line for a failure that was not recorded.
    assert.equal(logs.warns.length, 1);
    assert.match(logs.warns[0] ?? '', /before it was marked failed/);
  });

  test('a job whose claim expired while its batch was running is skipped, then run once', async () => {
    const rows = [enqueue('slow'), enqueue('late')];
    // Each run outlasts stuckTimeoutMs, so the next job's claim is already
    // reclaimable by another worker when its turn comes.
    const jobsClaimer = claimer(() => sleep(80));
    const logs = captureLogs();
    try {
      const report = await jobsClaimer.tick({ stuckTimeoutMs: 50 });
      assert.deepEqual(report, { scheduled: 0, claimed: 2, completed: 1, retried: 0, failed: 0, lost: 1 });
    } finally {
      logs.restore();
    }
    const [ran] = runs;
    const skipped = rows.find((r) => r.id !== ran?.id)!;
    assert.equal(fetchRow(ran!.id)?.status, 'completed');
    assert.equal(fetchRow(skipped.id)?.status, 'processing');
    assert.deepEqual(logs.warns, [
      `skipped 1 claimed job(s) [${skipped.id}]: the batch was held longer than stuckTimeoutMs (50 ms), so another worker may own them now; raise stuckTimeoutMs or lower batchSize`,
    ]);

    // Once stuck, the skipped job is reclaimed and run: each job ran once.
    await sleep(60);
    assert.equal((await jobsClaimer.tick({ stuckTimeoutMs: 50 })).completed, 1);
    assert.deepEqual(runs.map((r) => r.id).sort(), rows.map((r) => r.id).sort());
  });

  test('a claim slower than stuckTimeoutMs still runs the first job of its batch', async () => {
    // Ages count from the batch's arrival: measured from the claim stamp, a
    // slow claim would skip every job and the worker would never progress.
    enqueue();
    const store: JobStore = {
      enqueue: (handle, input) => real.enqueue(handle, input),
      claimBatch: async (handle, cfg) => {
        const rows = await real.claimBatch(handle, cfg);
        await sleep(30);
        return rows;
      },
      markCompleted: (handle, claim) => real.markCompleted(handle, claim),
      retry: (handle, claim, delayMs, lastError) => real.retry(handle, claim, delayMs, lastError),
      markFailed: (handle, claim, reason) => real.markFailed(handle, claim, reason),
    };
    const report = await claimer(undefined, store).tick({ stuckTimeoutMs: 10 });
    assert.equal(report.completed, 1);
    assert.equal(runs.length, 1);
  });

  test('failing to record a completion throws instead of retrying the job', async () => {
    // Treating it as a handler failure spent an attempt, and on the last one
    // marked a job that ran failed.
    const row = enqueue();
    const store = {
      claimBatch: (handle: unknown, cfg: Parameters<JobStore['claimBatch']>[1]) =>
        real.claimBatch(handle, cfg),
      markCompleted: () => Promise.reject(new Error('database went away')),
    } as unknown as JobStore;
    await assert.rejects(claimer(undefined, store).tick(), /database went away/);
    const after = fetchRow(row.id);
    assert.equal(after?.status, 'processing');
    assert.equal(after?.attempts, 0);
    assert.equal(runs.length, 1);
  });

  // A store whose first markCompleted fails, as a dropped connection would,
  // and whose `release` is the real one unless `release` says otherwise.
  const failingFirstCompletion = (release?: JobStore['release'] | null): JobStore => {
    let completions = 0;
    return {
      enqueue: (handle, input) => real.enqueue(handle, input),
      claimBatch: (handle, cfg) => real.claimBatch(handle, cfg),
      markCompleted: (handle, claim) =>
        (completions += 1) === 1
          ? Promise.reject(new Error('database went away'))
          : real.markCompleted(handle, claim),
      retry: (handle, claim, delayMs, lastError) => real.retry(handle, claim, delayMs, lastError),
      markFailed: (handle, claim, reason) => real.markFailed(handle, claim, reason),
      ...(release === null ? {} : { release: release ?? ((handle, claim) => real.release(handle, claim)) }),
    };
  };

  test('a failed transition hands the jobs that have not run back for the next claim', async () => {
    const rows = [enqueue('first'), enqueue('second'), enqueue('third')];
    const logs = captureLogs();
    try {
      await assert.rejects(claimer(undefined, failingFirstCompletion()).tick(), /database went away/);
    } finally {
      logs.restore();
    }
    assert.equal(runs.length, 1);
    const [ran] = runs;
    // The job that ran stays claimed: handing it back would run it again at once.
    assert.equal(fetchRow(ran!.id)?.status, 'processing');
    for (const row of rows.filter((r) => r.id !== ran!.id)) {
      const after = fetchRow(row.id);
      assert.equal(after?.status, 'pending');
      assert.equal(after?.claimedBy, null);
      assert.equal(after?.attempts, 0);
    }
    assert.deepEqual(logs.warns, [
      'handed back 2 job(s) that had not run after a failed transition, for the next claim to take',
    ]);
    // The next claim takes them straight away, without waiting for the stuck timeout.
    assert.equal((await claimer().tick()).completed, 2);
  });

  test('without a store release, the rest of the batch waits for the stuck timeout', async () => {
    const rows = [enqueue('first'), enqueue('second')];
    await assert.rejects(claimer(undefined, failingFirstCompletion(null)).tick(), /database went away/);
    assert.deepEqual(
      rows.map((row) => fetchRow(row.id)?.status),
      ['processing', 'processing'],
    );
  });

  test('a release that fails too keeps the original error', async () => {
    enqueue('first');
    enqueue('second');
    const logs = captureLogs();
    try {
      await assert.rejects(
        claimer(undefined, failingFirstCompletion(() => Promise.reject(new Error('still down')))).tick(),
        /database went away/,
      );
    } finally {
      logs.restore();
    }
    assert.deepEqual(logs.warns, [
      'could not hand back 1 job(s) that had not run after a failed transition (still down); they are reclaimed after stuckTimeoutMs',
    ]);
  });

  test('a job without a claim stamp is not handed back', async () => {
    const row = enqueue();
    const unstamped = { ...row, status: 'processing', claimedBy: null, claimedAt: null } as unknown as JobRow;
    let released = 0;
    const store: JobStore = {
      enqueue: (handle, input) => real.enqueue(handle, input),
      claimBatch: async (handle, cfg) => [...(await real.claimBatch(handle, cfg)), unstamped],
      markCompleted: () => Promise.reject(new Error('database went away')),
      retry: (handle, claim, delayMs, lastError) => real.retry(handle, claim, delayMs, lastError),
      markFailed: (handle, claim, reason) => real.markFailed(handle, claim, reason),
      release: () => {
        released += 1;
        return Promise.resolve(true);
      },
    };
    await assert.rejects(claimer(undefined, store).tick(), /database went away/);
    assert.equal(released, 0);
  });

  test('a job claimBatch returns without its claim stamp is neither run nor transitioned', async () => {
    const row = enqueue();
    const fresh = new Date().toISOString();
    for (const [stamp, shown] of [
      [{ claimedBy: null, claimedAt: fresh }, 'claimedBy Null'],
      [{ claimedBy: 'custom-store', claimedAt: null }, 'claimedAt Null'],
      // Rows straight from a driver, whose keys do not match the schema's.
      [{ claimedBy: undefined, claimedAt: fresh }, 'claimedBy Undefined'],
      [{ claimedBy: 'custom-store', claimedAt: undefined }, 'claimedAt Undefined'],
      // Not the string the claim wrote; a Date must not read like one in the log.
      [{ claimedBy: 'custom-store', claimedAt: new Date() }, 'claimedAt Date'],
      [{ claimedBy: 'custom-store', claimedAt: Date.now() }, 'claimedAt Number'],
      [{ claimedBy: 'custom-store', claimedAt: 1n }, 'claimedAt BigInt'],
      [{ claimedBy: 42, claimedAt: fresh }, 'claimedBy Number'],
    ] as const) {
      const unstamped = { ...row, status: 'processing', ...stamp } as unknown as JobRow;
      // A store that forgets to stamp: only claimBatch exists, so any
      // transition call would throw and fail the test.
      const store = { claimBatch: () => Promise.resolve([unstamped]) } as unknown as JobStore;
      const logs = captureLogs();
      try {
        const report = await claimer(undefined, store).tick();
        assert.deepEqual(report, { scheduled: 0, claimed: 1, completed: 0, retried: 0, failed: 0, lost: 1 });
      } finally {
        logs.restore();
      }
      assert.match(logs.errors[0] ?? '', /without a string claim stamp/);
      assert.ok(logs.errors[0]?.includes(shown), `${shown} in ${logs.errors[0]}`);
    }
    assert.equal(runs.length, 0);
  });

  test('a store that stamps claims in its own format runs the job under that stamp', async () => {
    // The claimer cannot judge a stamp's format or clock, so it does not try:
    // the store's own transitions match the stamp it wrote.
    const row = enqueue();
    const store: JobStore = {
      enqueue: (handle, input) => real.enqueue(handle, input),
      claimBatch: async (handle, cfg) => {
        const claimed = await real.claimBatch(handle, cfg);
        return claimed.map((claimedRow) => {
          const claimedAt = '2026-10-04 12:00:00.123';
          db.update(jobs).set({ claimedAt }).where(eq(jobs.id, claimedRow.id)).run();
          return { ...claimedRow, claimedAt };
        });
      },
      markCompleted: (handle, claim) => real.markCompleted(handle, claim),
      retry: (handle, claim, delayMs, lastError) => real.retry(handle, claim, delayMs, lastError),
      markFailed: (handle, claim, reason) => real.markFailed(handle, claim, reason),
    };
    const report = await claimer(undefined, store).tick();
    assert.deepEqual(report, { scheduled: 0, claimed: 1, completed: 1, retried: 0, failed: 0, lost: 0 });
    assert.equal(fetchRow(row.id)?.status, 'completed');
  });
});

describe('resolveRunnerConfig', () => {
  test('applies overrides over the defaults; an undefined override keeps the default', () => {
    assert.deepEqual(resolveRunnerConfig(), DEFAULT_RUNNER_CONFIG);
    assert.deepEqual(resolveRunnerConfig({ batchSize: 5, workerInstanceId: undefined }), {
      ...DEFAULT_RUNNER_CONFIG,
      batchSize: 5,
    });
    // A plain JavaScript caller may pass null for "no overrides".
    assert.deepEqual(resolveRunnerConfig(null), DEFAULT_RUNNER_CONFIG);
  });

  test('names a string value as a string, as an env-backed config hands it over', () => {
    assert.throws(
      () => resolveRunnerConfig({ stuckTimeoutMs: '60000' as unknown as number }),
      /stuckTimeoutMs must be a positive number of milliseconds within Date's range, got "60000" \(string\)/,
    );
  });

  for (const [name, overrides] of [
    ['an empty workerInstanceId', { workerInstanceId: '' }],
    ['a blank workerInstanceId', { workerInstanceId: '  ' }],
    ['a non-string workerInstanceId', { workerInstanceId: 7 as unknown as string }],
    ['a zero batchSize', { batchSize: 0 }],
    ['a fractional batchSize', { batchSize: 1.5 }],
    ['a zero stuckTimeoutMs', { stuckTimeoutMs: 0 }],
    ['an infinite stuckTimeoutMs', { stuckTimeoutMs: Number.POSITIVE_INFINITY }],
    ['a stuckTimeoutMs past Date range', { stuckTimeoutMs: Number.MAX_SAFE_INTEGER }],
    ['a negative baseBackoffMs', { baseBackoffMs: -1 }],
    ['a NaN maxBackoffMs', { maxBackoffMs: Number.NaN }],
  ] as const) {
    test(`rejects ${name}`, () => {
      assert.throws(() => resolveRunnerConfig(overrides), /^\w+Error: runner \w+ must be/);
    });
  }

  test('tick rejects an invalid config before claiming anything', async () => {
    const row = enqueue();
    await assert.rejects(claimer().tick({ batchSize: 0 }), /batchSize must be a positive integer/);
    assert.equal(fetchRow(row.id)?.status, 'pending');
  });
});
