#!/usr/bin/env node
/**
 * Process boundary for the Kimi router daemon.
 *
 * The ONLY place this package reads the ambient environment. Everything under
 * src/ receives the resolved config record as an argument, which is why the
 * library half can be audited without knowing what this machine happens to
 * have exported.
 *
 * Environment (all optional unless noted; defaults resolved in src/config.mjs):
 *   KIMI_API_KEYS       comma-separated keys (testing only; visible in env)
 *   KIMI_ACCOUNTS_FILE  Keychain account labels (default ~/.kimi-key-accounts)
 *   KIMI_KEYCHAIN_SERVICE secret-store service (default ai.ora.kimi-key-router)
 *   KIMI_SECRET_BACKEND  auto, macos-keychain, or linux-secret-service
 *   KIMI_KEYS_FILE      explicit legacy/test key file (overrides Keychain)
 *   KIMI_PROVIDER_PROFILE kimi-code-membership (default), kimi-open-platform,
 *                              or custom
 *   KIMI_BASE_URL       optional upstream override for the selected profile
 *                              (required for the custom profile)
 *   KIMI_AUTH_MODE      bearer, x-api-key, or both (custom profile only)
 *   KIMI_ROUTER_STATE   state file path (default ~/.kimi-key-router-state.json)
 *   KIMI_ROUTER_LOCK    state lock path (default <state file>.lock)
 *   KIMI_MANAGEMENT_TOKEN_FILE bearer header file for management endpoints
 *                              (default ~/.config/kimi-router/management.header)
 *   KIMI_MANAGEMENT_TOKEN inline management token; prefer the file
 *   KIMI_LOG_FILE       structured event log
 *                              (default ~/.local/state/kimi-router/router.jsonl)
 *   KIMI_LOG_STDOUT     set to "0" to log only to the file
 *   KIMI_LOG_MAX_BYTES / KIMI_LOG_RETAIN  log rotation size and generations
 *   PORT / HOST         listen address (default 8787 / 127.0.0.1)
 *   KIMI_COOLDOWN_5H_MS        default 18000000 (5h)
 *   KIMI_COOLDOWN_WEEKLY_MS    default 604800000 (7d) — real weekly reset time
 *                              is unknown, so this is a conservative guess
 *   KIMI_COOLDOWN_MONTHLY_MS   default 2592000000 (30d)
 *   KIMI_COOLDOWN_TRANSIENT_MS default 60000  (network/5xx)
 *   KIMI_COOLDOWN_INVALID_MS   default 86400000 (24h, 401/402/403)
 *   KIMI_EXPLORATION_INTERVAL_MS default 900000 (15m)
 *   KIMI_PREFERENCE_TTL_MS     default 1800000 (30m)
 *   KIMI_HEADERS_TIMEOUT_MS    default 300000 — max wait for upstream response
 *                              headers; NO limit on response body lifetime
 *   KIMI_RECOVERY_PROBE_INITIAL_MS default 30000 (30s) — earliest a real
 *                              client request may re-check a quota-cooled key
 *   KIMI_RECOVERY_PROBE_MAX_MS default 300000 (5m) — maximum failed-probe
 *                              backoff; no synthetic requests are generated
 *   KIMI_ROUTER_ALLOW_REMOTE   set to "1" to allow binding a non-loopback HOST
 *                              (DANGEROUS: the router has no authentication)
 *   KIMI_MAX_BODY_BYTES        default 33554432 (32 MB) request body cap
 *   KIMI_ERROR_BODY_MAX_BYTES  default 1048576 (1 MB) upstream error capture
 *   KIMI_MAX_INFLIGHT_PER_KEY  default 24
 *   KIMI_MAX_QUEUE_DEPTH       default 128
 *   KIMI_QUEUE_TIMEOUT_MS      default 15000
 *   KIMI_DRAIN_TIMEOUT_MS      default 120000
 *   KIMI_RETRY_AMBIGUOUS_REQUESTS set to "1" to replay POST requests after
 *                              network/408/5xx failures (DANGEROUS: an
 *                              accepted request could be billed twice)
 *   KIMI_TEST_CLOCK_FILE       test-only clock override; refused unless
 *                              NODE_ENV=test
 */

import os from 'node:os';

import { resolveRouterConfig } from '../src/config.mjs';
import { startRouter } from '../src/router.mjs';

let config;
try {
  config = resolveRouterConfig(process.env, os.homedir());
} catch (err) {
  console.error(`Invalid router configuration: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

startRouter(config);
