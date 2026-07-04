import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { NestFactory } from '@nestjs/core';
import {
  JobsClaimer,
  JobsService,
  runWorkerLoop,
  type TickReport,
} from '@nest-native/jobs';
import type { SqliteJobStore } from '@nest-native/jobs/sqlite';
import { drainJobs } from '@nest-native/jobs/testing';
import { createDatabase } from '../src/database';
import { AppModule } from '../src/app.module';
import { UserService } from '../src/user.service';

async function main(): Promise<void> {
  const { db, sqlite } = createDatabase();
  const app = await NestFactory.createApplicationContext(AppModule.register(db), {
    logger: false,
  });
  const claimer = app.get(JobsClaimer);
  const jobs = app.get(JobsService<SqliteJobStore>);
  const count = (t: string): number =>
    (sqlite.prepare(`SELECT count(*) c FROM ${t}`).get() as { c: number }).c;
  const jobById = (id: string) =>
    sqlite.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as {
      status: string;
      attempts: number;
      unique_key: string | null;
      last_error: string | null;
    };

  // 1. Transactional enqueue: the user row and the job commit atomically, and
  //    the claimer runs the @JobHandler immediately (drained via drainJobs).
  const welcome = await app.get(UserService).register('u-1', 'ada@example.com');
  assert.equal(count('users'), 1, 'user persisted');
  assert.equal(jobById(welcome.id).status, 'pending', 'job enqueued in the same tx');
  let report = await drainJobs(claimer);
  assert.equal(report.completed, 1, 'welcome email job completed');
  assert.equal(count('sent_emails'), 1, 'handler side effect landed');
  assert.equal(jobById(welcome.id).status, 'completed');
  assert.equal(jobById(welcome.id).unique_key, null, 'terminal job released its key');

  // 2. uniqueKey dedup: while a welcome email for the same address is active,
  //    a duplicate enqueue is a no-op returning the EXISTING row.
  const first = await app.get(UserService).register('u-2', 'grace@example.com');
  const dup = jobs.enqueue({
    name: 'email.welcome',
    payload: { email: 'grace@example.com' },
    uniqueKey: 'welcome:grace@example.com',
  });
  assert.equal(dup.id, first.id, 'duplicate enqueue returned the existing row');
  const keyOwners = sqlite
    .prepare('SELECT count(*) c FROM jobs WHERE unique_key = ?')
    .get('welcome:grace@example.com') as { c: number };
  assert.equal(keyOwners.c, 1, 'a single active row owns the key');
  await drainJobs(claimer);

  // 3. delayMs: the job is NOT claimable before its due time, then runs.
  const delayed = jobs.enqueue({
    name: 'email.welcome',
    payload: { email: 'linus@example.com' },
    delayMs: 150,
  });
  const early: TickReport = await claimer.tick();
  assert.equal(early.claimed, 0, 'delayed job not claimed before its time');
  assert.equal(jobById(delayed.id).status, 'pending');
  await sleep(200);
  report = await drainJobs(claimer);
  assert.equal(report.completed, 1, 'delayed job ran after its due time');
  assert.equal(jobById(delayed.id).status, 'completed');

  // 4. Transient failure: the first attempt throws RetryableError(25ms); the
  //    retry (attempt 2) succeeds. The drain sees the retry, the second drain
  //    (after the delay) completes it.
  const flaky = jobs.enqueue({
    name: 'report.generate',
    payload: { title: 'Q3 numbers' },
  });
  report = await drainJobs(claimer);
  assert.equal(report.retried, 1, 'first attempt was retried');
  assert.equal(count('reports'), 0, 'no report yet');
  assert.equal(jobById(flaky.id).status, 'pending');
  assert.equal(jobById(flaky.id).attempts, 1, 'one failed attempt recorded');
  await sleep(50);
  report = await drainJobs(claimer);
  assert.equal(report.completed, 1, 'second attempt (attempt=2) completed');
  assert.equal(count('reports'), 1, 'report written exactly once');

  // 5. Permanent failure: the handler throws PermanentError — the job fails
  //    immediately, no retries burned.
  const doomed = jobs.enqueue({
    name: 'billing.charge',
    payload: { customerId: 'c-1' },
  });
  report = await drainJobs(claimer);
  assert.deepEqual(
    report,
    { claimed: 1, completed: 0, retried: 0, failed: 1 },
    'permanent error failed in a single tick',
  );
  const failed = jobById(doomed.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.last_error ?? '', /do not retry/);

  // 6. The worker loop: runs in the background, picks up a job enqueued after
  //    it started, and stops gracefully on abort.
  const controller = new AbortController();
  const ticks: TickReport[] = [];
  const loop = runWorkerLoop(claimer, {
    pollIntervalMs: 20,
    signal: controller.signal,
    onTick: (r) => ticks.push(r),
  });
  jobs.enqueue({ name: 'email.welcome', payload: { email: 'margaret@example.com' } });
  const deadline = Date.now() + 5_000;
  while (count('sent_emails') < 4 && Date.now() < deadline) {
    await sleep(10);
  }
  assert.equal(count('sent_emails'), 4, 'worker loop processed the live enqueue');
  controller.abort();
  await loop; // resolves — graceful shutdown, no dangling timers
  assert.ok(ticks.some((r) => r.completed > 0), 'loop reported its work');

  await app.close();
  sqlite.close();
  console.log(
    'Showcase smoke passed: transactional enqueue -> @JobHandler dispatch, ' +
      'uniqueKey dedup, delayed run, retry-then-succeed, permanent fail, ' +
      'graceful worker loop.',
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
