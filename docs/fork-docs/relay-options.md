# Relay alternatives

HanabiCode does not use or operate a relay. The selected topology is a direct daemon connection over Tailscale, followed by an optional private [Cloudflare Tunnel](cloudflare-tunnel.md) phase.

Keep `packages/relay` only because it remains part of the inherited build and protocol dependency graph. Do not deploy its Cloudflare Durable Objects adapter, fork the external Paseo relay, set relay endpoints in HanabiCode releases, or direct users to `relay.paseo.sh`.

Revisit a relay only if direct private networking cannot meet the mobile workflow. A future decision must account for application-layer end-to-end encryption, pairing compatibility, binary tunnel frames, reconnect behavior, bounded queues, service ownership, monitoring, and independent daemon/client upgrades. Reuse the existing reviewed encrypted-channel primitives; do not create new cryptography for convenience.
