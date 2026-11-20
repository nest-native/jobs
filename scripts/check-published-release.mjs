#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runConsumerSmoke } from './consumer-smoke.mjs';

const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const repoRoot = process.cwd();
const packagePath = path.join(repoRoot, 'packages/jobs/package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const packageName = packageJson.name;
const version = process.argv[2] ?? packageJson.version;
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nest-native-jobs-published-release-'),
);
const npmCache = path.join(tempRoot, 'npm-cache');

try {
  verifyRegistryVersion();
  packPublishedArtifact();
  runPublishedConsumerSmoke();
  runPublishedSampleSmoke();

  console.log(`Published release validation OK for ${packageName}@${version}.`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function verifyRegistryVersion() {
  const rawOutput = execFileSync(
    npmExecutable,
    ['view', `${packageName}@${version}`, 'version', 'dist-tags.latest', 'dist.tarball', '--json'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: npmEnv(),
    },
  );
  const registryInfo = JSON.parse(rawOutput);

  if (registryInfo.version !== version) {
    throw new Error(
      `Expected npm version ${version}, but registry returned ${registryInfo.version}.`,
    );
  }

  if (registryInfo['dist-tags.latest'] !== version) {
    throw new Error(
      `Expected npm latest tag ${version}, but registry returned ${registryInfo['dist-tags.latest']}.`,
    );
  }

  if (!registryInfo['dist.tarball']) {
    throw new Error('Registry response is missing the published tarball URL.');
  }

  console.log(`Registry validation OK: ${packageName}@${version} is latest.`);
}

function packPublishedArtifact() {
  const rawOutput = execFileSync(
    npmExecutable,
    ['pack', `${packageName}@${version}`, '--json', '--pack-destination', tempRoot],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: npmEnv(),
    },
  );
  const [packResult] = JSON.parse(rawOutput);

  if (!packResult?.filename || !Array.isArray(packResult.files)) {
    throw new Error('npm pack did not return the expected published artifact payload.');
  }

  const filePaths = packResult.files.map(file => file.path);
  for (const requiredFile of ['README.md', 'package.json', 'dist/index.js', 'dist/index.d.ts']) {
    if (!filePaths.includes(requiredFile)) {
      throw new Error(`Published artifact is missing ${requiredFile}.`);
    }
  }

  console.log(
    `Published artifact validation OK: ${packResult.filename} contains ${packResult.entryCount} files.`,
  );
}

function runPublishedConsumerSmoke() {
  const consumerRoot = path.join(tempRoot, 'consumer');
  fs.mkdirSync(consumerRoot);
  runConsumerSmoke({
    repoRoot,
    consumerRoot,
    consumerName: 'nest-native-jobs-published-consumer',
    packageName,
    packageSpec: version,
    env: npmEnv(),
  });

  console.log('Published consumer validation OK.');
}

function runPublishedSampleSmoke() {
  const sampleWorkspace = path.join(tempRoot, 'samples');
  fs.mkdirSync(sampleWorkspace);

  writeSampleWorkspacePackage(sampleWorkspace);
  fs.cpSync(path.join(repoRoot, 'sample'), path.join(sampleWorkspace, 'sample'), {
    recursive: true,
  });
  const pinnedSamples = pinSampleDependencies(
    path.join(sampleWorkspace, 'sample'),
  );
  fs.cpSync(path.join(repoRoot, 'scripts'), path.join(sampleWorkspace, 'scripts'), {
    recursive: true,
    filter: source => !source.includes(`${path.sep}node_modules${path.sep}`),
  });
  fs.copyFileSync(
    path.join(repoRoot, 'tsconfig.base.json'),
    path.join(sampleWorkspace, 'tsconfig.base.json'),
  );

  installPublishedSampleWorkspace(sampleWorkspace);

  const resolutionOutput = execFileSync(
    npmExecutable,
    ['ls', packageName, '--workspaces', '--depth=0'],
    {
      cwd: sampleWorkspace,
      encoding: 'utf8',
      env: npmEnv(),
    },
  );

  const localPackageLinkPattern = new RegExp(
    `${escapeRegExp(packageName)}@[^\\s]+\\s+->`,
  );
  const requestedVersionPattern = new RegExp(
    `${escapeRegExp(packageName)}@${escapeRegExp(version)}\\b`,
  );

  if (localPackageLinkPattern.test(resolutionOutput)) {
    throw new Error(
      `Sample workspace resolved ${packageName} through a local workspace link:\n${resolutionOutput}`,
    );
  }

  if (!requestedVersionPattern.test(resolutionOutput)) {
    throw new Error(
      `Sample workspace did not resolve ${packageName}@${version}:\n${resolutionOutput}`,
    );
  }

  execFileSync(npmExecutable, ['run', 'ci:sample'], {
    cwd: sampleWorkspace,
    stdio: 'inherit',
    env: npmEnv(),
  });

  console.log(
    `Published sample validation OK: pinned ${pinnedSamples} sample workspaces to ${packageName}@${version}.`,
  );
}

function pinSampleDependencies(sampleRoot) {
  const packageFiles = fs
    .readdirSync(sampleRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(sampleRoot, entry.name, 'package.json'))
    .filter(packageFile => fs.existsSync(packageFile));
  let pinnedSamples = 0;

  for (const packageFile of packageFiles) {
    const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const pinned = pinPackageDependency(packageJson);

    if (pinned) {
      pinnedSamples += 1;
      fs.writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
    }
  }

  if (pinnedSamples === 0) {
    throw new Error(
      `No sample package.json files declare ${packageName}; post-publish sample validation cannot prove registry consumption.`,
    );
  }

  return pinnedSamples;
}

function pinPackageDependency(packageJson) {
  let pinned = false;

  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    if (packageJson[field]?.[packageName]) {
      packageJson[field][packageName] = version;
      pinned = true;
    }
  }

  return pinned;
}

function installPublishedSampleWorkspace(sampleWorkspace) {
  try {
    execFileSync(npmExecutable, ['install', '--package-lock=false'], {
      cwd: sampleWorkspace,
      stdio: 'inherit',
      env: npmEnv(),
    });
  } catch (error) {
    throw new Error(
      [
        `Sample installation failed after pinning samples to ${packageName}@${version}.`,
        'This usually means the current sample workspace expects package peer dependency metadata that differs from the published version being checked.',
        'Run this check from the matching release commit, or after publishing the version that matches the current repository state.',
      ].join(' '),
      { cause: error },
    );
  }
}

function writeSampleWorkspacePackage(sampleWorkspace) {
  fs.writeFileSync(
    path.join(sampleWorkspace, 'package.json'),
    `${JSON.stringify(
      {
        name: 'nest-native-jobs-published-samples',
        private: true,
        workspaces: ['sample/*'],
        scripts: {
          showcase:
            'node scripts/run-optional-workspace.cjs nest-native-jobs-showcase test',
          'sample:focused': 'node scripts/run-focused-samples.mjs',
          sample: 'npm run showcase && npm run sample:focused',
          'ci:sample': 'npm run sample',
        },
      },
      null,
      2,
    )}\n`,
  );
}

function npmEnv() {
  return {
    ...process.env,
    npm_config_cache: npmCache,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
