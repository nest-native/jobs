---
sidebar_position: 5
title: Samples
---

# Samples

Runnable samples live in the repository's
[`sample/`](https://github.com/nest-native/jobs/tree/main/sample) directory.
Each is a standalone npm workspace with a `test` script (`typecheck` + a smoke
run), executed on every CI run against the packed library.

## 00-showcase — the whole engine on SQLite

[`sample/00-showcase`](https://github.com/nest-native/jobs/tree/main/sample/00-showcase)
is a small Nest application context on an in-memory better-sqlite3 database:
a `UserService` with a `@Transactional()` method, and three `@JobHandler`
classes exercising every outcome path.

Its smoke proves, end to end:

1. **Transactional enqueue** — `register()` inserts the user row and enqueues
   `email.welcome` in the same transaction; the handler's side effect
   (`sent_emails`, keyed on `ctx.jobId` with `ON CONFLICT DO NOTHING`) lands
   exactly once after a drain.
2. **uniqueKey dedup** — a second `welcome:<email>` enqueue while the first is
   active returns the **existing row** (same id, one row in the table), and
   completing the job releases the key.
3. **Delayed jobs** — a `delayMs: 150` job is not claimable early
   (`tick()` claims 0), then runs after its due time.
4. **Retry-then-succeed** — `report.generate` throws
   `RetryableError('…', 25)` on attempt 1 and writes its report on attempt 2;
   the drain reports `retried: 1`, the second drain `completed: 1`, and the
   report row is written exactly once.
5. **Permanent failure** — `billing.charge` throws `PermanentError`; the job
   fails in a single tick with the reason in `last_error`, no retries burned.
6. **The worker loop** — `runWorkerLoop` (20ms poll) picks up a job enqueued
   after it started, and `controller.abort()` stops it gracefully.

Run it from the repository root:

```bash
npm install
npm run build --workspace @nest-native/jobs
npm run showcase
```

## What a sample is for

The samples pin the exact published version (`"@nest-native/jobs": "0.1.0"`)
rather than a range — CI resolves them against the workspace before a release
and against the registry after one (`release:check:published`), so every
release is proven consumable by a real application before and after it ships.
