const PROFILE_ALIASES = new Map([
  ['kimi-code', 'kimi-code-membership'],
  ['membership', 'kimi-code-membership'],
  ['kimi-code-membership', 'kimi-code-membership'],
  ['open-platform', 'kimi-open-platform'],
  ['platform', 'kimi-open-platform'],
  ['kimi-open-platform', 'kimi-open-platform'],
  ['custom', 'custom'],
]);

const PROFILE_DEFINITIONS = Object.freeze({
  'kimi-code-membership': Object.freeze({
    id: 'kimi-code-membership',
    provider: 'kimi',
    protocol: 'anthropic-compatible',
    defaultBaseUrl: 'https://api.kimi.com',
    authMode: 'both',
    quotaDomain: 'membership',
  }),
  'kimi-open-platform': Object.freeze({
    id: 'kimi-open-platform',
    provider: 'kimi',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.moonshot.ai',
    authMode: 'bearer',
    quotaDomain: 'platform-billing',
  }),
  custom: Object.freeze({
    id: 'custom',
    provider: 'custom',
    protocol: 'pass-through',
    defaultBaseUrl: null,
    authMode: 'both',
    quotaDomain: 'custom',
  }),
});

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('provider base URL must use http or https');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('provider base URL must not contain credentials, query parameters, or fragments');
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !local) {
    throw new Error('provider base URL must use TLS unless it is loopback');
  }
  return value.replace(/\/+$/, '');
}

function normalizeAuthMode(value, fallback) {
  const mode = value?.trim().toLowerCase() || fallback;
  if (!['bearer', 'x-api-key', 'both'].includes(mode)) {
    throw new Error('KIMI_AUTH_MODE must be bearer, x-api-key, or both');
  }
  return mode;
}

export function resolveProviderAdapter(env = process.env) {
  const requested = (env.KIMI_PROVIDER_PROFILE || 'kimi-code-membership').trim().toLowerCase();
  const profileId = PROFILE_ALIASES.get(requested);
  if (profileId === undefined) {
    throw new Error(`unknown KIMI_PROVIDER_PROFILE: ${requested}`);
  }
  const definition = PROFILE_DEFINITIONS[profileId];
  const explicitBase = env.KIMI_BASE_URL?.trim();
  if (profileId === 'custom' && !explicitBase) {
    throw new Error('KIMI_BASE_URL is required for the custom provider profile');
  }
  const baseUrl = normalizeBaseUrl(explicitBase || definition.defaultBaseUrl);
  const authMode = profileId === 'custom'
    ? normalizeAuthMode(env.KIMI_AUTH_MODE, definition.authMode)
    : definition.authMode;
  return Object.freeze({ ...definition, baseUrl, authMode });
}

export function applyProviderAuthentication(headers, adapter, secret) {
  if (adapter.authMode === 'bearer' || adapter.authMode === 'both') {
    headers.authorization = `Bearer ${secret}`;
  }
  if (adapter.authMode === 'x-api-key' || adapter.authMode === 'both') {
    headers['x-api-key'] = secret;
  }
  return headers;
}

export function publicProviderMetadata(adapter) {
  return {
    id: adapter.id,
    provider: adapter.provider,
    protocol: adapter.protocol,
    quotaDomain: adapter.quotaDomain,
    authMode: adapter.authMode,
    baseUrl: adapter.baseUrl,
  };
}
