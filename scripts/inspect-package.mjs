#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const npmCache = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-router-npm-cache-'));
let output;
try {
  output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: npmCache },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
} finally {
  fs.rmSync(npmCache, { recursive: true, force: true });
}

const result = JSON.parse(output)[0];
if (!result || !Array.isArray(result.files)) throw new Error('npm pack returned no file manifest');

const forbiddenNames = [
  /^\.env(?:\.|$)/,
  /^\.kimi-/,
  /router-state/i,
  /router\.jsonl/i,
  /launchd\.(?:out|err)\.log/i,
];
const secretPatterns = [
  /sk-kimi-[A-Za-z0-9_-]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9_-]{40,}\b/,
];

for (const item of result.files) {
  const segments = item.path.split('/');
  if (segments.some((segment) => forbiddenNames.some((pattern) => pattern.test(segment)))) {
    throw new Error(`forbidden artifact path: ${item.path}`);
  }
  const full = path.join(root, item.path);
  if (!fs.existsSync(full) || fs.statSync(full).size > 5 * 1024 * 1024) continue;
  const content = fs.readFileSync(full);
  if (content.includes(0)) continue;
  const text = content.toString('utf8');
  if (secretPatterns.some((pattern) => pattern.test(text))) {
    throw new Error(`possible credential in artifact file: ${item.path}`);
  }
}

console.log(`artifact inspection passed (${result.files.length} files, ${result.size} bytes packed)`);
