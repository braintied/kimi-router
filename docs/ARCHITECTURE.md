# Architecture

The router is a stable local gateway between Claude Code and Kimi's
Anthropic-compatible API. Claude Code keeps one base URL for the lifetime of a
process; the gateway can select a different eligible credential for each new
request without changing that URL.

## State model

The target domain model deliberately separates:

- **Provider**: an upstream service and its global health circuit.
- **Account**: the owner of subscription quota and reset windows.
- **Credential**: a revocable secret used to authenticate an account.
- **Capability**: account eligibility for a model, context tier, or speed tier.
- **Route**: a provider profile, endpoint family, model, account, and credential.
- **QuotaWindow**: a five-hour, monthly, or provider-reported reset window.

`provider-adapters.mjs` makes each provider's protocol, upstream default,
authentication mode, and quota domain explicit. One router process owns one
adapter because the proxy does not translate Anthropic Messages into OpenAI Chat
Completions. Different protocol families require separate processes and ports.

Credential material stays behind the OS secret-store interface. The current
backends are macOS Keychain and Linux Secret Service (`secret-tool`); unsupported
platforms fail closed rather than falling back to plaintext. Persistent router
state contains
only one-way identifiers, counters, timestamps, circuit reasons, rate-limit
telemetry, explicit quota windows, and provider health. Schema v2 is protected by
a nonce-bound exclusive lock. Writes are permission-restricted, fsynced, and
atomically renamed; v1 migrates, future schemas fail closed, and invalid state is
quarantined.

## Request lifecycle

1. Buffer a bounded request body and inspect only the model field.
2. Filter routes by provider, capability, circuit, quota, and concurrency.
3. Prefer a healthy sticky route unless a materially better route exists.
4. Replace inbound authentication headers with the selected credential.
5. Stream successful responses without buffering.
6. Buffer only bounded error bodies for classification.
7. Retry explicit account/capability denials; replay ambiguous failures only with affirmative idempotency evidence.
8. Persist redacted versioned state atomically and release all in-flight counters.

The compatibility label is now the stable account identity used for persisted
quota state, while the one-way credential identity owns credential-rejection
circuits. This lets account quota survive a secret rotation without carrying a
revoked credential circuit onto the replacement secret. The v0.1 configuration
still exposes one active credential per labelled account; multi-credential
account configuration remains a post-v0.1 schema extension. Hot replacement
of that active credential is supported: an accepted old stream drains while the
replacement receives new work.
