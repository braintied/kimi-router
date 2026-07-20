# Provider profiles

Verified against first-party documentation on 2026-07-19.

## Kimi Code membership

- Anthropic-compatible base: `https://api.kimi.com/coding/`
- OpenAI-compatible base: `https://api.kimi.com/coding/v1`
- Models include `k3`, `k3[1m]`, `kimi-for-coding`, and
  `kimi-for-coding-highspeed`, subject to membership capability.
- Quota may include a rolling five-hour window and a separate monthly window.

## Kimi Open Platform

- Uses the Open Platform API and billing rather than membership quota.
- K3 is always reasoning on the current platform. The Open Platform currently
  documents `reasoning_effort=max` for K3.
- K3 streams reasoning and answer content separately; callers must preserve the
  full assistant message for subsequent tool and multi-turn requests.

## Claude Code boundary

Kimi documents its own Claude Code compatibility endpoint. Anthropic documents
gateways for Claude models and explicitly does not support using Claude Code
with non-Claude models. This package therefore describes Kimi as a Kimi-supported
compatibility bridge, not as an Anthropic-supported model gateway.

Native Claude Max/Pro login is a separate launcher profile. The router never
extracts, pools, copies, or rotates Claude subscription OAuth credentials.
