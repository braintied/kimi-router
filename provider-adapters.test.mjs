#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  applyProviderAuthentication,
  publicProviderMetadata,
  resolveProviderAdapter,
} from './provider-adapters.mjs';

const membership = resolveProviderAdapter({});
assert.equal(membership.id, 'kimi-code-membership');
assert.equal(membership.protocol, 'anthropic-compatible');
assert.equal(membership.baseUrl, 'https://api.kimi.com');
assert.deepEqual(
  applyProviderAuthentication({}, membership, 'test-secret'),
  { authorization: 'Bearer test-secret', 'x-api-key': 'test-secret' }
);

const platform = resolveProviderAdapter({ KIMI_PROVIDER_PROFILE: 'open-platform' });
assert.equal(platform.id, 'kimi-open-platform');
assert.equal(platform.protocol, 'openai-compatible');
assert.equal(platform.baseUrl, 'https://api.moonshot.ai');
assert.deepEqual(
  applyProviderAuthentication({}, platform, 'test-secret'),
  { authorization: 'Bearer test-secret' }
);

const custom = resolveProviderAdapter({
  KIMI_PROVIDER_PROFILE: 'custom',
  KIMI_BASE_URL: 'http://127.0.0.1:9000/',
  KIMI_AUTH_MODE: 'x-api-key',
});
assert.equal(custom.baseUrl, 'http://127.0.0.1:9000');
assert.deepEqual(
  applyProviderAuthentication({}, custom, 'test-secret'),
  { 'x-api-key': 'test-secret' }
);
assert.deepEqual(publicProviderMetadata(custom), {
  id: 'custom',
  provider: 'custom',
  protocol: 'pass-through',
  quotaDomain: 'custom',
  authMode: 'x-api-key',
  baseUrl: 'http://127.0.0.1:9000',
});

assert.throws(
  () => resolveProviderAdapter({ KIMI_PROVIDER_PROFILE: 'custom' }),
  /KIMI_BASE_URL is required/
);
assert.throws(
  () => resolveProviderAdapter({ KIMI_PROVIDER_PROFILE: 'unknown' }),
  /unknown KIMI_PROVIDER_PROFILE/
);
assert.throws(
  () => resolveProviderAdapter({
    KIMI_PROVIDER_PROFILE: 'custom',
    KIMI_BASE_URL: 'http://remote.example.test',
  }),
  /must use TLS/
);
assert.throws(
  () => resolveProviderAdapter({
    KIMI_PROVIDER_PROFILE: 'custom',
    KIMI_BASE_URL: 'https://user:password@example.test',
  }),
  /must not contain credentials/
);

console.log('provider adapter tests passed');
