# Desktop workspace port forwarding

Status: planned. No production implementation exists yet.

This feature gives Paseo Desktop an SSH `-L`-style path to a service running on the remote daemon host. You start a server in a workspace terminal, open the **Ports** tab in the right sidebar, and forward its port to the desktop loopback interface. Your Mac browser then opens a local URL while the service continues to run on the VPS.

The first release targets the Electron desktop app and a Linux daemon host. The protocol and daemon design must leave room for mobile, but mobile UI and mobile background networking are out of scope.

## Product decision

Add **Ports** beside **Files** in the right-sidebar header:

`Changes | Files | Ports | PR`

Show the tab only in Electron. Keep it visible when the selected host needs an update; the tab content should explain that the host does not support port forwarding. Do not expose an incomplete tab in browser web, Android, or iOS.

Each row shows:

- remote port;
- owning terminal or configured service when known;
- process name when discovery can provide it;
- remote bind address;
- local endpoint after forwarding;
- state: available, starting, forwarded, disconnected, or failed.

Available rows have **Forward**. Forwarded rows have **Open**, **Copy URL**, and **Stop**. **Open** is available for HTTP and HTTPS services; an unknown TCP service can still be forwarded and its endpoint copied. Treat protocol as a display hint, not tunnel behavior. Take the hint from configured service metadata or user selection, default an automatically observed development port to HTTP, and never probe an unknown service automatically.

Include **Forward a port** for containers, daemonized processes, and services that automatic discovery cannot attribute. A manual forward still targets the selected workspace and the daemon loopback interface. It does not permit an arbitrary destination host.

Try the same local port first. If it is occupied, select an ephemeral local port and show the actual endpoint. Bind to `127.0.0.1` only in the first release. Do not bind to the LAN, Tailscale, or `0.0.0.0` interfaces.

Forwards are explicit and last for the current desktop session. Do not restore them automatically after an app restart in the first release. Stop them when the user stops the forward, the host disconnects, the desktop app exits, or the daemon revokes the forward. Existing TCP streams end on a relay disconnect; new local connections can work after the tunnel reconnects.

## User path

1. You start `npm run dev` or another server in a Paseo terminal on the VPS.
2. The daemon observes a listening TCP socket owned by that terminal's process tree.
3. The desktop **Ports** tab receives a workspace-scoped update.
4. You select **Forward** on port `3000`.
5. Electron binds `127.0.0.1:3000`, or another free local port.
6. Paseo authorizes the remote target and opens a tunnel stream when a local program connects.
7. You open `http://127.0.0.1:3000` in the Mac browser.
8. HTTP, WebSocket/HMR, SSE, uploads, and other TCP traffic pass through the encrypted Paseo connection.

## Data path

```text
Mac browser
  -> Electron main-process loopback listener
  -> dedicated encrypted Paseo tunnel connection
  -> relay.paseo.sh (opaque frame routing)
  -> VPS daemon port-forward service
  -> 127.0.0.1:<remote port> on the VPS
```

Use a raw TCP tunnel. Do not implement an HTTP reverse proxy in the data path. TCP preserves WebSockets, HMR, SSE, uploads, and non-HTTP development services without protocol-specific rewriting.

The Electron main process owns local sockets. The React renderer must not bind ports or carry every data chunk across renderer IPC. The main process opens one dedicated encrypted daemon connection per remote host and multiplexes active forwards and TCP streams over it. Do not open a relay WebSocket for every browser TCP connection.

Keep tunnel traffic off the renderer's agent/control WebSocket. A large frontend response must not delay terminal output, agent events, or commands. The dedicated connection still uses the existing pairing offer, daemon public key, relay endpoint, encrypted handshake, and normal daemon session authentication.

## Official relay compatibility

The design is technically compatible with the current official relay:

- the daemon and desktop both initiate outbound WebSockets, so the VPS needs no inbound port;
- the relay pairs sockets by `serverId`, role, and v2 `connectionId` rather than by an official-app signature;
- application frames are opaque and end-to-end encrypted;
- the relay supports bidirectional binary frames;
- tunnel chunks will stay far below the relay's frame limit.

No client attestation, bundle-ID allowlist, or fork check appears in the current connection protocol. A protocol-compatible fork can therefore establish the same second client connection and send new encrypted daemon messages without a relay change.

