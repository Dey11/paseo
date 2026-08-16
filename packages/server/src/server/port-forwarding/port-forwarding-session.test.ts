/* eslint-disable max-nested-callbacks */
import { afterEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { decodeTunnelFrame, TunnelOpcode } from "@getpaseo/protocol/binary-frames/index";
import type { SessionOutboundMessage } from "../messages.js";
import {
  PortForwardingSession,
  type PortForwardingInboundMessage,
} from "./port-forwarding-session.js";

const logger = pino({ level: "silent" });

const activeServers: Server[] = [];

afterEach(async () => {
  for (const server of activeServers) {
    await closeServer(server).catch(() => {});
  }
  activeServers.length = 0;
});

function trackServer(server: Server): Server {
  activeServers.push(server);
  return server;
}

function listen(server: Server): Promise<number> {
  trackSockets(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    for (const socket of trackedSockets) {
      socket.destroy();
    }
  });
}

const trackedSockets = new Set<import("node:net").Socket>();

function trackSockets(server: Server): void {
  server.on("connection", (socket) => {
    trackedSockets.add(socket);
    socket.on("close", () => {
      trackedSockets.delete(socket);
    });
  });
}

function startEchoServer(): Promise<{ server: Server; port: number; received: string[] }> {
  const received: string[] = [];
  const server = trackServer(createServer());
  return listen(server).then((port) => {
    server.on("connection", (socket) => {
      socket.on("data", (chunk: Buffer) => {
        received.push(chunk.toString());
        socket.write(chunk);
      });
    });
    return { server, port, received };
  });
}

interface FeatureHarness {
  feature: PortForwardingSession;
  messages: SessionOutboundMessage[];
  binaryFrames: Uint8Array[];
  setServices: (ports: Array<{ port: number; scriptName: string }>) => void;
  setWorkspace: (workspace: { workspaceId: string; archivedAt: string | null } | null) => void;
}

function makeHarness(options?: {
  services?: Array<{ port: number; scriptName: string }>;
  workspace?: { workspaceId: string; archivedAt: string | null } | null;
}): FeatureHarness {
  const messages: SessionOutboundMessage[] = [];
  const binaryFrames: Uint8Array[] = [];
  let services = options?.services ?? [];
  let workspace: { workspaceId: string; archivedAt: string | null } | null =
    options?.workspace === undefined
      ? { workspaceId: "ws-1", archivedAt: null }
      : options.workspace;
  const feature = new PortForwardingSession({
    host: {
      emit: (message) => messages.push(message),
      emitBinary: (frame) => binaryFrames.push(frame),
    },
    getWorkspace: async () => workspace,
    listTerminalRootPids: () => [],
    listServicePorts: async () => services,
    logger,
  });
  return {
    feature,
    messages,
    binaryFrames,
    setServices: (next) => {
      services = next;
    },
    setWorkspace: (next) => {
      workspace = next;
    },
  };
}

function watchRequest(workspaceId: string, requestId = "req-watch"): PortForwardingInboundMessage {
  return { type: "workspace.port.watch.request", workspaceId, requestId };
}

function unwatchRequest(
  workspaceId: string,
  requestId = "req-unwatch",
): PortForwardingInboundMessage {
  return { type: "workspace.port.unwatch.request", workspaceId, requestId };
}

function createRequest(
  workspaceId: string,
  port: number,
  requestId = "req-create",
): PortForwardingInboundMessage {
  return { type: "workspace.port_forward.create.request", workspaceId, port, requestId };
}

function deleteRequest(
  forwardId: string,
  workspaceId: string,
  requestId = "req-delete",
): PortForwardingInboundMessage {
  return { type: "workspace.port_forward.delete.request", workspaceId, forwardId, requestId };
}

