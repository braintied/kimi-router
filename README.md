# @braintied/kimi-router

Kimi Router is a localhost-only, Keychain-backed proxy for using Kimi Code with
Claude Code. It keeps labelled personal accounts in a health-aware pool and
retries an eligible request on another account when Kimi reports an
account-specific quota or capability failure.

The router is zero-dependency Node.js code. It supports Kimi's Anthropic- and
OpenAI-compatible endpoints and preserves long-lived SSE streams with raw
`node:http`/`node:https` transport.

## Installed layout

| Purpose | Path |
|---|---|
| Package checkout | the standalone `braintied/kimi-router` repository |
| Deployed router | `~/.local/share/kimi-router/router.mjs` |
| Launcher | `~/.local/bin/kimi` |
| Keychain label file | `~/.kimi-key-accounts` |
| Persistent health state | `~/.kimi-key-router-state.json` |
| Structured rotating log | `~/.local/state/kimi-router/router.jsonl` |
| launchd service | `~/Library/LaunchAgents/ai.ora.kimi-key-router.plist` |

The label file contains email-style account labels only. Secrets are generic
password items in macOS Keychain under service `ai.ora.kimi-key-router`.

## What v3 changes

- Uses macOS Keychain instead of a plaintext key file.
- Labels every account in status, logs, preferences, and diagnostics.
- Classifies Kimi's documented errors by scope: request, model capability,
  account, or provider.
- Does not spray provider overloads or request-specific URL security failures
  across the key pool.
