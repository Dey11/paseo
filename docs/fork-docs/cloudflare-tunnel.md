# Cloudflare Tunnel transport plan

Status: planned. HanabiCode still uses the inherited relay-v2 pairing transport today. A named
Cloudflare Tunnel can expose the current direct socket, but the release must not call that path a
replacement for the relay until direct end-to-end encryption and transport-neutral pairing ship.

This document owns the Cloudflare Tunnel product decision, implementation sequence, operator
setup, client onboarding, cost model, security boundary, migration, and acceptance bar.

## Decision

HanabiCode will support a user-owned named Cloudflare Tunnel as the normal remote transport. Each
daemon operator creates a tunnel in their own Cloudflare account and maps one public hostname to
a dedicated E2EE ingress on loopback. The existing daemon listener remains private. macOS and
Android clients receive that hostname through the normal HanabiCode pairing link. The client does
not install `cloudflared`, join a VPN, or log in to Cloudflare.

The target is:

- one-time Cloudflare setup on the machine that runs the daemon;
- one pairing link or QR code for every client;
- application-level encryption between the client and daemon inside the Cloudflare WebSocket;
- the existing Agents, Files, Terminal, and Ports experience after pairing;
- automatic reconnect after a Cloudflare edge or connector interruption;
- Tailscale retained as an operator recovery path;
- no dependency on `relay.paseo.sh` or a HanabiCode-operated tunnel account.

HanabiCode will not place every community installation in Dey's Cloudflare account for the first
release. That would make HanabiCode a hosted tunnel provider with central billing, abuse, privacy,
support, account-limit, and availability obligations. A managed HanabiCode Connect service can be
designed later as an optional convenience.

## Why Tunnel fits the protocol

The daemon currently exposes an HTTP server and a WebSocket at `/ws`. The target adds a second,
minimal ingress that exposes only health and `/ws/e2ee`. The desktop port-forwarding feature does
not ask Cloudflare to publish each workspace port. It carries TCP stream frames inside dedicated
daemon WebSockets, so one published application route covers agents, terminals, files, control
messages, and forwarded ports.

Cloudflare maps a public hostname to a local HTTP service:

```text
HanabiCode on macOS or Android
              │
              │ HTTPS/WSS :443
              ▼
        Cloudflare edge
              │
              │ Cloudflare Tunnel
              ▼
       cloudflared on the host
              │
              │ HTTP/WS loopback
              ▼
  E2EE ingress 127.0.0.1:6770
              │
              ▼
  private daemon 127.0.0.1:6769
              │
              ├── agents, repositories, terminals
              └── workspace port-forward sockets
```

