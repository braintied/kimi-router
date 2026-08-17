# @braintied/kimi-router

Localhost proxy that pools **Kimi Code membership** keys and fails over when
Kimi rejects one account. Claude Code talks to `127.0.0.1:8787`. The router
swaps `Authorization` / `x-api-key`, classifies the error, and retries on
another labelled key when the failure is account-scoped.

It is not Open Platform billing, not Grok, not Claude Max, and not
`ora-model`. Those stay in their own packages and bridges.

**Version in this tree:** see `package.json`. **Current registry:** 1.0.1 on
GitHub Packages. **Current public GitHub Release:** v0.1.1 (2026-07-20) until
this tree is published. **License:** UNLICENSED. Public visibility is not
reuse rights.

---

## Install

Release tarball (no registry login):

```bash
npm install --global \
  https://github.com/braintied/kimi-router/releases/download/v1.0.2/braintied-kimi-router-1.0.2.tgz
```

GitHub Packages needs a classic PAT with `read:packages` even when the package
is public:

```bash
npm login --scope=@braintied --auth-type=legacy \
  --registry=https://npm.pkg.github.com
npm install --global @braintied/kimi-router@1.0.2
```

Then:

```bash
node "$(npm root -g)/@braintied/kimi-router/bin/install.mjs"
node "$(npm root -g)/@braintied/kimi-router/bin/install.mjs" --activate
kimi --doctor
```

From a git checkout of this package (Braintied operators):

```bash
npm run gate
node bin/install.mjs --activate
kimi --doctor
```

launchd unit: `ai.ora.kimi-key-router`. Program:
`~/.local/share/kimi-router/bin/kimi-router.mjs`. Health:
`http://127.0.0.1:8787/healthz`.

---

## kimi

```bash
kimi                 # Claude Code on routed K3
kimi --1m            # K3 1M where the membership allows it
kimi --status        # pool, last upstream sentence, next weekly reset
kimi --status-json   # full redacted diagnostics
kimi --prefer NAME   # temporary preference; failover stays on
kimi --auto          # drop preference
kimi --reload        # reread Keychain labels
kimi --reset         # clear every circuit (after Extra Usage is actually on)
kimi --restart       # drain + launchd restart
kimi --doctor        # launchd, Keychain source, health
kimi --logs          # last structured events
```

Anything else is passed to `claude`. A running Claude Code process keeps the
base URL it started with. Switch providers by starting a new process.

`--prefer` is not a pin. A cooling, 401, or capability-blocked preferred
account is skipped.

`--reset` is for a verified Extra Usage enable or a console top-up. Do not
poll it. Weekly 403 on every key with Extra Usage off will 403 again after
reset.

---

## Three Kimi meters, one 403

Kimi Code membership is **not** one balance.

| Meter | What it is | What the API says | What the router does |
|---|---|---|---|
| Rolling 5-hour | ~300–1200 requests / 5h | **429** `You've reached your usage limit for this period` | Cool that account for `Retry-After` or 5 hours; try the next key |
| Weekly billing cycle | 7-day membership quota | **403** `You've reached your usage limit for this billing cycle` | Cool until the next 7-day landing; try the next key |
| Extra Usage | USD wallet on that **same** Kimi Code membership | If enabled and funded, Kimi consumes it and **does not 403** | Nothing to switch; the request succeeds |
| Open Platform | `api.moonshot.ai` prepaid | 401 on a membership key | Not this router’s pool |

A Console card that still shows 5-hour remaining can sit next to weekly 100%.
The router is blocked on weekly in that case.

**$50 Extra Usage that still 403s** means the Extra Usage **toggle is off** on
that membership, or the $50 is Open Platform. Membership keys cannot read
Open Platform `GET /v1/users/me/balance` (401). There is no documented
membership usage API; `/coding/v1/usage` is 404. Console `/usage` is the
live meter.

---

## Weekly reset clock

Kimi does not send `Retry-After` or `X-RateLimit-Reset` on weekly 403.

Each membership has a phase clock from the Code Console, stored in
`~/.config/kimi-router/accounts.meta.json` as `weeklyResetEpoch`. Later
resets are that instant plus **N × 7 days**. A date in the past is not
dead. It is not `now + 7 days` from the 403.

On **2026-08-17** (Pacific), from the clocks recorded 2026-07-31:

