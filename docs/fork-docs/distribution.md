# HanabiCode distribution

`.github/workflows/hanabicode-release.yml` turns one existing `hanabicode-v*` tag into one GitHub Release. It builds macOS ARM64 and x64 installers, a signed Android APK, and a multi-architecture daemon image. The workflow creates a draft first and publishes it only after every required job succeeds.

## Identity

| Concern            | Value                                           |
| ------------------ | ----------------------------------------------- |
| Repository         | `Dey11/paseo`                                   |
| Release branch     | `hanabicode`                                    |
| Version line       | Independent `0.1.x` line                        |
| Tags               | `hanabicode-vX.Y.Z`, `hanabicode-vX.Y.Z-beta.N` |
| Production app ID  | `com.dey.hanabicode`                            |
| Development app ID | `com.dey.hanabicode.debug`                      |
| URL scheme         | `hanabicode`                                    |
| CLI                | `hanabicode`                                    |
| State              | `~/.hanabicode`                                 |
| Daemon listener    | `127.0.0.1:6769`                                |
| Daemon image       | `ghcr.io/dey11/hanabicode`                      |

The internal `@getpaseo/*` package namespace, `PASEO_*` environment prefix, protocol identifiers, and `.paseo` project metadata remain compatibility APIs. They are not publication targets.

## One-time GitHub setup

Create a protected `release` environment. Require reviewer approval if another person will ever hold release authority.

Generate one permanent Android release key on a trusted machine and keep two offline backups:

```bash
keytool -genkeypair \
  -keystore hanabicode-android-release.p12 \
  -storetype PKCS12 \
  -alias hanabicode \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000
```

Record the signing certificate fingerprint:

```bash
keytool -list -v -keystore hanabicode-android-release.p12 -alias hanabicode
```

Add these environment secrets without writing their values to the repository or shell history:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`
- `ANDROID_CERT_SHA256`

The workflow decodes the keystore only into the runner's temporary directory. It verifies the APK and the expected certificate fingerprint with `apksigner` before upload. Losing this key prevents a future APK from updating an installed HanabiCode app.

GitHub Actions also needs permission to create packages for the repository. The release job requests `packages: write` and uses the scoped `GITHUB_TOKEN`; no separate GHCR password belongs in repository secrets.

## Cut a release

Prepare and review the source locally:

```bash
git switch hanabicode
git fetch origin upstream
git merge --ff-only origin/hanabicode
npm run release:check

# Pick exactly one approved transition.
npm run version:hanabicode:patch
# npm run version:hanabicode:minor
# npm run version:hanabicode:beta:patch
# npm run version:hanabicode:beta:next
# npm run version:hanabicode:promote

git show --stat --oneline HEAD
git tag --points-at HEAD
```

Push only after the commit and tag are approved:

```bash
git push origin hanabicode
git push origin "$(git tag --points-at HEAD)"
```

The tag push starts the workflow. To retry jobs for an unchanged tag and draft:

```bash
gh workflow run hanabicode-release.yml \
  --repo Dey11/paseo \
  --ref hanabicode \
  -f tag="$(git tag --points-at HEAD)"
```

The workflow rejects tags outside the `hanabicode` branch and versions that do not match the tagged manifests. Never move or reuse a tag.

## Install and verify

### macOS

Download the DMG matching the Mac CPU and drag HanabiCode into Applications. The initial build is ad-hoc signed and not notarized, so open it with Finder's **Open** command or approve that exact app under **System Settings → Privacy & Security**.

Verify the signature:

```bash
codesign --verify --deep --strict --verbose=2 /Applications/HanabiCode.app
```

Gatekeeper assessment is expected to reject this unnotarized build. Test launch, updates, reconnect, terminals, agents, and port forwarding on both architectures before treating the release as accepted.

### Android

Install the APK from the GitHub Release. Confirm the certificate when Android SDK build tools are available:

```bash
apksigner verify --verbose --print-certs HanabiCode-v*-android.apk
```

Test connection setup, terminal and agent traffic, background/resume, reconnect, and an in-place upgrade from the previous APK.

### Daemon image

Pull the exact release version instead of `latest` for production-like use:

```bash
docker pull ghcr.io/dey11/hanabicode:0.1.0
```

Stable releases also move `latest`; betas never do. Follow [Docker](../docker.md) for state, password, mounts, and listener configuration.

## Deferred release work

- Apple Developer ID signing and notarization
- app stores, EAS, iOS, and F-Droid
- Windows and Linux desktop artifacts
- npm publication
- Cloudflare Tunnel activation

Cloudflare is a separate connectivity phase after the local, Tailscale, and release-artifact checks pass. See [Cloudflare Tunnel](cloudflare-tunnel.md).

## First-release gate

- Back up the Android signing key and configure all five protected secrets.
- Confirm HanabiCode and Paseo can run together without shared state, ports, app IDs, or updater state.
- Confirm every updater and source link targets `Dey11/paseo`.
- Confirm no tag-triggered workflow targets official npm, Expo, Cloudflare, relay, container, or GitHub resources.
- Confirm both macOS architectures install and the Android signature upgrades an earlier build.
- Confirm release assets include checksums, `LICENSE`, and `NOTICE`.
- Replace inherited logo assets or confirm their separate use rights before broad distribution.
