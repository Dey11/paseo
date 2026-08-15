# Fork connectivity and services

The fork uses Paseo's official relay for normal remote connections. Tailscale direct access remains the recovery path. Use the official [connectivity](../../public-docs/connectivity.md) and [security](../../public-docs/security.md) docs for the underlying connection and encryption model.

## Official relay

The daemon already defaults to `relay.paseo.sh:443`. A protocol-compatible fork can use the existing pairing flow without hosting Cloudflare Tunnel, opening the VPS firewall, or running a relay service. Pair the Mac and Android clients with the VPS daemon and confirm both clients reconnect after an app restart and a network change.

The relay transports the daemon connection. Agent processes, repositories, credentials, terminals, and development servers still live on the VPS. The connection is end-to-end encrypted; the relay does not replace daemon authentication or the trust established during pairing.

This is an external dependency owned by upstream. Its continued availability to third-party builds is not guaranteed. Do not change relay framing, pairing, encryption, or wire compatibility without first choosing a fork-owned relay or moving the primary topology to Tailscale. Every release that changes connection code must smoke-test a real pairing through `relay.paseo.sh`.

## Tailscale recovery

Install Tailscale on the VPS, Mac, and Android phone before relying on the fork away from home. Bind the daemon to its exact Tailscale address when direct recovery is needed:

```json
{
  "$schema": "https://paseo.sh/schemas/paseo.config.v1.json",
  "version": 1,
  "daemon": {
    "listen": "100.101.102.103:6767"
  }
}
```

Use the real address returned by `tailscale ip -4`. Add that address and port `6767` as a direct host on macOS and Android. Keep SSL off for the direct Tailscale address because Tailscale encrypts the network path. Store this direct host before it is needed; it remains usable if the hosted relay is unavailable.

Set a Paseo password even inside the tailnet. Tailscale protects transport and network membership; the Paseo password protects daemon authority. Do not bind to `0.0.0.0` when the exact Tailscale address works.

## Desktop role

The macOS desktop app connects to the VPS as a client. Disable built-in daemon management when the local daemon is not part of the workflow. Remote hosts remain connected.

Files, terminals, agents, worktrees, and Git actions execute on the VPS. Electron browser panes render on the Mac and need a URL the Mac can reach. Use SSH forwarding, Tailscale, Tailscale Serve, or the Paseo service proxy for development servers.

## Hosted-service decisions

| Service or destination                    | Fork decision                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `relay.paseo.sh` and pairing              | Use while compatible; retain Tailscale recovery                               |
| Cloudflare app or website deployments     | Do not use                                                                    |
| Hosted Paseo Hub                          | Do not use unless selected for a future feature                               |
| Official Expo/EAS project                 | Do not use; GitHub builds Android directly                                    |
| Official Firebase, push, or store account | Do not use; add fork-owned credentials only when the feature is selected      |
| Official GitHub releases and updates      | Do not use; publish only to the fork repository                               |
| Official npm packages or containers       | Do not publish; keep package publication outside the personal release process |

The production hosted relay is not the Cloudflare Worker under `packages/relay`. Do not deploy that package and assume it reproduces the current service. A fork-owned relay requires a separate infrastructure decision and a compatibility test against the current daemon and clients.

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
| Normal remote connection  | Upstream-hosted Paseo relay                                   |
| Recovery networking       | Tailscale personal tailnet                                    |
| Agent compute and storage | Existing VPS                                                  |
| Codex and Claude          | Existing provider subscriptions on the VPS                    |
| Speech                    | Local models when suitable                                    |
| Android builds            | GitHub Actions and Gradle                                     |
| macOS development         | Local unsigned development build                              |
| Installer distribution    | Fork-owned GitHub Releases for the operator and friends       |
| Push notifications        | Disabled or separately configured with fork-owned credentials |

The relay and GitHub-hosted runners are external services with terms and limits that can change. Tailscale direct access and local build instructions remain the recovery paths.
