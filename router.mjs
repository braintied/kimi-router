#!/usr/bin/env node
/**
 * Kimi Router v3
 *
 * Local pass-through proxy that rotates a pool of Kimi API keys.
 * When a key returns 429 (5-hour or weekly plan limit), the router
 * cools it down and transparently retries the same request with the
 * next available key. Only routing metadata (`model`) is inspected; prompts
 * and tool payloads are never logged. Both Anthropic- and OpenAI-compatible
 * endpoints are supported.
 *
 * Zero dependencies. Requires Node 20+.
 *
 * The upstream leg uses node:http/node:https directly (NOT global fetch):
 * undici's defaults include a 300s bodyTimeout that kills any SSE stream
 * with a >300s gap between chunks — verified empirically. Raw http.request
 * has no body timeout, and its IncomingMessage pipes straight to the client
 * with no web-stream conversion layer.
 *
 * Config (env):
 *   KIMI_API_KEYS       comma-separated keys (testing only; visible in env)
 *   KIMI_ACCOUNTS_FILE  Keychain account labels (default ~/.kimi-key-accounts)
 *   KIMI_KEYCHAIN_SERVICE secret-store service (default ai.ora.kimi-key-router)
 *   KIMI_SECRET_BACKEND  auto, macos-keychain, or linux-secret-service
 *   KIMI_KEYS_FILE      explicit legacy/test key file (overrides Keychain)
 *   KIMI_BASE_URL       upstream base (default https://api.moonshot.ai)
 *   KIMI_ROUTER_STATE   state file path (default ~/.kimi-key-router-state.json)
 *   KIMI_MANAGEMENT_TOKEN_FILE bearer header file for management endpoints
 *                              (default ~/.config/kimi-router/management.header)
 *   PORT / HOST         listen address (default 8787 / 127.0.0.1)
 *   KIMI_COOLDOWN_5H_MS        default 18000000 (5h)
 *   KIMI_COOLDOWN_WEEKLY_MS    default 604800000 (7d) — real weekly reset time
 *                              is unknown, so this is a conservative guess
 *   KIMI_COOLDOWN_TRANSIENT_MS default 60000  (network/5xx)
 *   KIMI_COOLDOWN_INVALID_MS   default 86400000 (24h, 401/402/403)
 *   KIMI_HEADERS_TIMEOUT_MS    default 300000 — max wait for upstream response
 *                              headers; NO limit on response body lifetime
 *   KIMI_RECOVERY_PROBE_INITIAL_MS default 30000 (30s) — earliest a real
 *                              client request may re-check a quota-cooled key
 *   KIMI_RECOVERY_PROBE_MAX_MS default 300000 (5m) — maximum failed-probe
 *                              backoff; no synthetic requests are generated
 *   KIMI_ROUTER_ALLOW_REMOTE   set to "1" to allow binding a non-loopback HOST
 *                              (DANGEROUS: the router has no authentication)
 *   KIMI_MAX_BODY_BYTES        default 33554432 (32 MB) request body cap
 *   KIMI_RETRY_AMBIGUOUS_REQUESTS set to "1" to replay POST requests after
 *                              network/408/5xx failures (DANGEROUS: an
 *                              accepted request could be billed twice)
 *
 * Management endpoints (not proxied):
 *   GET  /healthz
 *   GET  /status   per-key availability, cooldowns, counters
 *   POST /reload   hot-reload the labelled Keychain pool
 *   POST /reset    clear all cooldowns immediately
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream';
import { createSecretStore } from './secret-store.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function envString(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const PORT = (() => {
  const raw = envString('PORT', '8787');
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.error(`invalid PORT "${raw}": expected an integer between 1 and 65535`);
    process.exit(1);
  }
  return parsed;
})();
const HOST = envString('HOST', '127.0.0.1');
const UPSTREAM = envString('KIMI_BASE_URL', 'https://api.moonshot.ai').replace(/\/+$/, '');
const STATE_FILE = envString(
  'KIMI_ROUTER_STATE',
  path.join(os.homedir(), '.kimi-key-router-state.json')
);
const ACCOUNTS_FILE = envString(
  'KIMI_ACCOUNTS_FILE',
  path.join(os.homedir(), '.kimi-key-accounts')
);
const LEGACY_KEYS_FILE = path.join(os.homedir(), '.kimi-keys');
const KEYCHAIN_SERVICE = envString('KIMI_KEYCHAIN_SERVICE', 'ai.ora.kimi-key-router');
const SECRET_BACKEND = envString('KIMI_SECRET_BACKEND', 'auto');
const LOG_FILE = envString(
  'KIMI_LOG_FILE',
  path.join(os.homedir(), '.local', 'state', 'kimi-router', 'router.jsonl')
);
const MANAGEMENT_TOKEN_FILE = envString(
  'KIMI_MANAGEMENT_TOKEN_FILE',
  path.join(os.homedir(), '.config', 'kimi-router', 'management.header')
);

const COOLDOWN_5H = envMs('KIMI_COOLDOWN_5H_MS', 5 * HOUR);
const COOLDOWN_WEEKLY = envMs('KIMI_COOLDOWN_WEEKLY_MS', 7 * DAY);
const COOLDOWN_MONTHLY = envMs('KIMI_COOLDOWN_MONTHLY_MS', 30 * DAY);
const COOLDOWN_TRANSIENT = envMs('KIMI_COOLDOWN_TRANSIENT_MS', MINUTE);
const COOLDOWN_INVALID = envMs('KIMI_COOLDOWN_INVALID_MS', DAY);
const EXPLORATION_INTERVAL = envMs('KIMI_EXPLORATION_INTERVAL_MS', 15 * MINUTE);
const PREFERENCE_TTL = envMs('KIMI_PREFERENCE_TTL_MS', 30 * MINUTE);
const RECOVERY_PROBE_INITIAL = envMs('KIMI_RECOVERY_PROBE_INITIAL_MS', 30_000);
const RECOVERY_PROBE_MAX = Math.max(
  RECOVERY_PROBE_INITIAL,
  envMs('KIMI_RECOVERY_PROBE_MAX_MS', 5 * MINUTE)
);
const HEADERS_TIMEOUT_MS = envMs('KIMI_HEADERS_TIMEOUT_MS', 5 * MINUTE);
const MAX_BODY_BYTES = envMs('KIMI_MAX_BODY_BYTES', 32 * 1024 * 1024);
const BODY_IDLE_TIMEOUT_MS = 60_000;
const ERROR_BODY_MAX_BYTES = envInt('KIMI_ERROR_BODY_MAX_BYTES', 1024 * 1024);
const MAX_INFLIGHT_PER_KEY = envInt('KIMI_MAX_INFLIGHT_PER_KEY', 24);
const MAX_QUEUE_DEPTH = envInt('KIMI_MAX_QUEUE_DEPTH', 128);
const QUEUE_TIMEOUT_MS = envMs('KIMI_QUEUE_TIMEOUT_MS', 15_000);
const DRAIN_TIMEOUT_MS = envMs('KIMI_DRAIN_TIMEOUT_MS', 120_000);
const LOG_MAX_BYTES = envInt('KIMI_LOG_MAX_BYTES', 5 * 1024 * 1024);
const LOG_RETAIN = envInt('KIMI_LOG_RETAIN', 3);
const RETRY_AMBIGUOUS_REQUESTS = process.env.KIMI_RETRY_AMBIGUOUS_REQUESTS === '1';

// 402 included: a key on an exhausted paid plan is useless until topped up.
const ROTATE_STATUSES = new Set([401, 402, 403, 408, 429]);

function rotateLogIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE) || fs.statSync(LOG_FILE).size < LOG_MAX_BYTES) return;
    for (let i = LOG_RETAIN - 1; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      const to = `${LOG_FILE}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch (err) {
    console.error(`log rotation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function log(message, fields = {}) {
  const entry = JSON.stringify({ ...fields, timestamp: new Date().toISOString(), message });
  if (process.env.KIMI_LOG_STDOUT !== '0') console.log(entry);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 });
    rotateLogIfNeeded();
    fs.appendFileSync(LOG_FILE, `${entry}\n`, { mode: 0o600 });
    fs.chmodSync(LOG_FILE, 0o600);
  } catch (err) {
    console.error(`log write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function normalizeManagementToken(value) {
  const trimmed = value.trim();
  const header = trimmed.match(/^authorization\s*:\s*bearer\s+(.+)$/i);
  return (header === null ? trimmed : header[1].trim()).slice(0, 4096);
}

function loadManagementToken() {
  if (process.env.KIMI_MANAGEMENT_TOKEN !== undefined) {
    if (process.env.KIMI_MANAGEMENT_TOKEN !== '') {
      console.error('note: KIMI_MANAGEMENT_TOKEN exposes a secret through the process environment; a token file is preferred');
    }
    return normalizeManagementToken(process.env.KIMI_MANAGEMENT_TOKEN);
  }
  if (!fs.existsSync(MANAGEMENT_TOKEN_FILE)) return '';
  const mode = fs.statSync(MANAGEMENT_TOKEN_FILE).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`management token file must not be group/world accessible: ${MANAGEMENT_TOKEN_FILE}`);
  }
  const token = normalizeManagementToken(fs.readFileSync(MANAGEMENT_TOKEN_FILE, 'utf8'));
  if (token === '') throw new Error(`management token file is empty: ${MANAGEMENT_TOKEN_FILE}`);
  return token;
}

let MANAGEMENT_TOKEN;
try {
  MANAGEMENT_TOKEN = loadManagementToken();
} catch (err) {
  console.error(`Could not load management authentication: ${err instanceof Error ? err.message : String(err)}`);
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

function readLegacyKeyFile(keyFile) {
  if (!fs.existsSync(keyFile)) return [];
  try {
    const mode = fs.statSync(keyFile).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      console.error(`warning: ${keyFile} is readable by others (mode ${mode.toString(8)})`);
    }
  } catch {
    // The read below reports the actionable error.
  }
  const entries = [];
  let pendingLabel = '';
  for (const rawLine of fs.readFileSync(keyFile, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      const label = sanitizeLabel(line.slice(1));
      if (label !== '') pendingLabel = label;
      continue;
    }
    entries.push({ raw: line, label: pendingLabel, source: 'file' });
    pendingLabel = '';
  }
  return entries;
}

let osSecretStore = null;

function configuredSecretStore() {
  if (osSecretStore === null) {
    osSecretStore = createSecretStore({
      backend: SECRET_BACKEND,
      service: KEYCHAIN_SERVICE,
    });
  }
  return osSecretStore;
}

function readKeychainAccounts(accountsFile) {
  if (!fs.existsSync(accountsFile)) return [];
  const labels = fs.readFileSync(accountsFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => sanitizeLabel(line.replace(/^label\s*=\s*/i, '')))
    .filter((label) => label !== '');
  const store = configuredSecretStore();
  return labels.map((label) => ({ raw: store.read(label), label, source: store.source }));
}

