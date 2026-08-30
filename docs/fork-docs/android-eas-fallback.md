# Android EAS fallback

This is the fallback release path. The selected path is the direct GitHub Gradle build in [distribution.md](distribution.md). Use EAS only if maintaining that job costs more than using Expo's hosted builder.

EAS Build is an Expo-hosted CI service. Expo remains part of the app even when EAS is not used. Moving between direct Gradle and EAS does not require rewriting the React Native application.

## Account boundary

Create an Expo account owned by the fork maintainer. Do not use the `getpaseo` organization, its project ID, credentials, Firebase project, or submission accounts.

Before linking a new EAS project, keep the HanabiCode values in `packages/app/app.config.js`:

- production name `HanabiCode` and package ID `com.dey.hanabicode`;
- slug `hanabicode` and scheme `hanabicode`.

The repository intentionally has no Expo owner or EAS project ID. Let EAS initialization add only the new fork-owned values.

## Create the fork project

From `packages/app`:

```bash
npx eas-cli@latest login
npx eas-cli@latest whoami
npx eas-cli@latest build:configure
```

Choose Android, the fork-owned Expo account, and a new project when prompted. EAS writes or prints a new project ID. Confirm that the evaluated Expo configuration contains only the fork's values:

```bash
npx expo config --type public
```

Inspect the application name, Android package ID, owner, slug, and EAS project ID. Stop if `getpaseo`, `sh.paseo`, or the official project ID remains in a production field.

Create `packages/app/eas.json` under version control with a `production-apk` profile that requests an APK. Resource classes, build queues, and pricing change; select a machine size supported by the fork's Expo plan.

## Create Android credentials

The Android package ID must be final before creating credentials. Then run:

```bash
npx eas-cli@latest credentials --platform android
```

Select the production build profile and create a new Android keystore, or upload the fork-owned keystore created by [the direct-build setup](distribution.md#android-signing-setup). Use the same keystore for EAS and direct GitHub builds if both paths must update the same installed application.

Download and back up any EAS-generated keystore and passwords. EAS holding a copy is not a backup strategy. Never commit the downloaded credentials.

## Test a manual EAS build

Run the APK profile before connecting GitHub:

```bash
npx eas-cli@latest build --platform android --profile production-apk
```

When it finishes:

1. Download the APK from the Expo build page.
2. Verify its signing certificate fingerprint.
3. Install it on Android.
4. Pair it to the VPS through the configured relay, then confirm the direct Tailscale recovery host.
5. Confirm a later APK signed by the same key installs over it.

Do not automate a build that has not passed this manual round trip.

## Connect GitHub Actions

Create an Expo access token from the fork maintainer's Expo account. Give it only the access needed to build this project. In the fork GitHub repository, create an Actions secret named `EXPO_TOKEN`.

If you automate the fallback, create a separate manual workflow with this orchestration:

1. GitHub checks out a release tag.
2. `expo/expo-github-action` authenticates with `EXPO_TOKEN`.
3. `eas build --platform android --profile production-apk --wait` starts the hosted build.
4. GitHub obtains the artifact URL from EAS.
5. GitHub downloads the APK and attaches it to the fork's GitHub Release.

Before enabling it, replace upstream release titles and make sure every `gh release` command uses `${{ github.repository }}` or the explicit fork repository. Keep the Expo token in GitHub Secrets and the signing key in EAS Credentials; neither belongs in workflow YAML.

## Optional services are separate

An EAS Build project does not require these features:

- EAS Update;
- Play Store submission;
- Firebase or push notifications;
- Apple builds or App Store submission.

Enable each separately with fork-owned accounts. Android push delivery may need a fork-owned Firebase project and FCM credentials, but direct connections and normal foreground use do not require that decision.

Check the current [EAS pricing and account usage](https://expo.dev/pricing) before relying on hosted builds. Quotas and queue priority are service policy, not repository behavior.

## Leaving EAS later

Keep the keystore backup, application ID, version-code policy, and source-controlled Expo config. A direct GitHub Gradle job can then produce compatible updates. No user migration is needed when the package ID and signing certificate stay the same.
