import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { JobStatus } from '../../interfaces';

/**
 * SQLite `jobs` table. Add it to your Drizzle schema and generate a migration
 * with drizzle-kit.
 *
 * The **full** unique index on `(name, unique_key)` is the active-dedup
 * primitive: SQL treats `NULL` as distinct in unique indexes, so jobs without
 * a `uniqueKey` never collide, and — because terminal transitions clear
 * `unique_key` to `NULL` — uniqueness only constrains ACTIVE jobs. The same
 * full-index shape works on every dialect (no partial indexes needed). The
 * `(status, available_at)` index serves the claimer's batch query.
 */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    payload: text('payload', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    status: text('status').$type<JobStatus>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(10),
    uniqueKey: text('unique_key'),
    priority: integer('priority').notNull().default(0),
    availableAt: text('available_at').notNull(),
    claimedAt: text('claimed_at'),
    claimedBy: text('claimed_by'),
    processedAt: text('processed_at'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('jobs_name_unique_key_unique').on(table.name, table.uniqueKey),
    index('jobs_status_available_idx').on(table.status, table.availableAt),
  ],
);
