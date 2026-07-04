---
sidebar_position: 4
title: Testing
---

# Testing

`@nest-native/jobs/testing` ships two helpers that keep job tests hermetic —
no worker loop, no timers, no external services. On SQLite the whole stack
(store + claimer + handlers) runs in-memory.

## drainJobs

```ts
function drainJobs(claimer: JobsClaimer, options?: DrainJobsOptions): Promise<TickReport>;

interface DrainJobsOptions {
  runner?: RunnerConfig; // overrides applied to every tick
  maxTicks?: number;     // safety valve, default 100 — throws if exceeded
}
```

"Run everything currently due" in one await: it ticks the claimer until a tick
claims nothing and returns the aggregated report.

```ts
import { drainJobs } from '@nest-native/jobs/testing';

await userService.register('u-1', 'ada@example.com');

const report = await drainJobs(app.get(JobsClaimer));
expect(report.completed).toBe(1);
```

Jobs a tick reschedules into the future (retry backoff, `delayMs`) are not due,
so a drain settles even while retries are pending — wait past the delay and
drain again to run them. If a job keeps retrying with **no** delay, the
`maxTicks` valve throws instead of spinning forever.

## RecordingJobHandler

```ts
class RecordingJobHandler implements JobHandler {
  handle(payload, ctx): void;                    // records, then throws if armed
  executions(): readonly RecordedJobExecution[]; // every execution, in order
  failNextWith(error: Error): void;              // throw once, then succeed
  failWith(error: Error): void;                  // throw persistently
  clearFailure(): void;
  reset(): void;
}

interface RecordedJobExecution {
  payload: Record<string, unknown>;
  ctx: JobContext; // { jobId, attempt }
}
```

Subclass it to attach the decorator — the subclass is a normal provider, so the
explorer discovers it and your test can inspect it:

```ts
import { JobHandler } from '@nest-native/jobs';
import { RecordingJobHandler } from '@nest-native/jobs/testing';

@JobHandler('email.welcome')
@Injectable()
class WelcomeEmailHandler extends RecordingJobHandler {}

// in the test
const handler = app.get(WelcomeEmailHandler);
handler.failNextWith(new RetryableError('flaky', 0));

await userService.register('u-1', 'ada@example.com');
const report = await drainJobs(app.get(JobsClaimer));

expect(report).toEqual({ claimed: 2, completed: 1, retried: 1, failed: 0 });
expect(handler.executions()).toHaveLength(2);
expect(handler.executions()[1].ctx.attempt).toBe(2);
```

Executions are recorded **before** an armed failure is thrown, so
`executions()` reflects every attempt the claimer made — exactly what you want
when asserting retry behavior.

## A full in-memory fixture

The engine's own test suite boots a real Nest application context on an
in-memory better-sqlite3 database — the same fixture works in your app's tests:

```ts
const raw = new Database(':memory:');
raw.exec(JOBS_DDL); // your drizzle-kit migration output
const db = drizzle(raw);

const app = await NestFactory.createApplicationContext(
  AppTestModule.register(db), // ClsModule + JobsModule.forRoot + your providers
  { logger: false },
);

// enqueue via your @Transactional services, then:
await drainJobs(app.get(JobsClaimer));
```

Because the claimer only acts when you tick it, tests stay deterministic: no
sleeping for poll intervals, no races. For time-based behavior (`delayMs`,
`runAt`), enqueue with a small delay and `await setTimeout(...)` past it — or
assert the negative first (`tick()` claims 0) like the showcase smoke does.