function configuredKeySourcePath() {
  if (process.env.KIMI_KEYS_FILE?.trim()) return process.env.KIMI_KEYS_FILE.trim();
  if (process.env.KIMI_API_KEYS?.trim()) return null;
  if (fs.existsSync(ACCOUNTS_FILE)) return ACCOUNTS_FILE;
  return LEGACY_KEYS_FILE;
}

function dedupeEntries(entries) {
  const seenKeys = new Set();
  const seenLabels = new Set();
  return entries.filter((entry) => {
    if (seenKeys.has(entry.raw)) {
      console.error(`warning: duplicate key ignored${entry.label === '' ? '' : ` (${entry.label})`}`);
      return false;
    }
    const normalizedLabel = entry.label.toLowerCase();
    if (normalizedLabel !== '' && seenLabels.has(normalizedLabel)) {
      throw new Error(`duplicate key label: ${entry.label}`);
    }
    seenKeys.add(entry.raw);
    if (normalizedLabel !== '') seenLabels.add(normalizedLabel);
    return true;
  });
}

function loadKeyEntries() {
  const fromEnv = process.env.KIMI_API_KEYS;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    console.error('note: KIMI_API_KEYS exposes secrets through the process environment; Keychain is preferred');
    return dedupeEntries(fromEnv
      .split(',')
      .map((raw, index) => ({ raw: raw.trim(), label: `env-${index + 1}`, source: 'environment' }))
      .filter((entry) => entry.raw !== ''));
  }
  const explicitFile = process.env.KIMI_KEYS_FILE?.trim();
  if (explicitFile) return dedupeEntries(readLegacyKeyFile(explicitFile));
  if (fs.existsSync(ACCOUNTS_FILE)) return dedupeEntries(readKeychainAccounts(ACCOUNTS_FILE));
  return dedupeEntries(readLegacyKeyFile(LEGACY_KEYS_FILE));
}

