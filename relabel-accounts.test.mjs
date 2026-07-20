#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  atomicWriteAccounts,
  normalizeAlias,
  parseArgs,
  readAccountReferences,
} from './relabel-accounts.mjs';

assert.equal(normalizeAlias(' Team-Primary '), 'team-primary');
assert.throws(() => normalizeAlias('user@example.test'), /opaque names/);
assert.throws(() => normalizeAlias('ab'), /3-64/);
assert.throws(() => normalizeAlias('team--primary'), /repeated hyphens/);

assert.deepEqual(
  parseArgs(['--alias', 'team-primary', '--alias', 'personal', '--delete-old']),
  {
    aliases: ['team-primary', 'personal'],
    audit: false,
    deleteOld: true,
    dryRun: false,
    help: false,
  }
);
assert.deepEqual(
  parseArgs(['--audit']),
  { aliases: [], audit: true, deleteOld: false, dryRun: false, help: false }
);
assert.throws(() => parseArgs(['--audit', '--alias', 'personal']), /cannot be combined/);
assert.throws(() => parseArgs(['--alias', 'same', '--alias', 'same']), /unique/);
assert.throws(() => parseArgs(['--unknown']), /unknown option/);

assert.deepEqual(
  readAccountReferences('# ignored\n first-source \nlabel = second-source\n'),
  ['first-source', 'second-source']
);
assert.throws(() => readAccountReferences('same\nSAME\n'), /duplicate/);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-router-alias-test-'));
try {
  const accountFile = path.join(directory, 'accounts');
  atomicWriteAccounts(accountFile, ['team-primary', 'personal']);
  assert.equal(fs.readFileSync(accountFile, 'utf8'), 'team-primary\npersonal\n');
  assert.equal(fs.statSync(accountFile).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith('.tmp')), false);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('ALL ACCOUNT-RELABEL TESTS PASSED');
