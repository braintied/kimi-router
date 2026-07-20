# Changelog

All notable changes are recorded here. This project follows Semantic
Versioning once the public API reaches `1.0.0`.

## 0.1.0 - Unreleased

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