This is not a service guarantee. `relay.paseo.sh` is upstream-operated infrastructure, and no published commitment grants third-party forks unlimited sustained bandwidth. The operator can add quotas, policy, or protocol changes. Treat the official relay as an external dependency:

- run a bounded real-relay compatibility smoke test before merging the feature;
- do not load-test the production relay;
- cap streams, queued bytes, and transfer rates in the client and daemon;
- keep direct/Tailscale connectivity usable;
- keep the transport adapter independent enough to point at a fork-owned relay later.

The first proof should browse a small development page, exercise one WebSocket, and reconnect once. If ordinary bounded traffic is rejected or destabilizes the control connection, stop and choose a fork-owned relay or Tailscale transport before building the full UI.

## Domain model

| Term | Meaning | Owner |
| --- | --- | --- |
| Port | A listening TCP endpoint observed for a workspace terminal or declared service | Daemon, keyed by `workspaceId` |
| Port forward | The user's mapping from one remote port to one desktop loopback listener | Electron plus daemon session |
| Tunnel | The encrypted multiplexed byte transport carrying port-forward streams | Electron and daemon |
| Tunnel stream | One TCP connection accepted by the local listener and connected to the remote target | Electron and daemon |
| Local endpoint | The bound `127.0.0.1:<port>` address on the desktop | Electron |

Ports are workspace-owned. Two workspaces can share a `cwd`; their terminals and forwards must remain separate. Use `workspaceId` for discovery, authorization, UI state, and cleanup. The selected right-sidebar tab can continue using its existing checkout memory, but port contents cannot use `(serverId, cwd)` as identity.

## Component boundaries

### Daemon: listening-port observer

Add a focused observer under `packages/server` with an operating-system adapter. The Linux adapter should:

1. receive the root PTY process ID for each live terminal;
2. walk its descendant process tree through `/proc`;
3. read listening IPv4 and IPv6 TCP socket inodes;
4. match those inodes to descendant process file descriptors;
5. emit a stable, deduplicated workspace snapshot.

Extend the internal terminal-worker contract to expose the PTY root PID. Do not expose the PID as a public product identifier.

Poll only while a client watches Ports or a forward is active. Start with a two-second interval, refresh after terminal create/exit, and measure daemon cost before tuning. Parsing terminal output is not a discovery mechanism.

Attribute a socket only through terminal process lineage or an explicit configured workspace service. Do not infer ownership from `cwd` alone: same-directory sibling workspaces would leak state. A container, re-parented daemon, different user, or separate network namespace may be invisible. Show configured services and allow manual forwarding for those cases. A first-release target is eligible when it listens on IPv4/IPv6 loopback or a wildcard address. Report an exact non-loopback bind as unavailable instead of widening the daemon's destination policy.

Initial discovery support is Linux. Advertise discovery support separately from tunnel support so a desktop client can still manually forward on a host where automatic discovery is unavailable.

### Daemon: port-forward service

Add a session-owned service that:

- validates `workspaceId` and the requested TCP port;
- accepts an observed port, a configured service port, or an explicit manual port;
- restricts the target host to daemon loopback in the first release;
- returns an opaque forward ID;
- opens one VPS TCP socket for each incoming tunnel stream;
- propagates half-close and close in both directions;
- enforces per-stream and aggregate flow-control limits;
- tears everything down with the daemon session.

Manual entry is not permission to connect to another machine from the VPS. Reject destination hosts, Unix sockets, UDP, privileged special cases, and invalid port ranges.

### Protocol and client

Add optional capability flags to `server_info.features`:

- `workspacePortForwarding` for tunnel control and binary streams;
- `workspacePortDiscovery` for automatic port snapshots.

Tag both compatibility gates with `COMPAT(...)`. A new desktop with an old daemon should show the update-host state and send no unsupported requests. Old clients must continue parsing messages from a new daemon; only subscribed clients receive port updates.

Use dotted request/response names. Final names should follow these domains:

- `workspace.port.watch.request` / `.response`;
- `workspace.port.unwatch.request` / `.response`;
- `workspace.port.update` for subscribed snapshot changes;
- `workspace.port_forward.create.request` / `.response`;
- `workspace.port_forward.delete.request` / `.response`.

Add a distinct binary frame family for tunnel streams instead of base64-encoding bytes in JSON. The frame contract needs:

- forward ID and stream ID;
- open, open-result, data, window-update, half-close, and close operations;
- bounded payload length;
- explicit rejection of malformed, unknown, or oversized frames.

