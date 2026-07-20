#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const outputFlag = process.argv.indexOf('--output');
const outputDir = path.resolve(
  outputFlag === -1 ? path.join(root, 'releases') : process.argv[outputFlag + 1] || ''
);
const allowDirty = process.argv.includes('--allow-dirty');

function run(command, args) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const commit = run('git', ['rev-parse', 'HEAD']);
const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']);
if (!allowDirty && dirty !== '') {
  throw new Error('refusing to build release provenance from a dirty tracked worktree');
}
const commitEpoch = Number(run('git', ['show', '-s', '--format=%ct', 'HEAD']));
const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH || commitEpoch);
if (!Number.isInteger(sourceDateEpoch) || sourceDateEpoch <= 0) {
  throw new Error('SOURCE_DATE_EPOCH must be a positive Unix timestamp');
}

fs.mkdirSync(outputDir, { recursive: true, mode: 0o755 });
const npmCache = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-router-release-cache-'));
let packed;
try {
  const output = execFileSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', outputDir],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SOURCE_DATE_EPOCH: String(sourceDateEpoch),
        npm_config_cache: npmCache,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    }
  );
  [packed] = JSON.parse(output);
} finally {
  fs.rmSync(npmCache, { recursive: true, force: true });
}
if (!packed || !Array.isArray(packed.files)) throw new Error('npm pack returned no manifest');

const artifactPath = path.join(outputDir, path.basename(packed.filename));
const artifact = fs.readFileSync(artifactPath);
const sha256 = crypto.createHash('sha256').update(artifact).digest('hex');
const provenance = {
  schemaVersion: 1,
  package: { name: packageJson.name, version: packageJson.version },
  source: {
    repository: packageJson.repository?.url ?? null,
    commit,
    clean: dirty === '',
    sourceDateEpoch,
  },
  artifact: {
    filename: path.basename(artifactPath),
    size: artifact.length,
    sha256,
    npmShasum: packed.shasum,
    npmIntegrity: packed.integrity,
  },
  files: packed.files
    .map((file) => ({ path: file.path, size: file.size }))
    .sort((a, b) => a.path.localeCompare(b.path)),
};

const checksumPath = `${artifactPath}.sha256`;
const provenancePath = `${artifactPath}.provenance.json`;
fs.writeFileSync(checksumPath, `${sha256}  ${path.basename(artifactPath)}\n`, { mode: 0o644 });
fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o644 });

console.log(JSON.stringify({ artifactPath, checksumPath, provenancePath, sha256 }, null, 2));
