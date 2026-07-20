# Configuration reference

The installed service is deliberately single-provider and single-protocol. A
Claude Code process connects to the stable local Anthropic-format URL; the
router may rotate credentials inside the selected Kimi Code membership profile.
Changing to Open Platform, Anthropic, or another model family requires a new
client process.

## Provider profiles

| `KIMI_PROVIDER_PROFILE` | Protocol | Default upstream | Authentication |
|---|---|---|---|
| `kimi-code-membership` | Anthropic-compatible | `https://api.kimi.com` | bearer + `x-api-key` |
| `kimi-open-platform` | OpenAI-compatible | `https://api.moonshot.ai` | bearer |
| `custom` | pass-through | required `KIMI_BASE_URL` | `KIMI_AUTH_MODE` |

Aliases `membership`, `kimi-code`, `platform`, and `open-platform` are accepted.
`custom` supports `bearer`, `x-api-key`, or `both`. Plain HTTP is rejected for
non-loopback upstreams. URLs containing credentials, query strings, or fragments
are rejected.

The `kimi` launcher uses only `kimi-code-membership`. Open Platform is an
adapter for OpenAI-compatible clients; it is not protocol translation and must
not be selected behind the Claude Code launcher.

Kimi's current first-party endpoint and Claude Code examples are documented in
[Using in Third-Party Coding Agents](https://www.kimi.com/code/docs/en/third-party-tools/other-coding-agents).

## Router variables

| Variable | Default | Meaning |
|---|---:|---|
| `HOST` | `127.0.0.1` | Bind address; non-loopback is refused without the dangerous override |
| `PORT` | `8787` | Local gateway port |
| `KIMI_PROVIDER_PROFILE` | `kimi-code-membership` | Provider/protocol/auth contract |
| `KIMI_BASE_URL` | profile default | Explicit upstream override |
| `KIMI_AUTH_MODE` | `both` | Custom-profile authentication only |
| `KIMI_ACCOUNTS_FILE` | `~/.kimi-key-accounts` | Ordered secret-store account labels |
| `KIMI_KEYCHAIN_SERVICE` | `ai.ora.kimi-key-router` | Secret-store service/collection |
| `KIMI_SECRET_BACKEND` | `auto` | `macos-keychain` or `linux-secret-service` |
| `KIMI_ROUTER_STATE` | `~/.kimi-key-router-state.json` | Redacted versioned health metadata |
| `KIMI_ROUTER_LOCK` | state path + `.lock` | Single-writer lock path |
| `KIMI_LOG_FILE` | platform state directory | Permission-restricted JSONL log |
| `KIMI_MANAGEMENT_TOKEN_FILE` | config directory | bearer header file for management calls |
| `KIMI_MAX_BODY_BYTES` | `33554432` | Buffered request limit |
| `KIMI_ERROR_BODY_MAX_BYTES` | `1048576` | Classification buffer limit |
| `KIMI_MAX_INFLIGHT_PER_KEY` | `24` | Per-credential concurrency cap |
| `KIMI_MAX_QUEUE_DEPTH` | `128` | Bounded local wait queue |
| `KIMI_QUEUE_TIMEOUT_MS` | `15000` | Queue wait deadline |
| `KIMI_HEADERS_TIMEOUT_MS` | `300000` | Upstream time-to-headers deadline |
| `KIMI_DRAIN_TIMEOUT_MS` | `120000` | Graceful shutdown deadline |
| `KIMI_RETRY_AMBIGUOUS_REQUESTS` | disabled | Risk-bearing replay override |
| `KIMI_ROUTER_ALLOW_REMOTE` | disabled | Dangerous non-loopback override |

The test-only fake clock requires both `NODE_ENV=test` and
`KIMI_TEST_CLOCK_FILE`. Production startup rejects that variable.

## Routing and cooldown policy

| Variable | Default |
|---|---:|
| `KIMI_COOLDOWN_5H_MS` | `18000000` |
| `KIMI_COOLDOWN_WEEKLY_MS` | `604800000` |
| `KIMI_COOLDOWN_MONTHLY_MS` | `2592000000` |
| `KIMI_COOLDOWN_TRANSIENT_MS` | `60000` |
| `KIMI_COOLDOWN_INVALID_MS` | `86400000` |
| `KIMI_RECOVERY_PROBE_INITIAL_MS` | `30000` |
| `KIMI_RECOVERY_PROBE_MAX_MS` | `300000` |
| `KIMI_EXPLORATION_INTERVAL_MS` | `900000` |
| `KIMI_PREFERENCE_TTL_MS` | `1800000` |

`Retry-After` has priority over `X-RateLimit-Reset`,
`X-RateLimit-Reset-Requests`, and `X-RateLimit-Reset-Tokens`. A five-hour timer
is created only for a classified five-hour usage error. Concurrency and engine
overload use short transient/provider circuits instead.

## Launcher environment

`kimi` sets the local base URL, a non-secret local placeholder token, every
Claude Code model alias, the context/compaction window, and K3 effort. It unsets
ambient `ANTHROPIC_API_KEY` so a native Claude subscription or Console key cannot
silently take precedence inside the Kimi process.

Use `KIMI_MODEL`, `KIMI_CONTEXT_TOKENS`, or `CLAUDE_CODE_EFFORT_LEVEL` only for
an intentionally new process. Kimi documents `low`, `high`, and `max` for K3;
the launcher defaults to `max`. `ENABLE_TOOL_SEARCH=false` remains the
compatibility default because Kimi documents it as the workaround for unsupported
`tool_search` calls.

## Precedence and unsafe test inputs

`KIMI_KEYS_FILE` overrides the secret-store label file. `KIMI_API_KEYS` is used
only when non-empty and no explicit file is selected. Both expose secret
material outside the OS secret store and exist solely for migration and isolated
tests; never place either in a service definition or shell profile.
