import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// The consumer smoke of both release checks: check-packed-consumer.mjs runs it
// against the packed tarball, check-published-release.mjs against the version
// on the registry. This is its only copy.

const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const nodeExecutable = process.execPath;

// Installs `packageName` from `packageSpec` (a `file:` tarball or a registry
// version) into an empty CommonJS consumer at `consumerRoot`, then runs the
// smoke against it.
export function runConsumerSmoke({
  repoRoot,
  consumerRoot,
  consumerName,
  packageName,
  packageSpec,
  env,
}) {
  writeConsumerPackage({
    repoRoot,
    consumerRoot,
    consumerName,
    packageName,
    packageSpec,
  });
  writeConsumerSmoke(consumerRoot, packageName);

  execFileSync(
    npmExecutable,
    [
      'install',
      '--package-lock=false',
      '--no-audit',
      '--fund=false',
      '--ignore-scripts',
    ],
    {
      cwd: consumerRoot,
      stdio: 'inherit',
      env,
    },
  );
  execFileSync(nodeExecutable, ['smoke.cjs'], {
    cwd: consumerRoot,
    stdio: 'inherit',
  });
}

function writeConsumerPackage({
  repoRoot,
  consumerRoot,
  consumerName,
  packageName,
  packageSpec,
}) {
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  );
  const devDependencies = rootPackage.devDependencies ?? {};
  const dependencies = {
    '@nestjs/common': devDependencies['@nestjs/common'],
    '@nestjs/core': devDependencies['@nestjs/core'],
    '@nestjs-cls/transactional': devDependencies['@nestjs-cls/transactional'],
    'drizzle-orm': devDependencies['drizzle-orm'],
    [packageName]: packageSpec,
    'reflect-metadata': devDependencies['reflect-metadata'],
    rxjs: devDependencies.rxjs,
  };
  const missingDependencies = Object.entries(dependencies)
    .filter(([, version]) => !version)
    .map(([name]) => name);

  if (missingDependencies.length > 0) {
    throw new Error(
      `Consumer smoke is missing dependency versions: ${missingDependencies.join(', ')}`,
    );
  }

  fs.writeFileSync(
    path.join(consumerRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: consumerName,
        private: true,
        type: 'commonjs',
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
}

export function writeConsumerSmoke(consumerRoot, packageName) {
  fs.writeFileSync(
    path.join(consumerRoot, 'smoke.cjs'),
    `'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const core = require('${packageName}');
const sqlite = require('${packageName}/sqlite');
const postgres = require('${packageName}/postgres');
const mysql = require('${packageName}/mysql');
const testing = require('${packageName}/testing');
const packageJson = require('${packageName}/package.json');

// Every public entry point resolves from the installed package and exports its
// documented surface.
for (const name of [
  'JobsModule', 'JobsService', 'JobsClaimer', 'JobsHandlerExplorer',
  'JobHandler', 'runWorkerLoop', 'RetryableError', 'PermanentError',
  'JOB_STATUSES', 'DEFAULT_RUNNER_CONFIG', 'resolveAvailableAt',
  'JOBS_STORE', 'JOBS_DRIZZLE', 'JOBS_OPTIONS',
]) {
  assert.ok(name in core, 'missing core export: ' + name);
}
for (const name of ['SqliteJobStore', 'jobs', 'isSqliteUniqueViolation']) {
  assert.ok(name in sqlite, 'missing sqlite export: ' + name);
}
for (const name of ['PostgresJobStore', 'jobs', 'isPgUniqueViolation']) {
  assert.ok(name in postgres, 'missing postgres export: ' + name);
}
for (const name of ['MysqlJobStore', 'jobs', 'isMysqlUniqueViolation']) {
  assert.ok(name in mysql, 'missing mysql export: ' + name);
}
for (const name of ['drainJobs', 'RecordingJobHandler']) {
  assert.ok(name in testing, 'missing testing export: ' + name);
}
for (const subpath of ['./sqlite', './postgres', './mysql', './testing']) {
  assert.ok(packageJson.exports[subpath], 'missing subpath export: ' + subpath);
}

// The published package declares EXACTLY ONE runtime dependency: croner (cron
// math for schedules — see the guidelines' constitution amendment). Consumers
// only pull the peers they actually use beyond that. Adding a second runtime
// dependency requires the same amendment ceremony.
assert.deepEqual(
  Object.keys(packageJson.dependencies ?? {}),
  ['croner'],
  'The installed package must declare exactly one runtime dependency: croner.',
);

// Functional smoke, DB-free: the recording handler captures executions, the
// error vocabulary carries its retry metadata, runAt/delayMs resolution
// enforces its XOR contract, and drainJobs aggregates ticks off a fake claimer.
(async () => {
  const handler = new testing.RecordingJobHandler();
  await handler.handle({ ok: 1 }, { jobId: 'j-1', attempt: 1 });
  assert.equal(handler.executions().length, 1);
  assert.equal(handler.executions()[0].ctx.attempt, 1);

  assert.equal(new core.RetryableError('soon', 250).delayMs, 250);
  assert.equal(new core.PermanentError('never').name, 'PermanentError');
  assert.throws(
    () => core.resolveAvailableAt({ runAt: new Date(), delayMs: 5 }),
    /mutually exclusive/,
  );

  assert.equal(
    core.resolveRunnerConfig({ workerInstanceId: undefined }).workerInstanceId,
    core.DEFAULT_RUNNER_CONFIG.workerInstanceId,
  );
  assert.throws(() => core.resolveRunnerConfig({ batchSize: 0 }), /batchSize must be a positive integer/);

  const reports = [
    { scheduled: 0, claimed: 2, completed: 1, retried: 1, failed: 0, lost: 0 },
    { scheduled: 1, claimed: 2, completed: 1, retried: 0, failed: 0, lost: 1 },
    { scheduled: 0, claimed: 0, completed: 0, retried: 0, failed: 0, lost: 0 },
  ];
  const fakeClaimer = { tick: async () => reports.shift() };
  const total = await testing.drainJobs(fakeClaimer);
  assert.deepEqual(total, { scheduled: 1, claimed: 4, completed: 2, retried: 1, failed: 0, lost: 1 });
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
`,
  );
}
