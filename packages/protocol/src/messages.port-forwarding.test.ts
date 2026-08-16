import { describe, expect, it } from "vitest";

import {
  parseServerInfoStatusPayload,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WorkspacePortForwardCreateRequestSchema,
  WorkspacePortForwardCreateResponseSchema,
  WorkspacePortForwardDeleteRequestSchema,
  WorkspacePortForwardDeleteResponseSchema,
  WorkspacePortObservationSchema,
  WorkspacePortUnwatchRequestSchema,
  WorkspacePortUnwatchResponseSchema,
  WorkspacePortUpdateMessageSchema,
  WorkspacePortWatchRequestSchema,
  WorkspacePortWatchResponseSchema,
} from "./messages.js";

const observation = {
  port: 3000,
  bindAddress: "127.0.0.1",
  source: "observed",
  available: true,
  unavailableReason: null,
  protocol: "http",
  terminalId: "term-1",
  terminalTitle: "dev server",
  processName: "node",
  serviceName: null,
  observedAt: "2026-08-16T00:00:00.000Z",
} as const;

describe("workspace port request schemas", () => {
  it("parses watch requests", () => {
    expect(
      WorkspacePortWatchRequestSchema.parse({
        type: "workspace.port.watch.request",
        workspaceId: "ws-1",
        requestId: "req-1",
      }),
    ).toEqual({
      type: "workspace.port.watch.request",
      workspaceId: "ws-1",
      requestId: "req-1",
    });
  });

  it("parses unwatch requests", () => {
    expect(
      WorkspacePortUnwatchRequestSchema.parse({
        type: "workspace.port.unwatch.request",
        workspaceId: "ws-1",
        requestId: "req-1",
      }),
    ).toEqual({
      type: "workspace.port.unwatch.request",
      workspaceId: "ws-1",
      requestId: "req-1",
    });
  });

  it("parses forward create requests with a protocol hint and source", () => {
    expect(
      WorkspacePortForwardCreateRequestSchema.parse({
        type: "workspace.port_forward.create.request",
        workspaceId: "ws-1",
        port: 3000,
        protocol: "https",
        source: "configured",
        requestId: "req-1",
      }),
    ).toEqual({
      type: "workspace.port_forward.create.request",
      workspaceId: "ws-1",
      port: 3000,
      protocol: "https",
      source: "configured",
      requestId: "req-1",
    });
  });

  it("parses manual forward create requests without optional fields", () => {
    expect(
      WorkspacePortForwardCreateRequestSchema.parse({
        type: "workspace.port_forward.create.request",
        workspaceId: "ws-1",
        port: 5432,
        requestId: "req-1",
      }),
    ).toEqual({
      type: "workspace.port_forward.create.request",
      workspaceId: "ws-1",
      port: 5432,
      requestId: "req-1",
    });
  });

  it("rejects invalid forward ports", () => {
    for (const port of [0, -1, 65536, 1.5, "3000"]) {
      expect(() =>
        WorkspacePortForwardCreateRequestSchema.parse({
          type: "workspace.port_forward.create.request",
          workspaceId: "ws-1",
          port,
          requestId: "req-1",
        }),
      ).toThrow();
    }
  });

  it("parses forward delete requests", () => {
    expect(
      WorkspacePortForwardDeleteRequestSchema.parse({
        type: "workspace.port_forward.delete.request",
        workspaceId: "ws-1",
        forwardId: "fwd-1",
        requestId: "req-1",
      }),
    ).toEqual({
      type: "workspace.port_forward.delete.request",
      workspaceId: "ws-1",
      forwardId: "fwd-1",
      requestId: "req-1",
    });
  });

  it("rejects empty forward ids", () => {
    expect(() =>
      WorkspacePortForwardDeleteRequestSchema.parse({
        type: "workspace.port_forward.delete.request",
        workspaceId: "ws-1",
        forwardId: "",
        requestId: "req-1",
      }),
    ).toThrow();
  });

  it("accepts the requests on the session inbound union", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "workspace.port.watch.request",
        workspaceId: "ws-1",
        requestId: "req-1",
      }).type,
    ).toBe("workspace.port.watch.request");
    expect(
      SessionInboundMessageSchema.parse({
        type: "workspace.port_forward.create.request",
        workspaceId: "ws-1",
        port: 3000,
        requestId: "req-1",
      }).type,
    ).toBe("workspace.port_forward.create.request");
  });
});

