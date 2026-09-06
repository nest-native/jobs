#!/usr/bin/env node

// Prints which NestJS major every workspace in this repo actually resolves and
// fails unless all of them resolve the requested one. The NestJS 12
// compatibility leg runs this after its `--no-save` install: npm nests an
// older copy under a workspace whenever that workspace's own range is not
// satisfied by the hoisted version, and a suite that passes against a mixed
// 11/12 tree proves nothing about 12.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const expectedMajor = Number(process.argv[2]);
const packageNames = ['@nestjs/common', '@nestjs/core'];

if (!Number.isInteger(expectedMajor)) {
  console.error('Usage: node scripts/check-resolved-nestjs-major.mjs <major>');
  process.exit(1);
}

const failures = [];

for (const workspaceDir of ['.', ...collectWorkspaceDirs()]) {
  const require = createRequire(path.join(repoRoot, workspaceDir, 'package.json'));

  for (const packageName of packageNames) {
    const { version, packageDir } = resolveInstalled(require, packageName);
    const major = Number(version.split('.')[0]);

    console.log(
      `${workspaceDir.padEnd(18)} ${packageName.padEnd(15)} ${version.padEnd(8)} <- ${path.relative(repoRoot, packageDir)}`,
    );

    if (major !== expectedMajor) {
      failures.push(
        `${workspaceDir} resolves ${packageName}@${version}; expected major ${expectedMajor}`,
      );
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Resolved NestJS major mismatch:\n${failures.join('\n')}`);
}

console.log(`Every workspace resolves NestJS ${expectedMajor}.`);

function resolveInstalled(require, packageName) {
  // `require('<pkg>/package.json')` is not an option: the NestJS 12 exports
  // map routes `./*` to `./*.js`, so walk up from the resolved entry point to
  // the manifest that declares the package instead.
  const entryPoint = require.resolve(packageName);
  let packageDir = path.dirname(entryPoint);

  for (;;) {
    const manifestPath = path.join(packageDir, 'package.json');

    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

      if (manifest.name === packageName) {
        return { version: manifest.version, packageDir };
      }
    }

    const parentDir = path.dirname(packageDir);

    if (parentDir === packageDir) {
      throw new Error(`No package.json for ${packageName} above ${entryPoint}`);
    }

    packageDir = parentDir;
  }
}

function collectWorkspaceDirs() {
  const rootManifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  );

  return (rootManifest.workspaces ?? []).flatMap(pattern => {
    const baseDir = pattern.replace(/\/\*$/, '');
    const absoluteBaseDir = path.join(repoRoot, baseDir);

    if (!fs.existsSync(absoluteBaseDir)) {
      return [];
    }

    return fs
      .readdirSync(absoluteBaseDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(baseDir, entry.name))
      .filter(workspaceDir =>
        fs.existsSync(path.join(repoRoot, workspaceDir, 'package.json')),
      )
      .sort();
  });
}