let keyEntries;
try {
  keyEntries = loadKeyEntries();
} catch (err) {
  console.error(`Could not load Kimi key pool: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (keyEntries.length === 0) {
  console.error('No Kimi API keys found. Either:');
  console.error('  export KIMI_API_KEYS="sk-aaa,sk-bbb"');
  console.error(`  or configure Keychain labels in ${ACCOUNTS_FILE}`);
  process.exit(1);
}

function createKey(entry, index) {
  const label = entry.label || `key-${index + 1}`;
  const accountId = entry.accountId || label.toLowerCase();
  return {
  raw: entry.raw,
  label,
  accountId,
  credentialId: entry.credentialId || stateId(entry.raw),
  source: entry.source || 'unknown',
  credentialCooldownUntil: 0,
  credentialCooldownReason: '',
  cooldownUntil: 0,
  cooldownReason: '',
  fails: 0,
  successes: 0,
  accepted: 0,
  completed: 0,
  streamFailures: 0,
  inFlight: 0,
  activeAttemptIds: new Set(),
  consecutiveFailures: 0,
  lastAttemptAt: 0,
  lastSuccessAt: 0,
  lastFailureAt: 0,
  lastStatus: null,
  latencyEwmaMs: null,
  rateLimit: null,
  pendingFailure: null,
  latestSuccessAttemptId: 0,
  latestFailureAttemptId: 0,
  capabilityCooldowns: Object.create(null),
  retiring: false,
  nextRecoveryProbeAt: 0,
  recoveryRequired: false,
  recoveryProbeBackoffMs: RECOVERY_PROBE_INITIAL,
  lastRecoveryProbeAt: 0,
  recoveryProbeInFlight: false,
  };
}

let keys = keyEntries.map(createKey);
let nextAttemptId = 1;
let activeRequests = 0;
let shuttingDown = false;

// ---------------------------------------------------------------------------
// State persistence. State is keyed by a hash of the raw key (never the key
// itself) so this file is not a second on-disk copy of the secret pool.
// Writes are debounced (dirty flag + timer), atomic (tmp file + rename), and
// flushed synchronously on shutdown.
// ---------------------------------------------------------------------------

function stateId(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function accountStateId(accountId) {
  return `account-${crypto.createHash('sha256').update(`account\0${accountId.toLowerCase()}`).digest('hex').slice(0, 16)}`;
}

let stateDirty = false;
let rrPointer = 0;
let preferredLabel = '';
let preferredUntil = 0;
let lastExplorationAt = 0;
let lastSelectionReason = 'startup';

function saveState() {
  stateDirty = true;
}

function flushState() {
  if (!stateDirty) return;
  stateDirty = false;
  const out = Object.create(null);
  const credentialState = Object.create(null);
  for (const k of keys) {
    out[accountStateId(k.accountId)] = {
      cooldownUntil: k.cooldownUntil,
      cooldownReason: k.cooldownReason,
      fails: k.fails,
      successes: k.successes,
      accepted: k.accepted,
      completed: k.completed,
      streamFailures: k.streamFailures,
      consecutiveFailures: k.consecutiveFailures,
      lastAttemptAt: k.lastAttemptAt,
      lastSuccessAt: k.lastSuccessAt,
      lastFailureAt: k.lastFailureAt,
      lastStatus: k.lastStatus,
      latencyEwmaMs: k.latencyEwmaMs,
      rateLimit: k.rateLimit,
      latestSuccessAttemptId: k.latestSuccessAttemptId,
      latestFailureAttemptId: k.latestFailureAttemptId,
      capabilityCooldowns: k.capabilityCooldowns,
      nextRecoveryProbeAt: k.nextRecoveryProbeAt,
      recoveryRequired: k.recoveryRequired,
      recoveryProbeBackoffMs: k.recoveryProbeBackoffMs,
      lastRecoveryProbeAt: k.lastRecoveryProbeAt,
    };
    credentialState[stateId(k.raw)] = {
      cooldownUntil: k.credentialCooldownUntil,
      cooldownReason: k.credentialCooldownReason,
    };
  }
  out.__credentials = credentialState;
  out.__router = {
    rrPointer,
    preferredLabel,
    preferredUntil,
    lastExplorationAt,
    lastSelectionReason,
  };
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE); // atomic on the same filesystem
    fs.chmodSync(STATE_FILE, 0o600); // rename drops the mode; re-enforce
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`warning: could not persist state: ${message}`);
  }
}

function loadState() {
  let raw;
  let stateObservedAt = Date.now();
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
    stateObservedAt = fs.statSync(STATE_FILE).mtimeMs;
  } catch {
    return; // no state file yet — fine
  }
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    log(`warning: state file ${STATE_FILE} is not valid JSON, ignoring it`);
    return;
  }
  const routerState = saved.__router;
  if (routerState !== null && typeof routerState === 'object') {
    if (Number.isInteger(routerState.rrPointer)) {
      rrPointer = Math.max(0, Math.min(keys.length - 1, routerState.rrPointer));
    }
    if (typeof routerState.preferredLabel === 'string') preferredLabel = routerState.preferredLabel;
    if (typeof routerState.preferredUntil === 'number') preferredUntil = routerState.preferredUntil;
    if (typeof routerState.lastExplorationAt === 'number') lastExplorationAt = routerState.lastExplorationAt;
    if (typeof routerState.lastSelectionReason === 'string') {
      lastSelectionReason = routerState.lastSelectionReason;
    }
  }
  for (const k of keys) {
    const s = saved[accountStateId(k.accountId)] ?? saved[stateId(k.raw)];
    const credentialState = saved.__credentials?.[stateId(k.raw)];
    if (credentialState !== null && typeof credentialState === 'object') {
      if (typeof credentialState.cooldownUntil === 'number') {
        k.credentialCooldownUntil = credentialState.cooldownUntil;
      }
      if (typeof credentialState.cooldownReason === 'string') {
        k.credentialCooldownReason = credentialState.cooldownReason;
      }
    }
    if (s === undefined || s === null || typeof s !== 'object') continue;
    if (typeof s.cooldownUntil === 'number') k.cooldownUntil = s.cooldownUntil;
    if (typeof s.cooldownReason === 'string') k.cooldownReason = s.cooldownReason;
    if (typeof s.fails === 'number') k.fails = s.fails;
    if (typeof s.successes === 'number') k.successes = s.successes;
    if (typeof s.accepted === 'number') k.accepted = s.accepted;
    if (typeof s.completed === 'number') k.completed = s.completed;
    if (typeof s.streamFailures === 'number') k.streamFailures = s.streamFailures;
    if (typeof s.consecutiveFailures === 'number') k.consecutiveFailures = s.consecutiveFailures;
    if (typeof s.lastAttemptAt === 'number') k.lastAttemptAt = s.lastAttemptAt;
    if (typeof s.lastSuccessAt === 'number') k.lastSuccessAt = s.lastSuccessAt;
    if (typeof s.lastFailureAt === 'number') k.lastFailureAt = s.lastFailureAt;
    if (typeof s.lastStatus === 'number' || s.lastStatus === null) k.lastStatus = s.lastStatus;
    if (typeof s.latencyEwmaMs === 'number') k.latencyEwmaMs = s.latencyEwmaMs;
    if (s.rateLimit !== null && typeof s.rateLimit === 'object') k.rateLimit = s.rateLimit;
    if (typeof s.latestSuccessAttemptId === 'number') {
      k.latestSuccessAttemptId = s.latestSuccessAttemptId;
      nextAttemptId = Math.max(nextAttemptId, s.latestSuccessAttemptId + 1);
    }
    if (typeof s.latestFailureAttemptId === 'number') {
      k.latestFailureAttemptId = s.latestFailureAttemptId;
      nextAttemptId = Math.max(nextAttemptId, s.latestFailureAttemptId + 1);
    }
    if (s.capabilityCooldowns !== null && typeof s.capabilityCooldowns === 'object') {
      for (const [capability, circuit] of Object.entries(s.capabilityCooldowns)) {
        if (
          circuit !== null && typeof circuit === 'object' &&
          typeof circuit.until === 'number' && typeof circuit.reason === 'string'
        ) {
          k.capabilityCooldowns[capability] = {
            until: circuit.until,
            reason: circuit.reason,
            lastStatus: typeof circuit.lastStatus === 'number' ? circuit.lastStatus : null,
          };
        }
      }
    }
    if (typeof s.nextRecoveryProbeAt === 'number') {
      k.nextRecoveryProbeAt = s.nextRecoveryProbeAt;
    }
    if (typeof s.recoveryRequired === 'boolean') {
      k.recoveryRequired = s.recoveryRequired;
    }
    if (typeof s.recoveryProbeBackoffMs === 'number' && s.recoveryProbeBackoffMs > 0) {
      k.recoveryProbeBackoffMs = Math.min(
        RECOVERY_PROBE_MAX,
        Math.max(RECOVERY_PROBE_INITIAL, s.recoveryProbeBackoffMs)
      );
    }
    if (typeof s.lastRecoveryProbeAt === 'number') {
      k.lastRecoveryProbeAt = s.lastRecoveryProbeAt;
    }
    // Migrate counters written before adaptive timestamps existed. A currently
    // cooling legacy key was last observed failing; an available key with prior
    // successes was last observed healthy at the state file's modification time.
    if (k.lastAttemptAt === 0) {
      k.lastAttemptAt = stateObservedAt;
      if (k.cooldownUntil > stateObservedAt && k.fails > 0) {
        k.lastFailureAt = stateObservedAt;
      } else if (k.successes > 0) {
        k.lastSuccessAt = stateObservedAt;
        k.lastStatus = 200;
      }
    }
    // Repair state written by adaptive-health-v1, where recordSuccess updated
    // lastStatus/lastSuccessAt but did not clear an older cooldownUntil. A
    // later successful response is authoritative evidence that the key works.
    if (
      k.cooldownUntil > Date.now() &&
      k.lastStatus >= 200 &&
      k.lastStatus < 400 &&
      k.lastSuccessAt > k.lastFailureAt
    ) {
      log(`repairing stale cooldown for ${k.label} after persisted HTTP ${k.lastStatus} success`);
      k.cooldownUntil = 0;
      k.cooldownReason = '';
      k.nextRecoveryProbeAt = 0;
      k.recoveryRequired = false;
      k.recoveryProbeBackoffMs = RECOVERY_PROBE_INITIAL;
      saveState();
      continue;
    }
    // Migrate five-hour quota state written before strict timers existed.
    // The first request after the persisted deadline is serialized as a
    // recovery probe instead of letting every terminal stampede the account.
    if (
      k.lastStatus === 429 && /5-hour rolling usage limit/i.test(k.cooldownReason) &&
      k.lastFailureAt >= k.lastSuccessAt && k.cooldownUntil > 0 &&
      !k.recoveryRequired
    ) {
      k.recoveryRequired = true;
      k.nextRecoveryProbeAt = Math.max(k.nextRecoveryProbeAt, k.cooldownUntil);
      saveState();
    }
    // Older state files predate recovery scheduling. Derive the first
    // opportunity from the last observed failure so a refilled account is not
    // stranded until a conservative 24-hour/weekly/monthly cooldown expires.
    if (
      k.cooldownUntil > Date.now() &&
      recoveryProbeEligible(k.lastStatus, k.cooldownReason, k.recoveryRequired) &&
      k.nextRecoveryProbeAt === 0
    ) {
      const observedFailureAt = k.lastFailureAt > 0 ? k.lastFailureAt : stateObservedAt;
      k.nextRecoveryProbeAt = Math.min(
        k.cooldownUntil,
        observedFailureAt + RECOVERY_PROBE_INITIAL
      );
      saveState();
    }
    // Recovery windows are operational policy, not provider reset times.
    // Clamp old persisted schedules when the policy is tightened so a newly
    // replenished subscription cannot remain stranded behind yesterday's
    // hour-long backoff. Explicit five-hour timers remain strict.
    const latestOrdinaryProbeAt = Date.now() + RECOVERY_PROBE_MAX;
    if (
      !k.recoveryRequired &&
      k.cooldownUntil > Date.now() &&
      recoveryProbeEligible(k.lastStatus, k.cooldownReason) &&
      k.nextRecoveryProbeAt > latestOrdinaryProbeAt
    ) {
      log(`shortening stale recovery schedule for ${k.label}`, {
        previous: isoOrNull(k.nextRecoveryProbeAt),
        next: isoOrNull(Math.min(k.cooldownUntil, latestOrdinaryProbeAt)),
      });
      k.nextRecoveryProbeAt = Math.min(k.cooldownUntil, latestOrdinaryProbeAt);
      k.recoveryProbeBackoffMs = Math.min(k.recoveryProbeBackoffMs, RECOVERY_PROBE_MAX);
      saveState();
    }
  }
}

function reloadKeys() {
  let entries;
  try {
    entries = loadKeyEntries();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('key pool reload failed', { message });
    return { ok: false, message };
  }
  if (entries.length === 0) {
    const message = 'refusing to replace a working pool with an empty pool';
    log('key pool reload failed', { message });
    return { ok: false, message };
  }
  const existing = new Map(keys.map((k) => [stateId(k.raw), k]));
  const next = [];
  let added = 0;
  for (const [index, entry] of entries.entries()) {
    const id = stateId(entry.raw);
    const current = existing.get(id);
    if (current !== undefined) {
      current.label = entry.label || current.label;
      current.accountId = entry.accountId || current.label.toLowerCase();
      current.credentialId = entry.credentialId || current.credentialId;
      current.source = entry.source || current.source;
      current.retiring = false;
      next.push(current);
      existing.delete(id);
    } else {
      next.push(createKey(entry, index));
      added += 1;
    }
  }
  let retiring = 0;
  for (const removed of existing.values()) {
    if (removed.inFlight > 0) {
      removed.retiring = true;
      next.push(removed);
      retiring += 1;
    }
  }
  const removed = existing.size;
  keys = next;
  rrPointer = Math.max(0, Math.min(rrPointer, keys.length - 1));
  saveState();
  log('key pool reloaded', { total: entries.length, added, removed, retiring });
  notifyCapacity();
  return { ok: true, total: entries.length, added, removed, retiring };
}

// ---------------------------------------------------------------------------
// Key selection & cooldowns
// ---------------------------------------------------------------------------

function requestCapability(body) {
  if (!Buffer.isBuffer(body) || body.length === 0) return '*';
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    return typeof parsed?.model === 'string' && parsed.model.trim() !== ''
      ? parsed.model.trim().slice(0, 120)
      : '*';
  } catch {
    return '*';
  }
}

function capabilityCircuit(k, capability, now = Date.now()) {
  if (capability === '*') return null;
  const circuit = k.capabilityCooldowns[capability];
  if (circuit === undefined) return null;
  if (circuit.until <= now) {
    delete k.capabilityCooldowns[capability];
    saveState();
    return null;
  }
  return circuit;
}

function accountAvailable(k, now = Date.now()) {
  return k.cooldownUntil <= now && !k.recoveryRequired && k.credentialCooldownUntil <= now;
}

function scoreKey(k, index, now = Date.now(), capability = '*') {
  if (
    k.retiring || !accountAvailable(k, now) ||
    capabilityCircuit(k, capability, now) !== null ||
    k.inFlight >= MAX_INFLIGHT_PER_KEY
  ) return null;
  const attempts = k.successes + k.fails;
  let score = ((k.successes + 1) / (attempts + 2)) * 100;
  if (k.lastSuccessAt > k.lastFailureAt) score += 20;
  score -= Math.min(60, k.consecutiveFailures * 20);
  if (k.rateLimit !== null && k.rateLimit.limit > 0 && k.rateLimit.remaining >= 0) {
    score += Math.max(0, Math.min(1, k.rateLimit.remaining / k.rateLimit.limit)) * 250;
  }
  if (k.latencyEwmaMs !== null) score -= Math.min(30, k.latencyEwmaMs / 500);
  score -= k.inFlight * 35;
  if (index === rrPointer) score += 12;
  return Math.round(score * 10) / 10;
}

function chooseIndex(index, reason) {
  const changed = rrPointer !== index;
  rrPointer = index;
  lastSelectionReason = reason;
  if (changed) log(`selected ${keys[index].label} — ${reason}`);
  return keys[index];
}

function recoveryProbeEligible(status, reason, recoveryRequired = false) {
  if (recoveryRequired) return true;
  if (/access terminated|retry-after/i.test(reason)) return false;
  if (status === 402 || status === 403 || status === 429) return true;
  // Migration path for state written before lastStatus was persisted.
  return /(?:HTTP\s*)?(?:402|403|429)|quota|billing cycle|usage limit|weekly|5-hour/i.test(reason);
}

function dueRecoveryCandidate(now, capability, excluded) {
  // A single in-flight probe protects a replenished pool from a thundering
  // herd when many Claude Code sessions submit requests simultaneously.
  if (keys.some((k) => k.recoveryProbeInFlight)) return null;
  const due = keys
    .map((k, index) => ({ k, index }))
    .filter(({ k }) =>
      !k.retiring && !excluded.has(stateId(k.raw)) &&
      k.inFlight < MAX_INFLIGHT_PER_KEY &&
      capabilityCircuit(k, capability, now) === null &&
      (k.cooldownUntil > now || k.recoveryRequired) &&
      recoveryProbeEligible(k.lastStatus, k.cooldownReason, k.recoveryRequired) &&
      k.nextRecoveryProbeAt > 0 &&
      k.nextRecoveryProbeAt <= now
    )
    .sort((a, b) =>
      a.k.nextRecoveryProbeAt - b.k.nextRecoveryProbeAt ||
      a.k.lastRecoveryProbeAt - b.k.lastRecoveryProbeAt ||
      a.index - b.index
    );
  return due[0] ?? null;
}

function beginRecoveryProbe(candidate, now) {
  candidate.k.recoveryProbeInFlight = true;
  candidate.k.lastRecoveryProbeAt = now;
  lastExplorationAt = now;
  saveState();
  return chooseIndex(
    candidate.index,
    candidate.k.recoveryRequired
      ? 'quota timer expired; serialized real-traffic recovery probe'
      : `real-traffic recovery probe after ${Math.round(candidate.k.recoveryProbeBackoffMs / 1000)}s backoff`
  );
}

function deferRecoveryProbe(k) {
  if (!k.recoveryProbeInFlight) return;
  k.recoveryProbeInFlight = false;
  const retryAt = Date.now() + Math.max(RECOVERY_PROBE_INITIAL, k.recoveryProbeBackoffMs);
  k.nextRecoveryProbeAt = k.recoveryRequired
    ? Math.max(k.cooldownUntil, retryAt)
    : Math.min(k.cooldownUntil, retryAt);
  saveState();
  notifyRoutingChange();
}

function clearExpiredPreference(now) {
  if (preferredLabel !== '' && preferredUntil <= now) {
    log(`temporary preference for ${preferredLabel} expired; returning to automatic routing`);
    preferredLabel = '';
    preferredUntil = 0;
    saveState();
  }
}

function pickKey(capability = '*', excluded = new Set()) {
  const now = Date.now();
  clearExpiredPreference(now);
  const available = keys
    .map((k, index) => ({ k, index }))
    .filter(({ k }) =>
      !k.retiring && !excluded.has(stateId(k.raw)) &&
      accountAvailable(k, now) &&
      capabilityCircuit(k, capability, now) === null &&
      k.inFlight < MAX_INFLIGHT_PER_KEY
    );

  if (preferredLabel !== '') {
    const preferred = available.find(({ k }) => k.label.toLowerCase() === preferredLabel.toLowerCase());
    if (preferred !== undefined) return chooseIndex(preferred.index, 'temporary operator preference');
    log(`preferred key ${preferredLabel} is unavailable; falling back automatically`);
    preferredLabel = '';
    preferredUntil = 0;
    saveState();
  }

  const recovery = dueRecoveryCandidate(now, capability, excluded);
  if (recovery !== null) return beginRecoveryProbe(recovery, now);

  if (available.length === 0) return null;

  const current = available.find(({ index }) => index === rrPointer);
  if (current !== undefined && current.k.lastAttemptAt === 0) {
    return chooseIndex(current.index, 'initial health check');
  }

  const unchecked = available.filter(({ k }) => k.lastAttemptAt === 0);
  if (unchecked.length > 0) return chooseIndex(unchecked[0].index, 'checking an untested key');

  if (current !== undefined && now - lastExplorationAt >= EXPLORATION_INTERVAL) {
    const due = available
      .filter(({ index, k }) => index !== current.index && now - k.lastAttemptAt >= EXPLORATION_INTERVAL)
      .sort((a, b) => a.k.lastAttemptAt - b.k.lastAttemptAt);
    if (due.length > 0) {
      lastExplorationAt = now;
      saveState();
      return chooseIndex(due[0].index, 'scheduled health exploration');
    }
  }

  const ranked = available
    .map(({ k, index }) => ({ k, index, score: scoreKey(k, index, now, capability) }))
    .sort((a, b) =>
      a.k.inFlight - b.k.inFlight || b.score - a.score || a.k.lastAttemptAt - b.k.lastAttemptAt
    );
  const best = ranked[0];
  if (current !== undefined) {
    const currentScore = scoreKey(current.k, current.index, now, capability);
    if (
      current.k.inFlight <= best.k.inFlight &&
      best.index !== current.index && best.score < currentScore + 25
    ) {
      return chooseIndex(current.index, 'healthy sticky key within score margin');
    }
  }
  return chooseIndex(best.index, `best adaptive score (${best.score})`);
}

const capacityWaiters = [];

function capacityBlocked(capability, excluded) {
  const now = Date.now();
  return keys.some((k) =>
    !k.retiring && !excluded.has(stateId(k.raw)) &&
    accountAvailable(k, now) && capabilityCircuit(k, capability, now) === null &&
    k.inFlight >= MAX_INFLIGHT_PER_KEY
  );
}

function recoveryProbeBlocked(capability, excluded) {
  const now = Date.now();
  return keys.some((k) =>
    !k.retiring && !excluded.has(stateId(k.raw)) &&
    k.recoveryProbeInFlight && capabilityCircuit(k, capability, now) === null
  );
}

function notifyCapacity() {
  while (capacityWaiters.length > 0) {
    const waiter = capacityWaiters.shift();
    if (waiter.done) continue;
    waiter.done = true;
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener('abort', waiter.abort);
    waiter.resolve();
    return;
  }
}

function notifyRoutingChange() {
  const waiting = capacityWaiters.filter((waiter) => !waiter.done).length;
  for (let index = 0; index < waiting; index++) notifyCapacity();
}

function waitForCapacity(signal) {
  for (let index = capacityWaiters.length - 1; index >= 0; index--) {
    if (capacityWaiters[index].done) capacityWaiters.splice(index, 1);
  }
  if (capacityWaiters.length >= MAX_QUEUE_DEPTH) {
    const err = new Error('router queue is full');
    err.code = 'QUEUE_FULL';
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, done: false, timer: null, abort: null };
    const finishError = (err) => {
      if (waiter.done) return;
      waiter.done = true;
      clearTimeout(waiter.timer);
      signal?.removeEventListener('abort', waiter.abort);
      const index = capacityWaiters.indexOf(waiter);
      if (index !== -1) capacityWaiters.splice(index, 1);
      reject(err);
    };
    waiter.abort = () => {
      const err = new Error('client disconnected while queued');
      err.code = 'CLIENT_GONE';
      finishError(err);
    };
    waiter.timer = setTimeout(() => {
      const err = new Error('router queue wait timed out');
      err.code = 'QUEUE_TIMEOUT';
      finishError(err);
    }, QUEUE_TIMEOUT_MS);
    signal?.addEventListener('abort', waiter.abort, { once: true });
    capacityWaiters.push(waiter);
  });
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : null;
  if (value === undefined || value === null) return null;
  return String(value);
}

function updateRateLimit(k, headers) {
  const rawLimit = firstHeaderValue(headers['x-ratelimit-limit']);
  const rawRemaining = firstHeaderValue(headers['x-ratelimit-remaining']);
  if (rawLimit === null || rawRemaining === null) return;
  const limit = Number(rawLimit);
  const remaining = Number(rawRemaining);
  if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return;
  const reset = firstHeaderValue(headers['x-ratelimit-reset']);
  const resetMs = parseRateLimitReset(reset);
  k.rateLimit = {
    limit,
    remaining,
    reset: reset === null ? null : reset.slice(0, 120),
    resetAt: resetMs === null ? null : new Date(Date.now() + resetMs).toISOString(),
  };
}

function updateLatency(k, latencyMs) {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
  k.latencyEwmaMs = k.latencyEwmaMs === null
    ? latencyMs
    : Math.round((k.latencyEwmaMs * 0.8 + latencyMs * 0.2) * 10) / 10;
}

let providerCooldownUntil = 0;
let providerCooldownReason = '';

function applyFailure(k, failure) {
  const now = Date.now();
  const failedRecoveryProbe = k.recoveryProbeInFlight;
  if (failure.scope === 'provider') {
    providerCooldownUntil = now + failure.cooldownMs;
    providerCooldownReason = failure.reason;
    log('provider circuit opened', { reason: failure.reason, until: isoOrNull(providerCooldownUntil) });
    return;
  }
  if (failure.scope === 'credential') {
    k.credentialCooldownUntil = Math.min(8_000_000_000_000_000, now + failure.cooldownMs);
    k.credentialCooldownReason = failure.reason;
    k.recoveryProbeInFlight = false;
    saveState();
    log('credential circuit opened', {
      label: k.label,
      credentialId: k.credentialId,
      reason: failure.reason,
      until: isoOrNull(k.credentialCooldownUntil),
    });
    return;
  }
  if (failure.scope === 'capability') {
    k.capabilityCooldowns[failure.capability] = {
      until: now + failure.cooldownMs,
      reason: failure.reason,
      lastStatus: failure.status,
    };
    k.recoveryProbeInFlight = false;
    saveState();
    log('capability circuit opened', {
      label: k.label,
      capability: failure.capability,
      reason: failure.reason,
      until: isoOrNull(now + failure.cooldownMs),
    });
    if (failedRecoveryProbe) notifyRoutingChange();
    return;
  }
  if (failure.scope !== 'account') return;
  const preserveRequiredRecovery = failedRecoveryProbe && k.recoveryRequired;
  k.cooldownUntil = Math.min(8_000_000_000_000_000, now + failure.cooldownMs);
  k.cooldownReason = failure.reason;
  k.recoveryRequired = failure.probeAfterCooldown === true || preserveRequiredRecovery;
  if (
    recoveryProbeEligible(failure.status, failure.reason, k.recoveryRequired) &&
    failure.recoverable !== false
  ) {
    k.recoveryProbeBackoffMs = failedRecoveryProbe
      ? Math.min(
        RECOVERY_PROBE_MAX,
        Math.max(RECOVERY_PROBE_INITIAL, k.recoveryProbeBackoffMs * 2)
      )
      : RECOVERY_PROBE_INITIAL;
    k.nextRecoveryProbeAt = k.recoveryRequired
      ? failure.probeAfterCooldown === true
        ? k.cooldownUntil
        : now + k.recoveryProbeBackoffMs
      : Math.min(k.cooldownUntil, now + k.recoveryProbeBackoffMs);
  } else {
    k.nextRecoveryProbeAt = 0;
    k.recoveryRequired = false;
    k.recoveryProbeBackoffMs = RECOVERY_PROBE_INITIAL;
  }
  k.recoveryProbeInFlight = false;
  if (preferredLabel.toLowerCase() === k.label.toLowerCase()) {
    preferredLabel = '';
    preferredUntil = 0;
  }
  saveState();
  log('account circuit opened', {
    label: k.label,
    reason: failure.reason,
    until: isoOrNull(k.cooldownUntil),
  });
  if (failedRecoveryProbe) notifyRoutingChange();
}

function recordFailure(k, classification, attemptId, status, latencyMs, capability) {
  const now = Date.now();
  const failure = { ...classification, attemptId, status, capability };
  k.fails += 1;
  updateLatency(k, latencyMs);
  const latestOutcomeAttemptId = Math.max(
    k.latestSuccessAttemptId,
    k.latestFailureAttemptId
  );
  if (attemptId < latestOutcomeAttemptId) {
    log('outdated failure ignored after newer outcome', {
      label: k.label,
      attemptId,
      latestOutcomeAttemptId,
      reason: failure.reason,
    });
    saveState();
    return;
  }
  k.latestFailureAttemptId = attemptId;
  k.consecutiveFailures += 1;
  k.lastAttemptAt = now;
  k.lastFailureAt = now;
  k.lastStatus = status;
  k.pendingFailure = null;
  applyFailure(k, failure);
  saveState();
}

function recordSuccess(k, attemptId, capability, status, latencyMs, headers) {
  const now = Date.now();
  k.successes += 1;
  k.accepted += 1;
  k.latestSuccessAttemptId = Math.max(k.latestSuccessAttemptId, attemptId);
  updateLatency(k, latencyMs);
  updateRateLimit(k, headers);
  if (attemptId < k.latestFailureAttemptId) {
    log('outdated success preserved stream but not key health', {
      label: k.label,
      attemptId,
      latestFailureAttemptId: k.latestFailureAttemptId,
      status,
    });
    saveState();
    return;
  }
  const recovered = k.cooldownUntil > now || k.recoveryProbeInFlight || k.recoveryRequired;
  k.consecutiveFailures = 0;
  k.lastAttemptAt = now;
  k.lastSuccessAt = now;
  k.lastStatus = status;
  k.cooldownUntil = 0;
  k.cooldownReason = '';
  k.credentialCooldownUntil = 0;
  k.credentialCooldownReason = '';
  k.nextRecoveryProbeAt = 0;
  k.recoveryRequired = false;
  k.recoveryProbeBackoffMs = RECOVERY_PROBE_INITIAL;
  k.recoveryProbeInFlight = false;
  if (providerCooldownUntil > now) {
    providerCooldownUntil = 0;
    providerCooldownReason = '';
  }
  if (capability !== '*' && k.capabilityCooldowns[capability] !== undefined) {
    delete k.capabilityCooldowns[capability];
  }
  saveState();
  if (recovered) {
    log(`recovered ${k.label} after a successful real request (HTTP ${status})`);
    notifyRoutingChange();
  }
}

function releaseAttempt(k, attemptId, streamError = null, acceptedStream = false) {
  if (!k.activeAttemptIds.delete(attemptId)) return;
  k.inFlight = k.activeAttemptIds.size;
  if (acceptedStream && streamError === null) {
    k.completed += 1;
  } else if (acceptedStream && streamError.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
    k.streamFailures += 1;
  }
  if (k.retiring && k.inFlight === 0) {
    keys = keys.filter((candidate) => candidate !== k);
  }
  saveState();
  notifyCapacity();
}

function parseRetryAfter(value) {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > Date.now() ? parsed - Date.now() : null;
}

function retryAfterReason(value) {
  if (value === null) return '';
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return `retry-after ${seconds}s`;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > Date.now()
    ? `retry-after until ${new Date(parsed).toISOString()}`
    : '';
}

function parseRateLimitReset(value, now = Date.now()) {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    let resetAt;
    if (numeric >= 1_000_000_000_000) resetAt = numeric;
    else if (numeric >= 1_000_000_000) resetAt = numeric * 1000;
    else return numeric * 1000;
    return resetAt > now ? resetAt - now : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) && parsed > now ? parsed - now : null;
}

function rateLimitResetReason(value) {
  if (value === null) return '';
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0 && numeric < 1_000_000_000) {
    return `rate-limit reset in ${numeric}s`;
  }
  let resetAt = Number.NaN;
  if (Number.isFinite(numeric) && numeric >= 1_000_000_000_000) resetAt = numeric;
  else if (Number.isFinite(numeric) && numeric >= 1_000_000_000) resetAt = numeric * 1000;
  else resetAt = Date.parse(trimmed);
  return Number.isFinite(resetAt) && resetAt > Date.now()
    ? `rate-limit reset at ${new Date(resetAt).toISOString()}`
    : '';
}

function classifyFailure(status, bodyText, retryAfterHeader, rateLimitResetHeader, capability = '*') {
  const normalized = bodyText.toLowerCase();
  const retryAfterMs = parseRetryAfter(retryAfterHeader);
  const retryReason = retryAfterReason(retryAfterHeader);
  const resetMs = parseRateLimitReset(rateLimitResetHeader);
  const resetReason = rateLimitResetReason(rateLimitResetHeader);
  const quotaCooldownMs = retryAfterMs || resetMs;
  const quotaReason = retryReason || resetReason;
  if (status === 429) {
    if (/engine (?:is )?currently overloaded|engine overloaded/.test(normalized)) {
      return { scope: 'provider', cooldownMs: retryAfterMs || 5_000, reason: 'Kimi engine overloaded (429)', rotate: false };
    }
    if (/too many (?:concurrent )?requests|concurren/.test(normalized)) {
      return { scope: 'account', cooldownMs: retryAfterMs || 5_000, reason: 'account concurrency limit (429)', rotate: true };
    }
    if (/monthly|billing cycle/.test(normalized)) {
      return { scope: 'account', cooldownMs: quotaCooldownMs || COOLDOWN_MONTHLY, reason: `monthly quota exhausted (429${quotaReason ? `; ${quotaReason}` : ''})`, rotate: true };
    }
    if (/week/.test(normalized)) {
      return { scope: 'account', cooldownMs: quotaCooldownMs || COOLDOWN_WEEKLY, reason: `weekly plan limit (429${quotaReason ? `; ${quotaReason}` : ''})`, rotate: true };
    }
    if (/usage limit for this period|5[ -]?hour|five[ -]?hour/.test(normalized)) {
      return {
        scope: 'account',
        cooldownMs: quotaCooldownMs || COOLDOWN_5H,
        reason: `5-hour rolling usage limit (429; ${quotaReason || 'timer 5h'})`,
        rotate: true,
        probeAfterCooldown: true,
      };
    }
    return {
      scope: 'account',
      cooldownMs: quotaCooldownMs || COOLDOWN_TRANSIENT,
      reason: `unclassified transient rate limit (429${quotaReason === '' ? '' : `; ${quotaReason}`})`,
      rotate: true,
    };
  }
  if (status === 403 && /usage limit|billing cycle|weekly|quota.*exhaust/.test(normalized)) {
    return { scope: 'account', cooldownMs: quotaCooldownMs || COOLDOWN_WEEKLY, reason: `billing-cycle quota exhausted (403${quotaReason ? `; ${quotaReason}` : ''})`, rotate: true };
  }
  if (status === 403 && /access terminated/.test(normalized)) {
    return { scope: 'account', cooldownMs: 100 * 365 * DAY, reason: 'account access terminated (403)', rotate: true, recoverable: false };
  }
  if (status === 403 && /url security risk|security risk.*url/.test(normalized)) {
    return { scope: 'request', cooldownMs: 0, reason: 'request URL rejected by Kimi security policy (403)', rotate: false };
  }
  if (status === 402 && /unable to verify (?:your )?membership|verify membership/.test(normalized)) {
    return { scope: 'account', cooldownMs: retryAfterMs || COOLDOWN_TRANSIENT, reason: 'membership verification temporarily unavailable (402)', rotate: true };
  }
  if (status === 401 && !/invalid (?:api )?key|unauthorized|authentication|credential/.test(normalized) && /model|k3\[1m\]|1m context|high.?speed|capabilit|tier|plan|permission/.test(normalized)) {
    return { scope: 'capability', capability, cooldownMs: COOLDOWN_INVALID, reason: `model/capability unavailable (401)`, rotate: true };
  }
  if (status === 401) {
    return { scope: 'credential', cooldownMs: COOLDOWN_INVALID, reason: 'credential rejected (HTTP 401)', rotate: true };
  }
  if (status === 403) {
    return { scope: 'request', cooldownMs: 0, reason: 'unclassified forbidden response (HTTP 403)', rotate: false };
  }
  if (status === 402) {
    return { scope: 'account', cooldownMs: COOLDOWN_TRANSIENT, reason: 'temporary billing verification failure (402)', rotate: true };
  }
  if (status === 408 || status >= 500) {
    return { scope: 'account', cooldownMs: retryAfterMs || COOLDOWN_TRANSIENT, reason: `transient upstream error (HTTP ${status})`, rotate: true, ambiguousReplay: true };
  }
  return { scope: 'request', cooldownMs: 0, reason: `request rejected (HTTP ${status})`, rotate: false };
}

// ---------------------------------------------------------------------------
// Proxying
// ---------------------------------------------------------------------------

const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
  'content-length', // recomputed from the buffered body
  'accept-encoding', // force identity upstream so framing stays exact
  'authorization',   // replaced with the active pool key
  'x-api-key',
]);

// Response headers that must not be forwarded verbatim. Note this is a
// smaller set than HOP_BY_HOP: with no decode layer in between, the body
// bytes pass through exactly, so content-length/content-encoding stay valid.
const RESPONSE_STRIP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function buildUpstreamHeaders(req, k) {
  const headers = {};
  // RFC 7230 §6.1: the Connection header nominates extra hop-by-hop fields.
  const nominated = new Set();
  const connection = req.headers.connection;
  if (typeof connection === 'string') {
    for (const token of connection.split(',')) {
      const name = token.trim().toLowerCase();
      if (name !== '') nominated.add(name);
    }
  }
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name)) continue;
    if (nominated.has(name)) continue;
    headers[name] = value;
  }
  // Kimi's OpenAI-compatible endpoint reads Authorization, while its
  // Anthropic-compatible coding endpoint reads x-api-key. Replace both so a
  // single router can safely serve either client protocol.
  headers['authorization'] = `Bearer ${k.raw}`;
  headers['x-api-key'] = k.raw;
  return headers;
}

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

/**
 * Send the buffered request upstream and resolve with the raw
 * IncomingMessage once response headers arrive. No body timeout — SSE
 * streams may legitimately idle for minutes between chunks.
 */
function sendUpstream(req, k, body, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('client disconnected before upstream call'));
      return;
    }
    const target = new URL(UPSTREAM + req.url);
    const isHttps = target.protocol === 'https:';
    const headers = buildUpstreamHeaders(req, k);
    if (body !== null) {
      headers['content-length'] = String(body.length);
    }

    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(headersTimer);
      signal.removeEventListener('abort', onAbort);
      settle(value);
    };
    const onAbort = () => {
      up.destroy();
      finish(reject, new Error('client disconnected'));
    };
    const headersTimer = setTimeout(() => {
      up.destroy(new Error(`upstream headers timeout after ${HEADERS_TIMEOUT_MS}ms`));
    }, HEADERS_TIMEOUT_MS);

    const up = (isHttps ? https : http).request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port !== '' ? Number(target.port) : isHttps ? 443 : 80,
        path: target.pathname + target.search,
        method: req.method,
        headers,
        agent: isHttps ? httpsAgent : httpAgent,
      },
      (msg) => finish(resolve, msg)
    );
    up.on('error', (err) => finish(reject, err));
    signal.addEventListener('abort', onAbort, { once: true });

    if (body !== null) {
      up.write(body);
    }
    up.end();
  });
}

function readAllBounded(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let truncated = false;
    stream.on('data', (chunk) => {
      if (truncated) return;
      const remaining = ERROR_BODY_MAX_BYTES - total;
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        total = ERROR_BODY_MAX_BYTES;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    });
    stream.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated }));
    stream.on('error', reject);
  });
}

function responseHeaders(upstream) {
  const headers = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined) continue;
    if (RESPONSE_STRIP.has(name)) continue;
    headers[name] = value;
  }
  return headers;
}

function respondBuffered(upstream, res, body, truncated = false, extraHeaders = {}) {
  const headers = responseHeaders(upstream);
  delete headers['content-length'];
  headers['content-length'] = String(Buffer.byteLength(body));
  if (truncated) headers['x-router-error-body-truncated'] = 'true';
  for (const [name, value] of Object.entries(extraHeaders)) headers[name] = value;
  res.writeHead(upstream.statusCode, headers);
  res.end(body);
}

function requestAllowsAmbiguousReplay(req) {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  if (RETRY_AMBIGUOUS_REQUESTS) return true;
  const idempotencyKey = firstHeaderValue(req.headers['idempotency-key'])
    || firstHeaderValue(req.headers['x-idempotency-key']);
  return idempotencyKey !== null && idempotencyKey.trim() !== '';
}

function pipeResponse(upstream, res, k, attemptId) {
  const headers = responseHeaders(upstream);
  res.writeHead(upstream.statusCode, headers);
  let released = false;
  const finishAttempt = (err) => {
    if (released) return;
    released = true;
    res.removeListener('close', onResponseClose);
    releaseAttempt(k, attemptId, err, true);
  };
  const onResponseClose = () => {
    if (res.writableEnded) {
      finishAttempt(null);
      return;
    }
    const err = new Error('client response closed before stream completion');
    err.code = 'ERR_STREAM_PREMATURE_CLOSE';
    finishAttempt(err);
  };
  res.once('close', onResponseClose);
  // pipeline (unlike .pipe) routes terminal errors to the callback and
  // destroys both sides — an upstream that dies mid-stream, or a client
  // that disconnects mid-stream, can never crash the process.
  pipeline(upstream, res, (err) => {
    finishAttempt(err ?? null);
    if (err !== null && err !== undefined) {
      const message = err instanceof Error ? err.message : String(err);
      log('stream terminated early', { label: k.label, attemptId, message });
    }
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      const err = new Error(`payload too large (declared ${declared} bytes)`);
      err.code = 'PAYLOAD_TOO_LARGE';
      reject(err);
      return;
    }
    const chunks = [];
    let total = 0;
    // Idle (not total) timeout: large uploads are fine, stalled ones are not.
    let idleTimer = setTimeout(onIdle, BODY_IDLE_TIMEOUT_MS);
    function onIdle() {
      cleanup();
      const err = new Error('request body stalled');
      err.code = 'BODY_STALLED';
      reject(err);
    }
    function cleanup() {
      clearTimeout(idleTimer);
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      req.removeAllListeners('error');
    }
    req.on('data', (chunk) => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdle, BODY_IDLE_TIMEOUT_MS);
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        cleanup();
        const err = new Error(`payload too large (${total} bytes)`);
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}

async function handleProxy(req, res) {
  let body;
  try {
    body = await readRequestBody(req);
  } catch (err) {
    // The upload may still be in flight; answer first, then hang up.
    const isTooLarge = err instanceof Error && err.code === 'PAYLOAD_TOO_LARGE';
    const status = isTooLarge ? 413 : 400;
    const message = err instanceof Error ? err.message : String(err);
    res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ error: { message } }), () => {
      req.socket.destroy();
    });
    return;
  }
  const capability = requestCapability(body);

  // If the client disappears while we're waiting on upstream headers,
  // abort the upstream call. Mid-stream cleanup is pipeline's job.
  const clientGone = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) clientGone.abort();
  });

  let lastFailure = null;
  const attempted = new Set();

  while (attempted.size < keys.filter((k) => !k.retiring).length) {
    if (clientGone.signal.aborted) return;
    let k = pickKey(capability, attempted);
    while (
      k === null &&
      (capacityBlocked(capability, attempted) || recoveryProbeBlocked(capability, attempted))
    ) {
      try {
        await waitForCapacity(clientGone.signal);
      } catch (err) {
        if (err instanceof Error && err.code === 'CLIENT_GONE') return;
        const queueFull = err instanceof Error && err.code === 'QUEUE_FULL';
        res.writeHead(queueFull ? 503 : 504, {
          'content-type': 'application/json',
          'retry-after': '1',
          'x-router-queue-depth': String(capacityWaiters.filter((waiter) => !waiter.done).length),
        });
        res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } }));
        return;
      }
      k = pickKey(capability, attempted);
    }
    if (k === null) break;
    attempted.add(stateId(k.raw));
    const attemptId = nextAttemptId++;
    k.activeAttemptIds.add(attemptId);
    k.inFlight = k.activeAttemptIds.size;
    k.lastAttemptAt = Date.now();
    saveState();
    const attemptStartedAt = Date.now();

    let upstream;
    try {
      const sendBody = req.method === 'GET' || req.method === 'HEAD' ? null : body;
      upstream = await sendUpstream(req, k, sendBody, clientGone.signal);
    } catch (err) {
      if (clientGone.signal.aborted) {
        deferRecoveryProbe(k);
        releaseAttempt(k, attemptId, err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const failure = {
        scope: 'account', cooldownMs: COOLDOWN_TRANSIENT,
        reason: `network error: ${message}`, rotate: true, ambiguousReplay: true,
      };
      recordFailure(k, failure, attemptId, 0, Date.now() - attemptStartedAt, capability);
      releaseAttempt(k, attemptId, err instanceof Error ? err : new Error(message));
      lastFailure = { status: 502, body: JSON.stringify({ error: { message: `upstream network error: ${message}` } }) };
      if (!requestAllowsAmbiguousReplay(req)) {
        res.writeHead(502, {
          'content-type': 'application/json',
          'x-router-replay-suppressed': 'true',
        });
        res.end(lastFailure.body);
        return;
      }
      continue;
    }

    const status = typeof upstream.statusCode === 'number' ? upstream.statusCode : 0;
    const latencyMs = Date.now() - attemptStartedAt;

    if (status < 400) {
      recordSuccess(k, attemptId, capability, status, latencyMs, upstream.headers);
      pipeResponse(upstream, res, k, attemptId);
      return;
    }

    if (ROTATE_STATUSES.has(status) || status >= 500) {
      updateRateLimit(k, upstream.headers);
      const { text, truncated } = await readAllBounded(upstream);
      const retryAfter = firstHeaderValue(upstream.headers['retry-after']);
      const rateLimitReset = firstHeaderValue(upstream.headers['x-ratelimit-reset']);
      const cls = classifyFailure(status, text, retryAfter, rateLimitReset, capability);
      if (cls.scope === 'request' || cls.scope === 'provider' || !cls.rotate) {
        if (cls.scope === 'provider') applyFailure(k, { ...cls, status, capability });
        deferRecoveryProbe(k);
        releaseAttempt(k, attemptId);
        respondBuffered(upstream, res, text, truncated);
        return;
      }
      recordFailure(k, cls, attemptId, status, latencyMs, capability);
      releaseAttempt(k, attemptId);
      if (cls.ambiguousReplay && !requestAllowsAmbiguousReplay(req)) {
        respondBuffered(upstream, res, text, truncated, {
          'x-router-replay-suppressed': 'true',
        });
        return;
      }
      lastFailure = { status, body: text, truncated };
      continue;
    }

    // Any other 4xx (e.g. 400) is a problem with the request itself, not the
    // key — rotating would just spray the same bad request at every key.
    deferRecoveryProbe(k);
    pipeResponse(upstream, res, k, attemptId);
    return;
  }

  // Every key is cooling down. Surface the last upstream error with a
  // retry-after pointing at the soonest key recovery.
  const recoveries = keys.map((k) => {
    if (k.nextRecoveryProbeAt > Date.now()) {
      return Math.min(k.cooldownUntil, k.nextRecoveryProbeAt);
    }
    return k.cooldownUntil;
  }).filter((timestamp) => timestamp > Date.now());
  if (providerCooldownUntil > Date.now()) recoveries.push(providerCooldownUntil);
  const soonest = recoveries.length > 0 ? Math.min(...recoveries) : Date.now() + 1_000;
  const retryAfterSec = Math.max(1, Math.ceil((soonest - Date.now()) / 1000));
  const status = lastFailure !== null ? lastFailure.status : providerCooldownUntil > Date.now() ? 503 : 429;
  const payload = lastFailure !== null
    ? lastFailure.body
    : JSON.stringify({ error: { message: providerCooldownUntil > Date.now() ? providerCooldownReason : 'all compatible Kimi keys are cooling down' } });
  res.writeHead(status, {
    'content-type': 'application/json',
    'retry-after': String(retryAfterSec),
    'x-router-all-keys-cooling': 'true',
    ...(lastFailure?.truncated ? { 'x-router-error-body-truncated': 'true' } : {}),
  });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// Management endpoints + server
// ---------------------------------------------------------------------------

function isoOrNull(timestamp) {
  if (!(timestamp > 0) || timestamp > 8_000_000_000_000_000) return null;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return null;
  }
}

function keyHealth(k, now) {
  if (k.credentialCooldownUntil > now) return 'credential-rejected';
  if (k.recoveryProbeInFlight) return 'probing';
  if (k.recoveryRequired) {
    return k.nextRecoveryProbeAt > 0 && k.nextRecoveryProbeAt <= now
      ? 'recovery-due'
      : 'quota-limited';
  }
  if (k.cooldownUntil > now) {
    if (/quota|limit|billing cycle/i.test(k.cooldownReason)) return 'quota-limited';
    if (/terminated/i.test(k.cooldownReason)) return 'blocked';
    return 'cooling';
  }
  if (k.lastAttemptAt === 0) return 'unchecked';
  if (k.consecutiveFailures > 0) return 'degraded';
  if (k.lastSuccessAt >= k.lastFailureAt) return 'healthy';
  return 'unknown';
}

function handleStatus(res) {
  const now = Date.now();
  clearExpiredPreference(now);
  let activeIndex = keys.findIndex((k) => k.recoveryProbeInFlight);
  if (activeIndex === -1) {
    activeIndex = keys[rrPointer] !== undefined && accountAvailable(keys[rrPointer], now)
      ? rrPointer
      : -1;
  }
  if (activeIndex === -1) {
    const ranked = keys
      .map((k, index) => ({ index, score: scoreKey(k, index, now) }))
      .filter(({ score }) => score !== null)
      .sort((a, b) => b.score - a.score);
    if (ranked.length > 0) activeIndex = ranked[0].index;
  }
  const available = keys.filter((k) => accountAvailable(k, now)).length;
  const nextRecoveryProbeAt = keys
    .filter((k) =>
      (k.cooldownUntil > now || k.recoveryRequired) &&
      recoveryProbeEligible(k.lastStatus, k.cooldownReason, k.recoveryRequired) &&
      k.nextRecoveryProbeAt > now
    )
    .reduce((soonest, k) => Math.min(soonest, k.nextRecoveryProbeAt), Infinity);
  const payload = {
    upstream: UPSTREAM,
    now: new Date(now).toISOString(),
    summary: {
      total: keys.length,
      accounts: new Set(keys.map((k) => k.accountId)).size,
      credentials: keys.length,
      available,
      cooling: keys.length - available,
      inFlight: keys.reduce((sum, k) => sum + k.inFlight, 0),
      activeRequests,
      queueDepth: capacityWaiters.filter((waiter) => !waiter.done).length,
      queueLimit: MAX_QUEUE_DEPTH,
      maxInFlightPerKey: MAX_INFLIGHT_PER_KEY,
      draining: shuttingDown,
      activeLabel: activeIndex === -1 ? null : keys[activeIndex].label,
      strategy: 'adaptive-health-v3',
      selectionReason: lastSelectionReason,
      preferredLabel: preferredLabel === '' ? null : preferredLabel,
      preferredUntil: preferredLabel === '' ? null : isoOrNull(preferredUntil),
      explorationIntervalMs: EXPLORATION_INTERVAL,
      nextExplorationAt: lastExplorationAt > 0
        ? isoOrNull(lastExplorationAt + EXPLORATION_INTERVAL)
        : null,
      nextRecoveryProbeAt: Number.isFinite(nextRecoveryProbeAt)
        ? isoOrNull(nextRecoveryProbeAt)
        : null,
      recoveryDueLabels: keys
        .filter((k) =>
          (k.cooldownUntil > now || k.recoveryRequired) &&
          recoveryProbeEligible(k.lastStatus, k.cooldownReason, k.recoveryRequired) &&
          k.nextRecoveryProbeAt > 0 &&
          k.nextRecoveryProbeAt <= now
        )
        .map((k) => k.label),
      recoveryProbeInitialMs: RECOVERY_PROBE_INITIAL,
      recoveryProbeMaxMs: RECOVERY_PROBE_MAX,
      providerCircuitUntil: providerCooldownUntil > now ? isoOrNull(providerCooldownUntil) : null,
      providerCircuitReason: providerCooldownUntil > now ? providerCooldownReason : '',
      managementAuth: MANAGEMENT_TOKEN === '' ? 'disabled' : 'bearer',
    },
    keys: keys.map((k, index) => ({
      slot: index + 1,
      label: k.label,
      accountId: k.accountId,
      credentialId: k.credentialId,
      source: k.source,
      retiring: k.retiring,
      available: accountAvailable(k, now),
      active: index === activeIndex,
      health: keyHealth(k, now),
      score: scoreKey(k, index, now),
      cooldownUntil: k.cooldownUntil > 0 && !accountAvailable(k, now)
        ? new Date(k.cooldownUntil).toISOString()
        : null,
      cooldownRemainingMs: accountAvailable(k, now)
        ? null
        : Math.max(0, k.cooldownUntil - now),
      cooldownReason: k.cooldownReason,
      credentialCooldownUntil: k.credentialCooldownUntil > now
        ? isoOrNull(k.credentialCooldownUntil)
        : null,
      credentialCooldownReason: k.credentialCooldownReason,
      fails: k.fails,
      successes: k.successes,
      accepted: k.accepted,
      completed: k.completed,
      streamFailures: k.streamFailures,
      inFlight: k.inFlight,
      pendingFailure: k.pendingFailure === null ? null : {
        attemptId: k.pendingFailure.attemptId,
        scope: k.pendingFailure.scope,
        reason: k.pendingFailure.reason,
      },
      consecutiveFailures: k.consecutiveFailures,
      lastAttemptAt: isoOrNull(k.lastAttemptAt),
      lastSuccessAt: isoOrNull(k.lastSuccessAt),
      lastFailureAt: isoOrNull(k.lastFailureAt),
      lastStatus: k.lastStatus,
      latencyEwmaMs: k.latencyEwmaMs,
      ttfbEwmaMs: k.latencyEwmaMs,
      rateLimit: k.rateLimit,
      capabilityCooldowns: Object.fromEntries(
        Object.entries(k.capabilityCooldowns)
          .filter(([, circuit]) => circuit.until > now)
          .map(([capability, circuit]) => [capability, {
            until: isoOrNull(circuit.until),
            reason: circuit.reason,
            lastStatus: circuit.lastStatus,
          }])
      ),
      nextRecoveryProbeAt: k.nextRecoveryProbeAt > 0
        ? isoOrNull(k.nextRecoveryProbeAt)
        : null,
      nextRecoveryInMs: k.nextRecoveryProbeAt > 0
        ? Math.max(0, k.nextRecoveryProbeAt - now)
        : null,
      recoveryRequired: k.recoveryRequired,
      recoveryDue: (k.cooldownUntil > now || k.recoveryRequired) &&
        recoveryProbeEligible(k.lastStatus, k.cooldownReason, k.recoveryRequired) &&
        k.nextRecoveryProbeAt > 0 &&
        k.nextRecoveryProbeAt <= now,
      recoveryProbeBackoffMs: k.recoveryProbeBackoffMs,
      lastRecoveryProbeAt: isoOrNull(k.lastRecoveryProbeAt),
      recoveryProbeInFlight: k.recoveryProbeInFlight,
    })),
  };
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload, null, 2));
}

async function handlePreference(req, res) {
  let payload;
  try {
    const body = await readRequestBody(req);
    payload = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"expected JSON with a label field"}}');
    return;
  }
  const requested = typeof payload.label === 'string' ? sanitizeLabel(payload.label) : '';
  if (requested === '') {
    const previous = preferredLabel;
    preferredLabel = '';
    preferredUntil = 0;
    lastSelectionReason = 'automatic routing requested by operator';
    saveState();
    log(`operator cleared temporary preference${previous === '' ? '' : ` for ${previous}`}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"automatic":true}');
    return;
  }
  const index = keys.findIndex((k) => k.label.toLowerCase() === requested.toLowerCase());
  if (index === -1) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `unknown key label: ${requested}` } }));
    return;
  }
  const requestedTtl = Number(payload.ttlMs);
  const ttlMs = Number.isFinite(requestedTtl) && requestedTtl > 0
    ? Math.min(requestedTtl, DAY)
    : PREFERENCE_TTL;
  preferredLabel = keys[index].label;
  preferredUntil = Date.now() + ttlMs;
  rrPointer = index;
  lastSelectionReason = 'temporary operator preference';
  saveState();
  log(`operator preferred ${preferredLabel} until ${new Date(preferredUntil).toISOString()}`);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ preferredLabel, preferredUntil: isoOrNull(preferredUntil) }));
}

