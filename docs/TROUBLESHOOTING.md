# Troubleshooting

Start with:

```text
kimi --doctor
kimi --status
```

Do not paste status/log output into public issues without reviewing labels and
local paths. Neither surface includes API keys, prompts, tool payloads, or
responses.

## One terminal works and another does not

An already-running Claude Code process keeps the provider/base URL and startup
environment with which it was launched. It does not inherit later shell exports.

1. In the affected Claude Code process, run `/status` and inspect its base URL
   and authentication method.
2. A routed Kimi process should point at `127.0.0.1:8787/coding/`.
3. If it points directly at Kimi, Anthropic, or another gateway, start a new
   process with `kimi`; changing the live shell cannot rewrite it.
4. If it uses the local router, `kimi --reload` makes added/replaced Kimi
   credentials available to its next request without restarting that process.

## Credits exist but the router stays on an exhausted account

Run `kimi --status`. The usable account must show `available: true`; the
exhausted account should expose a `quotaWindow`, cooldown, and recovery time.
Automatic routing ignores cooling accounts even if they were previously active
or preferred. If metadata contradicts the provider after an operator-verified
top-up, `kimi --reload` first; use the protected `/reset` through the launcher
only when you intentionally want to clear every circuit.

The router never spends quota on synthetic probes. When a conservative recovery
deadline arrives, one real client request probes the account and concurrent
requests wait or use another healthy account.

## Five-hour, weekly, or monthly timer looks wrong

Kimi distinguishes engine overload, concurrency, five-hour usage, weekly billing
cycle, and monthly quota errors in its
[official error reference](https://www.kimi.com/code/docs/en/kimi-code/error-reference.html).
Only the five-hour text creates the strict five-hour window. An upstream
`Retry-After` or rate-limit reset header overrides policy guesses. Capture the
redacted status fields `lastStatus`, `cooldownReason`, and `quotaWindow`; never
capture the credential.

## `401`

- Invalid/expired authentication opens only the credential circuit.
- Model, 1M, HighSpeed, plan, or tier denial opens only that account/model
  capability circuit.
- Verify that membership keys use the membership endpoint. Kimi says membership
  and Open Platform keys/base URLs are not interchangeable.

## `402` or `403`

Kimi documents membership verification `402` as usually temporary. Known
billing-cycle `403` is account quota; `Access terminated` is a long, non-probed
account block. Unknown `403` is passed through without rotating because a new
or request-specific denial must not poison the pool.

## `429`

- Engine overload: provider circuit; no account spray.
- Too many concurrent requests: short account circuit and safe failover.
- Usage limit for this period: strict five-hour quota window.
- Monthly/weekly: matching account quota window.

## `400` from `tool_search`

The launcher defaults `ENABLE_TOOL_SEARCH=false`. Kimi's help center documents
this as a temporary compatibility workaround. If a parent shell or settings file
overrides it, start a fresh `kimi` process and check the environment conflict.

## Native Claude Max/Pro is charging an API account

Use plain `claude`, remove `ANTHROPIC_API_KEY` from that environment, and run
`/status`. Anthropic documents that environment API keys take precedence over a
logged-in subscription. The router never reads, exports, pools, or rotates Claude
OAuth credentials.

## State or startup failure

- Invalid JSON state is renamed to a permission-restricted `.corrupt-*` file and
  the router starts with clean health metadata.
- A future state schema fails closed rather than downgrading it.
- A live writer owns the `.lock`; a second instance using the same state exits.
- A crash leaves a stale lock, which the next process verifies and recovers.

Do not delete state or lock files while a router process is alive.
