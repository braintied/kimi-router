# ADR 0001: Stable local gateway

- Status: Accepted
- Date: 2026-07-19

## Decision

Claude Code launchers use one loopback gateway URL. Credential selection and
quota recovery happen behind that URL. Provider-family switching remains a new
process operation.

## Consequences

- Open proxy-launched sessions can use a newly selected Kimi credential.
- Credentials never need to be injected into Claude Code processes.
- The router becomes a local security boundary and must stay loopback-only.
- The gateway must preserve Anthropic-compatible request and streaming behavior.
- The management surface requires strict host/origin validation and redaction.
