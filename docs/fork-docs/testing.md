# Fork testing

Use the official [testing](../testing.md), [QA](../qa.md), and [mobile testing](../mobile-testing.md) docs for test architecture and commands. This file defines the personal acceptance loop.

## Feature loop

For each feature:

1. Write the observable success and failure behavior.
2. Identify affected surfaces before implementation.
3. Add one focused failing test.
4. Implement one vertical slice and make the test pass.
5. Exercise the shared UI against an isolated real daemon.
6. Check macOS desktop and Android when affected.
7. Run static checks and focused tests.
8. Give the user exact manual steps and expected results.
9. Package only when the change crosses a build boundary.
10. Commit one coherent change after the evidence is complete.

No deployment is part of this loop.

## Required checks

Run formatting before the final checks:

```bash
npm run format
npm run lint
npm run typecheck
```

Run only the changed test file locally:

```bash
npx vitest run path/to/feature.test.ts --bail=1
```

Do not run the full local suite. Use path-routed CI for broad verification.

## Evidence by change

| Change                              | Fast proof                                  | Required follow-up                                                         |
| ----------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| Shared app UI                       | Expo web + focused Playwright               | macOS and Android manual check when the surface ships there                |
| Daemon behavior                     | focused Vitest E2E or ad-hoc daemon harness | CLI or client smoke against an isolated daemon                             |
| App and daemon feature              | Playwright with a real daemon               | app/daemon version-skew reasoning and primary-platform check               |
| Electron behavior                   | Electron development mode                   | targeted Electron E2E and packaged smoke when packaging is involved        |
| Android navigation or gesture       | Android development client                  | Agent Device flow and physical-device check when hardware behavior matters |
| Native audio, files, or permissions | rebuilt development client                  | physical Android evidence; JS-only tests are insufficient                  |
| Protocol change                     | protocol/client tests                       | old/new peer compatibility in both directions                              |

Unit tests prove pure policy. Browser tests prove web workflows through a real browser and daemon. Agent Device proves native interaction. A screenshot records appearance but is not an assertion.

## Manual support matrix

Primary manual targets are macOS Electron and Android. Record the result without inventing coverage:

| Platform       | Result                            | Notes                                  |
| -------------- | --------------------------------- | -------------------------------------- |
| macOS Electron | tested / untested / not affected  | Development or packaged build          |
| Android        | tested / untested / not affected  | Emulator or physical device            |
| Browser web    | tested / untested / not affected  | Shared-UI harness                      |
| Windows        | CI only / untested / not affected | State when shared desktop code changed |
| iOS            | CI only / untested / not affected | State when shared native code changed  |

Check pending, success, failure, retry, first load, reconnect, compact layout, and theme behavior when the feature exposes those states.

## User handoff

Before requesting acceptance, report:

- the branch or commit under test;
- how to open the development surface;
- numbered actions to perform;
- the expected result after each meaningful action;
- automated commands and results;
- platforms already checked;
- platforms and cases still unverified.

Treat feedback about latency, layout shift, keyboard behavior, copy, and touch targets as product failures, not polish deferred until release.

## Artifact gate

Build a production-like artifact before acceptance when a change touches:

- Electron main, preload, packaging, daemon bundling, signing, or updates;
- Android native code, permissions, dependencies, Expo configuration, or signing;
- startup behavior that differs between development and production;
- a bug reported only in an installed application.

Install the artifact over the previous personal version when update behavior is part of the change. A clean install alone does not prove upgrades.
