# Fork distribution

The target release process builds every desktop installer and the Android APK in GitHub Actions. A release tag is the input; the fork's GitHub Release is the output. You do not need a local macOS, Windows, Linux, or Android build machine for routine releases after the workflow and signing credentials are configured.

GitHub coordinates separate platform compilers. Each job checks out the same tag on an operating-system runner and invokes the platform's normal build tools:

| Artifact                          | GitHub runner | Builder                          |
| --------------------------------- | ------------- | -------------------------------- |
| macOS ARM64 and x64 DMG/ZIP       | macOS         | Electron Builder                 |
| Windows x64 and ARM64 EXE/ZIP     | Windows       | Electron Builder and NSIS        |
| Linux x64 AppImage/DEB/RPM/TAR.GZ | Ubuntu        | Electron Builder                 |
| Android APK                       | Ubuntu        | Expo Prebuild and Android Gradle |

The current desktop workflow already follows this shape. The current Android workflow does not: GitHub asks EAS to build, waits for Expo's servers, downloads the result, and attaches it to the GitHub Release. The fork will replace that job with a direct Gradle build on the GitHub runner.

## What moves off EAS

Moving Android off EAS is supported. It does not remove Expo from the codebase.

- Expo and React Native remain the application framework.
- `expo prebuild` generates the ignored `packages/app/android` project on the runner.
- Gradle compiles and signs that generated project.
- EAS Build, the Expo-hosted build service, is no longer involved.

Removing Expo itself would mean replacing Expo modules, configuration plugins, routing, and native-project generation. That is a separate native migration with no benefit for this release goal.

