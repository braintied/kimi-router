# CLI reference

## Launching Claude Code

```text
kimi [CLAUDE_ARGS...]
kimi --1m [CLAUDE_ARGS...]
```

The normal command launches `k3` with a 256K context budget. `--1m` launches
Claude Code with the special `k3[1m]` alias and a 1M budget; Kimi documents that
the bracketed alias is specific to Claude Code configuration and requires an
eligible membership tier. All remaining arguments pass unchanged to `claude`.

## Management commands

| Command | Result |
|---|---|
| `kimi --status` | Human-readable pool health, selection, quota timers, and load |
| `kimi --status-json` | Complete redacted status document |
| `kimi --prefer LABEL` | Temporary preference; automatic failover remains active |
| `kimi --auto` | Remove the preference and restore automatic selection |
| `kimi --reload` | Re-read labels and secrets without interrupting accepted streams |
| `kimi --restart` | Signal graceful drain and restart the launchd service |
| `kimi --doctor` | Check dependencies, service, auth, secret source, and pool health |
| `kimi --logs` | Tail the local structured log |
| `kimi --help` | Usage summary |

Management authentication is read from a mode-`0600` curl header file. The
bearer value is not placed in process arguments. `/healthz` remains unauthenticated
and exposes only readiness/draining booleans.

## Exit behavior

Management commands exit nonzero on missing dependencies, unavailable service,
authentication failure, or failed health checks. The interactive launcher uses
`exec`, so its exit code and signals are Claude Code's.

`--prefer` is not a pin. If the preferred account is cooling, rejected, over its
concurrency limit, or missing a requested capability, the router clears the
preference and uses the best eligible account.
