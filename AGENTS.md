# AGENTS.md

How a coding agent installs, diagnoses, and must not extend
`@braintied/kimi-router`. Humans start at [README.md](./README.md).
This file is the contract.

**1.0.2** · source of truth: `braintied/stack` → `packages/kimi-router`.
This GitHub repo is a snapshot. Edit the stack tree, then:

```bash
node packages/kimi-router/scripts/sync-public.mjs --apply --push
```

Skill on Braintied operator Macs: `model-routing`. CLI map: `ora-model`.

## Do this first

1. `kimi --doctor` and `kimi --status` (or `kimi --status-json`).
2. Read `lastUpstreamMessage`. Quote Kimi’s sentence. Do not paraphrase
   a 403 into “out of credits” or “needs a new key.”
3. If every key is billing-cycle 403, **switching already ran**. Isolated
   `/coding/v1/chat/completions` on each key will return the same
   sentence. `/models` returning 200 only proves the key is valid.
4. Do not create a second router, a second Keychain service, a per-repo
   failover script, or `@braintied/model-routing`.

## Keep this package separate

Kimi membership policy (weekly 403, Extra Usage toggle, Keychain, loopback
`:8787`) is not Grok OIDC (`:8792`), not Claude Max (`:8790`), not Codex,
not MiniMax/z.ai vault keys, and not Cortex pins.

`ora-model` already inventories all of them. That is the combine layer.
Folding the proxies into one package would mix four threat models and
four rate-limit languages in one process.

Full table: [README.md#keep-kimi-its-own-package](./README.md#keep-kimi-its-own-package).
Policy: `ora-ai/platform/docs/agents/model-routing.md`.

| Job | Use | Do not |
|---|---|---|
| Kimi Code membership failover | this package, `:8787` | vault `moonshot/api_key` |
| Open Platform (`api.moonshot.ai`) | vault `moonshot/api_key` | these membership keys |
| Grok / SuperGrok OIDC | `xai-oauth-bridge` `:8792` + `ora-xai-bridge` | this package |
| Claude Max | official `claude` login / `:8790` tunnel | Keychain pooling |
| Fleet pins / inventory | `ora-model` in `ora-ai/platform` | a new `@braintied/model-routing` |
| Spend | `@braintied/cost` | a token counter here |

## Secrets

Never print:

- Keychain `-w` output
- `KIMI_MEMBERSHIP_KEY_*`
- `~/.config/kimi-router/management.header`
- raw `accounts.meta.json` (it can hold mailbox names)
- a tarball path that includes a live `.env`

`--status`, `--doctor`, and redacted `--status-json` are the allowed
surfaces. Relabel mailbox Keychain aliases before a public log
(`kimi-router-relabel --audit`).

`KIMI_API_KEYS` is tests only.

## Install / upgrade on a Mac

```bash
# login-free
npm install --global \
  https://github.com/braintied/kimi-router/releases/download/v1.0.2/braintied-kimi-router-1.0.2.tgz

node "$(npm root -g)/@braintied/kimi-router/bin/install.mjs" --activate
kimi --doctor
```

GitHub Packages needs a classic PAT with `read:packages` even when the
package is public. Prefer the Release tarball.

`npm install -g` without `--activate` does not move the running launchd
copy. The live process is `~/.local/share/kimi-router/bin/kimi-router.mjs`.

## Diagnose “not switching”

1. `kimi --status`. If 0/N available and every row is billing-cycle 403
   with the same upstream sentence, failover already walked the pool.
2. Probe one key at a time against `https://api.kimi.com/coding/v1/models`
   (expect 200) and a tiny `/coding/v1/chat/completions` (expect 403 when
   weekly is exhausted). A 200 on `/models` is not remaining quota.
3. `GET https://api.moonshot.ai/v1/users/me/balance` with a membership key
   is 401. That $50 on Open Platform is a different product.
4. Extra Usage that still 403s: the Console toggle is off, or the USD is
   Open Platform. Operator action in the Kimi Code Console, then
   `kimi --reset` **once**, then one real request.
5. Do not poll `--reset`. Do not mint a fifth key to “fix” a weekly 403.

## Weekly math

`nextWeeklyResetAt(epoch, now)` is the first `epoch + N×7d` **strictly
after** `now`. A past `weeklyResetAt` is not dead and is not `now+7d`.

Pinned 2026-08-17: Aug 1 + 7 = Aug 8. Tests: `weekly-reset.test.mjs`.
Clocks come from the Code Console, not from the API (no reset header on
weekly 403).

## Fly

Sidecar on the agent machine, still `127.0.0.1`.
`apps/ora-server/kimi-router-sidecar.sh`. Not its own Fly app.
`KIMI_ROUTER_ALLOW_REMOTE=1` is not sanctioned on Fly 6PN.
`build-ora-config.mjs` ignores loopback base URLs when `FLY_APP_NAME` is
set, so a Mac `kimi-router` pin cannot poison the fleet.

## Publish

```bash
# from braintied/stack, clean tree
node scripts/stack.mjs publish --only kimi-router
node packages/kimi-router/scripts/sync-public.mjs --apply --push
# then cut GitHub Release vX.Y.Z on braintied/kimi-router with
# npm run release:build  artifacts (tgz + sha256 + provenance)
```

`git push` does not publish. Vercel is not in this path. Do not `vship`
this package.

## Tests that must stay green

```bash
npm run gate
npm run artifact:check
```

Mutation: a weekly-reset test that accepts `now+7d` for a past epoch is
wrong. `weekly-reset.test.mjs` already fails that shape.

## Out of scope

- Reading Extra Usage USD or 5-hour remaining
- Combining other vendor routers
- Writing membership keys into Cortex / vault as a second copy
- Binding a public address
- Deploying ora-agents / ora-ai-web as part of a router change
