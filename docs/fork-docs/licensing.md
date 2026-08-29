# HanabiCode licensing

HanabiCode is a modified downstream of Paseo distributed under the repository's [Apache License 2.0](../../LICENSE). Keep the upstream copyright, license, and attribution notices when you redistribute source or installers.

This is practical project guidance, not legal advice. `LICENSE` is the controlling text.

## Release requirements

Every shared release must:

1. Include `LICENSE` and `NOTICE` with the app and daemon artifacts.
2. Identify HanabiCode as a modified downstream that is not endorsed by Paseo.
3. Preserve upstream and third-party notices in source and bundled dependencies.
4. Link the exact source tag or commit used for the build.
5. Use HanabiCode's own application IDs, executable names, updater repository, and publisher identity.

Apache License 2.0 does not require publishing private modifications or the source for every binary distribution. HanabiCode still publishes exact source links as a project policy so a release can be audited and rebuilt.

Do not publish passwords, provider tokens, signing private keys, Apple certificates, Firebase secrets, VPS configuration secrets, or generated credential files. A downstream builder supplies their own credentials and signing identity.

## Branding

The software license does not grant trademark rights. Describe HanabiCode as a fork of Paseo, keep required attribution, and do not present a HanabiCode installer as an official Paseo release. Replace inherited logos before broad distribution unless their separate rights permit reuse.

## Dependencies and services

Bundled dependencies retain their own licenses. Provider accounts and services such as Codex, Claude Code, GitHub, Apple, Google, Tailscale, and Cloudflare have separate terms. The Apache license does not transfer upstream service accounts or change provider quotas.

## Pre-release check

Before sharing a build, confirm:

- the source tag matches the built commit;
- `LICENSE` and `NOTICE` are included;
- the app's About screen links the exact source and license;
- upstream and third-party notices remain intact;
- the fork is visibly distinct from an official Paseo release;
- no credential or signing key is present in the source or release assets.
