import { Inject, Injectable } from '@nestjs/common';
import { InjectTransaction } from '@nestjs-cls/transactional';
import type { EnqueueJobInput, JobStore } from './interfaces';
import { JOBS_STORE } from './tokens';

/**
 * Enqueues jobs **inside the caller's business transaction** — the job row
 * commits atomically with your writes. Inject it into a `@Transactional()`
 * service and call `enqueue` alongside your business writes; if the
 * transaction rolls back, the job was never enqueued.
 *
 * `enqueue` returns the store's native shape: the **sqlite** store returns a
 * synchronous `JobRow` (call it without `await` inside a synchronous
 * `@Transactional` body); the **postgres** and **mysql** stores return a
 * `Promise` (await it). Type the service as `JobsService<typeof yourStore>` to get the
 * exact shape. On a `(name, uniqueKey)` collision with an ACTIVE job it
 * returns that existing row — a dedup no-op.
 *
 * Requires the host app to configure `@nestjs-cls/transactional` with the
 * Drizzle adapter (`enableTransactionProxy: true`) — `@InjectTransaction()`
 * resolves the transaction-scoped Drizzle instance from it (and falls back to
 * the base instance outside any transaction).
 */
@Injectable()
export class JobsService<TStore extends JobStore = JobStore> {
  constructor(
    @InjectTransaction() private readonly db: unknown,
    @Inject(JOBS_STORE) private readonly store: TStore,
  ) {}

  // TPayload keeps the input structural: a payload typed as a plain interface
  // compiles without casting (see EnqueueJobInput). The store widens it internally.
  enqueue<TPayload extends object>(
    input: EnqueueJobInput<TPayload>,
  ): ReturnType<TStore['enqueue']> {
    return this.store.enqueue(this.db, input) as ReturnType<TStore['enqueue']>;
  }
}
