---
sidebar_position: 4
---

# Cron Schedules

Since 0.2.0, recurring work is driven by **rows in your database**, not
in-memory timers: a `job_schedules` row says *"enqueue job X on this cron"*,
survives restarts, is safe across multiple instances, and can be edited at
runtime. (`@nestjs/schedule` timers die with the process and double-fire when
you scale out — that is the gap this closes.)

## Opt in

Schedules are **opt-in**. Add the `jobSchedules` table for your dialect to
your Drizzle schema (generate the migration with drizzle-kit) and pass a
schedule store to the module — without it, nothing about 0.1 behavior changes:

```ts
import { JobsModule } from '@nest-native/jobs';
import { SqliteJobStore, SqliteScheduleStore, jobs, jobSchedules } from '@nest-native/jobs/sqlite';

JobsModule.forRoot({
  drizzleInstanceToken: DRIZZLE,
  store: new SqliteJobStore(),
  scheduleStore: new SqliteScheduleStore(), // ← schedules on
});
```

`PostgresScheduleStore` (`@nest-native/jobs/postgres`) and
`MysqlScheduleStore` (`@nest-native/jobs/mysql`) work identically.

## Define a schedule

`JobSchedulesService` is the injectable CRUD — deliberately **no REST
controller and no admin UI**; expose it from your own endpoints if you want
runtime editing over HTTP:

```ts
@Injectable()
export class ReportsSetup implements OnApplicationBootstrap {
  constructor(private readonly schedules: JobSchedulesService<SqliteScheduleStore>) {}

  onApplicationBootstrap() {
    this.schedules.upsert({
      name: 'nightly-report',        // unique schedule identity (upsert key)
      jobName: 'report.build',       // the @JobHandler each occurrence runs
      payload: { kind: 'daily' },
      cron: '0 3 * * *',             // croner syntax
      timezone: 'America/Sao_Paulo', // IANA; omitted = UTC
      uniqueKey: 'nightly-report',   // optional overlap guard (see below)
    });
  }
}
```

`upsert` validates the cron expression (and timezone) at call time — invalid
schedules throw `InvalidScheduleError` and never reach the table. Like
`enqueue`, `upsert` returns the store's native shape (synchronous on sqlite)
and rides the caller's `@Transactional` context.

Manage at runtime: `get(name)`, `list()`, `setEnabled(name, enabled)`,
`remove(name)`.

## How firing works

The claimer's tick drains due schedules **before** claiming jobs, so an
occurrence is claimable by the very tick that fired it. Firing is an atomic
compare-and-swap on `next_run_at` plus the occurrence insert in **one store
transaction** — with several instances polling, exactly one wins each
occurrence, on every dialect. `TickReport.scheduled` counts the wins.

**Misfire policy (fixed):** missed occurrences are skipped — at most one
catch-up. `next_run_at` always advances from *now*; a schedule that was down
for a week fires once, then resumes its normal rhythm. Re-enabling a
long-disabled schedule likewise re-arms from the next FUTURE occurrence (no
burst).

**Overlap guard:** give the schedule a `uniqueKey` and every occurrence
enqueues with it — while one occurrence is still pending/processing, the next
becomes a dedup no-op through the normal
[uniqueKey contract](./api-reference.md#the-uniquekey-contract). No pile-ups
behind a slow handler.

**Failure isolation:** the schedule row is the source of truth. An occurrence
exhausting its retries marks that *job* failed and never touches the
schedule — the next occurrence fires on time. A schedule whose cron can no
longer be evaluated (hand-edited row) is disabled with the error recorded in
its `last_error` column instead of crashing the worker loop.

Timezones and DST are delegated to [croner](https://www.npmjs.com/package/croner)
— the package's single runtime dependency. The default timezone is **UTC**,
not server-local, so a schedule means the same thing on every instance.