Use chunks no larger than 64 KiB for the first implementation. Add credit-based flow control: pause the source socket when the peer's window is exhausted and resume it only after a window update. Keep the aggregate queued-byte ceiling below the existing physical WebSocket high-water mark. Measure and set the final constants during the transport spike.

TCP streams do not resume after reconnection. Close them with a concrete reason. Keep the local listener alive while the tunnel reconnects so a browser refresh can create a new stream.

### Electron main and preload

Add a cohesive `port-forwarding` feature under `packages/desktop/src/features`. It owns:

- the dedicated daemon client per host;
- local `node:net` servers and accepted sockets;
- stream multiplexing and backpressure;
- cleanup on renderer destruction, window close, host replacement, and app quit;
- validated IPC commands and state events.

Expose a narrow preload API for create, stop, list, and status subscription. Validate all renderer inputs in the main process. Keep preload imports type-only except for Electron, matching the existing sandbox rule.

The renderer supplies a validated relay connection lease containing the selected host's v2 offer fields. Do not persist another copy of pairing secrets in the desktop package. The main process discards the lease and closes its tunnel connection when no forwards remain after a short idle period.

### App: Ports tab

Extend `ExplorerTab` with `"ports"`, its persistence validator, and store migration. Insert the tab after Files in `packages/app/src/components/explorer-sidebar.tsx`. Gate it with `getIsElectron()` and render a new focused pane rather than adding port behavior to the file panes.

The pane subscribes only while the right sidebar is open on Ports. Merge daemon observations with Electron-local forward state by stable remote identity. Keep rows dense and use existing status, button, loading, and empty-state primitives.

Required UI states:

- host update required;
- tunnel supported, discovery unsupported;
- loading first snapshot;
- no ports found;
- available port;
- starting local listener;
- forwarded with local endpoint;
- relay/host disconnected;
- local port collision with automatic fallback;
- rejected or failed remote connection;
- port disappeared while a forward remains open.

Translate client-owned labels, actions, empty states, and error wrappers in every supported locale. Do not translate process names, terminal names, addresses, URLs, or raw daemon diagnostics.

## Security and resource limits

This feature turns an authenticated Paseo client into a network pivot through the daemon. Preserve these limits:

- pair only through the existing daemon trust anchor and E2E handshake;
- bind desktop listeners to loopback;
- connect daemon sockets to loopback;
- require a user-created forward for each remote port;
- scope every forward to one authenticated daemon session and `workspaceId`;
- use opaque IDs and validate every control and binary frame;
- limit active forwards, streams per forward, queued bytes, and frame size;
- pause sockets under backpressure rather than buffering without a bound;
- log addresses, IDs, byte counts, and close reasons, never tunneled contents;
- close forwards on session loss, app quit, workspace archive, or explicit stop.

Anyone holding a valid pairing offer can control the daemon and would also be able to request a forward. Treat pairing links shared with friends as daemon-operator credentials.

## Decision map and delivery tickets

Each ticket should fit one focused development session. Complete them in dependency order. Use TDD for protocol codecs, socket lifecycle, discovery attribution, and UI state reducers.

### 1. Prove the transport path

**Decision:** Can a dedicated fork client carry bounded TCP data through the official relay without changing it or starving normal Paseo traffic?

Build a disposable, manual-port spike with no sidebar UI. Open one dedicated encrypted connection, carry chunked data to a daemon loopback echo/HTTP server, and verify WebSocket traffic. Exercise normal agent/terminal traffic at the same time. Test locally against the open-source relay first, then run one bounded smoke test through `relay.paseo.sh`.

**Exit:** HTTP, WebSocket, bidirectional data, clean close, and one reconnect behave as specified; normal control traffic remains responsive; production relay emits no rejection attributable to fork identity or frame type. Record latency, close codes, and measured queue sizes. If this fails, stop the plan and decide between a fork-owned relay and Tailscale transport.

### 2. Specify and test tunnel binary frames

Define opcodes and encode/decode functions in `packages/protocol/src/binary-frames`. Extend the central demux. Cover truncated headers, unknown IDs, invalid operations, oversize payloads, and byte-exact round trips.

**Exit:** focused protocol tests pass and existing terminal/file frame families remain unchanged.

### 3. Build the daemon port-forward service