The repository's source-only Android path already proves that Prebuild and Gradle can build without EAS. See [the Android build doc](../android.md#f-droid--source-only-android-builds) and Expo's [local production build guide](https://docs.expo.dev/guides/local-app-production/).

## Release gates

Do not publish a release tag until these upstream-owned values have been replaced:

- Electron `appId`, product name, executable name, URL scheme, icons, publisher, updater owner, and updater repository;
- Android application ID, display name, URL scheme, icons, and release keystore;
- Expo owner, slug, and project ID, either removed when unused or replaced for the [EAS fallback](android-eas-fallback.md);
- upstream Firebase, push, store, website, issue, community, and update URLs that appear in the built clients;
- release titles, artifact names, checksums, and GitHub destinations;
- official npm or container publication steps, which are not part of this fork's installer release;
- the source and license links required by [the fork licensing policy](licensing.md).

Choose the fork name, Android application ID, desktop application ID, and URL scheme together. Record them here when chosen. Do not reuse `sh.paseo`, `sh.paseo.desktop`, the `paseo` scheme, or the `getpaseo/paseo` updater destination for shared fork builds.

## Android signing setup

Every Android APK is signed. A debug key is suitable only for development. A release key gives Android the stable identity it uses to decide whether a new APK may update the installed app.

Create the release keystore once on a trusted machine:

```bash
keytool -genkeypair -v \
  -storetype PKCS12 \
  -keystore fork-android-release.p12 \
  -alias fork-release \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

Back up the keystore and its passwords in two secure places. Losing the key means future APKs cannot update existing installations. Do not commit it; `packages/app/.gitignore` already excludes common keystore files, but the backup policy is the real protection.

Add these repository-level [GitHub Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets):

| Secret                       | Value                                      |
| ---------------------------- | ------------------------------------------ |
| `ANDROID_KEYSTORE_BASE64`    | Base64-encoded keystore                    |
| `ANDROID_KEYSTORE_PASSWORD`  | Keystore password                          |
| `ANDROID_KEY_ALIAS`          | Alias passed to `keytool`                  |
| `ANDROID_KEY_PASSWORD`       | Key password                               |

With GitHub CLI authenticated to the fork repository:

```bash
base64 < fork-android-release.p12 | tr -d '\n' | gh secret set ANDROID_KEYSTORE_BASE64
gh secret set ANDROID_KEYSTORE_PASSWORD
gh secret set ANDROID_KEY_ALIAS
gh secret set ANDROID_KEY_PASSWORD
```

The last three commands prompt for the value. Never paste passwords into a command argument, workflow file, issue, log, or release note.

Record the public certificate fingerprint separately:

```bash
keytool -list -v -keystore fork-android-release.p12 -alias fork-release
```

The fingerprint is safe to record. It lets you confirm that later releases use the same key without exposing the private key.

## Direct Android workflow

The replacement Android job should perform these operations on `ubuntu-latest`:

1. Check out the requested release tag with full history.
2. Set up Node 22, Java 21, and the Android SDK.
3. Install the locked JavaScript dependencies.
4. Build the workspace packages consumed by the app.
5. Run `APP_VARIANT=production npx expo prebuild --platform android --clean --non-interactive` in `packages/app`.
6. Decode `ANDROID_KEYSTORE_BASE64` into the runner's temporary directory.
7. Supply the four signing values to Gradle without printing them.
8. Run `./gradlew :app:assembleRelease --no-daemon --max-workers=1 -Dorg.gradle.parallel=false` from `packages/app/android`.
9. Verify the APK with Android's `apksigner verify --print-certs` and compare its fingerprint with the recorded release fingerprint.
10. Rename the APK with the fork name, version, and architecture scope.
11. Upload it as both a short-lived workflow artifact and a GitHub Release asset.

The generated Android directory is not committed. Release-signing configuration therefore must also be generated. Add a fork-owned Expo config plugin that writes Gradle references to environment or Gradle properties during Prebuild. The workflow writes the secret values to runner-local Gradle properties and points the generated build at the temporary keystore. Do not patch generated Gradle files by hand or place secret values in the Expo configuration.

The APK is the direct-download installer. Add `:app:bundleRelease` later only if a Play Store AAB is needed; it is not required for sideloading.

## Desktop workflow

Keep the existing platform matrix, but isolate all release metadata before enabling tag builds.

### macOS

The macOS jobs create ARM64 and Intel DMGs and ZIPs. A GitHub macOS runner can compile them without a local Mac.

Unsigned builds can be shared with trusted testers, but trust in the sender does not disable Gatekeeper. Testers must use a manual override, and updates can behave differently from signed builds. A smooth downloaded DMG and notarization require a paid Apple Developer membership and fork-owned secrets:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_PASSWORD` as an app-specific password
- `APPLE_TEAM_ID`

The certificate identity, bundle ID, entitlements, hardened runtime, and notarization settings must agree. Development can continue without these credentials; public-style macOS distribution cannot be treated as verified until the signed DMG is downloaded and opened on another Mac.

### Windows

The Windows jobs create x64 and ARM64 NSIS installers and ZIPs. GitHub supplies the Windows machine and NSIS toolchain. An unsigned EXE can run after a warning, but friends trusting the author does not prevent SmartScreen warnings. Add a fork-owned code-signing certificate later if reduced friction is worth its cost.

### Linux

The Ubuntu job creates AppImage, DEB, RPM, and TAR.GZ assets. Replace the upstream maintainer, vendor, artifact names, updater destination, and application identity before publishing.

## Automatic release shape

Start with a manual `workflow_dispatch` release. Once two manual releases update cleanly, let a version tag trigger the same workflow.

The release should use this sequence:

1. Resolve one source tag and version.
2. Create a draft GitHub Release in the fork repository.
3. Run macOS, Windows, Linux, and Android jobs in parallel.
4. Run packaged smoke checks inside the platform jobs.
5. Upload installers, update manifests, and SHA-256 checksums to the draft.
6. Link the exact source tag and license from the release notes.
7. Publish the draft only after every required job succeeds.

Do not let one platform publish a partially complete public release while other jobs are still running. A failed job should leave a draft that can be inspected or deleted manually.

GitHub Actions builds only committed source. You still develop and test features with the local dev loops. The release workflow is the clean-room packaging check after a commit is ready.

## First-release verification

For Android:

1. Download the APK from GitHub rather than using the runner artifact directly.
2. Install it on a clean device.
3. Pair with the VPS through `relay.paseo.sh`.
4. Exercise an agent, terminal, reconnect, and background/resume flow.
5. Install the next release over it without uninstalling.
6. Confirm the stored data remains and the signing fingerprint is unchanged.

For desktop:

1. Download each claimed installer from the release page.
2. Install on the matching operating system and architecture.
3. Confirm the app identifies itself as the fork and uses the fork updater.
4. Pair with the VPS relay connection and exercise the packaged daemon/client boundary.
5. Install the next release through the chosen manual or automatic update path.

Do not claim a platform as tested because GitHub produced a file. Compilation proves packaging; installation and a real workflow prove usability.

## Costs and account boundaries

GitHub-hosted runner billing depends on repository visibility, account plan, runner OS, and monthly usage. macOS minutes have a different multiplier from Linux minutes. Check the repository's Actions billing before making every commit a release build.

The build itself does not create model charges. Codex and Claude Code continue using the provider CLIs authenticated on the VPS. Apple signing, Windows signing, Play Store submission, Firebase, push delivery, and EAS are separate optional accounts.

Use [the EAS fallback](android-eas-fallback.md) only if direct GitHub Android builds become too slow or hard to maintain. It is not required for APK generation.
