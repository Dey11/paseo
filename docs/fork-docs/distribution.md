# HanabiCode releases

HanabiCode publishes one GitHub Release from one existing version tag. `.github/workflows/hanabicode-release.yml` builds every artifact from the exact tagged commit. EAS Build is not used.

## Identity

| Concern                            | Value                                 |
| ---------------------------------- | ------------------------------------- |
| Product                            | `HanabiCode`                          |
| Repository                         | `Dey11/hanabicode`                    |
| Desktop and Android application ID | `com.dey.hanabicode`                  |
| Development Android application ID | `com.dey.hanabicode.debug`            |
| URL scheme                         | `hanabicode`                          |
| Desktop executable and CLI         | `HanabiCode` and `hanabicode`         |
| Default state                      | `~/.hanabicode`                       |
| Default daemon listener            | `127.0.0.1:6769`                      |
| Updater                            | GitHub Releases in `Dey11/hanabicode` |

The internal `@getpaseo/*` package namespace, `PASEO_*` environment prefix, protocol identifiers, and `.paseo` project metadata remain compatibility APIs. They do not control the installed product identity.

## Artifacts

The manual **HanabiCode Release** workflow creates a draft first and publishes it only after all jobs pass:

- macOS ARM64 and x64 DMG, ZIP, blockmaps, and merged updater manifest;
- Windows x64 and ARM64 NSIS installers, ZIPs, blockmaps, and updater manifest;
- one signed universal Android APK;
- `HanabiCode-<tag>-SHA256SUMS.txt`.

macOS builds are ad-hoc signed and not notarized. Windows builds are unsigned. Those choices are suitable for testing on your own devices and produce first-launch operating-system warnings. Add Apple Developer ID signing and notarization later; do not pretend the current artifacts are normally signed.

Every app build receives `EXPO_PUBLIC_HANABICODE_SOURCE_COMMIT` from the tag. Settings → About links to that exact source tree and the AGPL license.

## One-time GitHub setup

Create a protected GitHub environment named `release`:

```bash
gh api --method PUT repos/Dey11/hanabicode/environments/release
```

Generate the Android release key on a trusted machine and keep two offline backups:

```bash
keytool -genkeypair -v \
  -storetype PKCS12 \
  -keystore hanabicode-android-release.p12 \
  -alias hanabicode-release \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

Record its SHA-256 certificate fingerprint:

```bash
keytool -list -v \
  -keystore hanabicode-android-release.p12 \
  -alias hanabicode-release
```

Set all five secrets on the `release` environment. The workflow accepts a fingerprint with or without colons.

```bash
base64 < hanabicode-android-release.p12 | tr -d '\n' | \
  gh secret set ANDROID_KEYSTORE_BASE64 --repo Dey11/hanabicode --env release

gh secret set ANDROID_KEYSTORE_PASSWORD --repo Dey11/hanabicode --env release
gh secret set ANDROID_KEY_ALIAS --repo Dey11/hanabicode --env release
gh secret set ANDROID_KEY_PASSWORD --repo Dey11/hanabicode --env release
gh secret set ANDROID_CERT_SHA256 --repo Dey11/hanabicode --env release
```

The last four commands prompt without echoing the value. Never put the keystore, passwords, certificates, or GitHub secrets in `.env`, Actions YAML, release assets, or Git.

The Android config plugin writes only Gradle property references. GitHub decodes the keystore into the runner's temporary directory and injects the four signing properties for that job. `apksigner` verifies both the APK and its expected public certificate before upload.

## Cut a release

Start from a clean, reviewed branch. The version command updates every workspace, creates a release commit, and tags it.

```bash
git switch main
git pull --ff-only

npm run release:check

# Pick exactly one.
npm run version:all:patch
# npm run version:all:minor

git show --stat --oneline HEAD
git tag --points-at HEAD
git push origin main
git push origin "$(git tag --points-at HEAD)"
```

Dispatch the manual workflow with that existing tag:

```bash
gh workflow run hanabicode-release.yml \
  --repo Dey11/hanabicode \
  -f tag="$(git tag --points-at HEAD)"

