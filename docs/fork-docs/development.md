# Fork development

Use the official [development docs](../development.md) for package details and troubleshooting. This file defines the personal fork loop.

## Toolchain

Use the versions in `.tool-versions` and the repository's npm workspace commands. Do not replace the lockfile or package manager.

```bash
mise trust
mise install
npm ci
```

Confirm Node matches `.tool-versions` before diagnosing dependency or build failures.

## Fast loop

Run the isolated daemon and shared Expo app in separate terminals:

```bash
npm run dev:server
npm run dev:app
```

The root checkout uses:

| Surface            | Default                 |
| ------------------ | ----------------------- |
| Development daemon | `127.0.0.1:6768`        |
| Expo web           | `http://localhost:8081` |
| Development state  | `.dev/paseo-home`       |
| Stable daemon      | `127.0.0.1:6767`        |
| Stable state       | `~/.paseo`              |

Use the browser surface for the first pass on shared UI. It gives the shortest feedback loop and exercises the real client/daemon WebSocket boundary.

## macOS desktop

Run the real Electron shell on a Mac when the feature touches desktop framing, menus, windows, file dialogs, the embedded browser, daemon management, startup, or updates:

```bash
npm run dev:desktop
```

The Electron renderer reuses the Expo app. Browser success is useful evidence for shared UI but does not prove Electron behavior.

Build a packaged app only after the development flow works. Packaging is required before accepting changes to Electron main, bundled dependencies, daemon startup, native Node modules, signing, or updates.

## Android

Install a development client for native checks:

```bash
npm run android:development
```

Metro reloads TypeScript and React Native changes without rebuilding the APK. Rebuild the development client after changes to native modules, dependencies, permissions, Expo configuration, package identifiers, or Gradle behavior.

An Android emulator reaches a daemon on its host through `10.0.2.2` or `adb reverse`; see [android.md](../android.md). A physical phone can reach the VPS or development host through Tailscale.

## VPS workflow

The VPS owns provider execution. Install and authenticate provider CLIs there, not on the client devices merely to satisfy Paseo:

```bash
codex login
claude
```

Use a disposable project and checkout-local daemon for feature development. Connect a development client to the stable VPS daemon only for a final real-workflow smoke test, and do not mutate stable state without explicit permission.

Open VPS development servers on the Mac through SSH forwarding, a Tailscale address, or the service proxy. The Electron embedded browser runs on the Mac, so its target URL must be reachable from the Mac.

## Build boundaries

| Change                       | Restart or rebuild                                  |
| ---------------------------- | --------------------------------------------------- |
| React/TypeScript UI          | Metro reload                                        |
| Daemon implementation        | Development daemon reload or restart                |
| Protocol/client declarations | Rebuild the owning stack; see `docs/development.md` |
| Electron main/preload        | Restart Electron                                    |
| Native Android module/config | Rebuild the development client                      |
| Packaging/signing/updater    | Build and smoke a real artifact                     |

Do not use a release build as the primary debugging loop. Use it to prove that a finished feature survives production bundling.
