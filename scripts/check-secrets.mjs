#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const excluded = new Set(['.git', 'node_modules', 'coverage', 'releases']);
const patterns = [
  ['Kimi API key', /sk-kimi-[A-Za-z0-9_-]{20,}/g],
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['generic long secret key', /\bsk-[A-Za-z0-9_-]{40,}\b/g],
];

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function candidateFiles() {
  try {
    const tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return tracked.split('\n').filter(Boolean).map((file) => path.join(root, file));
  } catch {
    return walk(root);
  }
}

const findings = [];
for (const file of candidateFiles()) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue;
  const content = fs.readFileSync(file);
  if (content.includes(0)) continue;
  const text = content.toString('utf8');
  for (const [name, pattern] of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push({ file: path.relative(root, file), name });
  }
}

if (findings.length > 0) {
  for (const finding of findings) console.error(`${finding.file}: possible ${finding.name}`);
  process.exit(1);
}

console.log(`secret scan passed (${candidateFiles().length} files)`);
