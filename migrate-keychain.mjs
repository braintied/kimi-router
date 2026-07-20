#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

process.umask(0o077);

const service = process.env.KIMI_KEYCHAIN_SERVICE || 'ai.ora.kimi-key-router';
const legacyFile = process.env.KIMI_KEYS_FILE || path.join(os.homedir(), '.kimi-keys');
const accountsFile = process.env.KIMI_ACCOUNTS_FILE || path.join(os.homedir(), '.kimi-key-accounts');
const deleteLegacy = process.argv.includes('--delete-legacy');
const dryRun = process.argv.includes('--dry-run');
const keychainWriter = fileURLToPath(new URL('./keychain-write.swift', import.meta.url));

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sanitizeLabel(value) {
  return value
    .trim()
    .replace(/^label\s*:\s*/i, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 120);
}

if (process.platform !== 'darwin') fail('This migration requires macOS Keychain.');
if (!fs.existsSync(legacyFile)) fail(`Legacy key file not found: ${legacyFile}`);

const entries = [];
let pendingLabel = '';
for (const rawLine of fs.readFileSync(legacyFile, 'utf8').split('\n')) {
  const line = rawLine.trim();
  if (line === '') continue;
  if (line.startsWith('#')) {
    pendingLabel = sanitizeLabel(line.slice(1));
    continue;
  }
  if (pendingLabel === '') fail('Every legacy key must have a preceding # account label.');
  entries.push({ label: pendingLabel, secret: line });
  pendingLabel = '';
}
if (entries.length === 0) fail('The legacy key file contains no keys.');

const labels = new Set();
for (const entry of entries) {
  const normalized = entry.label.toLowerCase();
  if (labels.has(normalized)) fail(`Duplicate account label: ${entry.label}`);
  labels.add(normalized);
}

console.log(`${dryRun ? 'Would migrate' : 'Migrating'} ${entries.length} labelled Kimi accounts to Keychain service ${service}.`);

if (dryRun) {
  for (const entry of entries) console.log(`  ${entry.label}`);
  process.exit(0);
}

const written = spawnSync(
  '/usr/bin/xcrun',
  ['swift', keychainWriter],
  {
    input: JSON.stringify(entries.map((entry) => ({
      service,
      account: entry.label,
      secret: entry.secret,
    }))),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  }
);
if (written.status !== 0) {
  fail(`Keychain write failed: ${(written.stderr || '').trim().slice(0, 500)}`);
}

for (const entry of entries) {
  const verified = spawnSync(
    '/usr/bin/security',
    ['find-generic-password', '-s', service, '-a', entry.label, '-w'],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  );
  if (verified.status !== 0 || verified.stdout.trim() !== entry.secret) {
    fail(`Keychain verification failed for ${entry.label}; the legacy file was left intact.`);
  }
  console.log(`  verified ${entry.label}`);
}

fs.mkdirSync(path.dirname(accountsFile), { recursive: true, mode: 0o700 });
const tmp = `${accountsFile}.tmp`;
fs.writeFileSync(tmp, `${entries.map((entry) => entry.label).join('\n')}\n`, { mode: 0o600 });
fs.renameSync(tmp, accountsFile);
fs.chmodSync(accountsFile, 0o600);

if (deleteLegacy) {
  fs.unlinkSync(legacyFile);
  console.log(`Removed verified plaintext key file: ${legacyFile}`);
} else {
  console.log(`Legacy plaintext remains at ${legacyFile}; rerun with --delete-legacy after validation.`);
}
console.log(`Label-only account file written: ${accountsFile}`);
