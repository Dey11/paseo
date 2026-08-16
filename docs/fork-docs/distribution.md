# Fork distribution

The target is one public GitHub Release in `Dey11/paseo` containing signed macOS builds, Windows installers, and a signed Android APK. GitHub Actions builds each platform from the same source tag. EAS Build is not required.

Do not create a `v*` tag yet. The current checkout can build installers, but its production identity still points at official Paseo and a `v*` tag starts unrelated upstream publication workflows.

## Target artifacts

| Artifact                  | Runner           | Builder                   | Required account                                       |
| ------------------------- | ---------------- | ------------------------- | ------------------------------------------------------ |
| macOS ARM64 DMG and ZIP   | `macos-14`       | Electron Builder          | Apple Developer Program for normal Gatekeeper behavior |
| macOS x64 DMG and ZIP     | `macos-15-intel` | Electron Builder          | Same Apple account and certificate                     |
| Windows x64 EXE and ZIP   | `windows-latest` | Electron Builder and NSIS | None for unsigned builds; signing is recommended       |
| Windows ARM64 EXE and ZIP | `windows-latest` | Electron Builder and NSIS | Same as x64                                            |
| Android universal APK     | `ubuntu-latest`  | Expo Prebuild and Gradle  | None beyond the fork-owned signing key                 |

Expo remains the React Native framework and native-project generator. The Android job runs `expo prebuild` and Gradle on GitHub's runner instead of sending the build to EAS. Use [the EAS fallback](android-eas-fallback.md) only if maintaining the direct Gradle job becomes a burden.

## Proposed fork identity

Finalize these values before making release changes. Changing an application ID or signing identity later breaks update continuity.

| Concern                              | Fork value                |
| ------------------------------------ | ------------------------- |
| Product name                         | `PaseoDev`                |
| GitHub repository                    | `Dey11/paseo`             |
| Desktop application ID               | `com.dey.paseodev`        |
| Android application ID               | `com.dey.paseodev`        |
| URL scheme                           | `paseodev`                |
| Desktop executable and CLI name      | `PaseoDev` and `paseodev` |
| Electron user-data directory         | Derived from `PaseoDev`   |
| Embedded local daemon home           | `~/.paseodev`             |
| Embedded local daemon listen address | `127.0.0.1:6769`          |
| Updater repository                   | `Dey11/paseo`             |

The VPS daemon can keep using `/home/dev/.paseo-port-forwarding` and `127.0.0.1:6768`; those are deployment values, not client package identity. The official app remains on `~/.paseo` and port `6767`.

## Current readiness

| Area             | Current state                                                | Release work                                                                                         |
| ---------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Desktop builders | macOS ARM64/x64, Windows x64/ARM64, and Linux x64 jobs exist | Replace official identity and make the release draft-first                                           |
| Desktop signing  | Workflow accepts Apple secrets                               | Create a fork-owned Developer ID certificate and secrets                                             |
| Windows signing  | Builds are unsigned                                          | Accept warnings for private testing or add a signing service                                         |
| Android          | GitHub workflow delegates to EAS                             | Replace it with Prebuild plus Gradle and fork-owned signing                                          |
| Tag safety       | `v*` triggers several upstream workflows                     | Remove or guard every unrelated tag trigger                                                          |
| Updates          | Electron Builder points at `getpaseo/paseo`                  | Point manifests and the updater at `Dey11/paseo`                                                     |
| Fork notice      | Installed app still presents upstream source/community links | Add the source, license, modified-fork notice, and versions required by [licensing.md](licensing.md) |

## Phase 1: isolate release automation

A normal `v*` tag currently starts more than the installer workflows:

- `.github/workflows/desktop-release.yml` builds desktop installers;
- `.github/workflows/android-apk-release.yml` starts an EAS build;
- `.github/workflows/deploy-app.yml` deploys the web app to the upstream Cloudflare account shape;
- `.github/workflows/docker.yml` publishes a container on tag pushes;
- `.github/workflows/release-notes-sync.yml` can create or mutate the release;
- publishing the release can start `.github/workflows/deploy-website.yml`.

Make release publishing one owned workflow before pushing a tag:

1. Remove `v*` tag triggers from web, website, Docker, relay, npm, store, and upstream release-note workflows. Keep them manual or delete them from the fork.
2. Keep CI on branches and pull requests.
3. Create one `fork-release.yml` orchestrator triggered by `workflow_dispatch` and, after two successful manual releases, by `v*` tags.
4. Have the orchestrator create one draft release, then run desktop and Android jobs against the exact tag.
5. Make every uploader use `${{ github.repository }}` and the resolved release tag.
6. Publish the draft only after every required job succeeds. A failed job must leave a draft rather than a partial public release.
7. Put signing secrets in a protected GitHub `release` environment. Require approval for the environment if other people can push to the repository.

