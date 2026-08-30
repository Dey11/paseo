# Cloudflare Tunnel phase

Status: shelved. The active design uses the official Paseo relay now and a fork-owned Paseo relay later.

Keep this design only as an alternative if the relay plan is revisited. It routes the daemon's direct WebSocket listener through Cloudflare One and does not implement the Paseo relay protocol. Tailscale would remain the recovery path.

## Proposed topology

```text
HanabiCode on macOS or Android
  -> Cloudflare One client (enrolled device)
  -> Cloudflare private hostname route
  -> cloudflared on the VPS
  -> HanabiCode daemon direct listener on a private address:6769
```

Cloudflare's current private hostname routing supports its client on macOS and Android and requires the client traffic and DNS query to route through Cloudflare. Follow the current [private hostname setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/connect-private-hostname/) rather than copying old dashboard steps into this repository.

## Preconditions

- A specific Cloudflare account, Zero Trust organization, and hostname are selected.
- `cloudflared` is installed on the daemon VPS.
- Cloudflare One is enrolled and connected on the Mac and Android device.
- Tailscale direct access is working and saved in both apps.
- HanabiCode requires a long daemon password.
- The VPS firewall does not expose port `6769` publicly.

Do not load Cloudflare credentials or create hosted resources until the user names the exact account, organization, hostname, and requested action.

## Implementation sequence

1. Create one named tunnel for the HanabiCode VPS.
2. Run `cloudflared` as a supervised, unprivileged service using a credential file readable only by that service account.
3. Add a private hostname route for the selected HanabiCode hostname. Route it to the daemon's private listener; do not enable relay settings.
4. Configure the Cloudflare One device profile so private-hostname DNS and the initial resolved IP range traverse WARP.
5. Add an allow policy for only the operator identity and enrolled devices, followed by a block policy for other access to the private route.
6. Add the hostname and port `6769` as a direct HanabiCode host on macOS and Android. Whether the client uses SSL depends on the selected private-route and origin-TLS design; verify this rather than guessing at setup time.
7. Test WebSocket upgrade, password rejection, agent traffic, terminal traffic, port forwarding, background/resume on Android, reconnect after `cloudflared` loss, and fallback to Tailscale.

## Security boundary

Cloudflare Tunnel makes the origin outbound-only, but it does not reproduce Paseo relay end-to-end encryption. Password authentication controls daemon access; it does not encrypt application data. The Cloudflare client and tunnel encrypt the network legs, while Cloudflare remains a trusted intermediary for the routed flow and can retain DNS, identity, timing, and network logs according to the account configuration.

Do not publish a public hostname as a shortcut. A public application route changes who can reach the endpoint and normally terminates public TLS at Cloudflare. That option needs a separate exposure review, Access policy design, origin TLS decision, rate limits, log-retention review, and mobile-client compatibility check.

If confidentiality from Cloudflare becomes a requirement, keep Tailscale or design an application-layer encrypted direct transport using Paseo's existing reviewed primitives. Do not invent a second cryptographic protocol in the tunnel setup.

## Acceptance gate

- No public inbound rule exposes the daemon port.
- An unenrolled device and a wrong identity cannot reach the private route.
- A missing or wrong HanabiCode password cannot establish daemon authority.
- Mac and Android sustain normal WebSocket traffic through the route.
- Port-forwarding streams remain bounded and responsive.
- Disabling `cloudflared` causes a clear failure and Tailscale still connects.
- No Cloudflare credential, tunnel token, password, or device enrollment artifact appears in Git, logs, or release assets.
