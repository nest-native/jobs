import {
  index,
  int,
  json,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { JobStatus } from '../../interfaces';

// MySQL-specific schema choices (documented so they are deliberate, not
// accidental divergence from the Postgres/SQLite definitions):
//
// - **`varchar` on every indexed column.** MySQL cannot index a `TEXT`/`BLOB`
//   column without a prefix length, so `id`, `name`, `status`, `unique_key`,
//   and `available_at` are `varchar(n)`. 191 is the classic utf8mb4-safe
//   single-column index width; the composite `(name, unique_key)` index at
//   255 + 191 utf8mb4 chars stays well under InnoDB's 3072-byte key limit.
//   The ISO-8601 timestamp columns fit comfortably in `varchar(32)`;
//   free-form `last_error` stays `text`.
// - **The SAME full unique index on `(name, unique_key)`** as the other
//   dialects. MySQL has no partial indexes, but none are needed: a UNIQUE
//   index over a nullable column permits multiple `NULL`s (SQL treats `NULL`
//   as distinct), and terminal transitions clear `unique_key` to `NULL` — so
//   "unique among ACTIVE jobs" holds with identical semantics everywhere.
// - **`json` payload.** MySQL's native JSON type; mysql2 returns it already
//   parsed, so the row shape matches `JobRow`.

/**
 * MySQL `jobs` table. Add it to your Drizzle schema and generate a migration
 * with drizzle-kit. Timestamps are stored as ISO-8601 `varchar` so the row
 * shape is identical across dialects (ISO-8601 compares lexicographically,
 * which the claimer's `available_at` range query relies on).
 */
export const jobs = mysqlTable(
  'jobs',
  {
    id: varchar('id', { length: 191 }).primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    payload: json('payload').$type<Record<string, unknown>>().notNull(),
    status: varchar('status', { length: 32 }).$type<JobStatus>().notNull(),
    attempts: int('attempts').notNull().default(0),
    maxAttempts: int('max_attempts').notNull().default(10),
    uniqueKey: varchar('unique_key', { length: 191 }),
    priority: int('priority').notNull().default(0),
    availableAt: varchar('available_at', { length: 32 }).notNull(),
    claimedAt: varchar('claimed_at', { length: 32 }),
    claimedBy: varchar('claimed_by', { length: 191 }),
    processedAt: varchar('processed_at', { length: 32 }),
    lastError: text('last_error'),
    createdAt: varchar('created_at', { length: 32 }).notNull(),
  },
  (table) => [
    uniqueIndex('jobs_name_unique_key_unique').on(table.name, table.uniqueKey),
    index('jobs_status_available_idx').on(table.status, table.availableAt),
  ],
);
