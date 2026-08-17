#!/usr/bin/env node
/**
 * Pins the env -> config boundary.
 *
 * Two things are being defended. First, that nothing under src/ reads the
 * ambient environment: the router's inputs have to stay declared, or the
 * package quietly becomes unusable to anyone whose machine is set up
 * differently. Second, that every default the router used to resolve inline
 * still resolves to the same value now that the bin resolves it — the
 * restructure was meant to move where the reading happens, not what it reads.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { resolveRouterConfig } from './src/config.mjs';

const HOME = '/home/router-test';
const AMBIENT_READ = ['process', 'env'].join('.');
const AMBIENT_META = ['import', 'meta', 'env'].join('.');

function sourceFilesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(full);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [full] : [];
  });
}

const libraryFiles = sourceFilesUnder(new URL('./src', import.meta.url).pathname);
assert.ok(libraryFiles.length >= 5, 'expected the library modules to be found');
for (const file of libraryFiles) {
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(
    text.includes(AMBIENT_READ), false,
    `${path.basename(file)} reads the ambient environment; the host must pass config in`
  );
  assert.equal(
    text.includes(AMBIENT_META), false,
    `${path.basename(file)} reads the ambient environment; the host must pass config in`
  );
}

const defaults = resolveRouterConfig({}, HOME);

assert.equal(defaults.port, 8787);
assert.equal(defaults.host, '127.0.0.1');
assert.equal(defaults.allowRemoteHost, false);

assert.equal(defaults.providerAdapter.id, 'kimi-code-membership');
assert.equal(defaults.providerAdapter.baseUrl, 'https://api.kimi.com');
assert.equal(defaults.providerAdapter.authMode, 'both');

assert.equal(defaults.stateFile, `${HOME}/.kimi-key-router-state.json`);
assert.equal(defaults.stateLockFile, `${HOME}/.kimi-key-router-state.json.lock`);
assert.equal(defaults.accountsFile, `${HOME}/.kimi-key-accounts`);
assert.equal(defaults.accountsMetaFile, `${HOME}/.config/kimi-router/accounts.meta.json`);
assert.equal(defaults.legacyKeysFile, `${HOME}/.kimi-keys`);
assert.equal(defaults.keysFile, null);
assert.equal(defaults.apiKeys, null);

assert.equal(defaults.keychainService, 'ai.ora.kimi-key-router');
assert.equal(defaults.secretBackend, 'auto');
assert.equal(defaults.managementTokenFile, `${HOME}/.config/kimi-router/management.header`);
assert.equal(defaults.managementToken, null);

assert.equal(defaults.logFile, `${HOME}/.local/state/kimi-router/router.jsonl`);
assert.equal(defaults.logToStdout, true);
assert.equal(defaults.logMaxBytes, 5 * 1024 * 1024);
assert.equal(defaults.logRetain, 3);

assert.equal(defaults.cooldown5hMs, 18_000_000);
assert.equal(defaults.cooldownWeeklyMs, 604_800_000);
assert.equal(defaults.cooldownMonthlyMs, 2_592_000_000);
assert.equal(defaults.cooldownTransientMs, 60_000);
assert.equal(defaults.cooldownInvalidMs, 86_400_000);
assert.equal(defaults.explorationIntervalMs, 900_000);
assert.equal(defaults.preferenceTtlMs, 1_800_000);
assert.equal(defaults.recoveryProbeInitialMs, 30_000);
assert.equal(defaults.recoveryProbeMaxMs, 300_000);

assert.equal(defaults.headersTimeoutMs, 300_000);
assert.equal(defaults.maxBodyBytes, 33_554_432);
assert.equal(defaults.errorBodyMaxBytes, 1_048_576);
assert.equal(defaults.maxInflightPerKey, 24);
assert.equal(defaults.maxQueueDepth, 128);
assert.equal(defaults.queueTimeoutMs, 15_000);
assert.equal(defaults.drainTimeoutMs, 120_000);
assert.equal(defaults.retryAmbiguousRequests, false);
assert.equal(defaults.testClockFile, '');

assert.equal(Object.isFrozen(defaults), true, 'the config record must not be mutable');

// A blank or unparseable value falls back rather than producing a zero timeout.
const sloppy = resolveRouterConfig(
  { KIMI_COOLDOWN_5H_MS: '   ', KIMI_QUEUE_TIMEOUT_MS: 'soon', KIMI_LOG_RETAIN: '0' },
  HOME
);
assert.equal(sloppy.cooldown5hMs, 18_000_000);
assert.equal(sloppy.queueTimeoutMs, 15_000);
assert.equal(sloppy.logRetain, 3);

// The maximum probe backoff can never sit below the initial one.
const probes = resolveRouterConfig(
  { KIMI_RECOVERY_PROBE_INITIAL_MS: '90000', KIMI_RECOVERY_PROBE_MAX_MS: '1000' },
  HOME
);
assert.equal(probes.recoveryProbeMaxMs, 90_000);

// Unset and empty are different for the management token: empty disables it
// without the secret-in-environment warning the router prints otherwise.
assert.equal(resolveRouterConfig({ KIMI_MANAGEMENT_TOKEN: '' }, HOME).managementToken, '');
assert.equal(resolveRouterConfig({}, HOME).managementToken, null);

const overridden = resolveRouterConfig({
  PORT: '9001',
  HOST: '0.0.0.0',
  KIMI_ROUTER_ALLOW_REMOTE: '1',
  KIMI_LOG_STDOUT: '0',
  KIMI_RETRY_AMBIGUOUS_REQUESTS: '1',
  KIMI_ROUTER_STATE: '/tmp/state.json',
  KIMI_KEYS_FILE: '/tmp/keys',
  KIMI_PROVIDER_PROFILE: 'open-platform',
}, HOME);
assert.equal(overridden.port, 9001);
assert.equal(overridden.host, '0.0.0.0');
assert.equal(overridden.allowRemoteHost, true);
assert.equal(overridden.logToStdout, false);
assert.equal(overridden.retryAmbiguousRequests, true);
assert.equal(overridden.stateLockFile, '/tmp/state.json.lock');
assert.equal(overridden.keysFile, '/tmp/keys');
assert.equal(overridden.providerAdapter.id, 'kimi-open-platform');

assert.throws(() => resolveRouterConfig({ PORT: '70000' }, HOME), /invalid PORT/);
assert.throws(() => resolveRouterConfig({ PORT: 'http' }, HOME), /invalid PORT/);
assert.throws(
  () => resolveRouterConfig({ KIMI_TEST_CLOCK_FILE: '/tmp/clock' }, HOME),
  /only when NODE_ENV=test/
);
assert.equal(
  resolveRouterConfig({ KIMI_TEST_CLOCK_FILE: '/tmp/clock', NODE_ENV: 'test' }, HOME).testClockFile,
  '/tmp/clock'
);
assert.throws(
  () => resolveRouterConfig({ KIMI_PROVIDER_PROFILE: 'nonesuch' }, HOME),
  /unknown KIMI_PROVIDER_PROFILE/
);

console.log('ALL CONFIG BOUNDARY TESTS PASSED');
