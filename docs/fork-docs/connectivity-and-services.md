# Fork connectivity and services

The fork uses a self-hosted HanabiCode relay for normal remote connections. Tailscale direct access remains the recovery path. See [relay-options.md](relay-options.md) for the selected deployment, environment contract, security constraints, and alternatives. Use the official [connectivity](../../public-docs/connectivity.md) and [security](../../public-docs/security.md) docs for the inherited connection and encryption model.

## HanabiCode relay

Run the fork-owned relay on the same VPS as the daemon. The daemon connects to the relay on `127.0.0.1:4000`; macOS and Android connect to its public TLS hostname. Pairing remains end-to-end encrypted and uses the daemon public key as its trust anchor.

The relay transports the daemon connection. Agent processes, repositories, credentials, terminals, and development servers still live on the VPS. The connection is end-to-end encrypted; the relay does not replace daemon authentication or the trust established during pairing.

Use the generic container from the Apache-2.0 [getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay) source through the fork-owned `Dey11/hanabicode-relay` repository. Pin the deployed revision, preserve its license notices, and deploy it manually. Relay replacement disconnects active WebSockets; clients reconnect, but active tunnel streams do not resume.

Do not configure `relay.paseo.sh` in HanabiCode defaults, examples, pairing offers, or releases. A connection profile copied from an upstream installation must be re-paired against HanabiCode rather than silently redirected.

## Tailscale recovery

Install Tailscale on the VPS, Mac, and Android phone before relying on the fork away from home. Bind the daemon to its exact Tailscale address when direct recovery is needed:

```json
{
  "version": 1,
  "daemon": {
    "listen": "100.101.102.103:6769"
  }
}
```

Use the real address returned by `tailscale ip -4`. Add that address and port `6769` as a direct host on macOS and Android. Keep SSL off for the direct Tailscale address because Tailscale encrypts the network path. Store this direct host before it is needed; it remains usable if the HanabiCode relay is unavailable.

Set a HanabiCode password even inside the tailnet. Tailscale protects transport and network membership; the HanabiCode password protects daemon authority. Do not bind to `0.0.0.0` when the exact Tailscale address works.

## Desktop role

The macOS desktop app connects to the VPS as a client. Disable built-in daemon management when the local daemon is not part of the workflow. Remote hosts remain connected.

Files, terminals, agents, worktrees, and Git actions execute on the VPS. Electron browser panes render on the Mac and need a URL the Mac can reach. Use the HanabiCode Ports tab for normal development-server access. Keep SSH forwarding and Tailscale available for recovery.

## Hosted-service decisions

| Service or destination                    | Fork decision                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| HanabiCode relay and pairing              | Self-host on the existing VPS; retain Tailscale recovery                      |
| `relay.paseo.sh`                          | Do not use in HanabiCode releases                                             |
| Cloudflare Tunnel                         | Optional ingress for the HanabiCode relay; not a replacement transport        |
| Cloudflare app or website deployments     | Do not use unless a specific fork-owned target is selected                    |
| Hosted Paseo Hub                          | Do not use                                                                    |
| Official Expo/EAS project                 | Do not use; GitHub builds Android directly                                    |
| Official Firebase, push, or store account | Do not use; add fork-owned credentials only when the feature is selected      |
| GitHub releases and updates               | Publish only through `Dey11/hanabicode`                                       |
| Official npm packages or containers       | Do not publish; keep package publication outside the personal release process |

The selected relay service lives in the separate fork-owned `Dey11/hanabicode-relay` repository. The adapter under `packages/relay` remains an unused Cloudflare Durable Objects alternative.

## Provider billing and authentication

HanabiCode launches existing provider CLIs and uses their existing authentication. Install and sign in on the VPS:

- Codex can use the access included with an eligible ChatGPT plan or an OpenAI API key.
- Claude Code can use a Claude plan that includes Claude Code or another supported Anthropic billing route.
- Other providers keep their own plans, keys, and limits.

HanabiCode adds no model usage fee. The fork does not change provider terms or quotas.

## Optional costs

Keep paid services optional:

| Capability                | Default fork choice                                           |
| ------------------------- | ------------------------------------------------------------- |
| Normal remote connection  | HanabiCode relay on the existing VPS                          |
| Recovery networking       | Tailscale personal tailnet                                    |
| Agent compute and storage | Existing VPS                                                  |
| Codex and Claude          | Existing provider subscriptions on the VPS                    |
| Speech                    | Local models when suitable                                    |
| Android builds            | GitHub Actions and Gradle                                     |
| macOS development         | Local unsigned development build                              |
| Installer distribution    | `Dey11/hanabicode` GitHub Releases                            |
| Push notifications        | Disabled or separately configured with fork-owned credentials |

The VPS provider, Tailscale, DNS, certificate authority, and GitHub-hosted runners remain external services with terms and limits that can change. Tailscale direct access and local build instructions remain the recovery paths.
