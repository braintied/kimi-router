# Migration from the v3 prototype

The existing launchd service remains the rollback target until the package has
passed local acceptance checks.

1. Run the package tests and artifact inspection without activating it.
2. Compare the installed router and launcher checksums with the known baseline.
3. Keep credentials in Keychain; migrate only labels and redacted state.
4. Generate and permission-check the management bearer header without printing it.
5. Start the candidate router on a parallel loopback port with isolated state.
6. Exercise health, classification, selection, recovery, and streaming tests.
7. Persist rollback copies of the installed router and launcher.
8. Gracefully drain the existing service before activating the candidate.
9. Require the candidate to pass loopback health checks; automatically restore the previous files and plist if it does not.
10. Verify existing proxy-launched sessions, new sessions, status, and rollback.

Account labels are stable quota identities; credential hashes own rejection
circuits. Hot replacement keeps an accepted old stream alive while new requests
use the replacement. Unversioned health files migrate from schema v1 to v2;
invalid JSON is quarantined. Never migrate Keychain material, lock files, or raw
logs.

Terminals started with the stable local proxy can receive credential changes
without restarting. Terminals configured directly for Kimi, or started before
the proxy variables were applied, must be relaunched. Changing provider or model
family requires a new Claude Code process.