function decodedFrames(binaryFrames: Uint8Array[]) {
  return binaryFrames
    .map((frame) => decodeTunnelFrame(frame))
    .filter((frame): frame is NonNullable<typeof frame> => frame !== null);
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

describe("PortForwardingSession observation", () => {
  test("watch acknowledges and emits a snapshot update with configured service ports", async () => {
    const harness = makeHarness({ services: [{ port: 4000, scriptName: "web" }] });
    await harness.feature.handleMessage(watchRequest("ws-1"));

    const watchResponse = harness.messages.find(
      (
        message,
      ): message is Extract<SessionOutboundMessage, { type: "workspace.port.watch.response" }> =>
        message.type === "workspace.port.watch.response",
    );
    expect(watchResponse?.payload).toEqual({
      workspaceId: "ws-1",
      success: true,
      error: null,
      requestId: "req-watch",
    });

    const update = harness.messages.find(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace.port.update" }> =>
        message.type === "workspace.port.update",
    );
    expect(update?.payload.workspaceId).toBe("ws-1");
    expect(update?.payload.ports).toEqual([
      {
        port: 4000,
        bindAddress: "127.0.0.1",
        source: "configured",
        available: true,
        unavailableReason: null,
        protocol: "http",
        serviceName: "web",
      },
    ]);
  });

  test("watch rejects an unknown workspace", async () => {
    const harness = makeHarness({ workspace: null });
    await harness.feature.handleMessage(watchRequest("ws-missing"));
    const watchResponse = harness.messages.find(
      (message) => message.type === "workspace.port.watch.response",
    );
    expect(watchResponse).toEqual({
      type: "workspace.port.watch.response",
      payload: {
        workspaceId: "ws-missing",
        success: false,
        error: "Workspace not found",
        requestId: "req-watch",
      },
    });
  });

  test("unwatch stops observation and acknowledges", async () => {
    const harness = makeHarness();
    await harness.feature.handleMessage(watchRequest("ws-1"));
    await harness.feature.handleMessage(unwatchRequest("ws-1"));
    const unwatchResponse = harness.messages.find(
      (message) => message.type === "workspace.port.unwatch.response",
    );
    expect(unwatchResponse?.payload).toEqual({
      workspaceId: "ws-1",
      success: true,
      error: null,
      requestId: "req-unwatch",
    });
  });
});

describe("PortForwardingSession forwards", () => {
  test("create returns an opaque forward id and duplicate creates fail", async () => {
    const echo = await startEchoServer();
    const harness = makeHarness();
    await harness.feature.handleMessage(createRequest("ws-1", echo.port));

    const created = harness.messages.find(
      (message) => message.type === "workspace.port_forward.create.response",
    );
    if (created?.type !== "workspace.port_forward.create.response") {
      throw new Error("expected create response");
    }
    expect(created.payload.forwardId).toMatch(/^fw_/);
    expect(created.payload.error).toBeNull();

    await harness.feature.handleMessage(createRequest("ws-1", echo.port, "req-dup"));
    const duplicated = harness.messages.filter(
      (message) => message.type === "workspace.port_forward.create.response",
    );
    const duplicateResponse = duplicated[1];
    if (duplicateResponse?.type !== "workspace.port_forward.create.response") {
      throw new Error("expected duplicate response");
    }
    expect(duplicateResponse.payload.forwardId).toBeNull();
    expect(duplicateResponse.payload.error).toContain("already forwarded");
  });

  test("delete acknowledges and revokes the forward", async () => {
    const echo = await startEchoServer();
    const harness = makeHarness();
    await harness.feature.handleMessage(createRequest("ws-1", echo.port));
    const created = harness.messages.find(
      (message) => message.type === "workspace.port_forward.create.response",
    );
    if (created?.type !== "workspace.port_forward.create.response") {
      throw new Error("expected create response");
    }
    const forwardId = created.payload.forwardId;
    if (!forwardId) throw new Error("expected forward id");

    await harness.feature.handleMessage(deleteRequest(forwardId, "ws-1"));
    const deleted = harness.messages.find(
      (message) => message.type === "workspace.port_forward.delete.response",
    );
    expect(deleted?.payload).toEqual({
      workspaceId: "ws-1",
      forwardId,
      success: true,
      error: null,
      requestId: "req-delete",
    });

    await harness.feature.handleMessage(deleteRequest(forwardId, "ws-1", "req-delete-missing"));
    const missing = harness.messages.filter(
      (message) => message.type === "workspace.port_forward.delete.response",
    )[1];
    expect(
      missing?.type === "workspace.port_forward.delete.response" && missing.payload.success,
    ).toBe(false);
  });

  test("tunnel frames flow through the real codec to a real local socket", async () => {
    const echo = await startEchoServer();
    const harness = makeHarness();
    await harness.feature.handleMessage(createRequest("ws-1", echo.port));
    const created = harness.messages.find(
      (message) => message.type === "workspace.port_forward.create.response",
    );
    if (created?.type !== "workspace.port_forward.create.response") {
      throw new Error("expected create response");
    }
    const forwardId = created.payload.forwardId;
    if (!forwardId) throw new Error("expected forward id");

    harness.feature.handleTunnelFrame({
      opcode: TunnelOpcode.Open,
      forwardId,
      streamId: "s1",
    });
    await waitForCondition(() => decodedFrames(harness.binaryFrames).length >= 1);
    const openResult = decodedFrames(harness.binaryFrames)[0];
    expect(openResult?.opcode).toBe(TunnelOpcode.OpenResult);
    if (openResult?.opcode === TunnelOpcode.OpenResult) {
      expect(openResult.ok).toBe(true);
    }

    harness.feature.handleTunnelFrame({
      opcode: TunnelOpcode.Data,
      forwardId,
      streamId: "s1",
      payload: Buffer.from("ping"),
    });
    await waitForCondition(() => {
      const frames = decodedFrames(harness.binaryFrames);
      return frames.some(
        (frame) =>
          frame.opcode === TunnelOpcode.Data && Buffer.from(frame.payload).toString() === "ping",
      );
    });
  });

  test("revokeForTransportLoss closes streams, clears forwards, and allows recreation", async () => {
    const echo = await startEchoServer();
    const harness = makeHarness();
    await harness.feature.handleMessage(createRequest("ws-1", echo.port));
    const created = harness.messages.find(
      (message) => message.type === "workspace.port_forward.create.response",
    );
    if (created?.type !== "workspace.port_forward.create.response") {
      throw new Error("expected create response");
    }
    const forwardId = created.payload.forwardId;
    if (!forwardId) throw new Error("expected forward id");

    harness.feature.handleTunnelFrame({
      opcode: TunnelOpcode.Open,
      forwardId,
      streamId: "s1",
    });
    await waitForCondition(() => decodedFrames(harness.binaryFrames).length >= 1);

    harness.feature.revokeForTransportLoss();
    await waitForCondition(() =>
      decodedFrames(harness.binaryFrames).some(
        (frame) => frame.opcode === TunnelOpcode.Close && frame.reason === "transport_disconnected",
      ),
    );

    await harness.feature.handleMessage(createRequest("ws-1", echo.port, "req-recreate"));
    const recreated = harness.messages.filter(
      (message) => message.type === "workspace.port_forward.create.response",
    );
    const recreatedResponse = recreated[1];
    if (recreatedResponse?.type !== "workspace.port_forward.create.response") {
      throw new Error("expected recreate response");
    }
    expect(recreatedResponse.payload.forwardId).not.toBeNull();
    expect(recreatedResponse.payload.forwardId).not.toBe(forwardId);
  });

  test("deleteForwardsForWorkspace closes live streams with forward_deleted", async () => {
    const echo = await startEchoServer();
    const harness = makeHarness();
    await harness.feature.handleMessage(createRequest("ws-1", echo.port));
    const created = harness.messages.find(
      (message) => message.type === "workspace.port_forward.create.response",
    );
    if (created?.type !== "workspace.port_forward.create.response") {
      throw new Error("expected create response");
    }
    const forwardId = created.payload.forwardId;
    if (!forwardId) throw new Error("expected forward id");

    harness.feature.handleTunnelFrame({
      opcode: TunnelOpcode.Open,
      forwardId,
      streamId: "s1",
    });
    await waitForCondition(() => decodedFrames(harness.binaryFrames).length >= 1);

    harness.feature.deleteForwardsForWorkspace("ws-1");
    await waitForCondition(() =>
      decodedFrames(harness.binaryFrames).some(
        (frame) => frame.opcode === TunnelOpcode.Close && frame.reason === "forward_deleted",
      ),
    );
  });

  test("dispose closes streams with session_cleanup and stops observation", async () => {
    const echo = await startEchoServer();
    const harness = makeHarness();
    await harness.feature.handleMessage(createRequest("ws-1", echo.port));
    const created = harness.messages.find(
      (message) => message.type === "workspace.port_forward.create.response",
    );
    if (created?.type !== "workspace.port_forward.create.response") {
      throw new Error("expected create response");
    }
    const forwardId = created.payload.forwardId;
    if (!forwardId) throw new Error("expected forward id");
    harness.feature.handleTunnelFrame({
      opcode: TunnelOpcode.Open,
      forwardId,
      streamId: "s1",
    });
    await waitForCondition(() => decodedFrames(harness.binaryFrames).length >= 1);

    harness.feature.dispose();
    await waitForCondition(() =>
      decodedFrames(harness.binaryFrames).some(
        (frame) => frame.opcode === TunnelOpcode.Close && frame.reason === "session_cleanup",
      ),
    );
  });
});
