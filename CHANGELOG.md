# Changelog

All notable changes are recorded here. This project follows Semantic
Versioning once the public API reaches `1.0.0`.

## 0.1.1 - 2026-07-19

- Add transactional macOS Keychain relabeling to replace personal account
  identifiers with opaque aliases without printing source metadata or secrets.
- Add deterministic relabel validation and atomic-file tests.
- Document GitHub Packages' mandatory classic-PAT authentication and provide a
  no-registry-login install path through the public release artifact.
- Correct package documentation formatting and include the relabel command in
  package, security, migration, CLI, operations, and release references.

## 0.1.0 - 2026-07-19

- Add explicit membership, Open Platform, and custom provider adapters.
- Add schema-v2 atomic state, live/stale writer locks, corruption quarantine,
  persisted provider health, and explicit quota-window metadata.
- Parse bounded structured error fields and rate-limit reset variants.
- Add deterministic fake-clock lifecycle and usable-capacity regression tests.
- Verify hot credential replacement preserves accepted proxy streams.
- Add configuration, CLI, troubleshooting, operations, threat, and release docs.

- Extract the tested Kimi Router v3 prototype into a standalone package.
- Add package, CI, security, artifact, and publication gates.
- Preserve the existing local deployment until migration acceptance checks pass.
- Suppress ambiguous POST replay after network, 408, and 5xx failures by default.
- Honor provider reset headers for exact quota cooldowns.
- Treat unknown 403 responses as request-scoped.
- Add installer-generated management bearer authentication and launcher support.
- Align Claude Code launcher defaults with Kimi K3 compatibility guidance.
- Persist quota health by stable account identity and isolate credential-rejection circuits.
- Add a tested cross-platform secret-store interface for macOS Keychain and Linux Secret Service.
- Add graceful activation, persistent file backups, health verification, and automatic service rollback.
- Add reproducible release tarballs with SHA-256 checksums and commit-bound provenance.
- Separate portable Ubuntu CI/publication from manually dispatched macOS validation.
