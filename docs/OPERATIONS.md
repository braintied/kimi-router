# Operations runbook

## Routine checks

```text
kimi --doctor
kimi --status
curl -fsS http://127.0.0.1:8787/healthz
```

Healthy means the service answers on loopback, management authentication works,
all production credentials come from the OS secret store, and at least one
compatible account is available or has a trustworthy scheduled recovery.

## Add or rotate a credential

1. Write the secret directly to macOS Keychain or Linux Secret Service without
   a command-line value.
2. Add its sanitized account label to the account file if it is new.
3. Run `kimi --reload`.
4. Confirm the credential count/source and account health with `--status`.

For replacement under the same label, accepted streams retain the old in-memory
credential until completion; new requests use the replacement. The old entry is
`retiring` and disappears when its in-flight count reaches zero.

## Deploy an update

1. Run `npm run gate` and `npm run artifact:check` in a clean checkout.
2. Build twice and compare the release tarballs byte-for-byte.
3. Install without activation; validate the copied files and a parallel
   candidate using a distinct port/state path.
4. Run `node install.mjs --activate` only after candidate health passes.
5. The installer signals the old service, allows up to 125 seconds for streams
   to drain, bootstraps the new plist, and waits for health.
6. If bootstrap/health fails, it restores router, provider adapter, secret-store
   adapter, launcher, and plist backups, then reloads the previous service.

## Incident: all accounts cooling

Do not repeatedly reset. Inspect each `quotaWindow.source`:

- `retry-after` and `x-ratelimit-reset` are provider evidence.
- `policy` is a conservative fallback.
- provider overload has a short provider circuit and is not a quota window.

If any account is `available`, routing should use it immediately. A status state
where an exhausted active account coexists with unused eligible capacity is a
regression and should be reported with redacted state fields and test steps.

## Incident: provider outage

The triggering request receives the upstream overload/error. During the provider
circuit, new traffic gets a local `503` with `Retry-After` and is not sprayed at
every account. Do not extend the circuit to five hours without an explicit Kimi
five-hour quota signal.

## Backup and recovery

Credentials are backed up only through the operator's OS secret-store policy.
The router never exports them. The state file is disposable redacted metadata;
corrupt copies are quarantined locally. Installer rollback files contain only
public program code and remain under the install directory.

## Uninstall

Unload the service, remove only the exact installed program/plist paths, and
retain the OS secret-store items unless the operator separately authorizes
credential deletion. State/log removal is optional and should be explicit.
