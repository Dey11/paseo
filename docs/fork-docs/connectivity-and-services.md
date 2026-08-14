# Fork connectivity and services

Tailscale direct access is the canonical connection between personal clients and the VPS daemon. Use the official [connectivity](../../public-docs/connectivity.md) and [security](../../public-docs/security.md) docs for configuration details.

## Direct topology

Install Tailscale on the VPS, Mac, and Android phone. Bind the daemon to its exact Tailscale address:

```json
{
  "$schema": "https://paseo.sh/schemas/paseo.config.v1.json",
  "version": 1,
  "daemon": {
    "listen": "100.101.102.103:6767"
  }
}
```

Use the real address returned by `tailscale ip -4`. Add that address and port `6767` as a direct host on macOS and Android. Keep SSL off for the direct Tailscale address because Tailscale encrypts the network path.

Set a Paseo password even inside the tailnet. Tailscale protects transport and network membership; the Paseo password protects daemon authority. Do not bind to `0.0.0.0` when the exact Tailscale address works.

## Desktop role

The macOS desktop app connects to the VPS as a client. Disable built-in daemon management when the local daemon is not part of the workflow. Remote hosts remain connected.

Files, terminals, agents, worktrees, and Git actions execute on the VPS. Electron browser panes render on the Mac and need a URL the Mac can reach. Use SSH forwarding, Tailscale, Tailscale Serve, or the Paseo service proxy for development servers.

## Hosted services

Do not depend on these upstream services by default:

- `relay.paseo.sh` and the official pairing page;
- Cloudflare app or website deployments;
- hosted Paseo Hub;
- official Expo, Firebase, push, or store credentials;
- official GitHub releases, update manifests, npm packages, or container tags.

The current fork may remain compatible with some of them. Compatibility is not an ownership grant or a durability guarantee. Choose and configure a service explicitly before making it part of the fork.

The production relay is a separate Elixir service. The Cloudflare relay code in this monorepo is legacy. Tailscale removes the need to run either relay for the personal topology.

## Provider billing and authentication

Paseo launches existing provider CLIs and uses their existing authentication. Install and sign in on the VPS:

- Codex can use the access included with an eligible ChatGPT plan or an OpenAI API key.
- Claude Code can use a Claude plan that includes Claude Code or another supported Anthropic billing route.
- Other providers keep their own plans, keys, and limits.

Paseo adds no model usage fee. The fork does not change provider terms or quotas.

## Optional costs

Keep paid services optional:

| Capability                | Default fork choice                                           |
| ------------------------- | ------------------------------------------------------------- |
| Private networking        | Tailscale personal tailnet                                    |
| Agent compute and storage | Existing VPS                                                  |
| Codex and Claude          | Existing provider subscriptions on the VPS                    |
| Speech                    | Local models when suitable                                    |
| Android builds            | Local Gradle, standard CI, or an optional EAS free quota      |
| macOS development         | Local unsigned development build                              |
| Public distribution       | Out of scope                                                  |
| Push notifications        | Disabled or separately configured with fork-owned credentials |

Free hosted quotas change. Do not make core development, access, or recovery depend on a promotional or unowned quota.
