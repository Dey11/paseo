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
docker run -d --name paseo \
  -p 6767:6767 \
  -e PASEO_PASSWORD=change-me \
  -v "$PWD/paseo-home:/home/paseo" \
  -v "$PWD:/workspace" \
  ghcr.io/getpaseo/paseo:latest
```

Open `http://localhost:6767` after it starts. Extend the base image with the agent CLIs you use, then provide credentials through environment variables or the persistent `/home/paseo` volume. See the [Docker documentation](docs/docker.md) for full setup details.

## CLI

Everything you can do in the app, you can do from the terminal.

```bash
paseo run --provider claude/opus-4.6 "implement user authentication"
paseo run --provider codex/gpt-5.5 --worktree feature-x "implement feature X"

paseo ls                           # list running agents
paseo attach abc123                # stream live output
paseo send abc123 "also add tests" # follow-up task

# run on a remote daemon; --cwd is a path on that host
paseo run --host workstation.local:6767 --cwd /workspace "run the full test suite"
```

See the [full CLI reference](https://paseo.sh/docs/cli) for more.

## TypeScript SDK

Build issue integrations, dashboards, and orchestration services with `@getpaseo/client`:

```ts
import { createPaseoClient } from "@getpaseo/client";

const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws" });
await client.connect();

const agent = await client.agents.create({
  config: { provider: "codex/gpt-5.5" },
  cwd: "/Users/me/dev/storefront",
  prompt: "Review the current diff and name the riskiest change.",
});

const result = await agent.waitForFinish();
console.log(result.lastMessage);

await client.close();
```

See the [SDK quickstart](https://paseo.sh/docs/sdk/quickstart), [recipes](https://paseo.sh/docs/sdk/recipes), and [API reference](https://paseo.sh/docs/sdk/reference).

## Skills

Skills teach your agent to use Paseo to orchestrate other agents.

```bash
npx skills add getpaseo/paseo
```

Then use them in any agent conversation:

- `/paseo-handoff` — hand off work between agents. I use this to plan with Claude and then handoff to Codex to implement.
- `/paseo-advisor` — spin up a single agent as an advisor for a second opinion, without delegating the work itself.
- `/paseo-committee` — form a committee of two contrasting agents to step back, do root cause analysis, and produce a plan.

## Development

Quick monorepo package map:

- `packages/server`: Paseo daemon (agent process orchestration, WebSocket API, MCP server)
- `packages/app`: Expo client (iOS, Android, web)
- `packages/cli`: `paseo` CLI for daemon and agent workflows
- `packages/desktop`: Electron desktop app
- `packages/relay`: Relay transport and encryption used by the daemon and clients
- `packages/website`: Marketing site and documentation (`paseo.sh`)

Common commands:

```bash
# run all local dev services
npm run dev

# run individual surfaces
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

- [getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay) — official distributed relay, written in Elixir
- [paseo-vscode](https://marketplace.visualstudio.com/items?itemName=hinnes.paseo-vscode) — VS Code extension

- `packages/server` — daemon and agent lifecycle
- `packages/app` — Expo Android, iOS, web, and Electron renderer
- `packages/desktop` — Electron main process and installers
- `packages/cli` — `hanabicode` command-line client
- `packages/protocol` — backward-compatible wire schemas
- `packages/relay` — in-repository relay transport implementation

Apache-2.0
