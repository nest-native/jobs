---
sidebar_position: 1
title: Introduction
---

# @nest-native/jobs

Background jobs for NestJS **without Redis** — a Drizzle-backed job queue
(SQLite, Postgres, and MySQL) with transactional enqueue, retries, delayed and
unique jobs.

:::note v0.x — early but stable
The producer, claimer, handler discovery, and the three Drizzle stores are
implemented and tested at 100% coverage. This is a community project in the
`nest-native` family and is **not** affiliated with the NestJS core team.
:::

## The problem it solves

Most NestJS apps grow a first background job long before they need a queueing
*system*: send a welcome email after signup, generate a report, retry a flaky
webhook. The official NestJS answer is `@nestjs/bullmq` — which means
**operating Redis** for what is often a handful of jobs a minute.

And because Redis is a second system, the classic **dual-write bug** appears on
day one: the signup transaction commits but the process crashes before
`queue.add()` — the email is never sent. Or `queue.add()` succeeds and the
transaction rolls back — you welcome a user that does not exist.

`@nest-native/jobs` stores jobs in the **same Drizzle database your app
already has**:

- **Transactional enqueue** — `enqueue()` inserts the job row *inside your
  business transaction* (via
  [`@nestjs-cls/transactional`](https://www.npmjs.com/package/@nestjs-cls/transactional)).
  The job exists if and only if your writes committed.
- **Nest-native execution** — declare a class with
  `@JobHandler('email.welcome')`, register it as a provider, and the claimer
  dispatches to it with full DI. Handlers are discovered at bootstrap;
  duplicate names throw at startup.
- **Retries, delays, priorities, unique jobs** — jittered exponential backoff
  (or `RetryableError`'s explicit `delayMs`), `PermanentError` to fail fast,
  `runAt`/`delayMs` scheduling, `priority` ordering, and `uniqueKey` dedup
  among active jobs.
- **Zero runtime dependencies** — everything (Nest, Drizzle, your driver) is a
  peer you already installed.

## Entry points

| Import | Contents |
| --- | --- |
| `@nest-native/jobs` | core engine — `JobsService` (enqueue), `JobsClaimer` + `runWorkerLoop`, `@JobHandler` + `JobsHandlerExplorer`, `RetryableError`/`PermanentError`, the `JobStore` seam, `JobsModule` |
| `@nest-native/jobs/sqlite` | better-sqlite3 (synchronous) store + the `jobs` table definition |
| `@nest-native/jobs/postgres` | node-postgres (asynchronous) store + table definition |
| `@nest-native/jobs/mysql` | mysql2 (asynchronous) store + table definition |
| `@nest-native/jobs/testing` | `drainJobs` + `RecordingJobHandler` for hermetic tests |

## Honest comparison

| | BullMQ (`@nestjs/bullmq`) | pg-boss | `@nest-native/jobs` |
| --- | --- | --- | --- |
| Backing store | Redis (required) | Postgres only | the Drizzle DB you already run — SQLite, Postgres, or MySQL |
| NestJS integration | official wrapper module | none (framework-agnostic) | native — module, DI, `@JobHandler` decorators |
| Enqueue in your DB transaction | no (Redis is a second system) | yes (raw SQL in your tx) | yes — first-class, via `@nestjs-cls/transactional` |
| Delivery | Redis push (blocking ops) | polling + LISTEN/NOTIFY | polling claimer |
| Throughput | very high | high | right-sized — polling batches, fine for most apps' background work |
| Repeatable / cron jobs | yes | yes | no (non-goal — use `@nestjs/schedule`) |
| Dashboards, rate limiting | yes | partial | no |
| Runtime dependencies | Redis server + client | `pg` | zero (peers you already have) |

If you need tens of thousands of jobs per second, sandboxed processors, or a
dashboard, use BullMQ — it is excellent at that. If you run Postgres without
Nest, pg-boss is battle-tested. This library is for the large middle: NestJS +
Drizzle apps that want reliable background jobs **without operating another
system**.

## Non-goals (v0.1)

- **Cron / repeatable jobs** — `@nestjs/schedule` already does this well;
  combine it with `enqueue()` if you want scheduled work to flow through the
  queue.
- **Dashboards / UI**, **rate limiting**, **concurrency groups**.
- **LISTEN/NOTIFY push** — the claimer polls; `pollIntervalMs` is your latency
  knob.
- **Redis-class throughput** — this is a polling claimer over your relational
  DB, by design.

## Delivery semantics

Delivery is **at-least-once**: a worker crash mid-job leaves the row in
`processing`, and after `stuckTimeoutMs` another claim reclaims and re-runs it.
Make handlers idempotent — key side effects on `ctx.jobId` (the
[showcase sample](./samples.md) demonstrates the `ON CONFLICT DO NOTHING`
pattern).

Continue with the [Quick Start](./quick-start.md).
