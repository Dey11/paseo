# Fork connectivity and services

HanabiCode does not depend on a relay. Use a direct daemon connection over Tailscale first. After releases are proven, Cloudflare Tunnel can become a second private path for the same direct connection. See [Cloudflare Tunnel](cloudflare-tunnel.md).

## Baseline: Tailscale direct

Install Tailscale on the VPS, Mac, and Android phone. Bind HanabiCode to the VPS's exact Tailscale address:

```json
{
  "version": 1,
  "daemon": {
    "listen": "100.101.102.103:6769"
  }
}
```

Use the real address from `tailscale ip -4`. Add that address and port `6769` as a direct host on macOS and Android. Leave SSL off because Tailscale encrypts the network path. Set a long HanabiCode password even inside the tailnet; network membership and daemon authority are separate controls.

Do not bind to `0.0.0.0` when the exact private address works. Keep this Tailscale profile after Cloudflare is introduced so a Cloudflare configuration, identity, DNS, or tunnel failure does not strand the operator.

## Deferred: Cloudflare private route

The preferred Cloudflare design uses `cloudflared` on the VPS plus the Cloudflare One client on macOS and Android. A private hostname route reaches the direct HanabiCode listener without a public inbound VPS port. It requires enrollment of both client devices in the fork owner's Cloudflare Zero Trust organization.

This is a network path, not Paseo's relay protocol. It does not use `packages/relay`, pairing offers, relay endpoints, or a separate relay repository.

Cloudflare becomes part of the transport trust boundary. A private route encrypts each leg through Cloudflare but is not application-layer end-to-end encryption against Cloudflare. Keep daemon password authentication enabled. Use Tailscale when the operator does not want Cloudflare on the data path.

## Service boundary

| Service                                | Fork policy                                                       |
| -------------------------------------- | ----------------------------------------------------------------- |
| Official Paseo relay                   | Never use                                                         |
| Fork-owned relay                       | Do not build or deploy                                            |
| Tailscale                              | Primary and recovery direct path                                  |
| Cloudflare Tunnel                      | Deferred private direct path                                      |
| Public Cloudflare hostname             | Optional later; requires a separate exposure review               |
| Hosted Paseo Hub                       | Do not use                                                        |
| Official Expo/EAS, Firebase, or stores | Do not use                                                        |
| GitHub Releases and GHCR               | Publish only through `Dey11/paseo` and `ghcr.io/dey11/hanabicode` |
| Official npm packages                  | Do not publish                                                    |

HanabiCode launches provider CLIs with the accounts already authenticated on the daemon host. It does not broker model billing or embed provider credentials in app packages.
