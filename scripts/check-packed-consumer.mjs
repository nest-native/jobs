import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const nodeExecutable = process.execPath;
const repoRoot = process.cwd();
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nest-native-jobs-consumer-'),
);
const consumerRoot = path.join(tempRoot, 'consumer');
const npmCache = path.join(tempRoot, 'npm-cache');

try {
  fs.mkdirSync(consumerRoot);

  const tarballPath = packTarball();
  writeConsumerPackage(tarballPath);
  writeConsumerSmoke();

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
      env: {
        ...process.env,
        npm_config_cache: npmCache,
      },
    },
  );
  execFileSync(nodeExecutable, ['smoke.cjs'], {
    cwd: consumerRoot,
    stdio: 'inherit',
  });

  console.log('Packed consumer validation OK.');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function packTarball() {
  const rawOutput = execFileSync(
    npmExecutable,
    [
      'pack',
      '--json',
      '--workspace',
      '@nest-native/jobs',
      '--pack-destination',
      tempRoot,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_cache: npmCache,
      },
    },
  );
  const [packResult] = JSON.parse(rawOutput);

  if (!packResult?.filename) {
    throw new Error('npm pack did not produce a tarball filename.');
  }

  return path.join(tempRoot, packResult.filename);
}

function writeConsumerPackage(tarballPath) {
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  );
  const devDependencies = rootPackage.devDependencies ?? {};
  const dependencies = {
    '@nestjs/common': devDependencies['@nestjs/common'],
    '@nestjs/core': devDependencies['@nestjs/core'],
    '@nestjs-cls/transactional': devDependencies['@nestjs-cls/transactional'],
    'drizzle-orm': devDependencies['drizzle-orm'],
    '@nest-native/jobs': `file:${tarballPath}`,
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
        name: 'nest-native-jobs-packed-consumer',
        private: true,
        type: 'commonjs',
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
}

function writeConsumerSmoke() {
  fs.writeFileSync(
    path.join(consumerRoot, 'smoke.cjs'),
    `'use strict';

require('reflect-metadata');

const assert = require('node:assert/strict');
const core = require('@nest-native/jobs');
const sqlite = require('@nest-native/jobs/sqlite');
const postgres = require('@nest-native/jobs/postgres');
const mysql = require('@nest-native/jobs/mysql');
const testing = require('@nest-native/jobs/testing');
const packageJson = require('@nest-native/jobs/package.json');

// Every public entry point resolves from the packed tarball and exports its
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

// The published package declares zero runtime dependencies (consumers only pull
// the peers they actually use).
assert.equal(
  Object.keys(packageJson.dependencies ?? {}).length,
  0,
  'The packed package must not declare runtime dependencies.',
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

  const reports = [
    { claimed: 2, completed: 1, retried: 1, failed: 0 },
    { claimed: 1, completed: 1, retried: 0, failed: 0 },
    { claimed: 0, completed: 0, retried: 0, failed: 0 },
  ];
  const fakeClaimer = { tick: async () => reports.shift() };
  const total = await testing.drainJobs(fakeClaimer);
  assert.deepEqual(total, { claimed: 3, completed: 2, retried: 1, failed: 0 });
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
`,
  );
}