| Account | Epoch (Pacific) | Landings | Next |
|---|---|---|---|
| hello@braintied.com | Fri Jul 31, 5:39 PM | Jul 31, Aug 7, Aug 14 | **Fri Aug 21, 5:39 PM PT** |
| g@braintied.com | Sat Aug 1, 4:26 PM | Aug 1, Aug 8, Aug 15 | **Sat Aug 22, 4:26 PM PT** |
| galenoakes@gmail.com | Sat Aug 1, 7:10 PM | Aug 1, Aug 8, Aug 15 | **Sat Aug 22, 7:10 PM PT** |
| nex@braintied.com | Sat Aug 1, 11:17 PM | Aug 1, Aug 8, Aug 15 | **Sat Aug 22, 11:17 PM PT** |

`kimi --status` prints `weekly reset:` in UTC. `nextWeeklyResetAt` in
`--status-json` is the same instant.

Math lives in `src/weekly-reset.mjs`. Tests in `weekly-reset.test.mjs` pin
2026-08-17 so Aug 1 + 7 stays Aug 8.

---

## Accounts

Secrets are macOS Keychain items, service `ai.ora.kimi-key-router`. The
account file is labels only:

```text
~/.kimi-key-accounts          # one alias per line
~/.config/kimi-router/accounts.meta.json   # email, owner, weekly epoch
```

Add a key without putting it in the shell:

```bash
security add-generic-password -U \
  -s ai.ora.kimi-key-router \
  -a team-primary \
  -w
```

`-w` last, no value. Then the same alias on its own line in
`~/.kimi-key-accounts`, then `kimi --reload`.

Do not use an email as the alias on a machine you will screenshot or share.
This Mac’s pool currently uses mailbox labels (`hello@`, `g@`, …) because
that is how the four seats were enrolled. Relabel before any public log:

```bash
kimi-router-relabel --dry-run --alias team-hello --alias team-g --alias team-galen --alias team-nex
```

`kimi-router-relabel --audit` fails if any Keychain account name still looks
like an email.

---

## Request path

```text
Claude Code / any Anthropic- or OpenAI-compatible client
    │
    ▼
127.0.0.1:8787/coding/…
    │  replace Authorization and x-api-key
    │  inspect JSON `model` only
    ▼
api.kimi.com   (membership)
```

Loopback only. Foreign `Host` / `Origin` → 403. No synthetic probe requests.
Recovery uses the next real client call. POST is not replayed after 5xx or
network failure unless `KIMI_RETRY_AMBIGUOUS_REQUESTS=1`.

On Fly, this process is a **sidecar on the agent machine**
(`apps/ora-server/kimi-router-sidecar.sh`), still bound to 127.0.0.1, with
`KIMI_MEMBERSHIP_KEY_1..4` projected into a tmpfs key file. It is not its
own Fly app: the package refuses non-loopback bind without
`KIMI_ROUTER_ALLOW_REMOTE=1`, and that flag is not sanctioned on Fly 6PN.

---

## Failure policy

| Kimi response | Scope | Action |
|---|---|---|
| 429 engine overloaded | provider | pass through; do not spray keys |
| 429 too many concurrent requests | account | short cool; next key |
| 429 usage limit for this period | account / 5-hour | `Retry-After` or 5h timer |
| 429 weekly / monthly | account | matching window |
| 403 billing-cycle | account / weekly | cool until `nextWeeklyResetAt`; next key |
| 403 access terminated | account | long, no probe |
| 403 URL security risk | request | pass through |
| unknown 403 | request | pass through; do not poison the pool |
| 401 model / 1M / tier | capability | cool that model on that account only |
| 401 invalid key | credential | credential circuit |
| 5xx / 408 / network | ambiguous | health only; no POST replay |

`Retry-After` wins over `X-RateLimit-Reset`. Weekly 403 on 2026-08-17 sent
neither header; the console epoch is what sets the landing.

---

## Status

`kimi --status` / `GET /status` (bearer from
`~/.config/kimi-router/management.header`):

- `available` / `cooling` / `retiring`
- `lastStatus`, `lastUpstreamMessage` (Kimi’s sentence, not our paraphrase)
- `quotaWindow.kind` + `source` (`console-7d`, `retry-after`, `policy`)
- `nextWeeklyResetAt`, `weeklyResetEpoch`
- `extraUsageHint` when **every** key is billing-cycle 403
- in-flight / accepted / completed / fails
- secret `source` (`keychain`), never the secret

Management: `/healthz`, `/status`, `/prefer`, `/reload`, `/reset`.

---

## Layout

| Path | Role |
|---|---|
| `bin/kimi-router.mjs` | process boundary; only place that reads `process.env` |
| `bin/kimi` | launcher |
| `bin/install.mjs` | copy + launchd |
| `src/router.mjs` | `startRouter(config)` |
| `src/weekly-reset.mjs` | 7-day landings |
| `src/config.mjs` | `resolveRouterConfig` |
| `src/secret-store.mjs` | Keychain / Secret Service |
| `src/provider-adapters.mjs` | membership vs Open Platform vs custom |
| `~/.local/share/kimi-router/` | installed copy (`bin/` + `src/`) |
| `~/.kimi-key-router-state.json` | redacted health; disposable |
| `~/.local/state/kimi-router/router.jsonl` | events |

