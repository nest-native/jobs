# @nest-native/jobs

<p align="center">Background jobs for NestJS without Redis — a Drizzle-backed job queue (SQLite, Postgres &amp; MySQL) with transactional enqueue, retries, delayed and unique jobs.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nest-native/jobs"><img src="https://img.shields.io/npm/v/@nest-native/jobs.svg" alt="NPM Version" /></a>
  <a href="https://www.npmjs.com/package/@nest-native/jobs"><img src="https://img.shields.io/npm/dm/@nest-native/jobs.svg" alt="NPM Downloads" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="Package License" /></a>
  <img src="https://img.shields.io/badge/coverage-100%25-brightgreen.svg" alt="Test Coverage" />
  <a href="https://nest-native.dev/jobs/"><img src="https://img.shields.io/badge/docs-%40nest--native%2Fjobs-0f766e.svg" alt="Documentation" /></a>
</p>

> [!NOTE]
> **v0.x — early but stable.** The producer, claimer, handler discovery, and the three Drizzle stores are implemented and tested at 100% coverage. SQLite, Postgres, and MySQL are supported.

## The problem it solves

Most NestJS apps grow a first background job long before they need a queueing *system*: send a welcome email after signup, generate a report, retry a flaky webhook. The official NestJS answer is `@nestjs/bullmq` — which means **operating Redis** for what is often a handful of jobs a minute. And because Redis is a second system, the classic dual-write bug appears on day one: the signup commits but the process crashes before `queue.add()` — the email is never sent. Or `queue.add()` succeeds and the transaction rolls back — a welcome email for a user that does not exist.

`@nest-native/jobs` stores jobs in the **same Drizzle database your app already has**:

- **Transactional enqueue** — `enqueue()` inserts the job row *inside your business transaction* (via [`@nestjs-cls/transactional`](https://www.npmjs.com/package/@nestjs-cls/transactional)). The job exists if and only if your writes committed.
- **Nest-native execution** — declare a class with `@JobHandler('email.welcome')`, register it as a provider, and the claimer dispatches to it with full DI. Handlers are discovered at bootstrap; duplicate names throw at startup.
- **Retries, delays, priorities, unique jobs** — jittered exponential backoff (or `RetryableError`'s explicit `delayMs`), `PermanentError` to fail fast, `runAt`/`delayMs` scheduling, `priority` ordering, and `uniqueKey` dedup among active jobs.
- **Zero runtime dependencies** — everything (Nest, Drizzle, your driver) is a peer you already installed.

## Install

```bash
npm install @nest-native/jobs
# plus your driver (peer dependencies):
npm install drizzle-orm @nestjs-cls/transactional better-sqlite3   # or pg / mysql2
```

## Entry points

| Import | Contents |
| --- | --- |
| `@nest-native/jobs` | core engine — `JobsService` (enqueue), `JobsClaimer` + `runWorkerLoop`, `@JobHandler` + `JobsHandlerExplorer`, `RetryableError`/`PermanentError`, the `JobStore` seam, `JobsModule` |
| `@nest-native/jobs/sqlite` | better-sqlite3 (synchronous) store + the `jobs` table definition |
| `@nest-native/jobs/postgres` | node-postgres (async) store + table definition |
| `@nest-native/jobs/mysql` | mysql2 (async) store + table definition |
| `@nest-native/jobs/testing` | `drainJobs` + `RecordingJobHandler` for hermetic tests |

## How it fits together

1. Add the dialect's `jobs` table definition to your Drizzle schema and generate a migration with drizzle-kit.
2. Configure `@nestjs-cls/transactional` with the Drizzle adapter, then register `JobsModule.forRoot({ drizzleInstanceToken, store })`.
3. Inject `JobsService` into your `@Transactional()` services and `enqueue()` alongside your business writes — the job commits atomically with them.
4. Declare `@JobHandler('job.name')` classes as providers; the explorer builds the name → handler registry at bootstrap.
5. Run `JobsClaimer` in a worker (`runWorkerLoop`) — it claims due jobs in batches (priority first, oldest due first, reclaiming stuck ones) and dispatches to your handlers. Delivery is at-least-once — make handlers idempotent or key side effects on `ctx.jobId`.

See the [00-showcase sample](sample/00-showcase) for a runnable end-to-end example on SQLite, and the [documentation](https://nest-native.dev/jobs/) for the full guide.

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

If you need tens of thousands of jobs per second, sandboxed processors, or a dashboard, use BullMQ — it is excellent at that. If you run Postgres without Nest, pg-boss is battle-tested. This library is for the large middle: NestJS + Drizzle apps that want reliable background jobs **without operating another system**.

## Non-goals (v0.1)

- **Cron / repeatable jobs** — `@nestjs/schedule` already does this well; combine it with `enqueue()` if you want scheduled work to flow through the queue.
- **Dashboards / UI**, **rate limiting**, **concurrency groups**.
- **LISTEN/NOTIFY push** — the claimer polls; `pollIntervalMs` is your latency knob.
- **Redis-class throughput** — this is a polling claimer over your relational DB, by design.

Part of the [nest-native](https://github.com/nest-native) family. Not affiliated with the NestJS core team. MIT licensed.
