import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { JobStatus } from '../../interfaces';

/**
 * Postgres `jobs` table. Add it to your Drizzle schema and generate a
 * migration with drizzle-kit. Timestamps are stored as ISO-8601 `text` so the
 * row shape is identical across dialects (ISO-8601 compares lexicographically,
 * which the claimer's `available_at` range query relies on).
 *
 * The **full** unique index on `(name, unique_key)` is the active-dedup
 * primitive: Postgres treats `NULL`s as distinct in unique indexes (the
 * default `NULLS DISTINCT`), so jobs without a `uniqueKey` never collide,
 * and — because terminal transitions clear `unique_key` to `NULL` —
 * uniqueness only constrains ACTIVE jobs. No partial index needed, so the
 * same shape works on every dialect.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
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
