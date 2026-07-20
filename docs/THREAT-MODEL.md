# Threat model

## Assets

- Kimi API credentials and paid quota
- Claude Code request/response content
- account labels and local operational metadata
- management bearer credential
- integrity of routing, state, and release artifacts

## Trust boundaries

Claude Code and the router share the local user account. The router crosses the
network boundary to the selected Kimi provider. macOS Keychain or Linux Secret
Service is the credential boundary. GitHub/npm release systems are a separate
supply-chain boundary.

## Defenses

- Loopback binding by default; non-loopback requires an explicit dangerous flag.
- `Host` and browser `Origin` validation reduce DNS-rebinding and drive-by calls.
- Protected status/mutation endpoints use a high-entropy bearer read from a
  mode-`0600` header file and compared in constant time.
- Secrets are read through a backend interface and never stored in state, logs,
  source, test fixtures, provenance, or tarballs.
- Request bodies are bounded and never logged. Only the model field is inspected.
- Error bodies are bounded and structured fields are extracted for classification.
- Hop-by-hop and inbound authentication headers are stripped.
- Ambiguous POST replay is denied without a safe method, idempotency key, or
  explicit risk-bearing opt-in.
- State writes are single-writer, versioned, permission-restricted, fsynced, and
  atomically renamed; corrupt state is quarantined.
- Release builds require clean source, commit-derived timestamps, two-build byte
  equality, SHA-256, and provenance.

## Residual risks

- A process running as the same OS user can generally observe or alter local
  traffic, files, and processes; this is not a hostile-user isolation boundary.
- The management bearer protects HTTP endpoints, not arbitrary code execution as
  the local user.
- The router relies on provider error semantics that may change without notice.
- Plain labels can be personal data; use sanitized aliases on shared machines.
- Opting into ambiguous replay can duplicate work or billing.
- Remote binding is unsafe without a separately authenticated, encrypted gateway.
- Pooling accounts may be restricted by provider terms. This software does not
  waive plan, community, or acceptable-use rules.
- Public visibility with `UNLICENSED` metadata does not grant open-source rights;
  licensing is an owner decision.

## Claude subscription boundary

Anthropic says subscription OAuth is intended for the subscriber's ordinary use
in native Anthropic applications, including Claude Code, and warns against tools
that misrepresent identity or route third-party traffic against subscription
limits. This package therefore does not inspect, proxy, export, pool, or rotate
Claude Max/Pro OAuth credentials. Use official `claude` login and `/status`.
