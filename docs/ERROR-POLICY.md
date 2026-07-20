# Error and replay policy

The classifier is based on Kimi's first-party error reference, last verified
2026-07-19. The router first parses bounded `message`, `detail`, `code`,
`type`, and `reason` fields from the root/error/details objects. Text matching is
a fallback only for non-JSON responses; unrelated JSON fields cannot trigger
rotation. Trustworthy reset headers take precedence over policy windows.

| Response | Scope | Action |
|---|---|---|
| 400 request/context/tool/thinking error | Request | Return unchanged; never rotate |
| 401 invalid or revoked credential | Credential | Disable that credential |
| 401 model, context, high-speed, or tier denial | Account + capability | Open only that capability circuit |
| 402 membership verification unavailable | Account transient | Short cooldown; safe failover |
| 403 billing-cycle quota | Account quota window | Cool until known reset or recovery policy |
| 403 access terminated | Account | Disable without automatic probes |
| 429 engine overloaded | Provider | Short provider circuit; do not spray accounts |
| 429 concurrency | Account transient | Short cooldown; safe failover |
| 429 five-hour usage limit | Account quota window | Exact reset/Retry-After, otherwise five hours |
| 429 monthly usage limit | Account quota window | Exact reset when present; otherwise conservative policy |
| Network, 408, or 5xx after request dispatch | Ambiguous | Update future-route health; do not replay by default |

An ambiguous failure may have occurred after the provider accepted and billed a
request. Automatic replay therefore requires affirmative idempotency evidence or
an explicit operator opt-in. Availability must not silently create duplicate
work or spend.

Unknown errors are request-scoped by default. In particular, an unknown 403
is returned without rotation or account quarantine. A new provider message is
not grounds to poison every credential. `Retry-After` wins over a valid
`X-RateLimit-Reset`; reset values may be relative seconds, Unix seconds, Unix
milliseconds, or an HTTP date. Reset names include
`X-RateLimit-Reset`, `X-RateLimit-Reset-Requests`, and
`X-RateLimit-Reset-Tokens`, in that order. Status exposes quota-window kind,
reset timestamp, and whether the source was `Retry-After`, a rate-limit header,
or policy.
