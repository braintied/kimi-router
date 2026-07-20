# Management authentication

The proxy path remains compatible with Claude Code authentication headers. The
management plane is separate: `/status`, `/prefer`, `/reload`, and
`/reset` require a bearer credential whenever management auth is configured.
`/healthz` remains an unauthenticated loopback liveness endpoint.

The macOS installer creates
`~/.config/kimi-router/management.header` with mode `0600`. Its contents are
a complete curl header, generated from 32 random bytes:

```text
Authorization: Bearer REDACTED
```

The `kimi` launcher calls `curl -H @management.header`, so the bearer value
does not appear in the process argument list. The router reads the same file,
normalizes the header, and compares supplied tokens in constant time.

Never commit, log, paste, or package this file. Rotate it by writing a newly
generated 32-byte-or-stronger bearer value to a temporary file, setting mode
`0600`, atomically replacing the old file, and gracefully restarting the
router. Existing Claude Code proxy sessions continue after the restart because
management auth is independent of upstream Kimi credentials.

`KIMI_MANAGEMENT_TOKEN` exists only for isolated tests. Environment variables
are visible to process inspection and are not the production secret backend.