- Uses per-key in-flight counts and a configurable concurrency ceiling (24 by
  default, below Kimi's documented maximum of 30).
- Queues bounded overflow rather than allocating an unbounded backlog.
- Serializes real-traffic recovery probes to prevent a thundering herd. When
  the probe is the pool's only path back to service, concurrent sessions wait
  for its result and continue automatically if the account recovers.
- Parks explicit five-hour quota failures behind a persisted timer. An exact
  upstream `Retry-After` wins; otherwise the timer is five hours. The first
  request after expiry is serialized as the recovery probe.
- Resolves contradictory concurrent failures and successes by attempt order.
  Quota failures quarantine an account immediately; only a newer accepted
  attempt may reopen it, while already-accepted streams keep running.
- Keeps separate model circuits, so a `k3[1m]` permission error does not disable
  standard `k3` for the same account.
- Hot-reloads labels and Keychain secrets. Removed accounts drain existing
  streams and stop receiving new work.
- Gracefully drains streams on SIGTERM/SIGINT.
- Emits permission-restricted JSONL logs with rotation and bounded error bodies.

## Request flow

```text
Claude Code
    │
    ▼
127.0.0.1:8787 ── model + health + load routing ──▶ api.kimi.com
    │
    ├─ replaces both Authorization and x-api-key
    ├─ never logs prompts, tool calls, responses, or secrets
    ├─ immediately quarantines quota failures from new work
    ├─ retries explicit account/model denials on another eligible account
    ├─ suppresses ambiguous POST replay after network/408/5xx failures
    └─ pipes an accepted SSE response until completion
```

The router buffers the request body (32 MiB default) because transparent retry
requires replaying it. It inspects only the JSON `model` field for capability
routing. Response bodies are streamed without a body timeout. Error bodies that
must be buffered for classification are capped at 1 MiB.

## Launcher

```bash
kimi                         # Claude Code on Kimi K3
kimi --1m                    # Kimi K3 1M model where the account allows it
kimi --status                # readable labelled pool status
kimi --status-json           # complete diagnostics JSON
kimi --prefer ACCOUNT        # temporary preference; failover stays enabled
kimi --auto                  # clear preference
kimi --reload                # hot-reload Keychain labels
kimi --restart               # graceful drain and launchd restart
kimi --doctor                # dependencies, launchd, Keychain source, health
kimi --logs                  # latest structured events
```

All other arguments are passed to `claude`.

## Account management

Add or update an account without putting the secret in shell history:

```bash
security add-generic-password -U \
  -s ai.ora.kimi-key-router \
  -a account@example.com \
  -w
```

Keep `-w` last with no following argument. macOS prompts for the secret. Then
add the account label as its own line in `~/.kimi-key-accounts` and run:

```bash
kimi --reload
kimi --doctor
```

To remove an account, delete its label from `~/.kimi-key-accounts`, reload, and
then remove the Keychain item:

```bash
security delete-generic-password \
  -s ai.ora.kimi-key-router \
  -a account@example.com
```

An in-flight removed account appears as `retiring` until its final stream ends.

## Failure policy

| Kimi response | Scope | Router action |
|---|---|---|
| 429 engine overloaded | provider | pass through; do not spray accounts |
| 429 too many concurrent requests | account/transient | short circuit, try another account |
| 429 usage limit for this period | account/5-hour | honor `Retry-After` or start a persisted five-hour timer; serialize the first retry |
| 429 monthly or weekly limit | account | cool for the matching window |
| 402 unable to verify membership | account/transient | short circuit, try another account |
| 403 billing-cycle usage limit | account/weekly | cool account, try another account |
| 403 access terminated | account/blocked | long non-probed circuit |
| 403 URL security risk | request | pass through; do not rotate |
| unknown 403 | request | pass through; do not poison account health |
| 401 model/tier/capability denial | model capability | cool only that model/account pair |
| 401 invalid credentials | account | invalid-key circuit |
| other non-retryable 4xx | request | pass through unchanged |
| 5xx/network/408 | ambiguous | update health; do not replay POST by default |

`Retry-After` takes precedence over `X-RateLimit-Reset`; both can drive exact
quota cooldowns. Recovery probes use real user traffic, and the router
generates no synthetic billable requests. Ambiguous replay is allowed only
for safe methods, a request carrying an idempotency key, or the explicit and
risk-bearing `KIMI_RETRY_AMBIGUOUS_REQUESTS=1` opt-in.

The classifier is grounded in Kimi's official
[error reference](https://www.kimi.com/code/docs/en/kimi-code/error-reference.html)
and [membership documentation](https://www.kimi.com/code/docs/en/kimi-code/membership.html).

## Status model

`GET /status` includes:

- active/available/cooling/retiring accounts;
- account and model-specific circuits;
- in-flight, accepted, completed, and failed-stream counters;
- bounded queue depth and limit;
- TTFB EWMA and optional upstream rate-limit telemetry;
- authoritative attempt ordering and recovery-probe state;
- exact cooldown/recovery timestamps and remaining milliseconds for countdowns;
- secret source (`keychain`, never the secret).

Management endpoints are loopback-only, protected against foreign `Host` and
browser `Origin` values, and bearer-authenticated when the installer-managed
`management.header` file is present. The launcher passes that file to curl
without placing the token in process arguments:

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | liveness/readiness; 503 while draining |
| `GET /status` | redacted pool diagnostics |
| `POST /prefer` | temporary labelled preference |
| `POST /reload` | hot pool reload |
| `POST /reset` | operator-only circuit reset |

## Install and update

Run tests first, migrate a legacy plaintext pool if one exists, install without
interrupting the service, validate on a parallel port, then activate:

```bash
npm run gate
npm run artifact:check
node migrate-keychain.mjs --dry-run
node migrate-keychain.mjs --delete-legacy
node install.mjs
node install.mjs --activate
kimi --doctor
```

The installer validates syntax and the generated plist. Activation restores and
reloads the previous plist if the new launchd bootstrap fails.

## Configuration

| Variable | Default |
|---|---|
| `KIMI_ACCOUNTS_FILE` | `~/.kimi-key-accounts` |
| `KIMI_KEYCHAIN_SERVICE` | `ai.ora.kimi-key-router` |
| `KIMI_BASE_URL` | `https://api.moonshot.ai` (installed service uses `https://api.kimi.com`) |
| `KIMI_ROUTER_STATE` | `~/.kimi-key-router-state.json` |
| `KIMI_LOG_FILE` | `~/.local/state/kimi-router/router.jsonl` |
| `KIMI_MANAGEMENT_TOKEN_FILE` | `~/.config/kimi-router/management.header` |
| `HOST` / `PORT` | `127.0.0.1` / `8787` |
| `KIMI_MAX_INFLIGHT_PER_KEY` | `24` |
| `KIMI_MAX_QUEUE_DEPTH` | `128` |
| `KIMI_QUEUE_TIMEOUT_MS` | `15000` |
| `KIMI_COOLDOWN_5H_MS` | `18000000` |
| `KIMI_ERROR_BODY_MAX_BYTES` | `1048576` |
| `KIMI_RETRY_AMBIGUOUS_REQUESTS` | unset/disabled |
| `KIMI_RECOVERY_PROBE_INITIAL_MS` | `30000` |
| `KIMI_RECOVERY_PROBE_MAX_MS` | `300000` |
| `KIMI_DRAIN_TIMEOUT_MS` | `120000` |
| `KIMI_LOG_MAX_BYTES` / `KIMI_LOG_RETAIN` | `5242880` / `3` |

`KIMI_KEYS_FILE` and `KIMI_API_KEYS` remain available for isolated tests and
migration only. An explicit `KIMI_KEYS_FILE` takes precedence so tests never
touch the production Keychain pool.

## Provider and subscription boundary

This router is for personal interactive accounts the operator owns and is not a
shared gateway, resale service, or background automation system. Kimi's
[community guidelines](https://www.kimi.com/code/docs/en/kimi-code/community-guidelines.html)
and [user agreement](https://www.kimi.com/user/agreement/en/modelUse) govern use.
Do not use pooling to evade provider restrictions; obtain written provider
confirmation if account pooling is unclear for a particular plan.

Claude Max subscriptions are not API-key pools. They use Anthropic login/session
credentials and should remain on Anthropic's official login flow. The launcher
does not extract, copy, or rotate Max credentials. Use `claude` for the normal
Anthropic session and `kimi` for a Kimi-backed process.

Claude Code reads provider/base-URL credentials at process startup. Switching
between Kimi, Anthropic, or another compatible provider therefore requires
starting a new Claude Code process. A saved conversation may be resumed after
relaunch, but the already-running process cannot safely change providers in
place.

## Tests

```bash
npm run gate
npm run artifact:check
xcrun swiftc -typecheck keychain-write.swift
```

The v3 suite covers official error scopes, no-spray provider/request failures,
model circuits, unknown-403 safety, ambiguous replay suppression, exact reset
headers, management authentication, both orderings of contradictory concurrent
results, leak-proof in-flight accounting, load distribution, bounded
queueing, automatic and explicit hot reload, draining removed keys, bounded
error bodies, and graceful completion of an active stream.
