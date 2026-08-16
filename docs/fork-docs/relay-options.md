# HanabiCode remote transport

HanabiCode uses a fork-owned relay on the existing VPS for normal remote connections. Tailscale direct access remains the recovery path. This keeps the current pairing and Ports UX without depending on upstream infrastructure.

The relay is an untrusted WebSocket router. The daemon public key in the pairing offer remains the trust anchor, and application frames remain end-to-end encrypted between HanabiCode and the daemon. The relay can observe IP addresses, routing identifiers, timing, and frame sizes. It cannot read or modify authenticated application data.

## Decision

Fork [getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay) into `Dey11/hanabicode-relay`, retain its Apache-2.0 notices, and run its generic container on the existing VPS. Put Caddy in front of it for the public TLS endpoint. Cloudflare Tunnel may replace the public Caddy ingress later, but it is not the relay protocol.

Keep the relay and daemon on the same VPS for the first deployment. A separate highly available relay does not make that daemon available when its host is down. Use a process manager with automatic restart and retain Tailscale direct access for relay-process or ingress failures.

Do not deploy `packages/relay/src/cloudflare-adapter.ts` for this topology. It is a Cloudflare Durable Objects implementation, not the selected production service.

## Options

| Option                             | Pairing and Ports UX        | Operations and lock-in                                       | Decision                   |
| ---------------------------------- | --------------------------- | ------------------------------------------------------------ | -------------------------- |
| Relay on the existing VPS          | Unchanged                   | Lowest cost; one failure domain with the daemon              | Use now                    |
| Relay on Fly.io                    | Unchanged                   | Mature multi-node adapter; separate compute and traffic cost | Revisit for multiple hosts |
| Cloudflare Tunnel to the VPS relay | Unchanged                   | Hides VPS ingress; adds Cloudflare as the public path        | Optional ingress           |
| Cloudflare Durable Objects relay   | Unchanged                   | Managed edge and per-message billing; Cloudflare-specific    | Do not use now             |
| Tailscale or Headscale direct      | Separate network enrollment | Fast raw TCP and no relay on a direct path                   | Keep as recovery           |
| SSH forwarding                     | Manual and desktop-oriented | Low infrastructure cost; poor Android and pairing UX         | Emergency tool             |
| New relay implementation           | Can remain unchanged        | Full ownership; highest correctness and operations burden    | Defer                      |

Cloudflare Tunnel's published TCP mode requires client-side `cloudflared` or WARP. It cannot replace HanabiCode's mobile and desktop relay path while preserving one-app pairing. It can expose the self-hosted WebSocket relay because both HanabiCode clients and the daemon already speak that protocol.

Tailscale works with HanabiCode's direct TCP connection and desktop port-forwarding lease. It still requires Tailscale enrollment on the VPS, Mac, and Android device. Headscale can own the coordination server, but it continues to depend on Tailscale clients and adds a second onboarding flow.

## Runtime contract

Run the relay with this single-node service environment:

```dotenv
PASEO_RELAY_HOST=127.0.0.1
PASEO_RELAY_PORT=4000
PASEO_RELAY_MIN_CLUSTER_SIZE=1
PASEO_RELAY_OWNERSHIP_TARGET=local
```

Run the HanabiCode daemon with a private service environment based on the repository `.env.example`. The `PASEO_*` prefix is an inherited configuration API; these values configure HanabiCode in this repository.

```dotenv
PASEO_HOME=/home/dev/.hanabicode
PASEO_LISTEN=127.0.0.1:6769

PASEO_RELAY_ENABLED=true
PASEO_RELAY_ENDPOINT=127.0.0.1:4000
PASEO_RELAY_PUBLIC_ENDPOINT=relay.example.com:443
PASEO_RELAY_USE_TLS=false
PASEO_RELAY_PUBLIC_USE_TLS=true

PASEO_APP_BASE_URL=hanabicode://pair
PASEO_PASSWORD=replace-with-a-long-random-secret
```

Replace `relay.example.com` before enabling pairing. Do not commit the service environment or real password.

`PASEO_RELAY_ENDPOINT` is the daemon-to-relay path. It stays on loopback without TLS because both processes share the VPS. `PASEO_RELAY_PUBLIC_ENDPOINT` is written into pairing offers and must be reachable from macOS and Android over trusted TLS. Caddy forwards its WebSocket and health traffic to the relay on `127.0.0.1:4000`.

The relay process does not need the HanabiCode password or daemon private key. Multi-node relay deployments require their own cluster cookie; a single-node deployment does not.

## Security and operations

- Bind the relay application to loopback and expose only the TLS reverse proxy.
- Keep `/metrics` private. Expose `/health` and `/ready` only as required by the process supervisor or external monitor.
- Pin the relay source revision and container digest. Do not deploy an unreviewed moving tag.
- Use the relay's connection, frame, retained-byte, delivery, and memory limits. Set a nonzero memory watermark from the container or service memory limit before opening the endpoint to other users.
- Add reverse-proxy connection and upgrade rate limits. An obscure hostname is not access control, and the compatible relay protocol permits unauthenticated route allocation before the HanabiCode E2EE handshake.
- Monitor active WebSockets, rejected connections, slow-consumer closes, delivery timeouts, memory, process exits, and VPS bandwidth.
- Deploy manually. Replacing the relay process closes its WebSockets; clients reconnect, but active TCP tunnel streams do not resume.
- Never log pairing offers, private keys, passwords, or decrypted application frames. Relay logs may contain routing IDs, byte counts, and close reasons.
- Keep the daemon bound to loopback when only relay access is enabled. To keep direct recovery continuously available, replace `PASEO_LISTEN` with the exact Tailscale address, protect it with `PASEO_PASSWORD`, and never use `0.0.0.0` when the exact address works. The daemon has one TCP listener; changing its address requires a planned restart.

The pairing offer is effectively an operator credential. Store it as carefully as the direct-connection password.

## Migration

1. Create `Dey11/hanabicode-relay` from the Apache-2.0 relay source and pin the imported revision.
2. Choose the final relay hostname and configure its DNS and TLS certificate.
3. Start one relay instance on VPS loopback and place Caddy in front of it.
4. Verify `/health` and `/ready`, then run a bounded v2 text-and-binary compatibility smoke test.
5. Configure the HanabiCode daemon with the runtime contract above and generate a new HanabiCode pairing offer.
6. Pair clean macOS and Android installs. Existing profiles that contain `relay.paseo.sh` must be re-paired; do not silently redirect an upstream endpoint.
7. Verify agent control, terminal binary frames, one forwarded HTTP page, WebSocket/HMR, reconnect, app restart, and relay-process restart.
8. Save and test the Tailscale direct profile before treating the relay as the normal remote path.
9. Observe resource and bandwidth use before allowing additional users or sustained large transfers.

## Long-term boundary

Keep daemon identity separate from transport identity:

- `serverId` and the daemon public key identify and authenticate the host;
- a transport descriptor says how to reach it;
- agent, terminal, file, and tunnel protocols run above the selected WebSocket transport;
- remote transports use the same daemon-key E2EE handshake;
- UI state refers to the host, not the current relay hostname.

A future pairing offer can carry ordered relay and direct descriptors. Clients should prefer an authenticated direct path when available and fall back to the HanabiCode relay without changing the workspace or Ports UI.

Do not create new cryptography for a future relay. A clean HanabiCode relay can preserve the current v2 routing contract and encrypted-channel implementation. Budget one to three weeks for a bounded, observable single-node service and substantially more for multi-node ownership, draining, convergence, and production soak. Build it only when the fork needs behavior the Apache relay cannot provide cleanly.
