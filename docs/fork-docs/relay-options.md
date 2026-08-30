# Relay deployment

HanabiCode uses `relay.paseo.sh:443` over TLS for the current release. This gives macOS and Android the normal Paseo pairing flow without opening a public inbound port on the VPS. Application frames remain end-to-end encrypted between the client and daemon.

The native installer writes the endpoint and TLS policy into the systemd user service. `--relay-endpoint` changes the routed endpoint, `--relay-use-tls true|false` controls transport TLS, and `--no-relay` keeps a direct-only installation. Tailscale remains the saved recovery connection.

## Future self-hosting

Self-host the production implementation from `getpaseo/paseo-relay`, not the Cloudflare Durable Objects adapter in `packages/relay`. The monorepo package remains because the inherited build and encrypted-channel code depend on it, but upstream does not deploy that adapter as the production relay.

Treat self-hosting as infrastructure work. The phase must cover:

- a fork-owned hostname and TLS certificate;
- deployment and rollback for the Elixir service;
- reconnect behavior and bounded queues;
- health checks, logs, metrics, and alerting;
- compatibility across independently upgraded daemon and clients;
- end-to-end tests for control messages, binary tunnel frames, Android background/resume, and long-thread loading.

Do not replace or invent cryptography. Reuse Paseo's reviewed encrypted-channel and pairing primitives. After the new endpoint passes those checks, update the native service with the installer and pair each client again.