Do not use `npm run release:patch`, `release:minor`, `release:major`, or their beta variants. Those scripts publish the official `@getpaseo/*` workspace packages before pushing a tag. Installer releases do not need npm publication.

The first two releases should be manual. Run the desktop workflow with `publish=false` when checking packaging without creating release assets.

## Phase 2: make PaseoDev a separate desktop app

Update the product identity in all code that derives paths or validates packaged output. A command-line Electron Builder override is not sufficient.

### Packaging and updater

Update `packages/desktop/electron-builder.yml`:

- `appId`, `productName`, and `executableName`;
- protocol name and scheme;
- GitHub publish owner and repository;
- macOS, Linux, and Windows artifact names;
- Linux maintainer and vendor;
- fork-owned icons;

Update `packages/desktop/package.json` and the root `package.json` repository, homepage, author, and description metadata. Internal package names such as `@getpaseo/client` may remain until a separate package-namespace migration; they are bundled workspace dependencies, not the installed application's identity.

### Runtime identity and coexistence

Update `packages/desktop/src/main.ts` so packaged builds use `PaseoDev` and `paseodev`. Keep the Electron Builder protocol scheme and the runtime scheme identical.

Set fork defaults before the daemon manager starts:

- set `PASEO_HOME=~/.paseodev` only when the user has not supplied `PASEO_HOME`;
- set `PASEO_LISTEN=127.0.0.1:6769` only when the user has not supplied `PASEO_LISTEN`;
- keep explicit environment overrides working for development and diagnostics.

`app.setName("PaseoDev")` gives the packaged app a separate default Electron `userData` directory and single-instance lock. The fork-specific daemon home and port keep its embedded daemon, PID file, pairing identity, workspaces, and logs separate from official Paseo.

Rename the packaged CLI wrappers and their hardcoded executable paths:

- `packages/desktop/bin/paseo` and `packages/desktop/bin/paseo.cmd`;
- `packages/desktop/scripts/after-pack.js` and `after-sign.js`;
- `packages/desktop/e2e/packaged-app-smoke.js`;
- the desktop assertions in `.github/workflows/nix.yml`.

Search for remaining operational identity before release:

```bash
rg -n 'getpaseo/paseo|sh\.paseo|paseo://|relay\.paseo\.sh|app\.paseo\.sh|Paseo' \
  packages/desktop packages/app packages/server .github docs/fork-docs
```

Not every internal type or translated sentence must be renamed. Replace values that control bundle identity, storage, executable paths, deep links, update destinations, source links, or public branding. Review each hosted-service URL separately; do not replace protocol-compatible defaults blindly.

### macOS signing and notarization

For direct distribution outside the Mac App Store, join the Apple Developer Program and create a `Developer ID Application` certificate for the fork owner. Export the certificate and private key from Keychain Access as a password-protected `.p12` file.

Add these repository or `release` environment secrets:

| Secret                       | Value                               |
| ---------------------------- | ----------------------------------- |
| `APPLE_CERTIFICATE`          | Base64-encoded `.p12`               |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` password                     |
| `APPLE_ID`                   | Apple account used for notarization |
| `APPLE_PASSWORD`             | App-specific Apple password         |
| `APPLE_TEAM_ID`              | Apple Developer team ID             |

The current desktop workflow maps these to Electron Builder's `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_APP_SPECIFIC_PASSWORD`, and related variables. Keep hardened runtime enabled. Add `-c.forceCodeSigning=true` to the macOS release job after the secrets work so a missing identity fails that job without forcing the deliberately unsigned Windows build to fail. Verify the entitlements and every nested helper and framework, let Electron Builder notarize the app, and assess the downloaded DMG and the app extracted from the ZIP on another Mac.

Apple documents Developer ID and notarization for software distributed outside the App Store: <https://developer.apple.com/support/developer-id/>. Electron Builder's CI variables are documented at <https://www.electron.build/docs/features/code-signing/>.

An unsigned or ad-hoc signed build is acceptable only for development. Gatekeeper requires a manual override and ad-hoc signing mistakes can reproduce the Team ID mismatch seen during the manual PaseoDev experiment.

### Windows signing

GitHub can produce unsigned NSIS installers immediately. Windows will identify them as an unknown publisher and SmartScreen may require **More info → Run anyway**. This is acceptable for your own test machines.

For a normal public installation flow, use a fork-owned Authenticode certificate or Microsoft's Artifact Signing service and expose its credentials only to the protected release environment. Configure Electron Builder to fail the release if signing was expected but did not occur. Signing does not guarantee that a brand-new binary avoids every SmartScreen warning; reputation also affects the decision.

Microsoft's current SmartScreen guidance is at <https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation>. Electron Builder's Windows signing options are at <https://www.electron.build/docs/features/code-signing/code-signing-win/>.

## Phase 3: build Android without EAS

EAS is optional. GitHub's Ubuntu runner can generate, compile, and sign the APK.

### Android identity

Update `packages/app/app.config.js`:

- production name to `PaseoDev`;
- production package ID to `com.dey.paseodev`;
- slug and scheme to fork values;
- icons and splash assets to fork-owned art;
- remove `owner: "getpaseo"`;
- remove the official EAS project ID unless the [EAS fallback](android-eas-fallback.md) is configured with a fork-owned project;
- leave Google service files absent until a fork-owned Firebase project is intentionally added.

Push notifications, Firebase, EAS Update, and Play Store submission are separate features. Pairing, relay connections, terminals, and a directly downloaded APK do not require EAS. Without fork-owned notification credentials, push delivery should be treated as unavailable and tested as such.

### Create and preserve the signing key

Android requires every installable APK to be signed. Create one release key on a trusted machine:

```bash
keytool -genkeypair -v \
  -storetype PKCS12 \
  -keystore paseodev-android-release.p12 \
  -alias paseodev-release \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