gh run watch --repo Dey11/hanabicode
```

Do not move or reuse a tag. Fix a failed release in a new commit and cut a new version. The workflow leaves a draft when any platform fails, so a partial release is never presented as complete.

Root scripts that publish the upstream `@getpaseo/*` npm namespace are intentionally unavailable in HanabiCode. A GitHub installer release does not require npm publication.

## Install and verify

### macOS

Download the DMG matching the Mac CPU and drag HanabiCode into Applications. Because this first release is not notarized, right-click HanabiCode and choose **Open**. If macOS still blocks it, use **System Settings → Privacy & Security → Open Anyway** for that exact app.

Verify the ad-hoc signature:

```bash
codesign --verify --deep --strict --verbose=2 /Applications/HanabiCode.app
```

Gatekeeper assessment is expected to reject an unnotarized build. After Apple signing is added, `spctl --assess --type execute --verbose=4 /Applications/HanabiCode.app` must pass on a clean Mac.

Launch HanabiCode from Finder. It owns its own bundle ID, user-data directory, `~/.hanabicode` daemon home, port `6769`, scheme, and single-instance lock, so it can run beside official Paseo. Pair it with the HanabiCode daemon and test agent control, terminal traffic, port forwarding, reconnect, app restart, and installation of the next HanabiCode version.

### Windows

Install the EXE matching the machine architecture. Windows will show **Unknown publisher** and may require **More info → Run anyway**. Confirm Start menu launch, the bundled `hanabicode` CLI, pairing, port forwarding, reconnect, and upgrade to the next version without losing state.

### Android

Allow installation from the browser or file manager used to download the APK, then install it. Verify the downloaded certificate when Android SDK build tools are available:

```bash
apksigner verify --verbose --print-certs HanabiCode-v*-android.apk
```

Confirm the printed SHA-256 fingerprint matches the backed-up release key. Test pairing, terminal traffic, reconnect, background/resume, and installing the next signed APK over the first without uninstalling. Losing the signing key prevents future APKs from updating existing installs.

## Apple signing later

Join the Apple Developer Program, create a **Developer ID Application** certificate, export the certificate and private key as a password-protected PKCS#12 file, and create notarization credentials. Store them only in the protected `release` environment. Then update the macOS job to require signing, hardened runtime, and notarization, and remove the release warning only after both architectures pass installation checks on clean Macs.

The likely secrets are `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Follow the current Electron Builder and Apple notarization documentation when implementing this because their credential flows change.

## Windows signing later

Use a HanabiCode-owned Authenticode certificate or a managed Windows signing service. Keep its credentials in the protected environment and make the workflow fail if signing is expected but absent. A valid signature identifies the publisher; SmartScreen reputation may still take time to build.

## Local source build

Use the repository's normal prerequisites and commands:

```bash
npm ci
npm run build:server
npm run build:app-deps
```

Desktop packaging is platform-native: build macOS artifacts on macOS and Windows artifacts on Windows. Android needs Java 21 and the Android SDK. GitHub Actions is the supported cross-platform release builder.

Use `.env.example` and `packages/server/.env.example` only as templates for HanabiCode runtime configuration. The inherited `PASEO_*` prefix is deliberate. Do not commit a populated `.env`.

## Release gate

Before publishing the first release:

- Replace upstream Paseo logo/icon assets or obtain permission to use them. The release pipeline deliberately keeps the existing assets until HanabiCode has its own artwork; the AGPL copyright license does not grant trademark rights.
- Back up the Android signing key and configure all five protected secrets.
- Confirm HanabiCode and official Paseo run together without shared state or ports.
- Confirm updater URLs and release notes point only at `Dey11/hanabicode`.
- Confirm no tag-triggered workflow deploys to official Paseo, Expo, Cloudflare, npm, or release targets.
- Confirm macOS and Windows warnings match the documented unsigned policy.
- Confirm Android signature verification and upgrade continuity.
- Confirm About exposes the exact source, license, fork notice, app version, and daemon version.
- Confirm release assets include checksums, `LICENSE`, and `NOTICE` through the packaged applications.

## EAS fallback

EAS is not part of the HanabiCode release path. If the direct Gradle workflow becomes too expensive to maintain, create a new fork-owned Expo account and project, restore a fork-owned `eas.json`, and use new credentials. Never restore the official Expo owner, project ID, update channel, or store credentials. See [Android EAS fallback](android-eas-fallback.md).
