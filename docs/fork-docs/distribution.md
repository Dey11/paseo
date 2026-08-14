# Fork distribution

The fork distributes personal macOS and Android clients. It does not use the official Paseo release process unchanged.

## Isolation before the first release

Change every upstream-owned identity and destination before publishing a personal artifact:

- Electron `appId`, product identity, protocol scheme if both apps must coexist, and updater repository;
- Android application ID and release keystore;
- Expo account and project ID if EAS is used;
- Firebase and push configuration if push is enabled;
- GitHub Release repository and update manifests;
- container image owner if a custom daemon image is published.

Keep signing keys and service credentials outside the repository. Retain the Android release keystore permanently; Android accepts an update only when it is signed by the same identity as the installed app.

The current upstream configuration points at official identifiers and release destinations. Do not push `v*` tags or run the root `release:*` scripts until the fork workflow has replaced them. Those scripts publish official npm package names and coordinate infrastructure this fork does not own.

## macOS

Use Electron development mode for feature work:

```bash
npm run dev:desktop
```

`npm run build:desktop` exports the Expo renderer, compiles Electron and the daemon, and runs `electron-builder`. Artifacts land in `packages/desktop/release`.

An unsigned or ad-hoc local build is sufficient for one operator who accepts Gatekeeper friction. A smooth downloaded DMG, notarization, and dependable auto-update path require a fork-owned Apple Developer identity and consistent signing. Do not make paid Apple distribution a prerequisite for development.

Build macOS artifacts on macOS. Use GitHub's macOS runner only after the personal workflow no longer assumes upstream signing secrets or update destinations.

## Android

Use the development client for the daily loop:

```bash
npm run android:development
```

Every APK is signed. Debug builds use a development key. Personal release APKs use a fork-owned release keystore. Sideloading does not require Play Store submission.

The upstream Android release workflow asks GitHub Actions to start an Expo EAS build, waits for EAS, downloads the APK, and uploads it to GitHub Releases. The fork may use one of three paths:

1. local Expo prebuild and Gradle;
2. a fork-owned GitHub Actions Gradle build;
3. a fork-owned Expo project and EAS token.

Prefer the smallest path that produces a repeatable signed APK. Store submission and EAS Update are separate decisions.

## Personal release workflow

Start with manual workflows:

1. Run focused tests, lint, typecheck, and formatting.
2. Build one macOS ARM64 artifact and one Android APK.
3. Run packaged desktop smoke and install the APK over the previous personal build.
4. Upload artifacts to a release in the fork repository.
5. Download and test them as the user would.
6. Record the source commit and signing identity.

Do not add auto-update until manual releases are reliable. When auto-update is enabled, point it at the fork repository and require consistent macOS signing across releases.

Release automation is optional. Local commands perform the builds; GitHub Actions supplies clean host operating systems, repeatability, and artifact hosting.
