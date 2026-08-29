# HanabiCode personal fork

This repository is Dey's HanabiCode downstream of Paseo. It is not an official `getpaseo/paseo` checkout or release source.

Read this file before non-trivial work. Then read the subject doc that owns the task:

- [development.md](development.md) — local and VPS development loops
- [testing.md](testing.md) — feature verification and acceptance evidence
- [connectivity-and-services.md](connectivity-and-services.md) — the HanabiCode connection topology, VPS, recovery path, and service dependencies
- [cloudflare-tunnel.md](cloudflare-tunnel.md) — the deferred private Cloudflare route and acceptance gate
- [relay-options.md](relay-options.md) — why relay deployment is outside the selected topology
- [desktop-port-forwarding.md](desktop-port-forwarding.md) — desktop Ports tab and remote VPS port forwarding
- [distribution.md](distribution.md) — GitHub-built desktop and Android releases
- [android-eas-fallback.md](android-eas-fallback.md) — optional fork-owned Expo/EAS setup
- [licensing.md](licensing.md) — Apache-2.0 notices and distribution policy
- [upstream.md](upstream.md) — upstream sync and divergence policy

The official docs remain authoritative for Paseo's current architecture and implementation conventions. These fork docs own personal product intent, operating topology, support priorities, and release policy. When an official-product assumption conflicts with a fork decision, follow the fork doc and keep the deviation explicit.

## Goal

Improve Paseo for one operator and one workflow. Keep upstream updates easy while they remain valuable. Accept deeper divergence when a better personal design is worth the maintenance cost.

The work does not need to fit the official product roadmap or contribution policy. It must still meet the repository's architecture, type, testing, and quality standards unless a fork doc records a deliberate replacement.

## Operating topology

The primary clients are:

- the Electron desktop app on macOS;
- the Android app on a personal phone.

The daemon, projects, terminals, Git operations, and agent processes run on a VPS. Codex, Claude Code, and other provider CLIs are installed and authenticated on that VPS. Clients first reach the daemon directly over Tailscale. A private Cloudflare Tunnel route is a separate phase after release artifacts work.

The desktop app is a client in this topology. Its built-in local daemon can be disabled while remote hosts stay connected.

## Desktop port forwarding

Electron adds a **Ports** tab beside Files. It discovers TCP listeners owned by workspace terminal processes on the Linux VPS and lets you bind a forward to `127.0.0.1` on the desktop. Manual forwarding covers services that process discovery cannot attribute, including containers. The tunnel reuses the selected host's direct connection credentials; it does not add an environment variable or persist another pairing secret. See [desktop-port-forwarding.md](desktop-port-forwarding.md) for behavior, limits, and the remaining packaged-app acceptance check.

## Product boundaries

- Do not use upstream or fork-owned relay infrastructure for HanabiCode releases.
- Keep direct Tailscale access working so a Cloudflare, identity, DNS, or tunnel failure does not strand the operator.
- Cloudflare Tunnel activation, hosted Hub, store submission, push infrastructure, and public websites are out of scope until explicitly requested against a named target.
- Paseo does not broker model billing. Provider subscriptions and API usage belong to the provider CLI authenticated on the VPS.
- Local speech is preferred when it meets the workflow. Paid speech APIs remain opt-in.
- macOS and Android receive primary manual QA. Browser web is the fast shared-UI harness. Keep Windows, Linux, and iOS buildable when the cost is reasonable, but do not claim manual coverage that did not happen.

## Change policy

First check whether configuration or a local plugin can solve the problem without a core patch. Use a core change when the requested workflow alters existing behavior or cannot fit the supported extension points.

Keep personal changes cohesive. Avoid drive-by cleanup and broad formatting because every unrelated edit increases upstream conflict cost. A feature that spans the app and daemon still follows the protocol compatibility rules: the macOS client, Android client, and VPS daemon update independently even if upstream compatibility is later abandoned.

## Safety

- Use checkout-local `.dev/paseo-home` state and development ports for normal testing.
- Do not restart or mutate the stable daemon on port `6767` without explicit permission.
- Do not publish official npm packages or write to official Paseo release targets.
- Do not push release tags until the fork release workflow and identifiers are isolated.
- Do not share installers until the release includes the fork's license notices and exact source link.
- Treat the VPS daemon as the authority for code, credentials, agents, and terminals.

## Definition of done

A fork feature is done when:

1. Its user-visible behavior and failure recovery are defined.
2. Focused automated coverage proves the behavior at the smallest real boundary.
3. Typecheck, lint, and formatting pass.
4. Every affected primary platform is manually checked or reported as untested.
5. A production-like artifact is exercised when the change touches packaging, native code, permissions, startup, or updates.
6. The docs that own changed workflow or architecture facts are updated.
