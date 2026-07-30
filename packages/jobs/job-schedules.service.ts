import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectTransaction } from '@nestjs-cls/transactional';
import type {
  ResolvedScheduleUpsert,
  ScheduleRow,
  ScheduleStore,
  UpsertScheduleInput,
} from './interfaces';
import { armSchedule } from './schedule-planner';
import { JOBS_SCHEDULE_STORE } from './tokens';

/**
 * Injectable CRUD for DB-stored cron schedules — deliberately **no REST
 * controller and no admin UI**: expose it from your own endpoints if you want
 * runtime editing over HTTP.
 *
 * `upsert` returns the store's native shape (synchronous `ScheduleRow` on
 * sqlite, a `Promise` on pg/mysql) and — like `JobsService.enqueue` — runs on
 * the transaction-scoped Drizzle instance, so creating a schedule can ride the
 * caller's business transaction.
 *
 * Upserts are safe to run on every boot (the documented pattern): on an
 * existing schedule, an OMITTED `enabled` preserves the stored value (an ops
 * `setEnabled(name, false)` survives redeploys), and the stored `nextRunAt`
 * is preserved while `cron`/`timezone` are unchanged (a pending catch-up
 * survives restarts).
 *
 * Cron expressions are validated (croner) at call time; invalid ones — and
 * expressions with no future occurrence at all — throw `InvalidScheduleError`
 * and never reach the table. The misfire policy is fixed: arming always
 * computes from *now*, so `setEnabled(name, true)` on a long-disabled
 * schedule resumes at the next FUTURE occurrence instead of bursting.
 */
@Injectable()
export class JobSchedulesService<
  TStore extends ScheduleStore = ScheduleStore,
> {
  constructor(
    @InjectTransaction() private readonly db: unknown,
    @Optional()
    @Inject(JOBS_SCHEDULE_STORE)
    private readonly store: TStore | null = null,
  ) {}

  upsert<TPayload extends object>(
    input: UpsertScheduleInput<TPayload>,
  ): ReturnType<TStore['upsert']> {
    const store = this.requireStore();
    const timezone = input.timezone ?? null;
    const resolved: ResolvedScheduleUpsert = {
      name: input.name,
      jobName: input.jobName,
      // The one place the structural payload widens to the stored shape.
      payload: (input.payload ?? {}) as Record<string, unknown>,
      cron: input.cron,
      timezone,
      // null = omitted: the store defaults it to true on insert and
      // preserves the stored value on update.
      enabled: input.enabled ?? null,
      // Validates the expression AND rejects never-firing ones.
      nextRunAt: armSchedule(input.cron, timezone, new Date()),
      maxAttempts: input.maxAttempts ?? null,
      priority: input.priority ?? null,
      uniqueKey: input.uniqueKey ?? null,
    };
    return store.upsert(this.db, resolved) as ReturnType<TStore['upsert']>;
  }

  async get(name: string): Promise<ScheduleRow | undefined> {
    return this.requireStore().get(this.db, name);
  }

  async list(): Promise<ScheduleRow[]> {
    return this.requireStore().list(this.db);
  }

  /** Resolves true when the schedule existed and was deleted. */
  async remove(name: string): Promise<boolean> {
    return this.requireStore().remove(this.db, name);
  }

  /**
   * Enables or disables a schedule. Enabling re-arms `nextRunAt` from now
   * (skip-missed policy — no catch-up burst); disabling clears it. Resolves
   * the updated row, or undefined when the name is unknown.
   *
   * The enable path is a read-compute-write guarded by the row's `updatedAt`
   * (so a concurrent upsert changing the cron cannot be overwritten with a
   * stale computation) and retried a few times; persistent contention throws.
   */
  async setEnabled(
    name: string,
    enabled: boolean,
  ): Promise<ScheduleRow | undefined> {
    const store = this.requireStore();
    if (!enabled) {
      return store.setEnabled(this.db, name, false, null);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = await store.get(this.db, name);
      if (!row) {
        return undefined;
      }
      // The row may have been hand-edited behind the service's back — arming
      // validates (and rejects never-firing expressions) before enabling.
      const next = armSchedule(row.cron, row.timezone, new Date());
      const updated = await store.setEnabled(
        this.db,
        name,
        true,
        next,
        row.updatedAt,
      );
      if (updated) {
        return updated;
      }
      // Guard miss: someone modified the row between our read and write —
      // re-read and recompute from the fresh cron/timezone.
    }
    throw new Error(
      `Schedule "${name}" is being modified concurrently — retry setEnabled.`,
    );
  }

  private requireStore(): TStore {
    if (!this.store) {
      throw new Error(
        'JobsModule was configured without a scheduleStore — pass one ' +
          '(e.g. new SqliteScheduleStore()) to JobsModule.forRoot to use schedules.',
      );
    }
    return this.store;
  }
}
