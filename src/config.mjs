/**
 * Router configuration: the env -> config resolution step.
 *
 * This module is a pure function of its arguments. It never touches the
 * ambient environment or the home directory: the process boundary
 * (`bin/kimi-router.mjs`) reads those and hands them in. That is what makes
 * the rest of `src/` auditable — every input the router depends on is named in
 * the record this function returns.
 *
 * Defaults live HERE and nowhere else. `src/router.mjs` treats every field as
 * required and never re-derives one, so a missing value is a loud failure in
 * the host rather than a silent fallback deep in the request path.
 *
 * Errors are thrown, not exited on: the caller owns the process.
 */

import path from 'node:path';

import { resolveProviderAdapter } from './provider-adapters.mjs';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Blank and unparseable values fall back, matching the documented behavior. */
function envMs(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function envString(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw;
}

function envInt(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A value the router must distinguish "unset" from "set to empty" for: an
 * empty KIMI_MANAGEMENT_TOKEN disables the token without printing the
 * secret-in-environment warning, and that difference is observable.
 */
function envOrNull(env, name) {
  const raw = env[name];
  return raw === undefined ? null : raw;
}

function resolvePort(env) {
  const raw = envString(env, 'PORT', '8787');
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`invalid PORT "${raw}": expected an integer between 1 and 65535`);
  }
  return parsed;
}

/**
 * @param {Record<string, string|undefined>} env  the host's environment
 * @param {string} homeDir  the host's home directory
 * @returns {Readonly<object>} every input `startRouter` needs
 */
export function resolveRouterConfig(env, homeDir) {
  const testClockFile = env.KIMI_TEST_CLOCK_FILE === undefined
    ? ''
    : env.KIMI_TEST_CLOCK_FILE.trim();
  if (testClockFile !== '' && env.NODE_ENV !== 'test') {
    throw new Error('KIMI_TEST_CLOCK_FILE is available only when NODE_ENV=test');
  }

  const stateFile = envString(
    env,
    'KIMI_ROUTER_STATE',
    path.join(homeDir, '.kimi-key-router-state.json')
  );
  const recoveryProbeInitialMs = envMs(env, 'KIMI_RECOVERY_PROBE_INITIAL_MS', 30_000);

  return Object.freeze({
    port: resolvePort(env),
    host: envString(env, 'HOST', '127.0.0.1'),
    allowRemoteHost: env.KIMI_ROUTER_ALLOW_REMOTE === '1',

    providerAdapter: resolveProviderAdapter(env),

    stateFile,
    stateLockFile: envString(env, 'KIMI_ROUTER_LOCK', `${stateFile}.lock`),
    accountsFile: envString(env, 'KIMI_ACCOUNTS_FILE', path.join(homeDir, '.kimi-key-accounts')),
    accountsMetaFile: envString(
      env,
      'KIMI_ACCOUNTS_META_FILE',
      path.join(homeDir, '.config', 'kimi-router', 'accounts.meta.json')
    ),
    legacyKeysFile: path.join(homeDir, '.kimi-keys'),
    keysFile: envOrNull(env, 'KIMI_KEYS_FILE'),
    apiKeys: envOrNull(env, 'KIMI_API_KEYS'),

    keychainService: envString(env, 'KIMI_KEYCHAIN_SERVICE', 'ai.ora.kimi-key-router'),
    secretBackend: envString(env, 'KIMI_SECRET_BACKEND', 'auto'),

    managementTokenFile: envString(
      env,
      'KIMI_MANAGEMENT_TOKEN_FILE',
      path.join(homeDir, '.config', 'kimi-router', 'management.header')
    ),
    managementToken: envOrNull(env, 'KIMI_MANAGEMENT_TOKEN'),

    logFile: envString(
      env,
      'KIMI_LOG_FILE',
      path.join(homeDir, '.local', 'state', 'kimi-router', 'router.jsonl')
    ),
    logToStdout: env.KIMI_LOG_STDOUT !== '0',
    logMaxBytes: envInt(env, 'KIMI_LOG_MAX_BYTES', 5 * 1024 * 1024),
    logRetain: envInt(env, 'KIMI_LOG_RETAIN', 3),

    cooldown5hMs: envMs(env, 'KIMI_COOLDOWN_5H_MS', 5 * HOUR),
    cooldownWeeklyMs: envMs(env, 'KIMI_COOLDOWN_WEEKLY_MS', 7 * DAY),
    cooldownMonthlyMs: envMs(env, 'KIMI_COOLDOWN_MONTHLY_MS', 30 * DAY),
    cooldownTransientMs: envMs(env, 'KIMI_COOLDOWN_TRANSIENT_MS', MINUTE),
    cooldownInvalidMs: envMs(env, 'KIMI_COOLDOWN_INVALID_MS', DAY),
    explorationIntervalMs: envMs(env, 'KIMI_EXPLORATION_INTERVAL_MS', 15 * MINUTE),
    preferenceTtlMs: envMs(env, 'KIMI_PREFERENCE_TTL_MS', 30 * MINUTE),
    recoveryProbeInitialMs,
    recoveryProbeMaxMs: Math.max(
      recoveryProbeInitialMs,
      envMs(env, 'KIMI_RECOVERY_PROBE_MAX_MS', 5 * MINUTE)
    ),

    headersTimeoutMs: envMs(env, 'KIMI_HEADERS_TIMEOUT_MS', 5 * MINUTE),
    maxBodyBytes: envMs(env, 'KIMI_MAX_BODY_BYTES', 32 * 1024 * 1024),
    errorBodyMaxBytes: envInt(env, 'KIMI_ERROR_BODY_MAX_BYTES', 1024 * 1024),
    maxInflightPerKey: envInt(env, 'KIMI_MAX_INFLIGHT_PER_KEY', 24),
    maxQueueDepth: envInt(env, 'KIMI_MAX_QUEUE_DEPTH', 128),
    queueTimeoutMs: envMs(env, 'KIMI_QUEUE_TIMEOUT_MS', 15_000),
    drainTimeoutMs: envMs(env, 'KIMI_DRAIN_TIMEOUT_MS', 120_000),
    retryAmbiguousRequests: env.KIMI_RETRY_AMBIGUOUS_REQUESTS === '1',

    testClockFile,
  });
}
