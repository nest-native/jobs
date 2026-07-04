import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { schema } from './schema';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

/** The DI token the CLS adapter and JobsModule resolve the Drizzle db by. */
export const DRIZZLE = Symbol('showcase-drizzle');

// In a real app these tables come from `drizzle-kit generate` after adding the
// library's `jobs` table to your schema. The showcase creates them inline so it
// runs with no migration step.
const DDL = `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 10,
  unique_key TEXT, priority INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL,
  claimed_at TEXT, claimed_by TEXT, processed_at TEXT, last_error TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX jobs_name_unique_key_unique ON jobs (name, unique_key);
CREATE INDEX jobs_status_available_idx ON jobs (status, available_at);
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL);
CREATE TABLE sent_emails (job_id TEXT PRIMARY KEY, email TEXT NOT NULL);
CREATE TABLE reports (id TEXT PRIMARY KEY, title TEXT NOT NULL);
`;

export function createDatabase(): { sqlite: Database.Database; db: AppDatabase } {
  const sqlite = new Database(':memory:');
  sqlite.exec(DDL);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
