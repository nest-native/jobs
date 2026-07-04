import { Injectable } from '@nestjs/common';
import { InjectTransaction, Transactional } from '@nestjs-cls/transactional';
import { JobsService, type JobRow } from '@nest-native/jobs';
import type { SqliteJobStore } from '@nest-native/jobs/sqlite';
import type { AppDatabase } from './database';
import { users } from './schema';

// A plain interface (no index signature) — enqueue accepts it directly, no
// `as unknown as Record<string, unknown>` cast.
export interface WelcomeEmailPayload {
  email: string;
}

/**
 * Registers a user and enqueues the welcome email **in the SAME transaction**
 * — the job exists if and only if the user row committed. The body is
 * synchronous (better-sqlite3), so `enqueue` returns the row directly; a throw
 * would roll back both writes.
 *
 * `uniqueKey` makes registration retries safe: while a welcome email for this
 * address is still pending, enqueueing another is a no-op.
 */
@Injectable()
export class UserService {
  constructor(
    @InjectTransaction() private readonly db: AppDatabase,
    private readonly jobs: JobsService<SqliteJobStore>,
  ) {}

  @Transactional()
  register(id: string, email: string): Promise<JobRow> {
    this.db.insert(users).values({ id, email }).run();
    const payload: WelcomeEmailPayload = { email };
    const row = this.jobs.enqueue({
      name: 'email.welcome',
      payload,
      uniqueKey: `welcome:${email}`,
    });
    return row as unknown as Promise<JobRow>;
  }
}
