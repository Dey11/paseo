import { describe, expect, it } from "vitest";
import type { HostProfile } from "@/types/host-connection";
import { defaultHostAppearance } from "@/hosts/appearance";
import { buildDesktopPortForwardingLease } from "./lease";

function makeHost(connections: HostProfile["connections"]): HostProfile {
  return {
    serverId: "host-1",
    label: "Host",
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections,
    preferredConnectionId: connections[0]?.id ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("desktop port-forwarding leases", () => {
  it("builds a direct TCP lease without exposing unrelated connections", () => {
    const host = makeHost([
      {
        id: "tcp-1",
        type: "directTcp",
        endpoint: "devbox.test:6767",
        useTls: true,
        password: "secret",
      },
    ]);

    expect(
      buildDesktopPortForwardingLease({
        host,
        activeConnectionId: "tcp-1",
        appVersion: "1.2.3",
      }),
    ).toEqual({
      serverId: "host-1",
      connectionId: "tcp-1",
      url: "wss://devbox.test:6767/ws",
      password: "secret",
      appVersion: "1.2.3",
    });
  });

  it("builds an end-to-end encrypted relay lease", () => {
    const host = makeHost([
      {
        id: "relay-1",
        type: "relay",
        relayEndpoint: "relay.example.test:443",
        useTls: true,
        daemonPublicKeyB64: "public-key",
      },
    ]);

    const lease = buildDesktopPortForwardingLease({
      host,
      activeConnectionId: "relay-1",
      appVersion: null,
    });

    expect(lease).toMatchObject({
      serverId: "host-1",
      connectionId: "relay-1",
      daemonPublicKeyB64: "public-key",
    });
    expect(lease?.url).toContain("relay.example.test");
    expect(lease?.url).toContain("role=client");
    expect(lease?.url).toContain("serverId=host-1");
  });

  it("rejects local socket and stale active-connection leases", () => {
    const host = makeHost([{ id: "socket-1", type: "directSocket", path: "/tmp/paseo.sock" }]);

    expect(
      buildDesktopPortForwardingLease({
        host,
        activeConnectionId: "socket-1",
        appVersion: null,
      }),
    ).toBeNull();
    expect(
      buildDesktopPortForwardingLease({
        host,
        activeConnectionId: "missing",
        appVersion: null,
      }),
    ).toBeNull();
  });
});
