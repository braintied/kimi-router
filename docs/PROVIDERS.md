# Provider profiles

Verified against first-party documentation on 2026-07-19.

## Kimi Code membership

- Anthropic-compatible base: `https://api.kimi.com/coding/`
- OpenAI-compatible base: `https://api.kimi.com/coding/v1`
- Models include `k3`, `k3[1m]`, `kimi-for-coding`, and
  `kimi-for-coding-highspeed`, subject to membership capability.
- Quota may include a rolling five-hour window, weekly billing-cycle limits,
  a shared monthly window, and optional Extra Usage.
- The membership adapter sends bearer and `x-api-key` authentication to the
  Anthropic-compatible endpoint.

## Kimi Open Platform

- Uses the Open Platform API and billing rather than membership quota.
- K3 is always reasoning on the current platform. The Open Platform currently
  documents `reasoning_effort=max` for K3.
- K3 streams reasoning and answer content separately; callers must preserve the
  full assistant message for subsequent tool and multi-turn requests.
- The Open Platform adapter is OpenAI-compatible and bearer-authenticated. It is
  for matching clients and is never selected by the Claude Code launcher.

## Claude Code boundary

Kimi documents its own Claude Code compatibility endpoint. Anthropic documents
gateway access to Claude models; Kimi, not Anthropic, documents this non-Claude
compatibility path. This package therefore calls it a Kimi-supported bridge, not
an Anthropic-supported model gateway.

Kimi's current [third-party agent guide](https://www.kimi.com/code/docs/en/third-party-tools/other-coding-agents)
documents the model aliases, context windows, and effort mapping. Its
[What's New](https://www.kimi.com/code/docs/en/kimi-code/whats-new.html) notes
that changing model or effort invalidates prompt caches; start a new session when
changing model families.

Native Claude Max/Pro login is a separate launcher profile. The router never
extracts, pools, copies, or rotates Claude subscription OAuth credentials.