const ALLOWED_HOSTS = new Set([
  `${HOST}:${PORT}`,
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  `[::1]:${PORT}`,
]);
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const MANAGEMENT_PATHS = new Set(['/status', '/prefer', '/reload', '/reset']);

function managementAuthorized(req) {
  if (MANAGEMENT_TOKEN === '') return true;
  const authorization = firstHeaderValue(req.headers.authorization);
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const supplied = bearer || firstHeaderValue(req.headers['x-kimi-router-token']);
  if (supplied === null || supplied === undefined) return false;
  const expectedBuffer = Buffer.from(MANAGEMENT_TOKEN);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function requireManagementAuth(req, res) {
  if (managementAuthorized(req)) return true;
  res.writeHead(401, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'www-authenticate': 'Bearer realm=\"kimi-router-management\"',
  });
  res.end('{\"error\":{\"message\":\"management authentication required\"}}');
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    // DNS-rebinding / drive-by browser guard: only answer requests addressed
    // to the loopback name, and reject cross-origin browser calls.
    const host = req.headers.host;
    if (typeof host !== 'string' || !ALLOWED_HOSTS.has(host.toLowerCase())) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"forbidden host"}}');
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !LOOPBACK_ORIGIN.test(origin)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"forbidden origin"}}');
      return;
    }
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (url.pathname === '/healthz') {
      res.writeHead(shuttingDown ? 503 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: !shuttingDown, draining: shuttingDown }));
      return;
    }
    if (MANAGEMENT_PATHS.has(url.pathname) && !requireManagementAuth(req, res)) return;
    if (url.pathname === '/status') {
      handleStatus(res);
      return;
    }
    if (url.pathname === '/prefer' && req.method === 'POST') {
      await handlePreference(req, res);
      return;
    }
    if (url.pathname === '/reload' && req.method === 'POST') {
      const result = reloadKeys();
      res.writeHead(result.ok ? 200 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
    if (url.pathname === '/reset' && req.method === 'POST') {
      for (const k of keys) {
        k.cooldownUntil = 0;
        k.cooldownReason = '';
        k.credentialCooldownUntil = 0;
        k.credentialCooldownReason = '';
        k.consecutiveFailures = 0;
        k.nextRecoveryProbeAt = 0;
        k.recoveryRequired = false;
        k.recoveryProbeBackoffMs = RECOVERY_PROBE_INITIAL;
        k.lastRecoveryProbeAt = 0;
        k.recoveryProbeInFlight = false;
        k.pendingFailure = null;
        k.capabilityCooldowns = Object.create(null);
      }
      providerCooldownUntil = 0;
      providerCooldownReason = '';
      saveState();
      log('all cooldowns cleared via /reset');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"reset":true}');
      return;
    }
    if (shuttingDown) {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end('{"error":{"message":"router is draining"}}');
      return;
    }
    activeRequests += 1;
    let released = false;
    const releaseRequest = () => {
      if (released) return;
      released = true;
      activeRequests = Math.max(0, activeRequests - 1);
      if (shuttingDown && activeRequests === 0) server.closeIdleConnections?.();
    };
    res.once('finish', releaseRequest);
    res.once('close', releaseRequest);
    await handleProxy(req, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`handler error: ${message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ error: { message: `router error: ${message}` } }));
  }
});

// Long streaming completions must not be cut off by server-level timeouts.
server.requestTimeout = 0;

loadState();

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
if (!LOOPBACK_HOSTS.has(HOST) && process.env.KIMI_ROUTER_ALLOW_REMOTE !== '1') {
  console.error(
    `Refusing to bind ${HOST}: the router is designed for loopback use and would expose ` +
    'your paid Kimi quota to the network. Set KIMI_ROUTER_ALLOW_REMOTE=1 only behind a ' +
    'separately authenticated and encrypted gateway.'
  );
  process.exit(1);
}

setInterval(flushState, 5_000).unref();

const watchedKeySource = configuredKeySourcePath();
let reloadTimer = null;
if (watchedKeySource !== null) {
  fs.watchFile(watchedKeySource, { interval: 1_000, persistent: false }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reloadKeys, 250);
  });
}

server.listen(PORT, HOST, () => {
  log(`kimi-key-router listening on http://${HOST}:${PORT}`);
  log(`upstream: ${UPSTREAM}`);
  log(`pool: ${keys.map((k) => k.label).join(', ')}`);
  log('router configuration', {
    strategy: 'adaptive-health-v3',
    keySource: configuredKeySourcePath() === ACCOUNTS_FILE ? 'keychain' : 'file-or-environment',
    maxInFlightPerKey: MAX_INFLIGHT_PER_KEY,
    queueLimit: MAX_QUEUE_DEPTH,
  });
  const cooling = keys.filter((k) => !accountAvailable(k)).length;
  if (cooling > 0) {
    log(`${cooling} key(s) still cooling down from a previous run (see /status)`);
  }
});

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('graceful drain started', { signal, activeRequests });
  if (watchedKeySource !== null) fs.unwatchFile(watchedKeySource);
  for (const waiter of capacityWaiters) {
    if (waiter.done) continue;
    waiter.done = true;
    clearTimeout(waiter.timer);
    const err = new Error('router is draining');
    err.code = 'DRAINING';
    waiter.reject(err);
  }
  server.close(() => {
    flushState();
    httpAgent.destroy();
    httpsAgent.destroy();
    log('graceful drain complete', { activeRequests });
    process.exit(0);
  });
  if (activeRequests === 0) server.closeIdleConnections?.();
  const forceTimer = setTimeout(() => {
    flushState();
    log('graceful drain deadline reached', { activeRequests });
    process.exit(1);
  }, DRAIN_TIMEOUT_MS);
  forceTimer.unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => gracefulShutdown(signal));
}
