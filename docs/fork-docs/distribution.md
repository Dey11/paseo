# HanabiCode distribution

`.github/workflows/hanabicode-release.yml` turns one existing `hanabicode-v*` tag into one GitHub Release. It builds macOS ARM64 and x64 installers, a signed Android APK, and a self-contained Linux ARM64 daemon archive. The workflow creates a draft first and publishes it only after every required job succeeds.

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
| Daemon listener    | Tailscale address on port `6769`                |
| Default relay      | `relay.paseo.sh:443` over TLS                   |
| VPS daemon asset   | `HanabiCode-X.Y.Z-linux-arm64.tar.gz`           |

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

The release workflow needs repository contents write access to create and publish the draft release. It does not need package-registry permissions or an npm token.

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

### VPS daemon

Download the native archive and `SHA256SUMS` from the same release. Verify and extract it on the Ubuntu 22.04 ARM64 VPS:

```bash
sha256sum --check SHA256SUMS --ignore-missing
tar -xzf HanabiCode-0.1.0-linux-arm64.tar.gz
cd HanabiCode-0.1.0-linux-arm64
./install.sh --listen 100.101.102.103:6769 --working-directory /home/dev/projects
```

The archive includes Node and all daemon production dependencies. The installer stages the release under the user's home and writes a user systemd service without starting or restarting it. The service uses the official relay with TLS by default and keeps the Tailscale listener available for recovery. Follow [Native VPS daemon](native-daemon.md) for pairing, password setup, manual promotion, logs, upgrades, rollback, and future self-hosted relay configuration.

## Deferred release work

- Apple Developer ID signing and notarization
- app stores, EAS, iOS, and F-Droid
- Windows and Linux desktop artifacts
- npm publication
- x64 daemon archive
- self-hosted relay deployment
- Cloudflare Tunnel activation

Cloudflare Tunnel is a shelved alternative. The next connectivity phase is a fork-owned deployment of the production Paseo relay. See [Relay deployment](relay-options.md).

## First-release gate

- Back up the Android signing key and configure all five protected secrets.
- Confirm HanabiCode and Paseo can run together without shared state, ports, app IDs, or updater state.
- Confirm every updater and source link targets `Dey11/paseo`.
- Confirm no tag-triggered workflow deploys npm, Expo, Cloudflare, relay, container registry, or official GitHub resources. Using the hosted relay at runtime does not grant deployment authority.
- Confirm both macOS architectures install and the Android signature upgrades an earlier build.
- Confirm the Linux ARM64 archive installs under an isolated home, loads `node-pty`, and never restarts the daemon during installation.
- Confirm release assets include checksums, `LICENSE`, and `NOTICE`.
- Replace inherited logo assets or confirm their separate use rights before broad distribution.