Implement forward authorization, remote loopback sockets, stream lifecycle, flow control, limits, and session cleanup using real local TCP fixtures. Add capability advertisement and dotted control messages.

**Exit:** focused daemon tests prove echo, HTTP, WebSocket-style duplex traffic, half-close, refusal, invalid workspace/port rejection, backpressure, disconnect cleanup, and concurrent stream isolation.

### 4. Build the Electron tunnel manager

Move the spike into a main-process module. Add the dedicated host connection, loopback listener, validated IPC, preload API, idle teardown, and quit cleanup. Prefer the requested local port and fall back to an ephemeral port on collision.

**Exit:** focused desktop tests use real loopback sockets to prove listener ownership, collision fallback, multiplexing, state events, renderer-loss cleanup, and app-quit cleanup.

### 5. Ship manual forwarding in the Ports tab

Add the Electron-only tab, host capability gate, manual port form, forward rows, actions, i18n, and persistence migration. Keep content keyed by `workspaceId`.

**Exit:** a packaged-development Electron run can manually forward a known VPS port, open it in the external browser, copy the endpoint, stop it, and recover after relay reconnect. Browser web and native do not render the tab.

### 6. Add Linux terminal-owned discovery

Expose PTY root PIDs through the internal terminal worker contract. Implement the Linux `/proc` adapter, observer lifecycle, snapshot RPCs, and subscription. Combine discovered sockets with configured service ports.

**Exit:** fixture-backed parser tests cover IPv4, IPv6, descendants, terminal exit, port disappearance, duplicate sockets, two same-`cwd` workspaces, ambiguous processes, and unsupported hosts. An integration test starts real terminal child servers and attributes each port to the correct workspace.

### 7. Integrate discovered rows

Replace manual-only UI with the merged observation model. Add terminal/service labels, protocol hints, automatic refresh, disappearance behavior, and the manual fallback.

**Exit:** starting and stopping a service in a workspace terminal adds and removes the correct row without leaking it into a same-directory sibling workspace.

### 8. Harden flow control and failure recovery

Test slow consumers, large responses, uploads, many browser asset connections, HMR reconnect loops, relay loss, daemon restart, desktop sleep/wake, and host switching. Tune chunk, credit, idle, and concurrency limits from measurements.

**Exit:** memory stays within the chosen bounds, control traffic stays responsive, every failure becomes a stable UI state, and no stream or listener survives its owner.

### 9. Complete desktop acceptance

Run focused automated checks, real-Electron E2E, and packaged-app QA. The primary manual matrix is macOS desktop to a Linux VPS through the official relay. Also run the deterministic tunnel tests on direct/local transport. Record Windows and Linux desktop as tested or untested; do not claim coverage without evidence.

Acceptance scenarios:

1. Vite/Next-style page load plus WebSocket HMR.
2. Backend HTTP API, SSE, and a moderate upload/download.
3. Same remote and local port available.
4. Local port occupied and fallback selected.
5. Two workspaces with the same `cwd` but different terminals.
6. Multiple browser connections through one forward.
7. Relay disconnect during a request, followed by browser refresh.
8. Stop forward, close workspace, switch host, and quit app.
9. Manual port for a Docker or daemonized service.
10. Old daemon capability state.

### 10. Document operation and fallback

After implementation, update the architecture, protocol, testing, security, connectivity, and fork docs at the sections that own the new behavior. Document Tailscale/direct recovery and the fork-owned relay escape hatch. Do not describe the feature as mobile-ready until mobile lifecycle and browser behavior have their own design and evidence.

## Explicit non-goals

- public shareable URLs;
- LAN-visible local listeners;
- UDP forwarding;
- arbitrary remote destination hosts;
- reverse forwarding from the VPS to the desktop;
- HTTPS certificate generation or hostname rewriting;
- transparent resumption of existing TCP streams;
- automatic forward restoration after restart;
- discovering every container or network namespace;
- Android or iOS UI in the first release.

## Future mobile path

The daemon observer, authorization rules, protocol, and binary tunnel can be shared with mobile. A phone cannot copy the desktop implementation unchanged: mobile operating systems suspend background listeners, and an external mobile browser cannot reliably reach a listener owned by a suspended app. A later mobile decision should compare an in-app browser/WebView, an OS VPN/tunnel integration, and relay-issued browser access. None of those choices should shape the desktop MVP beyond keeping the protocol client-neutral.
