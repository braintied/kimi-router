#!/usr/bin/env node
/**
 * Process boundary for `kimi-router-relabel`.
 *
 * Environment:
 *   KIMI_ACCOUNTS_FILE    account label file (default ~/.kimi-key-accounts)
 *   KIMI_KEYCHAIN_SERVICE Keychain service (default ai.ora.kimi-key-router)
 */

import os from 'node:os';
import path from 'node:path';

import { parseArgs, run, usage } from '../src/relabel-accounts.mjs';

process.umask(0o077);

function resolveTarget(env, homeDir) {
  const accountsFile = env.KIMI_ACCOUNTS_FILE === undefined || env.KIMI_ACCOUNTS_FILE === ''
    ? path.join(homeDir, '.kimi-key-accounts')
    : env.KIMI_ACCOUNTS_FILE;
  const service = env.KIMI_KEYCHAIN_SERVICE === undefined || env.KIMI_KEYCHAIN_SERVICE === ''
    ? 'ai.ora.kimi-key-router'
    : env.KIMI_KEYCHAIN_SERVICE;
  return { accountsFile, service };
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) usage();
  else run(options, resolveTarget(process.env, os.homedir()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
