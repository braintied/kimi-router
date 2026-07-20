# Release procedure

## Preconditions

- clean tracked worktree at an intentional commit;
- Node 20 and 24 portable validation;
- macOS Keychain helper validation on a compatible Apple toolchain;
- no secrets, personal account labels, tokens, or Keychain exports;
- owner-approved license and registry visibility;
- authenticated package publisher with `write:packages` (or registry-equivalent)
  permission.

## Gates

```text
npm run gate
npm run artifact:check
xcrun swiftc -typecheck keychain-write.swift
```

`artifact:check` packs the exact npm payload and inspects paths and content.
`release:build` refuses dirty source, derives `SOURCE_DATE_EPOCH` from Git, and
writes the `.tgz`, `.sha256`, and `.provenance.json` files under `releases/`.

Build twice into separate output directories and require byte equality before
tagging. Install the exact tarball into an empty prefix, run its packaged gates,
and execute `kimi-claude --help`.

## Publish

The GitHub workflow publishes only after portable gates, artifact inspection,
and reproducible release construction. Never weaken those gates to work around a
runner, billing, permissions, or registry outage. Record the exact control-plane
error and publish later from the same verified commit.

## Provenance verification

Verify that:

- provenance commit equals the tagged commit;
- `clean` is `true`;
- the tarball SHA-256 equals the checksum file and provenance value;
- the manifest contains only documented package files;
- a second build has the same digest;
- the public release attachment digest matches the registry download.

## Rollback

Package publication is immutable. Deprecate a bad version and release a higher
fixed version; never replace a tarball under the same version. Local activation
rollback is handled by the installer and must be health-verified after recovery.
