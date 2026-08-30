# Release

HanabiCode releases from the long-lived `hanabicode` branch in [Dey11/paseo](https://github.com/Dey11/paseo). [Fork distribution](fork-docs/distribution.md) owns the setup, release, installation, and recovery playbook.

All workspaces share one independent version. HanabiCode starts at `0.1.0` and uses `hanabicode-vX.Y.Z` or `hanabicode-vX.Y.Z-beta.N` tags. Upstream Paseo versions and `v*` tags do not set the HanabiCode version.

## Publication boundary

The HanabiCode workflow publishes only:

- ad-hoc-signed macOS DMG and ZIP artifacts for ARM64 and x64;
- one APK signed with the HanabiCode Android release key;
- one self-contained Ubuntu 22.04 ARM64 daemon archive with a bundled Node runtime;
- checksums, `LICENSE`, and `NOTICE` in a GitHub Release.

It does not publish `@getpaseo/*` npm packages, container images, EAS builds, store builds, Cloudflare services, relay services, or upstream GitHub releases.

## Release sequence

Start from a clean `hanabicode` branch containing the intended upstream merge and fork changes:

```bash
git switch hanabicode
git fetch origin upstream
git merge --ff-only origin/hanabicode
npm run release:check

# Pick one approved version transition.
npm run version:hanabicode:patch
# npm run version:hanabicode:minor
# npm run version:hanabicode:beta:patch

git show --stat --oneline HEAD
git tag --points-at HEAD
```

The version command updates every workspace, commits the result, and creates the prefixed tag. Review both before pushing. Pushing the branch and tag is the publication authorization boundary:

```bash
git push origin hanabicode
git push origin "$(git tag --points-at HEAD)"
```

The tag starts `.github/workflows/hanabicode-release.yml`. A manual dispatch with the same existing tag retries a failed draft; it does not create or move a tag.

Never reuse or force-move a release tag. Fix a failure on a new commit and cut a new version when the tagged source must change.