Back up the keystore and passwords in two secure places. The Android package ID and signing certificate together define update continuity; losing the key prevents a later GitHub APK from updating the installed app.

Add these secrets:

| Secret                      | Value                          |
| --------------------------- | ------------------------------ |
| `ANDROID_KEYSTORE_BASE64`   | Base64-encoded PKCS12 keystore |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password              |
| `ANDROID_KEY_ALIAS`         | `paseodev-release`             |
| `ANDROID_KEY_PASSWORD`      | Key password                   |

With GitHub CLI authenticated to `Dey11/paseo`:

```bash
base64 < paseodev-android-release.p12 | tr -d '\n' | \
  gh secret set ANDROID_KEYSTORE_BASE64 --repo Dey11/paseo
gh secret set ANDROID_KEYSTORE_PASSWORD --repo Dey11/paseo
gh secret set ANDROID_KEY_ALIAS --repo Dey11/paseo
gh secret set ANDROID_KEY_PASSWORD --repo Dey11/paseo
```

The last three commands prompt for the value. Record the public SHA-256 certificate fingerprint:

```bash
keytool -list -v \
  -keystore paseodev-android-release.p12 \
  -alias paseodev-release
```

Android's signing and update model is documented at <https://developer.android.com/studio/publish/app-signing>.

### Generate signing configuration during Prebuild

`packages/app/android` is generated and ignored, so release signing cannot depend on a hand-edited `build.gradle`. Add a fork-owned Expo config plugin that makes the generated Android release build read these Gradle properties:

- `PASEODEV_UPLOAD_STORE_FILE`;
- `PASEODEV_UPLOAD_STORE_PASSWORD`;
- `PASEODEV_UPLOAD_KEY_ALIAS`;
- `PASEODEV_UPLOAD_KEY_PASSWORD`.

The plugin writes only property references and the `signingConfigs.release` wiring. It must not write secret values. The workflow decodes the keystore to `$RUNNER_TEMP` and supplies the four values through runner-local `~/.gradle/gradle.properties` or `ORG_GRADLE_PROJECT_*` environment variables. Ensure logs never print the properties.

### Replace the EAS workflow

Replace `.github/workflows/android-apk-release.yml` with an Ubuntu job that:

1. checks out the exact release tag with full history;
2. sets up Node 22, Java 21, and the Android SDK;
3. installs the lockfile with `npm ci`;
4. runs `npm run build:app-deps`;
5. runs `APP_VARIANT=production npx expo prebuild --platform android --clean --non-interactive` from `packages/app`;
6. decodes the keystore into `$RUNNER_TEMP` and supplies signing properties;
7. runs `./gradlew :app:assembleRelease --no-daemon --max-workers=1 -Dorg.gradle.parallel=false` from `packages/app/android`;
8. verifies the APK with `apksigner verify --verbose --print-certs` and compares the SHA-256 fingerprint with the recorded certificate;
9. renames the file to `PaseoDev-<version>-android.apk`;
10. uploads it as a workflow artifact and to the same draft GitHub Release as the desktop jobs.

The repository's [source-only Android path](../android.md#f-droid--source-only-android-builds) already proves that Prebuild and Gradle can compile the app. The release job should use the normal production profile unless you intentionally want the F-Droid feature reductions. Expo's local build overview is at <https://docs.expo.dev/guides/local-app-overview/>.

