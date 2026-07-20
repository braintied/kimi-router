#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

process.umask(0o077);

export function normalizeAlias(value) {
  const alias = String(value ?? '').trim().toLowerCase();
  if (alias.includes('@')) {
    throw new Error('aliases must be opaque names without email syntax');
  }
  if (!/^[a-z][a-z0-9-]{1,62}[a-z0-9]$/.test(alias)) {
    throw new Error('aliases must be 3-64 lowercase letters, digits, or hyphens and start with a letter');
  }
  if (alias.includes('--')) {
    throw new Error('aliases must be opaque names without repeated hyphens');
  }
  return alias;
}

export function parseArgs(argv) {
  const options = { aliases: [], audit: false, deleteOld: false, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--alias') {
      if (index + 1 >= argv.length) throw new Error('--alias requires a value');
      options.aliases.push(normalizeAlias(argv[++index]));
    } else if (arg === '--audit') options.audit = true;
    else if (arg === '--delete-old') options.deleteOld = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  const unique = new Set(options.aliases);
  if (options.audit && (options.aliases.length > 0 || options.deleteOld || options.dryRun)) {
    throw new Error('--audit cannot be combined with relabel options');
  }
  if (!options.help && !options.audit && options.aliases.length === 0) {
    throw new Error('provide one --alias for each account');
  }
  if (unique.size !== options.aliases.length) throw new Error('aliases must be unique');
  return options;
}

export function readAccountReferences(contents) {
  const refs = contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.replace(/^label\s*=\s*/i, '').trim());
  if (refs.length === 0) throw new Error('the account file contains no account references');
  if (refs.some((ref) => ref === '' || /[\u0000-\u001f\u007f]/.test(ref))) {
    throw new Error('the account file contains an invalid account reference');
  }
  const unique = new Set(refs.map((ref) => ref.toLowerCase()));
  if (unique.size !== refs.length) throw new Error('the account file contains duplicate account references');
  return refs;
}

export function atomicWriteAccounts(accountsFile, aliases, fsApi = fs) {
  const directory = path.dirname(accountsFile);
  fsApi.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(accountsFile)}.${process.pid}.tmp`);
  let descriptor;
  try {
    descriptor = fsApi.openSync(temporary, 'wx', 0o600);
    fsApi.writeFileSync(descriptor, `${aliases.join('\n')}\n`, 'utf8');
    fsApi.fsyncSync(descriptor);
    fsApi.closeSync(descriptor);
    descriptor = undefined;
    fsApi.renameSync(temporary, accountsFile);
    fsApi.chmodSync(accountsFile, 0o600);
    const directoryFd = fsApi.openSync(directory, 'r');
    try { fsApi.fsyncSync(directoryFd); } finally { fsApi.closeSync(directoryFd); }
  } catch (error) {
    if (descriptor !== undefined) fsApi.closeSync(descriptor);
    try { fsApi.unlinkSync(temporary); } catch { /* absent */ }
    throw error;
  }
}

function usage() {
  console.log(`Usage:
  kimi-router-relabel --alias NAME [--alias NAME ...] [--dry-run] [--delete-old]
  kimi-router-relabel --audit

Copies each current macOS Keychain credential, in account-file order, to the
corresponding opaque alias. Source identifiers and secret values are never
printed or written to the replacement account file. --delete-old removes old
Keychain account metadata only after every copy and the atomic file swap pass.
--audit reports counts only and exits nonzero if email-shaped metadata remains.`);
}

function invokeHelper(helper, request) {
  const result = spawnSync('/usr/bin/xcrun', ['swift', helper], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout.trim()); } catch { /* handled below */ }
  return { status: result.status, parsed };
}

export function run(options, env = process.env) {
  if (process.platform !== 'darwin') {
    throw new Error('transactional account relabeling currently requires macOS Keychain');
  }
  const accountsFile = env.KIMI_ACCOUNTS_FILE || path.join(os.homedir(), '.kimi-key-accounts');
  const service = env.KIMI_KEYCHAIN_SERVICE || 'ai.ora.kimi-key-router';
  const helper = fileURLToPath(new URL('./keychain-relabel.swift', import.meta.url));
  if (options.audit) {
    const audit = invokeHelper(helper, { operation: 'audit', service, mappings: [] });
    if (audit.parsed === null || typeof audit.parsed.total !== 'number' ||
        typeof audit.parsed.identifying !== 'number') {
      throw new Error('Keychain metadata audit failed without exposing identifiers');
    }
    console.log(
      `Audited ${audit.parsed.total} Keychain account item(s); ` +
      `${audit.parsed.identifying} email-shaped identifier(s) remain.`
    );
    if (audit.status !== 0 || audit.parsed.ok !== true) process.exitCode = 2;
    return { total: audit.parsed.total, identifying: audit.parsed.identifying };
  }
  const sources = readAccountReferences(fs.readFileSync(accountsFile, 'utf8'));
  if (sources.length !== options.aliases.length) {
    throw new Error(`expected ${sources.length} aliases but received ${options.aliases.length}`);
  }
  const mappings = sources.map((source, index) => ({ source, target: options.aliases[index] }));
  const unchanged = mappings.every((mapping) => mapping.source === mapping.target);
  if (unchanged) {
    console.log(`Account file already uses ${mappings.length} requested opaque aliases.`);
    return { count: mappings.length, created: 0, reused: mappings.length, deleted: 0 };
  }
  if (options.dryRun) {
    console.log(`Validated a ${mappings.length}-account relabel plan; no Keychain or file changes were made.`);
    console.log(`Target aliases: ${options.aliases.join(', ')}`);
    return { count: mappings.length, created: 0, reused: 0, deleted: 0 };
  }

  const copied = invokeHelper(helper, { operation: 'copy', service, mappings });
  if (copied.status !== 0 || copied.parsed?.ok !== true || !Array.isArray(copied.parsed.createdTargets)) {
    throw new Error('Keychain copy/verification failed; source identifiers were not printed');
  }
  const createdSet = new Set(copied.parsed.createdTargets);
  const createdMappings = mappings.filter((mapping) => createdSet.has(mapping.target));
  try {
    atomicWriteAccounts(accountsFile, options.aliases);
  } catch (error) {
    if (createdMappings.length > 0) {
      invokeHelper(helper, { operation: 'delete-targets', service, mappings: createdMappings });
    }
    throw new Error('account-file swap failed; newly created aliases were rolled back');
  }

  let deleted = 0;
  if (options.deleteOld) {
    const cleanup = invokeHelper(helper, { operation: 'delete-sources', service, mappings });
    deleted = Number(cleanup.parsed?.deleted || 0);
    if (cleanup.status !== 0 || cleanup.parsed?.ok !== true) {
      console.error(`warning: relabeling succeeded, but ${Number(cleanup.parsed?.failed || 1)} old Keychain item(s) could not be removed`);
      process.exitCode = 2;
    }
  }
  console.log(
    `Relabeled ${mappings.length} account(s): ${copied.parsed.createdTargets.length} copied, ` +
    `${Number(copied.parsed.reused || 0)} reused, ${deleted} old item(s) removed.`
  );
  console.log(`Active aliases: ${options.aliases.join(', ')}`);
  return {
    count: mappings.length,
    created: copied.parsed.createdTargets.length,
    reused: Number(copied.parsed.reused || 0),
    deleted,
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { usage(); return; }
    run(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}
