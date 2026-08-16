<h1 align="center">HanabiCode</h1>

<p align="center">Run and control Claude Code, Codex, Copilot, OpenCode, and Pi agents from desktop, Android, web, or the CLI.</p>

<p align="center">
  <a href="https://github.com/Dey11/hanabicode/releases">Releases</a> ·
  <a href="docs/fork-docs/distribution.md">Install and release guide</a> ·
  <a href="docs/fork-docs/relay-options.md">Connectivity</a> ·
  <a href="LICENSE">License</a>
</p>

> HanabiCode is a modified, renamed downstream fork of
> [Paseo](https://github.com/getpaseo/paseo). It is not endorsed by or affiliated
> with the upstream project.

HanabiCode runs coding agents on your own machines and gives you one interface for
monitoring them, sending follow-ups, handling approvals, using terminals, and
forwarding workspace ports from a remote host to the desktop app.

- **Self-hosted daemon:** your repositories and agent processes stay on your machine or VPS.
- **Desktop port forwarding:** expose a workspace service on a local desktop port through the active encrypted connection.
- **Multiple providers:** use Claude Code, Codex, Copilot, OpenCode, and Pi from the same client.
- **Cross-device clients:** macOS, Windows, Android, web, and CLI share the same protocol.
- **Independent install:** HanabiCode uses `~/.hanabicode`, local port `6769`, app ID `com.dey.hanabicode`, and the `hanabicode` URL scheme so it can run beside Paseo.

## Install

Download the latest artifacts from [GitHub Releases](https://github.com/Dey11/hanabicode/releases).
The initial macOS builds are ad-hoc signed and not notarized; Windows builds are
unsigned. Android releases are signed with HanabiCode's Android release key.

See [the installation and release guide](docs/fork-docs/distribution.md) for
platform-specific installation steps, signing status, release secrets, and the
exact workflow used to publish a version.

## Run from source

Requirements: Node.js 22 and the native build tools required by the target
platform.

```bash
npm install
npm run build:server
npm run dev:desktop
```

Useful commands:

```bash
npm run dev:server
npm run dev:app
npm run dev:desktop
npm run cli -- daemon status
npm run typecheck
npm run lint
```

The installed desktop app bundles the `hanabicode` CLI. HanabiCode intentionally retains
the inherited `PASEO_*` environment-variable prefix as a compatibility API. See
[`.env.example`](.env.example) for safe defaults and relay configuration.

## Repository map

- `packages/server` — daemon and agent lifecycle
- `packages/app` — Expo Android, iOS, web, and Electron renderer
- `packages/desktop` — Electron main process and installers
- `packages/cli` — `hanabicode` command-line client
- `packages/protocol` — backward-compatible wire schemas
- `packages/relay` — in-repository relay transport implementation

## Connectivity

HanabiCode can connect directly over LAN/Tailscale or through an end-to-end encrypted
relay. The fork does not assume an upstream hosted relay. Configure a self-hosted
endpoint before enabling relay pairing. The recommended deployment and option
comparison are in [docs/fork-docs/relay-options.md](docs/fork-docs/relay-options.md).

## License and source

HanabiCode is distributed under the
[GNU Affero General Public License v3 or later](LICENSE). You may inspect,
modify, redistribute, host, and charge for copies or services under those terms.
Modified network deployments and distributed binaries must keep the notices and
offer their users the corresponding source.

The GNU license text in `LICENSE` is retained unchanged. Fork attribution and
additional copyright notices live in [NOTICE](NOTICE). See
[docs/fork-docs/licensing.md](docs/fork-docs/licensing.md) for practical fork
compliance guidance.