Build an AAB with `:app:bundleRelease` only when publishing to Google Play. The direct-download GitHub artifact is the APK.

## Phase 4: make releases atomic and reproducible

The release workflow should use this sequence:

1. Validate that the tag version matches the repository package versions.
2. Create a draft GitHub Release named `PaseoDev <tag>`.
3. Build macOS, Windows, and Android in parallel from that tag.
4. Run the existing packaged desktop smoke checks and Android signature verification.
5. Upload installers, Electron update manifests, and SHA-256 checksums.
6. Add release notes that identify the modified fork and link the exact source tag, `LICENSE`, and build workflow.
7. Confirm the expected artifact set in a final job.
8. Publish the draft only if all required jobs succeeded.

Keep the GitHub workflow token at `contents: read` by default and grant `contents: write` only to jobs that create or upload the release. Pin third-party actions to reviewed versions or commit SHAs before treating signing secrets as production credentials.

## Version and release commands

After workflow isolation, identity changes, signing, and manual artifact tests are complete:

```bash
git switch main
git pull --ff-only

# Choose patch or minor. This updates every workspace, commits, and creates v<version>.
npm run version:all:minor

git show --stat --oneline HEAD
git tag --points-at HEAD
git push origin main
git push origin "$(git tag --points-at HEAD)"
```

For the first release, keep the tag trigger disabled and dispatch the workflow manually against the existing tag. Enable automatic `v*` releases only after the manual path works twice.

Never move or reuse a published tag. If a build is wrong, fix it and cut a new version. Keep package versions, Android `versionCode`, desktop updater manifests, and the Git tag monotonic.

## First-release acceptance test

GitHub producing a file proves packaging, not installation.

### macOS

1. Download the ARM64 DMG from the GitHub Release on the M4 Mac.
2. Drag `PaseoDev.app` into Applications and launch it from Finder, not Terminal.
3. Run `codesign --verify --deep --strict --verbose=2 /Applications/PaseoDev.app`.
4. Run `spctl --assess --type execute --verbose=4 /Applications/PaseoDev.app`.
5. Confirm official Paseo and PaseoDev can run together with different user data and daemon homes.
6. Pair PaseoDev with the fork daemon on the VPS and test port forwarding, terminal traffic, reconnect, and app relaunch.
7. Install the next version over it and test the fork updater.

### Windows

1. Test x64 on an x64 Windows machine and ARM64 on Windows ARM64.
2. Install from the NSIS EXE, launch from the Start menu, and confirm the publisher state matches the signing decision.
3. Confirm the installed CLI wrapper finds the renamed executable.
4. Pair with the VPS and repeat the desktop workflow checks.
5. Install the next release over the first one.

### Android

1. Download the APK from the GitHub Release.
2. Verify the certificate fingerprint with `apksigner`.
3. Install it on a clean device and confirm it coexists with official Paseo.
4. Pair it with the fork daemon and test agent, terminal, reconnect, and background/resume behavior.
5. Install the next APK over it without uninstalling and confirm app data remains.

## Optional accounts and costs

- Apple Developer Program membership is required for a normal signed and notarized macOS download.
- Windows signing is optional for a working EXE but recommended for public distribution.
- EAS is not required for APK generation.
- Google Play is not required for GitHub APK downloads.
- Firebase is needed only for fork-owned notification delivery and related Google services.
- GitHub-hosted runner usage depends on repository visibility and account plan; macOS minutes are the expensive part of this matrix.

Model-provider subscriptions remain on the VPS. Do not embed Codex, Claude, GitHub, relay, Apple, Android, or signing credentials in any installer.

There is no release `.env` file to commit. GitHub injects release secrets into individual jobs, the VPS keeps its own service environment, and local overrides stay outside Git. Use `.env.example` only for documented non-secret configuration if a future workflow needs it.

## Release gate

Do not publish the first non-test tag until all of these are true:

- [ ] Product name, application IDs, scheme, icons, executable names, and local storage are fork-owned.
- [ ] Official Paseo and PaseoDev run side by side.
- [ ] Updater manifests point only at `Dey11/paseo`.
- [ ] Unrelated `v*` workflows cannot deploy or publish upstream-shaped resources.
- [ ] The Android signing key is backed up and GitHub produces a verified signed APK without EAS.
- [ ] macOS signing and notarization pass on both architectures.
- [ ] The Windows signing decision is documented and tested.
- [ ] Release creation is draft-first and fails closed when an artifact is missing.
- [ ] The installed app exposes the source, license, modified-fork notice, client version, and daemon version.
- [ ] Release notes link the exact source tag and license.
- [ ] No secret, certificate private key, keystore, `.env`, or VPS credential is tracked by Git.
