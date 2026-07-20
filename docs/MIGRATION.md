# Migration from the v3 prototype

The existing launchd service remains the rollback target until the package has
passed local acceptance checks.

1. Run the package tests and artifact inspection without activating it.
2. Compare the installed router and launcher checksums with the known baseline.
3. Keep credentials in Keychain; migrate only labels and redacted state.
4. Generate and permission-check the management bearer header without printing it.
5. Start the candidate router on a parallel loopback port with isolated state.
6. Exercise health, classification, selection, recovery, and streaming tests.
7. Drain the existing service before activating the candidate.
8. Verify existing proxy-launched sessions, new sessions, status, and rollback.

Terminals started with the stable local proxy can receive credential changes
without restarting. Terminals configured directly for Kimi, or started before
the proxy variables were applied, must be relaunched. Changing provider or model
family requires a new Claude Code process.
