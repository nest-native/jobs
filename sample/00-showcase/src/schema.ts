import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { jobs } from '@nest-native/jobs/sqlite';

// The app's schema combines the library's `jobs` table (imported from the
// dialect entrypoint) with the business tables. `sent_emails` and `reports`
// are the handlers' side effects — real DB rows, so behavior is observable.
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
});

export const sentEmails = sqliteTable('sent_emails', {
  jobId: text('job_id').primaryKey(),
  email: text('email').notNull(),
});

export const reports = sqliteTable('reports', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
});

export const schema = { jobs, users, sentEmails, reports };
