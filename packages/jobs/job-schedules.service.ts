import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectTransaction } from '@nestjs-cls/transactional';
import type {
  ResolvedScheduleUpsert,
  ScheduleRow,
  ScheduleStore,
  UpsertScheduleInput,
} from './interfaces';
import { assertValidSchedule, nextOccurrence } from './schedule-planner';
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
 * Cron expressions are validated (croner) at call time; invalid ones throw
 * `InvalidScheduleError` and never reach the table. The misfire policy is
 * fixed: `nextRunAt` always advances from *now* — so `setEnabled(name, true)`
 * on a long-disabled schedule resumes at the next FUTURE occurrence instead of
 * bursting catch-ups.
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
    assertValidSchedule(input.cron, input.timezone);
    const resolved: ResolvedScheduleUpsert = {
      name: input.name,
      jobName: input.jobName,
      // The one place the structural payload widens to the stored shape.
      payload: (input.payload ?? {}) as Record<string, unknown>,
      cron: input.cron,
      timezone: input.timezone ?? null,
      enabled: input.enabled ?? true,
      nextRunAt: nextOccurrence(input.cron, input.timezone ?? null, new Date()),
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
   * Enables or disables a schedule. Enabling recomputes `nextRunAt` from now
   * (skip-missed policy — no catch-up burst); disabling clears it. Resolves
   * the updated row, or undefined when the name is unknown.
   */
  async setEnabled(
    name: string,
    enabled: boolean,
  ): Promise<ScheduleRow | undefined> {
    const store = this.requireStore();
    if (!enabled) {
      return store.setEnabled(this.db, name, false, null);
    }
    const row = await store.get(this.db, name);
    if (!row) {
      return undefined;
    }
    // The row may have been hand-edited behind the service's back — validate
    // before arming it so the claimer never meets an unparsable expression.
    assertValidSchedule(row.cron, row.timezone);
    const next = nextOccurrence(row.cron, row.timezone, new Date());
    return store.setEnabled(this.db, name, true, next);
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