describe("workspace port response and update schemas", () => {
  it("parses watch and unwatch responses", () => {
    expect(
      WorkspacePortWatchResponseSchema.parse({
        type: "workspace.port.watch.response",
        payload: {
          workspaceId: "ws-1",
          success: true,
          error: null,
          requestId: "req-1",
        },
      }).payload,
    ).toEqual({
      workspaceId: "ws-1",
      success: true,
      error: null,
      requestId: "req-1",
    });

    expect(
      WorkspacePortUnwatchResponseSchema.parse({
        type: "workspace.port.unwatch.response",
        payload: {
          workspaceId: "ws-1",
          success: false,
          error: "not subscribed",
          requestId: "req-1",
        },
      }).payload,
    ).toEqual({
      workspaceId: "ws-1",
      success: false,
      error: "not subscribed",
      requestId: "req-1",
    });
  });

  it("parses forward create responses with a forward id", () => {
    expect(
      WorkspacePortForwardCreateResponseSchema.parse({
        type: "workspace.port_forward.create.response",
        payload: {
          workspaceId: "ws-1",
          port: 3000,
          forwardId: "fwd-1",
          error: null,
          requestId: "req-1",
        },
      }).payload,
    ).toEqual({
      workspaceId: "ws-1",
      port: 3000,
      forwardId: "fwd-1",
      error: null,
      requestId: "req-1",
    });
  });

  it("parses forward create failures with a null forward id", () => {
    expect(
      WorkspacePortForwardCreateResponseSchema.parse({
        type: "workspace.port_forward.create.response",
        payload: {
          workspaceId: "ws-1",
          port: 3000,
          forwardId: null,
          error: "port not attributable to workspace",
          requestId: "req-1",
        },
      }).payload.forwardId,
    ).toBeNull();
  });

  it("parses forward delete responses", () => {
    expect(
      WorkspacePortForwardDeleteResponseSchema.parse({
        type: "workspace.port_forward.delete.response",
        payload: {
          workspaceId: "ws-1",
          forwardId: "fwd-1",
          success: true,
          error: null,
          requestId: "req-1",
        },
      }).payload,
    ).toEqual({
      workspaceId: "ws-1",
      forwardId: "fwd-1",
      success: true,
      error: null,
      requestId: "req-1",
    });
  });

  it("parses a full port update snapshot", () => {
    expect(
      WorkspacePortUpdateMessageSchema.parse({
        type: "workspace.port.update",
        payload: {
          workspaceId: "ws-1",
          ports: [observation],
        },
      }).payload.ports,
    ).toEqual([observation]);
  });

  it("parses updates with the minimal observation shape", () => {
    expect(
      WorkspacePortObservationSchema.parse({
        port: 3000,
        bindAddress: "::",
        source: "manual",
        available: true,
        unavailableReason: null,
      }),
    ).toEqual({
      port: 3000,
      bindAddress: "::",
      source: "manual",
      available: true,
      unavailableReason: null,
    });
  });

  it("strips unknown observation fields on parse", () => {
    // New daemon fields must not break an old client's parse.
    expect(
      WorkspacePortObservationSchema.parse({
        port: 3000,
        bindAddress: "127.0.0.1",
        source: "observed",
        available: false,
        unavailableReason: "bound to a non-loopback address",
        futureField: true,
      }),
    ).toEqual({
      port: 3000,
      bindAddress: "127.0.0.1",
      source: "observed",
      available: false,
      unavailableReason: "bound to a non-loopback address",
    });
  });

  it("accepts the update message on the session outbound union", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "workspace.port.update",
        payload: {
          workspaceId: "ws-1",
          ports: [observation],
        },
      }).type,
    ).toBe("workspace.port.update");
    expect(
      SessionOutboundMessageSchema.parse({
        type: "workspace.port_forward.create.response",
        payload: {
          workspaceId: "ws-1",
          port: 3000,
          forwardId: "fwd-1",
          error: null,
          requestId: "req-1",
        },
      }).type,
    ).toBe("workspace.port_forward.create.response");
  });
});

describe("workspace port capability flags", () => {
  it("accepts both port feature flags", () => {
    const parsed = parseServerInfoStatusPayload({
      status: "server_info",
      serverId: "srv-1",
      features: {
        workspacePortForwarding: true,
        workspacePortDiscovery: true,
      },
    });

    expect(parsed?.features?.workspacePortForwarding).toBe(true);
    expect(parsed?.features?.workspacePortDiscovery).toBe(true);
  });

  it("keeps both flags absent for daemons that do not advertise them", () => {
    // An old daemon's server_info must still parse and leave the new
    // capabilities undefined so the client shows the update-host state.
    const parsed = parseServerInfoStatusPayload({
      status: "server_info",
      serverId: "srv-1",
      features: {
        plugins: true,
      },
    });

    expect(parsed?.features?.plugins).toBe(true);
    expect(parsed?.features?.workspacePortForwarding).toBeUndefined();
    expect(parsed?.features?.workspacePortDiscovery).toBeUndefined();
  });

  it("parses a server_info without any features object", () => {
    const parsed = parseServerInfoStatusPayload({
      status: "server_info",
      serverId: "srv-1",
    });

    expect(parsed?.features?.workspacePortForwarding).toBeUndefined();
    expect(parsed?.features?.workspacePortDiscovery).toBeUndefined();
  });
});
