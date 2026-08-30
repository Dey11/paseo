# Fork connectivity and services

HanabiCode uses the official Paseo relay for remote access in the current release. The daemon and clients make outbound TLS WebSocket connections to `relay.paseo.sh:443`. Paseo's encrypted channel protects application frames end to end; the relay routes ciphertext between paired peers.

## Primary path: official relay

The native VPS installer enables the relay and TLS by default. After starting the service, create a pairing offer:

```bash
~/.local/bin/hanabicode daemon pair --home ~/.hanabicode --relay
```

Open the link with the HanabiCode macOS or Android app. The pairing offer contains the relay endpoint, the daemon identity, and the key material required by the encrypted handshake. Do not copy daemon state or invent a separate shared secret.

The official relay is an interim hosted dependency. Provider CLIs, source code, terminals, and agent processes remain on the VPS. The relay does not run agents or hold provider credentials.

## Recovery path: Tailscale direct

Install Tailscale on the VPS, Mac, and Android phone. Bind HanabiCode to the VPS's exact Tailscale address:

```json
{
  "version": 1,
  "daemon": {
    "listen": "100.101.102.103:6769"
  }
}
```

Use the real address from `tailscale ip -4`. Add that address and port `6769` as a direct host on macOS and Android. Leave SSL off because Tailscale encrypts the network path. Set a long HanabiCode password because network membership and daemon authority are separate controls.

Do not bind to `0.0.0.0` when the exact private address works. Keep this profile saved so an official or future self-hosted relay failure does not strand the operator.

## Future path: self-hosted Paseo relay

The production relay lives in the external `getpaseo/paseo-relay` repository. It is an Elixir service. The Cloudflare Durable Objects adapter under `packages/relay` is legacy code and is not the production deployment.

Self-hosting is a separate infrastructure phase. It must select a fork-owned hostname, TLS termination, deployment target, monitoring, backups, and upgrade process. Once the endpoint works, reinstall the native service with:

```bash
./install.sh \
  --listen 100.101.102.103:6769 \
  --working-directory /home/dev/projects \
  --relay-endpoint relay.example.com:443 \
  --relay-use-tls true
```

Restart only during the chosen promotion window, then generate a new pairing offer for clients. Existing offers retain their original relay endpoint.

## Service boundary

| Service                                | Fork policy                        |
| -------------------------------------- | ---------------------------------- |
| Official Paseo relay                   | Current primary remote path        |
| Fork-owned Paseo relay                 | Later infrastructure phase         |
| Tailscale                              | Direct recovery path               |
| Cloudflare Tunnel                      | Shelved alternative                |
| Hosted Paseo Hub                       | Do not use                         |
| Official Expo/EAS, Firebase, or stores | Do not use                         |
| GitHub Releases                        | Publish only through `Dey11/paseo` |
| Container registries                   | Do not publish                     |
| Official npm packages                  | Do not publish                     |

HanabiCode launches provider CLIs with the accounts already authenticated on the daemon host. It does not broker model billing or embed provider credentials in app packages.
