# Changelog

## 1.0.2

### Patch Changes

- `kimi --reset` is a launcher command. Status keeps Kimi's own 403 sentence
  and names Extra Usage when every membership key is billing-cycle 403.
- Weekly reset walks the console epoch forward 7 days at a time (Aug 1, then
  Aug 8, 15, 22). A past date is not dead and is not now+7d.

## 1.0.1

### Patch Changes

- Publish source already on main that the registry never received. public surface identical; internal change only.

## 1.0.0

### Major Changes

- 7bb2519: Split the package into a `src/` library and a `bin/` process boundary, so the
  environment is read in exactly one place.

  Every module shipped from the package root read `process.env` wherever it
  happened to need a value: `router.mjs` alone resolved 30-odd variables at module
  scope, spread across the file, interleaved with the request path. That is an
  undeclared input surface. It works on the machine that happens to have the
  variables exported and fails silently anywhere else, and it is why the
  third-party-safety audit reported 24 `no-direct-env` findings against this
  package — the largest count in the repo after `@braintied/research`.

  `bin/kimi-router.mjs` now reads the environment and the home directory, hands
  both to `resolveRouterConfig` (`src/config.mjs`), and passes the resulting frozen
  record to `startRouter`. Every default lives in that one resolver; `src/router.mjs`
  treats each field as required and never re-derives one, so a value that cannot be
  resolved fails at startup rather than turning into surprising behavior mid-request.
  `bin/relabel-accounts.mjs` and `bin/migrate-keychain.mjs` do the same for their
  CLIs, and `resolveProviderAdapter` no longer defaults its `env` argument to the
  process.

  Runtime behavior is unchanged: the same variables, the same defaults, the same
  warnings on `KIMI_API_KEYS` and `KIMI_MANAGEMENT_TOKEN`. The one difference is
  that the three startup failures which previously printed their own prefix
  (invalid `PORT`, invalid provider configuration, `KIMI_TEST_CLOCK_FILE` outside
  `NODE_ENV=test`) now share one `Invalid router configuration:` prefix, because
  there is now one place that can fail.

  Breaking, hence major:

  - Module paths moved. `router.mjs`, `provider-adapters.mjs`, `secret-store.mjs`
    and `relabel-accounts.mjs` are now under `src/`; `install.mjs`,
    `migrate-keychain.mjs` and the `kimi` launcher are under `bin/`. The `bin`
    entries in the manifest keep their names, so `kimi`, `kimi-router` and the rest
    are unaffected, but any deep import of a root module path must be updated.
  - `src/router.mjs` no longer starts a server on import. It exports
    `startRouter(config)`; importing it does nothing until called.
  - `run(options, env)` in `src/relabel-accounts.mjs` is now
    `run(options, { accountsFile, service })`. The caller resolves the target
    rather than passing an environment for the library to interpret.
  - The installer copies a tree (`bin/` plus `src/`) into
    `~/.local/share/kimi-router/` instead of three flat files, and the generated
    launchd plist points at `bin/kimi-router.mjs`. An existing service keeps
    running its already-installed copy; the new layout applies on the next
    `bin/install.mjs --activate`.

  `config.test.mjs` pins both halves of the boundary: that nothing under `src/`
  reads ambient state, and that every default resolves to the value the router
  previously read inline.

## 0.1.4

### Patch Changes

- Make three packages publishable again.

  `kimi-router/install.mjs` could not be parsed at all. The launchd plist is built
  from a template literal, and an XML comment inside it quoted `supervisor audit`
  and `ps` in backticks, which closed the string and left the prose to be read as
  code. The publish gate caught it as `SyntaxError: Unexpected identifier
'supervisor'`. The quotes are now single, so the comment survives the template.
  Anyone who ran the installer between that comment landing and now got the same
  parse error, because the file was never valid JavaScript.

  `research` and `onboarding-react` both build content that differs from what is
  already on the registry under their current version numbers, so the publish gate
  refuses them: a version that already exists must be byte-identical or the
  mapping from version to commit is a lie. Neither needs a code change, only a
  number that has not been used yet.

## 0.1.3

### Patch Changes

- d430d70: Ship a Braintied proprietary LICENSE and correct the license field.

  Sixteen of these packages declared `"license": "MIT"` and the repository
  contained no LICENSE file at all, while the two highest-value packages were the
  only ones marked UNLICENSED. MIT permits sublicensing and redistribution and
  survives termination of any surrounding agreement, so an MIT declaration would
  have given any recipient a perpetual right to the code regardless of contract.

  All eighteen now declare UNLICENSED and ship the same proprietary LICENSE file.
  No runtime behaviour changes.

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
