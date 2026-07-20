# Security policy

See [the threat model](docs/THREAT-MODEL.md) for assets, trust boundaries,
defenses, and residual risks.

## Reporting

Do not open a public issue containing credentials, account identifiers, prompt
content, router state, or logs. Report a suspected vulnerability privately to
the maintainers through GitHub's private vulnerability reporting for this
repository.

## Secret handling

The router must never write credential values to configuration, state, logs,
status responses, crash output, tests, fixtures, package artifacts, or version
control. macOS installations use generic-password items in Keychain. The label
file contains identifiers only and must remain permission-restricted.

`KIMI_API_KEYS` and the legacy plaintext key file are migration and isolated-test
paths. They are intentionally not the recommended production configuration.

## Network boundary

The management and proxy listener is loopback-only by default. Do not expose it
through a public tunnel, shared host, container port, reverse proxy, or LAN bind.
The current management API assumes the operating-system account is the trust
boundary.

## Supported versions

Security fixes are applied to the latest released version. Until the first
stable release, users should update to the newest `0.x` build.