Cloudflare supports proxied WebSockets and Cloudflare Tunnel on all plans. `cloudflared` creates
outbound connections, so the daemon remains on loopback and the VPS does not need an inbound
daemon port. See Cloudflare's [Tunnel overview](https://developers.cloudflare.com/tunnel/),
[setup guide](https://developers.cloudflare.com/tunnel/setup/), and
[WebSocket notes](https://developers.cloudflare.com/network/websockets/).

## The UX contract

The transport changes without creating a second host concept in the app.

### Server operator

The person running a daemon performs one infrastructure setup:

1. Create or select a Cloudflare account and a domain managed by that account.
2. Create one remotely managed named tunnel for the daemon host.
3. Publish `code.example.com` to the dedicated HanabiCode E2EE ingress on loopback.
4. Install `cloudflared` as a persistent service on the daemon host.
5. Configure HanabiCode with the public hostname and allow that Host header.
6. Ask HanabiCode to generate an encrypted pairing link or QR code.

### Client user

The person installing the desktop or Android app:

1. Install HanabiCode from the fork's GitHub Release.
2. Open the pairing link or scan the QR code.
3. Confirm the host identity shown by HanabiCode.
4. Use the workspace normally.

The client user does not need:

- a Cloudflare account;
- the `cloudflared` binary;
- the Cloudflare One Client or WARP;
- a domain;
- a Tailscale account;
- a tunnel token.

For a personal deployment, the server operator and client user are usually the same person. The
Cloudflare work still happens only on the VPS.

"Same UX" applies to pairing and daily client use after the server is configured. The first
user-owned release still includes a one-time Cloudflare dashboard setup. Reaching a universal
one-command flow with no Cloudflare knowledge requires either a HanabiCode-managed provisioning
service or a separate Cloudflare authorization flow that grants HanabiCode scoped API access to
the user's account.

## Who owns the tunnels

There are three viable ownership models.

| Model              | Who creates the tunnel                                 | Client onboarding     | Cost and responsibility                                                    | Decision         |
| ------------------ | ------------------------------------------------------ | --------------------- | -------------------------------------------------------------------------- | ---------------- |
| User-owned         | Each daemon operator                                   | Pairing link only     | Operator owns domain, account, token, logs, and availability               | Default          |
| HanabiCode-managed | Dey's service provisions one tunnel per daemon         | Sign in, then pairing | HanabiCode owns control plane, limits, abuse, support, and Cloudflare bill | Future option    |
| Quick Tunnel       | `cloudflared` creates a random `trycloudflare.com` URL | Temporary link        | No account, no stable identity or uptime commitment                        | Development only |

### User-owned tunnels

This is the correct open-source default. Every daemon operator controls their hostname and can
rotate or delete the connector without asking HanabiCode. Traffic does not share Dey's account,
account limits, credentials, or suspension risk.

A user with three daemon hosts should normally create three tunnels and three hostnames. A tunnel
can publish multiple applications, but sharing one connector token between unrelated hosts makes
them replicas of the same tunnel. Cloudflare may send traffic to any active replica, so unrelated
daemon hosts must not share a tunnel token.

### HanabiCode-managed tunnels

This is the model behind products such as T3 Connect. It requires more than running
`cloudflared`. HanabiCode would need:

- user authentication and account recovery;
- a Cloudflare API integration with least-privilege credentials;
- a database mapping users, daemons, tunnel UUIDs, hostnames, and lifecycle state;
- one separately scoped connector token per daemon;
- hostname allocation and cleanup;
- token rotation and revocation;
- quotas, abuse handling, privacy disclosures, logging policy, and support;
- monitoring for account, route, traffic, and billing limits;
- a plan for account suspension and service migration.

Do not distribute a shared account-wide API token or a shared connector token. A connector token
allows anyone holding it to run that tunnel. An account API token can create, modify, or delete
resources within its granted scope.

### Quick Tunnels

Quick Tunnels create a random `*.trycloudflare.com` address without a Cloudflare account. They are
appropriate for a manual smoke test. Cloudflare documents them as development-only, without an
uptime guarantee, with a limit of 200 in-flight requests and no SSE support. HanabiCode does not
use SSE, but the temporary hostname and unsupported production status make Quick Tunnels
unsuitable for stored host profiles. See the
[Quick Tunnels limits](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

## Cost and limits

The following facts were checked on 2026-08-16. Cloudflare can change plans, limits, and terms, so
release documentation should link to the live sources instead of promising permanent pricing.

### Personal user-owned deployment

Cloudflare Tunnel is available on all Cloudflare plans, including Cloudflare's `$0` Free plan. A
named tunnel that publishes one HanabiCode hostname can therefore cost `$0` in Cloudflare service
charges for a normal personal deployment. The domain registration and VPS remain separate costs.

Cloudflare currently documents these account limits:

- 1,000 `cloudflared` tunnels per account;
- 1,000 combined CIDR and hostname routes per account;
- 25 active replicas per tunnel.

See Cloudflare's [plan page](https://www.cloudflare.com/plans/zero-trust-services/) and
[account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/).

Do not describe the service as unlimited. The free plan has no paid support or uptime SLA, normal
Cloudflare terms and abuse controls apply, and traffic still consumes the VPS provider's network
allowance. Optional products can create charges.

### Features that can add cost

- Buying or renewing a domain.
- Paid Cloudflare Access or WARP capacity if an operator adds those products beyond their current
  free allowances.
- Paid support, contractual SLA, or enterprise controls.
- Cloudflare Load Balancing for cross-host connector redundancy.
- Workers, Durable Objects, logging, or other metered products added around the tunnel.
- VPS bandwidth, storage, and compute.

HanabiCode does not require Cloudflare Access, Workers, Durable Objects, Load Balancing, or WARP
for the user-owned design. Do not enable Argo Smart Routing for this path; Cloudflare's WebSocket
compatibility table currently marks Argo as incompatible with WebSockets.

### If everyone uses Dey's account

The connector may begin at `$0`, but this is still a hosted service. The current 1,000-tunnel and
1,000-route account limits cap the simple one-tunnel-per-daemon design. Public users also create
support, abuse, privacy, availability, and terms-of-service exposure. Free-plan availability is
not a business continuity guarantee.

If HanabiCode later offers a managed service, it should have explicit quotas and a cost model
before public onboarding. Do not infer that a free personal tunnel makes an unbounded public
tunnel service free.

## Security model

### TLS termination is not enough for parity

A basic published application provides TLS from the client to Cloudflare and an encrypted Tunnel
connection from `cloudflared` to Cloudflare. Cloudflare terminates the public TLS connection. If
HanabiCode sends ordinary direct-connection frames through that path, Cloudflare can process the
WebSocket upgrade and can technically observe application plaintext.

The inherited relay path has a stronger property: application frames are encrypted between the
client and daemon using the daemon public key from the pairing offer. The relay only routes
ciphertext. HanabiCode must carry that encrypted-channel handshake over the direct Tunnel
WebSocket before claiming the same security or pairing UX.

The target path is:

```text
client ── HanabiCode ciphertext inside WSS ── Cloudflare ── ciphertext ── daemon
```

Cloudflare can still observe the public hostname, client and origin IP information, connection
timing, connection duration, and frame sizes. It cannot decrypt authenticated HanabiCode
application frames after the E2EE handshake.

`cloudflared` is trusted software running on the daemon host and must be updated and protected like
any other service with local network access. Application E2EE limits what Cloudflare's network
path can read; it does not protect the daemon from a process that has already compromised the VPS.

### Cloudflare Access

Cloudflare Access is optional and should not be required by the first implementation. Interactive
Access login introduces another identity provider, browser callback, cookie lifetime, and native
client flow. Service-token headers are also awkward for browser WebSocket construction.

Use the HanabiCode daemon-key pairing handshake as the application authorization boundary. A
future managed service can layer Access or another identity system on the initial upgrade without
replacing E2EE.

### Tunnel token

The remotely managed tunnel token belongs only on the daemon host. Anyone with it can start a
connector for that tunnel. Store it in the `cloudflared` service configuration or a protected
credential file, never in:

- the repository;
- `.env.example`;
- the HanabiCode pairing link;
- the desktop or mobile app;
- logs or support screenshots.

Rotate a compromised token in the Cloudflare dashboard and terminate existing connector
connections. Cloudflare documents the process in
[Tunnel tokens](https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/).

### Pairing link

The daemon public key and transport descriptor remain in the URL fragment. The fragment is passed
to HanabiCode and is not sent in the HTTP request to Cloudflare. Treat the pairing link as an
operator credential. Regenerate daemon identity when a pairing offer is believed to be exposed.

### Daemon exposure

- Keep the private daemon at `PASEO_LISTEN=127.0.0.1:6769`.
- Map the tunnel only to the dedicated loopback E2EE ingress, proposed as
  `127.0.0.1:6770`.
- Expose only `/ws/e2ee` and a minimal health response on that ingress. Do not expose the legacy
  `/ws`, static application, file preview, or administrative HTTP routes.
- Accept only the exact configured Tunnel hostname; do not disable the Host allowlist for
  convenience.
- Keep the VPS firewall closed to inbound port `6769`.
- Apply Cloudflare rate limits to the initial WebSocket upgrade when appropriate.
- Add daemon-side handshake timeouts, frame limits, and connection limits because WAF inspection
  stops after the WebSocket upgrade.
- Keep Tailscale or SSH access for recovery, but do not publish those credentials in pairing data.

## Current implementation gap

The current source cannot provide the target path without code changes:

- `ConnectionOfferV2` is relay-only and requires a relay endpoint.
- Pairing generation returns no link when relay is disabled.
- The client selects E2EE because a URL has relay `role` and `serverId` query parameters.
- The daemon attaches the E2EE responder to relay data sockets, not direct `/ws` connections.
- Direct connections use TLS plus an optional shared password; they do not use the daemon-key
  E2EE channel.
- There is no HanabiCode command that creates, inspects, or removes a Cloudflare Tunnel.

A named tunnel pointed at the current daemon can be used as a transitional direct connection, but
it does not yet deliver relay-equivalent pairing and E2EE.

## Protocol and code plan

Cloudflare is an infrastructure choice. The wire contract should describe a secure WebSocket
transport without baking the vendor name into connection profiles.

### 1. Add a transport-neutral pairing offer

Add an additive `ConnectionOfferV3` while retaining V2 relay parsing:

```ts
{
  v: 3,
  serverId: "srv_...",
  daemonPublicKeyB64: "...",
  transports: [
    {
      kind: "websocket",
      url: "wss://code.example.com/ws/e2ee",
      e2ee: "daemon-key-v1"
    }
  ]
}
```

Rules:

- Keep V2 valid for existing relay profiles.
- Use pure Zod wire schemas and optional additive server feature flags.
- Validate `https`/`wss`, host, port, and path; reject credentials in URL userinfo.
- Keep the daemon public key outside the transport descriptor.
- Allow an ordered transport array so a later client can try direct E2EE and then a relay or VPN
  endpoint without creating another host.
- Show an actionable update message when an old client receives an unsupported offer version.
- Do not put a Cloudflare tunnel token, API token, or HanabiCode password in the offer.

### 2. Generalize the encrypted WebSocket wrapper

Move the client encrypted-channel wrapper out of its relay-specific selection logic. It already
wraps a WebSocket-like duplex transport and can serve relay or direct WebSocket connections.

- Keep one cryptographic implementation.
- Select E2EE from the parsed transport descriptor, not relay query parameters.
- Preserve binary frames for terminal, file transfer, and port forwarding.
- Let Electron's dedicated port-tunnel connection consume the same generic descriptor instead of
  requiring relay-v2 offer fields.
- Record `relay`, `direct`, or `tunnel` as connection telemetry without making telemetry control
  security behavior.
- Keep bounded pending sends and surface handshake failures in the host connection UI.

### 3. Add an explicit daemon E2EE ingress

Add a second loopback listener, proposed as `127.0.0.1:6770`, instead of publishing the existing
daemon server. It serves `/ws/e2ee` and a minimal health endpoint. All other paths return `404`.

- Load the daemon keypair before accepting application messages.
- Require `e2ee_hello` as the first frame.
- Apply a short handshake timeout and close malformed or oversized handshakes.
- Wrap the accepted physical socket with the existing daemon encrypted channel.
- Attach the decrypted socket to the normal server session only after authentication succeeds.
- Reject plaintext application messages on this route.
- Keep the private `127.0.0.1:6769` server and its `/ws` route for backward-compatible local,
  Tailscale, and direct-password connections.
- Do not serve the application bundle, previews, or normal daemon HTTP APIs from the Tunnel
  listener.

The separate listener avoids guessing whether the first JSON message is an E2EE handshake, keeps
old direct clients working, and prevents Cloudflare from exposing the unauthenticated loopback
control surface.

### 4. Advertise and generate the secure endpoint

Add one feature gate, such as `directE2eePairing`, to `server_info.features`. Add runtime
configuration for the public URL and enable pairing only when:

- direct E2EE support is active;
- the public URL is valid and uses `wss` outside development;
- its hostname is allowed by daemon configuration.

The proposed configuration contract is:

```dotenv
PASEO_HOME=/home/dev/.hanabicode
PASEO_LISTEN=127.0.0.1:6769
PASEO_TUNNEL_LISTEN=127.0.0.1:6770
PASEO_TUNNEL_HOSTNAME=code.example.com
PASEO_TUNNEL_PUBLIC_URL=wss://code.example.com/ws/e2ee
PASEO_APP_BASE_URL=hanabicode://pair
```

The `PASEO_TUNNEL_*` variables are proposed names, not current release configuration. Add them to
the repository `.env.example` only when the implementation consumes them.

The Cloudflare tunnel token remains in the `cloudflared` service environment. It is not a
HanabiCode environment variable.

### 5. Pair and persist one host

Desktop, Android, and web pairing must:

- parse V2 relay and V3 transport offers;
- persist host identity separately from its current endpoint;
- retain the daemon public key as the trust anchor;
- reconnect to the selected transport without asking for Cloudflare credentials;
- allow transport replacement without duplicating workspaces or agents;
- show whether the host is connected through Tunnel, relay, or direct recovery;
- give the Electron main process a short-lived generic E2EE connection lease for Ports;
- keep Ports leases scoped to the host connection and close local listeners on disconnect.

### 6. Add connector setup commands after the protocol works

The first supported release can document dashboard provisioning and let Cloudflare install its
own service. A later `hanabicode tunnel` command can reduce setup friction:

```text
hanabicode tunnel configure
hanabicode tunnel status
hanabicode tunnel pair
hanabicode tunnel disable
hanabicode tunnel doctor
```

`configure` should accept a remotely managed tunnel token and public hostname. It should validate
the hostname, write only non-secret HanabiCode configuration, install or configure a pinned
`cloudflared` version, and store the token using the platform service credential mechanism.

Do not request an account-wide API token for the basic flow. The operator can create the tunnel
and route in the Cloudflare dashboard, then give the host only the connector token. Automated
hostname creation is a separate opt-in flow requiring scoped API permissions.

## Setup after the feature ships

This section describes the intended supported flow. Commands marked **proposed** do not exist in
the current release.

### A. Prepare Cloudflare

The daemon operator needs:

- a Cloudflare account;
- a domain available in that Cloudflare account;
- permission to create a Tunnel and a DNS record;
- outbound access from the daemon host to Cloudflare, including port `7844` where required.

In the Cloudflare dashboard:

1. Open **Networking → Tunnels**.
2. Create a remotely managed tunnel named for the daemon host, such as `hanabicode-vps-1`.
3. Choose Linux and the host architecture.
4. Copy the connector installation command and run it on the daemon host.
5. Add a published application route:
   - hostname: `code.example.com`;
   - service: `http://127.0.0.1:6770`.
6. Wait until the tunnel reports **Healthy**.

Use a stable named tunnel. Do not use a Quick Tunnel for a stored production profile.

### B. Configure the daemon

Set the private daemon listener, dedicated Tunnel listener, exact Tunnel hostname, public URL, and
application scheme using the implemented runtime configuration. Restart the HanabiCode daemon
during a planned window, then verify:

```bash
curl --fail https://code.example.com/api/health
```

The release must provide a **proposed** command that verifies the external upgrade and generates
the pairing link:

```bash
hanabicode tunnel doctor
hanabicode tunnel pair
```

The doctor should test DNS, TLS, HTTP health, WebSocket upgrade, E2EE handshake capability,
daemon hostname acceptance, and client-visible version compatibility without printing secrets.

### C. Install a client

On macOS or Android:

1. Download the HanabiCode release for the platform.
2. Open `hanabicode://pair#offer=...` or scan its QR code.
3. Confirm the displayed hostname and daemon identity.
4. Open a workspace and verify an agent or terminal update.
5. Start a development server on the VPS and use **Ports** to bind it on the Mac.

No Cloudflare action occurs on the client device.

### D. Add another client

Generate another pairing link from the daemon and open it on the new device. Do not copy the
tunnel token or the existing app's local storage. Client revocation is a HanabiCode identity
feature; tunnel-token rotation revokes connectors, not paired app identities.

## Fresh-install checklist

Downloading the desktop or Android application is only the client half of a personal deployment.
One machine must run the HanabiCode daemon and provider CLIs.

### Daemon host or VPS

1. Install the HanabiCode daemon/CLI artifact documented by the release.
2. Create a persistent `PASEO_HOME` owned by the daemon service user.
3. Install and authenticate each provider CLI, such as Codex or Claude Code, under that same user.
4. Add the projects and workspaces that agents may use.
5. Keep the normal daemon listener on loopback.
6. Create the user-owned named Cloudflare Tunnel and dedicated E2EE route described above.
7. Install both the daemon and `cloudflared` as restartable services that start after reboot.
8. Run the Tunnel doctor and generate a pairing offer.
9. Save and test an SSH or Tailscale recovery path.

### macOS desktop

1. Install the matching HanabiCode desktop release.
2. Keep its data directory separate from upstream Paseo.
3. Disable local daemon management when this Mac is only a client of the VPS.
4. Open the VPS pairing link.
5. Verify one agent update, one terminal, and one Ports forward.

### Android

1. Install the matching HanabiCode APK.
2. Allow the `hanabicode://` pairing deep link when Android asks.
3. Scan or open the VPS pairing offer.
4. Verify agent history and a live update over mobile data, not only the home LAN.

### Invited client-only user

An invited user installs HanabiCode and receives a pairing offer from the daemon operator. They do
not install a daemon, provider CLI, domain, or connector. Pairing gives operator-level authority
over the daemon, so do not invite users who should not control its agents and accessible files.

## Transitional setup with the current release

Before direct E2EE pairing ships, an operator can point a named tunnel at the daemon and add a
manual direct host:

```text
tcp://code.example.com:443?ssl=true&password=<shared-secret>
```

The daemon must use a long `PASEO_PASSWORD`, allow `code.example.com` in `PASEO_HOSTNAMES`, and
remain on loopback behind `cloudflared`.

This path provides remote connectivity and the existing workspace UI, including Ports. It has
four limitations:

- pairing is manual instead of the relay QR flow;
- Cloudflare terminates TLS and can technically observe application plaintext and the bearer
  subprotocol;
- the shared password is the application authorization boundary;
- the published route exposes the daemon's full HTTP surface rather than the dedicated E2EE-only
  ingress planned for the supported design.

Do not present this transitional path as relay-equivalent E2EE in releases or security docs.

## Reconnect and lifecycle

Cloudflare states that network deployments may restart edge servers and terminate WebSockets.
Cloudflare also closes idle WebSockets after a period with no traffic. HanabiCode must therefore:

- send protocol heartbeats during idle sessions;
- use exponential reconnect backoff with jitter;
- redo the E2EE handshake on every physical WebSocket;
- restore subscriptions and full snapshots after reconnect;
- close local forwarded-port sockets when their encrypted host channel is lost;
- let users recreate a port forward after reconnect rather than implying a TCP stream resumed;
- distinguish authentication, DNS, TLS, tunnel-offline, and daemon-offline failures;
- survive `cloudflared` update or service restart without duplicating the stored host.

Cloudflare applies WAF and rate-limit rules to the initial HTTP upgrade. It does not inspect
messages after the `101` response. Daemon frame and session limits remain required.

## Operations

### Monitor

Monitor both processes and the external path:

- HanabiCode daemon health and restart count;
- `cloudflared` service health and version;
- tunnel connector state in Cloudflare;
- WebSocket reconnect frequency and close reasons;
- E2EE handshake failures;
- active connections and forwarded streams;
- VPS CPU, memory, open files, and bandwidth;
- Cloudflare account and route counts.

Keep logs free of pairing fragments, passwords, tunnel tokens, API tokens, daemon private keys,
and decrypted frames.

### Update

Update `cloudflared` in a planned window. A single connector restart interrupts active WebSockets.
HanabiCode reconnects control sessions, but active forwarded TCP streams do not resume. Multiple
replicas can reduce connector-process downtime on one origin, while cross-host replicas are not
appropriate for unrelated stateful daemons.

### Rotate a token

Rotate the tunnel token in Cloudflare, install the new token on the daemon host, and terminate old
connector connections if compromise is suspected. Rotation does not change the public hostname or
HanabiCode daemon key.

### Remove

1. Disable new HanabiCode pairing for the Tunnel endpoint.
2. Preserve a Tailscale or SSH recovery path.
3. Stop and uninstall the `cloudflared` service.
4. Delete the published application route and DNS record.
5. Delete the tunnel only after confirming no connector depends on it. Cloudflare tunnel deletion
   is not reversible.
6. Remove the public hostname from `PASEO_HOSTNAMES`.
7. Remove the stored transport from clients or replace it through a new pairing offer.

## Migration from the relay

Migration must not silently reinterpret a relay profile as a Tunnel profile.

1. Ship V3 parsing and direct E2EE while retaining V2 relay support.
2. Configure and verify the named tunnel.
3. Generate a new V3 pairing offer for the existing daemon identity.
4. Add the transport to a clean macOS client and a clean Android client.
5. Verify agents, terminal binary frames, files, one HTTP forward, one WebSocket/HMR forward, and
   reconnect.
6. Re-pair existing clients or add the new transport to the same host through an authenticated
   host-settings flow.
7. Keep the old relay enabled during the observation window.
8. Disable the relay only after the Tunnel path and Tailscale recovery path pass acceptance.
9. Remove upstream relay endpoints from defaults and active pairing offers.

The daemon public key should remain stable through the transport migration. Changing transport
must not create a second host or duplicate agent history.

## Implementation phases

### Phase 1: transport contract

- Add V3 schemas, serialization, parsing, and compatibility tests.
- Add the optional daemon capability flag.
- Define persistent host identity separately from transport descriptors.
- Document unsupported-client behavior.

Estimated effort: one to two engineering days.

### Phase 2: direct E2EE

- Generalize the client encrypted transport.
- Add the dedicated `/ws/e2ee` ingress on the daemon.
- Enforce handshake, frame, timeout, and resource limits.
- Prove text and binary parity with the relay channel.

Estimated effort: three to five engineering days.

### Phase 3: pairing and product UX

- Generate V3 links and QR codes.
- Pair and persist them on desktop and Android.
- Add transport status and actionable failures.
- Keep the same host and workspace state during reconnect.

Estimated effort: two to four engineering days.

### Phase 4: operator tooling

- Add `tunnel configure`, `status`, `doctor`, `pair`, and `disable` commands.
- Add proposed runtime variables to `.env.example`.
- Document dashboard provisioning and token storage.
- Add service-manager guidance without taking ownership of unrelated `cloudflared` installations.

Estimated effort: two to four engineering days.

### Phase 5: packaged acceptance

- Exercise a production-like Linux daemon behind a real named tunnel.
- Pair packaged macOS and Android clients.
- Verify reconnect across daemon, connector, network, and app restarts.
- Verify port forwarding under HTTP, WebSocket/HMR, concurrent streams, and backpressure.
- Update security, connectivity, release, and troubleshooting docs.

Estimated effort: two to three engineering days plus observation time.

The complete user-owned path is approximately one to two focused engineering weeks. A public
HanabiCode-managed provisioning service is a separate multi-week product and operations project.

## Acceptance matrix

| Area                | Required evidence                                                                 |
| ------------------- | --------------------------------------------------------------------------------- |
| Cloudflare setup    | Named tunnel healthy; exact hostname routes to loopback daemon                    |
| Pairing             | Fresh macOS and Android installs accept one V3 link without Cloudflare login      |
| Trust               | Wrong daemon key fails before application messages are accepted                   |
| Plaintext rejection | `/ws/e2ee` rejects ordinary JSON application messages                             |
| Control plane       | Agent list, history, prompts, permissions, and updates work                       |
| Binary frames       | Terminal, file transfer, and port-tunnel frames preserve binary semantics         |
| Ports               | HTTP, WebSocket/HMR, concurrent connections, half-close, and stop work            |
| Reconnect           | Edge close, `cloudflared` restart, daemon restart, and app restart recover        |
| Failure UX          | DNS, TLS, tunnel offline, daemon offline, auth, and version errors are distinct   |
| Resource safety     | Handshake timeout, frame limits, connection caps, and backpressure are bounded    |
| Compatibility       | V2 relay profiles still connect; unsupported V3 clients receive update guidance   |
| Secrets             | No token, password, pairing fragment, or private key appears in logs or artifacts |
| Recovery            | Saved Tailscale or SSH procedure reaches the daemon when Tunnel is unavailable    |

Do not declare Tunnel the default until the packaged macOS and Android rows pass against a real
named tunnel.

## Source links

- [Cloudflare Tunnel overview](https://developers.cloudflare.com/tunnel/)
- [Create a tunnel and publish an application](https://developers.cloudflare.com/tunnel/setup/)
- [Tunnel routing and protocol behavior](https://developers.cloudflare.com/tunnel/routing/)
- [Cloudflare WebSocket behavior](https://developers.cloudflare.com/network/websockets/)
- [Tunnel tokens and rotation](https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/)
- [Cloudflare account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/)
- [Cloudflare Zero Trust plans](https://www.cloudflare.com/plans/zero-trust-services/)
- [Quick Tunnel restrictions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