---

## For agents

**This is the Kimi membership pool.** Do not start a second router, a second
Keychain service, or a per-repo failover script.

| Job | Use | Do not |
|---|---|---|
| Kimi Code membership failover | this package, `:8787` | vault `moonshot/api_key` |
| Open Platform (moonshot.ai) | vault `moonshot/api_key` | these four membership keys |
| Grok / SuperGrok OIDC | `xai-oauth-bridge` `:8792` + `ora-xai-bridge` | this package |
| Claude Max | official `claude` login / `:8790` tunnel | Keychain pooling |
| Fleet pins / inventory | `ora-model` in `ora-ai/platform` | a new `@braintied/model-routing` |
| Spend | `@braintied/cost` | a token counter here |

`docs/agents/model-routing.md` in ora-ai: **do not create
`@braintied/model-routing`**. Cortex pins are Ora policy. Extract export
helpers only when a second product needs the inventory without an ora-ai
checkout.

Never print Keychain `-w` output, `management.header`, membership keys, or
`accounts.meta.json` emails into a transcript you will publish. Status and
`--doctor` are the allowed surfaces.

On weekly 403 for all four seats (measured 2026-08-17): auto-switch already
walked the pool. Isolated `/coding/v1/chat/completions` on each key returned
the same billing-cycle sentence. `/models` was 200 (keys valid).
`api.moonshot.ai/v1/users/me/balance` was 401 (not Open Platform keys).
Do not “fix switching.” Enable Extra Usage on the membership that holds the
USD, or wait for `nextWeeklyResetAt`.

After Extra Usage is **on** in the Kimi Code Console for that mailbox:
`kimi --reset` once, then one real request.

Source of truth for this package is `braintied/stack` →
`packages/kimi-router`. `braintied/kimi-router` is the public snapshot +
Release tarball. Edit the stack tree; `scripts/sync-public.mjs --apply --push`
updates GitHub.

---

## What this package does not do

- Read Extra Usage dollars or 5-hour remaining. No membership usage API.
- Spend Open Platform balance.
- Pool Claude Max, Codex, or Grok OAuth.
- Bind a public address. `KIMI_ROUTER_ALLOW_REMOTE=1` is for a separately
  authenticated gateway only.
- Auto-deploy. `git push` does not ship this. Publish is
  `node scripts/stack.mjs publish --only kimi-router` from stack, then a
  GitHub Release on `braintied/kimi-router`.

---

## Configuration

[docs/CONFIGURATION.md](docs/CONFIGURATION.md). Environment is read only in
`bin/kimi-router.mjs`.

| Variable | Default |
|---|---|
| `KIMI_ACCOUNTS_FILE` | `~/.kimi-key-accounts` |
| `KIMI_ACCOUNTS_META_FILE` | `~/.config/kimi-router/accounts.meta.json` |
| `KIMI_KEYCHAIN_SERVICE` | `ai.ora.kimi-key-router` |
| `KIMI_PROVIDER_PROFILE` | `kimi-code-membership` |
| `KIMI_ROUTER_STATE` | `~/.kimi-key-router-state.json` |
| `HOST` / `PORT` | `127.0.0.1` / `8787` |
| `KIMI_MAX_INFLIGHT_PER_KEY` | `24` |
| `KIMI_COOLDOWN_5H_MS` | `18000000` |
| `KIMI_RECOVERY_PROBE_MAX_MS` | `300000` |

`KIMI_API_KEYS` is tests only and warns.

---

## Tests and release

```bash
npm run gate
npm run artifact:check
npm run release:build
```

`weekly-reset.test.mjs` is the 2026 landing table. `router.test.mjs` covers
failover, reset, and last-upstream-message. `router.v3.test.mjs` covers
unknown-403 safety and management auth.

Release tarball goes on
[GitHub Releases](https://github.com/braintied/kimi-router/releases).
Registry package is `@braintied/kimi-router` on `npm.pkg.github.com`.

## Manuals

- [CLI](docs/CLI.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Operations](docs/OPERATIONS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Providers](docs/PROVIDERS.md)
- [Error policy](docs/ERROR-POLICY.md)
- [Management auth](docs/MANAGEMENT-AUTH.md)
- [Migration](docs/MIGRATION.md)
- [Threat model](docs/THREAT-MODEL.md)
- [Release](docs/RELEASE.md)
