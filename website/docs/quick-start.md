---
sidebar_position: 2
title: Quick Start
---

# Quick Start

This walkthrough wires the queue end to end on **SQLite** with better-sqlite3 —
the same path the [`00-showcase` sample](./samples.md) proves. The Postgres and
MySQL dialects are identical except for the import path and `await`ing
`enqueue`; see the [API Reference](./api-reference.md).

## 1. Install

```bash
npm install @nest-native/jobs
# plus your driver + transaction library (peer dependencies):
npm install drizzle-orm @nestjs-cls/transactional @nestjs-cls/transactional-adapter-drizzle-orm nestjs-cls better-sqlite3
```

The published package declares **zero runtime dependencies** — Nest, Drizzle,
and your driver are peer dependencies you already control.

## 2. Add the `jobs` table to your schema

Import the dialect's table definition and add it to your Drizzle schema
alongside your business tables, then generate a migration with drizzle-kit.

```ts title="schema.ts"
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { jobs } from '@nest-native/jobs/sqlite';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
});

export const schema = { jobs, users };
```

## 3. Wire CLS + the module

Register `@nestjs-cls/transactional` with the Drizzle adapter (this is what
makes `enqueue` share your business transaction), then `JobsModule.forRoot`
with the dialect store:

```ts title="app.module.ts"
import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { JobsModule } from '@nest-native/jobs';
import { SqliteJobStore } from '@nest-native/jobs/sqlite';
import { DRIZZLE } from './database'; // your app's Drizzle provider token

@Module({
  imports: [
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
    }),
    JobsModule.forRoot({
      drizzleInstanceToken: DRIZZLE,
      store: new SqliteJobStore(),
    }),
  ],
})
export class AppModule {}
```

## 4. Enqueue inside your business transaction

```ts title="user.service.ts"
import { Injectable } from '@nestjs/common';
import { InjectTransaction, Transactional } from '@nestjs-cls/transactional';
import { JobsService } from '@nest-native/jobs';
import type { SqliteJobStore } from '@nest-native/jobs/sqlite';

interface WelcomeEmailPayload {
  email: string;
}

@Injectable()
export class UserService {
  constructor(
    @InjectTransaction() private readonly db: AppDatabase,
    private readonly jobs: JobsService<SqliteJobStore>,
  ) {}

  @Transactional()
  register(id: string, email: string) {
    this.db.insert(users).values({ id, email }).run();
    const payload: WelcomeEmailPayload = { email };
    this.jobs.enqueue({
      name: 'email.welcome',
      payload,
      uniqueKey: `welcome:${email}`, // dedup among active jobs
    });
    // both rows commit atomically; a throw rolls both back
  }
}
```

On sqlite the body is synchronous and `enqueue` returns the `JobRow` directly;
on Postgres/MySQL, `await` it. Scheduling options: `runAt` (absolute) **xor**
`delayMs` (relative) — setting both throws; `priority` (higher first);
`maxAttempts` (default 10).

## 5. Handle the job

```ts title="welcome-email.handler.ts"
import { Injectable } from '@nestjs/common';
import { JobHandler, type JobContext } from '@nest-native/jobs';

@JobHandler('email.welcome')
@Injectable()
export class WelcomeEmailHandler implements JobHandler {
  constructor(private readonly mailer: MailerService) {}

  async handle(payload: Record<string, unknown>, ctx: JobContext) {
    // Delivery is at-least-once: key side effects on ctx.jobId, or make
    // them naturally idempotent.
    await this.mailer.send(String(payload.email));
  }
}
```

Register the class as a provider in any module. The explorer discovers every
`@JobHandler` at bootstrap; two classes claiming the same name fail the app at
startup.

Inside a handler, throw to steer retries:

- `throw new RetryableError('rate limited', 30_000)` — retry in 30s (omit the
  delay for jittered exponential backoff);
- `throw new PermanentError('malformed payload')` — fail now, no retries;
- any other throw — retry with backoff until `maxAttempts`, then fail.

## 6. Run the worker

```ts title="main.ts"
import { JobsClaimer, runWorkerLoop } from '@nest-native/jobs';

const app = await NestFactory.create(AppModule);
await app.listen(3000);

// Same process, or a dedicated worker process — your call.
const controller = new AbortController();
void runWorkerLoop(app.get(JobsClaimer), {
  pollIntervalMs: 1_000,
  signal: controller.signal,
  onError: (error) => logger.error(error),
});
app.enableShutdownHooks();
process.on('SIGTERM', () => controller.abort());
```

The loop drains due jobs in batches (priority first, oldest due first,
reclaiming jobs stuck in `processing`), then idles for `pollIntervalMs` when
the queue is empty. Aborting the signal stops it cleanly.

That's the whole system: one table, your transaction, your handlers, a poll
loop. See the [Testing guide](./testing.md) for `drainJobs` and the
[API Reference](./api-reference.md) for every knob.
