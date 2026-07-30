import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { getTableConfig as getSqliteConfig } from 'drizzle-orm/sqlite-core';
import { getTableConfig as getPgConfig } from 'drizzle-orm/pg-core';
import { getTableConfig as getMysqlConfig } from 'drizzle-orm/mysql-core';
import * as sqlite from '../dialects/sqlite';
import * as postgres from '../dialects/postgres';
import * as mysql from '../dialects/mysql';

// getTableConfig builds the table's columns + indexes, which executes the
// `(table) => [...]` index-definition callbacks — validating the schema and
// the FULL (name, unique_key) unique index the active-dedup contract relies
// on, plus the claimer's (status, available_at) index.

describe('sqlite schema', () => {
  test('jobs: full (name, unique_key) unique index + claim index', () => {
    const cfg = getSqliteConfig(sqlite.jobs);
    assert.equal(cfg.name, 'jobs');
    const names = cfg.indexes.map((i) => i.config.name).sort();
    assert.deepEqual(names, [
      'jobs_name_unique_key_unique',
      'jobs_status_available_idx',
    ]);
    const unique = cfg.indexes.find(
      (i) => i.config.name === 'jobs_name_unique_key_unique',
    );
    // A FULL composite unique index (no partial WHERE clause): NULL keys never
    // collide, and clearing the key on terminal transitions releases it.
    assert.equal(unique?.config.unique, true);
    assert.equal(unique?.config.columns.length, 2);
    assert.equal(unique?.config.where, undefined);
  });

  test('jobs: column defaults match the engine contract', () => {
    const cfg = getSqliteConfig(sqlite.jobs);
    const column = (name: string) => cfg.columns.find((c) => c.name === name);
    assert.equal(column('attempts')?.default, 0);
    assert.equal(column('max_attempts')?.default, 10);
    assert.equal(column('priority')?.default, 0);
    assert.equal(column('unique_key')?.notNull, false);
    assert.equal(column('name')?.notNull, true);
  });
});

describe('postgres schema', () => {
  test('jobs: full (name, unique_key) unique index + claim index', () => {
    const cfg = getPgConfig(postgres.jobs);
    assert.equal(cfg.name, 'jobs');
    const names = cfg.indexes.map((i) => i.config.name).sort();
    assert.deepEqual(names, [
      'jobs_name_unique_key_unique',
      'jobs_status_available_idx',
    ]);
    const unique = cfg.indexes.find(
      (i) => i.config.name === 'jobs_name_unique_key_unique',
    );
    // A FULL composite unique index (no partial WHERE): Postgres's default
    // NULLS DISTINCT keeps NULL keys from colliding — identical semantics to
    // the sqlite/mysql definitions.
    assert.equal(unique?.config.unique, true);
    assert.equal(unique?.config.columns.length, 2);
    assert.equal(unique?.config.where, undefined);
  });

  test('jobs: column defaults match the engine contract', () => {
    const cfg = getPgConfig(postgres.jobs);
    const column = (name: string) => cfg.columns.find((c) => c.name === name);
    assert.equal(column('attempts')?.default, 0);
    assert.equal(column('max_attempts')?.default, 10);
    assert.equal(column('priority')?.default, 0);
    assert.equal(column('unique_key')?.notNull, false);
  });
});

describe('mysql schema', () => {
  test('jobs: full (name, unique_key) unique index + claim index', () => {
    const cfg = getMysqlConfig(mysql.jobs);
    assert.equal(cfg.name, 'jobs');
    const names = cfg.indexes.map((i) => i.config.name).sort();
    assert.deepEqual(names, [
      'jobs_name_unique_key_unique',
      'jobs_status_available_idx',
    ]);
    // MySQL has no partial indexes, and none are needed: a UNIQUE index on the
    // nullable column still permits multiple NULLs, matching the semantics.
    const unique = cfg.indexes.find(
      (i) => i.config.name === 'jobs_name_unique_key_unique',
    );
    assert.equal(unique?.config.unique, true);
    assert.equal(unique?.config.columns.length, 2);
  });

  test('jobs: column defaults match the engine contract', () => {
    const cfg = getMysqlConfig(mysql.jobs);
    const column = (name: string) => cfg.columns.find((c) => c.name === name);
    assert.equal(column('attempts')?.default, 0);
    assert.equal(column('max_attempts')?.default, 10);
    assert.equal(column('priority')?.default, 0);
    assert.equal(column('unique_key')?.notNull, false);
  });
});

describe('job_schedules schema (all dialects)', () => {
  const cases = [
    { dialect: 'sqlite', cfg: () => getSqliteConfig(sqlite.jobSchedules) },
    { dialect: 'postgres', cfg: () => getPgConfig(postgres.jobSchedules) },
    { dialect: 'mysql', cfg: () => getMysqlConfig(mysql.jobSchedules) },
  ] as const;

  for (const { dialect, cfg } of cases) {
    test(`${dialect}: unique name + due-query index, arming columns nullable`, () => {
      const config = cfg();
      assert.equal(config.name, 'job_schedules');
      const names = config.indexes.map((i) => i.config.name).sort();
      assert.deepEqual(names, [
        'job_schedules_enabled_next_run_idx',
        'job_schedules_name_unique',
      ]);
      const unique = config.indexes.find(
        (i) => i.config.name === 'job_schedules_name_unique',
      );
      // Upserts key on the schedule name — it must be uniquely indexed.
      assert.equal(unique?.config.unique, true);
      assert.equal(unique?.config.columns.length, 1);

      const column = (name: string) => config.columns.find((c) => c.name === name);
      assert.equal(column('enabled')?.default, true);
      assert.equal(column('enabled')?.notNull, true);
      // A dormant schedule (no future occurrence) has no due time.
      assert.equal(column('next_run_at')?.notNull, false);
      assert.equal(column('timezone')?.notNull, false);
      assert.equal(column('unique_key')?.notNull, false);
      assert.equal(column('name')?.notNull, true);
      assert.equal(column('job_name')?.notNull, true);
      assert.equal(column('cron')?.notNull, true);
    });
  }
});
