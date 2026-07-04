import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { getTableConfig as getSqliteConfig } from 'drizzle-orm/sqlite-core';
import * as sqlite from '../dialects/sqlite';

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
