/* eslint-disable max-nested-callbacks */
import net from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, test } from "vitest";
import pino from "pino";
import { TunnelOpcode, type TunnelFrame } from "@getpaseo/protocol/binary-frames/index";
import { PortForwardService, type TunnelFrameInput } from "./forward-service.js";

const servers: net.Server[] = [];
const services: PortForwardService[] = [];

async function listen(
  connection: (socket: net.Socket) => void,
): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer({ allowHalfOpen: true }, connection);
  servers.push(server);
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return { server, port: address.port };
}

function createService(
  frames: TunnelFrameInput[],
  options: ConstructorParameters<typeof PortForwardService>[0] = {
    getWorkspace: async () => ({ workspaceId: "workspace-1", archivedAt: null }),
    sendFrame: (frame) => frames.push(frame),
    logger: pino({ level: "silent" }),
  },
): PortForwardService {
  const service = new PortForwardService(options);
  services.push(service);
  return service;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for port-forward frame");
}

function frameData(frames: TunnelFrameInput[], streamId: string): string[] {
  return frames
    .filter((frame) => frame.opcode === TunnelOpcode.Data && frame.streamId === streamId)
    .map((frame) => Buffer.from(frame.payload).toString());
}

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  for (const server of servers.splice(0)) server.close();
});

describe("PortForwardService", () => {
  test("carries duplex HTTP/WebSocket-style bytes and preserves half-close", async () => {
    const received: string[] = [];
    const target = await listen((socket) => {
      socket.on("data", (chunk) => {
        received.push(chunk.toString());
        socket.write(Buffer.concat([Buffer.from("reply:"), chunk]));
      });
      socket.on("end", () => socket.end("goodbye"));
    });
    const frames: TunnelFrameInput[] = [];
    const service = createService(frames);
    const created = await service.createForward({ workspaceId: "workspace-1", port: target.port });
    if (!created.ok) throw new Error(created.message);

    service.handleFrame({
      opcode: TunnelOpcode.Open,
      forwardId: created.forward.forwardId,
      streamId: "stream-1",
    });
    await waitFor(() =>
      frames.some(
        (frame) => frame.opcode === TunnelOpcode.OpenResult && frame.streamId === "stream-1",
      ),
    );
    const request = "GET / HTTP/1.1\r\nUpgrade: websocket\r\n\r\n";
    service.handleFrame({
      opcode: TunnelOpcode.Data,
      forwardId: created.forward.forwardId,
      streamId: "stream-1",
      payload: Buffer.from(request),
    });

    await waitFor(() => frameData(frames, "stream-1").length > 0);
    expect(received).toEqual([request]);
    expect(frameData(frames, "stream-1").join("")).toBe(`reply:${request}`);
    const replyBytes = Buffer.byteLength(`reply:${request}`);
    service.handleFrame({
      opcode: TunnelOpcode.WindowUpdate,
      forwardId: created.forward.forwardId,
      streamId: "stream-1",
      credit: replyBytes,
    });
    service.handleFrame({
      opcode: TunnelOpcode.HalfClose,
      forwardId: created.forward.forwardId,
      streamId: "stream-1",
    });

    await waitFor(() =>
      frames.some(
        (frame) => frame.opcode === TunnelOpcode.HalfClose && frame.streamId === "stream-1",
      ),
    );
    expect(frameData(frames, "stream-1").join("")).toBe(`reply:${request}goodbye`);
  });

  test("isolates concurrent streams on one forward", async () => {
    const target = await listen((socket) => socket.on("data", (chunk) => socket.write(chunk)));
    const frames: TunnelFrameInput[] = [];
    const service = createService(frames);
    const created = await service.createForward({ workspaceId: "workspace-1", port: target.port });
    if (!created.ok) throw new Error(created.message);

    for (const streamId of ["stream-a", "stream-b"]) {
      service.handleFrame({
        opcode: TunnelOpcode.Open,
        forwardId: created.forward.forwardId,
        streamId,
      });
    }
    await waitFor(
      () => frames.filter((frame) => frame.opcode === TunnelOpcode.OpenResult).length === 2,
    );
    service.handleFrame({
      opcode: TunnelOpcode.Data,
      forwardId: created.forward.forwardId,
      streamId: "stream-a",
      payload: Buffer.from("alpha"),
    });
    service.handleFrame({
      opcode: TunnelOpcode.Data,
      forwardId: created.forward.forwardId,
      streamId: "stream-b",
      payload: Buffer.from("beta"),
    });
    await waitFor(
      () => frameData(frames, "stream-a").length > 0 && frameData(frames, "stream-b").length > 0,
    );

    expect(frameData(frames, "stream-a").join("")).toBe("alpha");
    expect(frameData(frames, "stream-b").join("")).toBe("beta");
  });

  test("rejects a duplicate stream id while its first TCP connect is pending", async () => {
    let resolveConnect: ((socket: net.Socket) => void) | null = null;
    const frames: TunnelFrameInput[] = [];
    const service = createService(frames, {
      getWorkspace: async () => ({ workspaceId: "workspace-1", archivedAt: null }),
      sendFrame: (frame) => frames.push(frame),
      logger: pino({ level: "silent" }),
      connectTcp: () =>
        new Promise((resolve) => {
          resolveConnect = resolve;
        }),
    });
    const created = await service.createForward({ workspaceId: "workspace-1", port: 3000 });
    if (!created.ok) throw new Error(created.message);
    const open = {
      opcode: TunnelOpcode.Open,
      forwardId: created.forward.forwardId,
      streamId: "duplicate-pending",
    } as const;

    service.handleFrame(open);
    service.handleFrame(open);
    expect(frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          opcode: TunnelOpcode.OpenResult,
          streamId: "duplicate-pending",
          ok: false,
          error: "duplicate_stream",
        }),
      ]),
    );

    const socket = new net.Socket();
    if (!resolveConnect) throw new Error("Expected a pending TCP connect");
    resolveConnect(socket);
    await waitFor(
      () =>
        frames.filter(
          (frame) =>
            frame.opcode === TunnelOpcode.OpenResult &&
            frame.streamId === "duplicate-pending" &&
            frame.ok,
        ).length === 1,
    );
    socket.destroy();
  });

  test("treats a graceful target EOF as a half-close instead of a stream failure", async () => {
    const target = await listen((socket) => socket.end("done"));
    const frames: TunnelFrameInput[] = [];
    const service = createService(frames);
    const created = await service.createForward({ workspaceId: "workspace-1", port: target.port });
    if (!created.ok) throw new Error(created.message);

    service.handleFrame({
      opcode: TunnelOpcode.Open,
      forwardId: created.forward.forwardId,
      streamId: "graceful-eof",
    });
    await waitFor(() =>
      frames.some(
        (frame) => frame.opcode === TunnelOpcode.HalfClose && frame.streamId === "graceful-eof",
      ),
    );

    expect(frames).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          opcode: TunnelOpcode.Close,
          streamId: "graceful-eof",
          reason: "stream_aborted",
        }),
      ]),
    );
  });

  test("rejects invalid authorization and refused targets", async () => {
    const temporary = await listen(() => {});
    temporary.server.close();
    await once(temporary.server, "close");
    const frames: TunnelFrameInput[] = [];
    const service = createService(frames, {
      getWorkspace: async (workspaceId) =>
        workspaceId === "workspace-1" ? { workspaceId, archivedAt: null } : null,
      sendFrame: (frame) => frames.push(frame),
      logger: pino({ level: "silent" }),
    });

    await expect(
      service.createForward({ workspaceId: "missing", port: 3000 }),
    ).resolves.toMatchObject({
      ok: false,
      code: "workspace_not_found",
    });
    await expect(
      service.createForward({ workspaceId: "workspace-1", port: 0 }),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid_port",
    });
    await expect(
      service.createForward({ workspaceId: "workspace-1", port: 3000, host: "10.0.0.1" }),
    ).resolves.toMatchObject({ ok: false, code: "invalid_host" });

    const created = await service.createForward({
      workspaceId: "workspace-1",
      port: temporary.port,
    });
    if (!created.ok) throw new Error(created.message);
    service.handleFrame({
      opcode: TunnelOpcode.Open,
      forwardId: created.forward.forwardId,
      streamId: "refused",
    });
    await waitFor(() =>
      frames.some(
        (frame) =>
          frame.opcode === TunnelOpcode.OpenResult && frame.streamId === "refused" && !frame.ok,
      ),
    );
  });

  test("bounds remote backpressure and revokes every forward on transport loss", async () => {
    const target = await listen((socket) => socket.write(Buffer.alloc(32, 7)));
    const frames: TunnelFrameInput[] = [];
    const service = createService(frames, {
      getWorkspace: async () => ({ workspaceId: "workspace-1", archivedAt: null }),
      sendFrame: (frame) => frames.push(frame),
      logger: pino({ level: "silent" }),
      limits: {
        initialWindowBytes: 4,
        maxQueuedBytesPerStream: 8,
        maxAggregateQueuedBytes: 8,
      },
    });
    const created = await service.createForward({ workspaceId: "workspace-1", port: target.port });
    if (!created.ok) throw new Error(created.message);
    service.handleFrame({
      opcode: TunnelOpcode.Open,
      forwardId: created.forward.forwardId,
      streamId: "slow",
    });
    await waitFor(() =>
      frames.some(
        (frame) =>
          frame.opcode === TunnelOpcode.Close &&
          frame.streamId === "slow" &&
          frame.reason === "backpressure_exceeded",
      ),
    );

    const second = await service.createForward({
      workspaceId: "workspace-1",
      port: target.port + 1,
    });
    if (!second.ok) throw new Error(second.message);
    service.revokeAllForTransportLoss();
    expect(service.listForwards()).toEqual([]);
    service.handleFrame({
      opcode: TunnelOpcode.Open,
      forwardId: second.forward.forwardId,
      streamId: "after-disconnect",
    } satisfies TunnelFrame);
    expect(frames.at(-1)).toMatchObject({
      opcode: TunnelOpcode.Close,
      streamId: "after-disconnect",
      reason: "unknown_forward",
    });
  });

  test("counts pending outbound bytes in the daemon aggregate ceiling", async () => {
    const target = await listen((socket) => socket.write("four"));
    const frames: TunnelFrameInput[] = [];
    const service = createService(frames, {
      getWorkspace: async () => ({ workspaceId: "workspace-1", archivedAt: null }),
      sendFrame: (frame) => frames.push(frame),
      logger: pino({ level: "silent" }),
      limits: {
        initialWindowBytes: 4,
        maxQueuedBytesPerStream: 32,
        maxAggregateQueuedBytes: 6,
      },
    });
    const created = await service.createForward({ workspaceId: "workspace-1", port: target.port });
    if (!created.ok) throw new Error(created.message);
    for (const streamId of ["pending-a", "pending-b"]) {
      service.handleFrame({
        opcode: TunnelOpcode.Open,
        forwardId: created.forward.forwardId,
        streamId,
      });
    }

    await waitFor(() =>
      frames.some(
        (frame) => frame.opcode === TunnelOpcode.Close && frame.reason === "backpressure_exceeded",
      ),
    );
    expect(frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ opcode: TunnelOpcode.Data }),
        expect.objectContaining({ opcode: TunnelOpcode.Close, reason: "backpressure_exceeded" }),
      ]),
    );
  });

  test("counts pending target writes in the daemon aggregate ceiling", async () => {
    const sockets: net.Socket[] = [];
    const frames: TunnelFrameInput[] = [];
    const service = createService(frames, {
      getWorkspace: async () => ({ workspaceId: "workspace-1", archivedAt: null }),
      sendFrame: (frame) => frames.push(frame),
      logger: pino({ level: "silent" }),
      connectTcp: async () => {
        const socket = new net.Socket();
        Object.defineProperty(socket, "write", {
          value: () => false,
        });
        sockets.push(socket);
        return socket;
      },
      limits: {
        initialWindowBytes: 4,
        maxQueuedBytesPerStream: 8,
        maxAggregateQueuedBytes: 6,
      },
    });
    const created = await service.createForward({ workspaceId: "workspace-1", port: 3000 });
    if (!created.ok) throw new Error(created.message);
    for (const streamId of ["pending-in-a", "pending-in-b"]) {
      service.handleFrame({
        opcode: TunnelOpcode.Open,
        forwardId: created.forward.forwardId,
        streamId,
      });
    }
    await waitFor(
      () => frames.filter((frame) => frame.opcode === TunnelOpcode.OpenResult).length === 2,
    );

    for (const streamId of ["pending-in-a", "pending-in-b"]) {
      service.handleFrame({
        opcode: TunnelOpcode.Data,
        forwardId: created.forward.forwardId,
        streamId,
        payload: Buffer.from("four"),
      });
    }

    expect(frames.at(-1)).toMatchObject({
      opcode: TunnelOpcode.Close,
      streamId: "pending-in-b",
      reason: "backpressure_exceeded",
    });
    for (const socket of sockets) socket.destroy();
  });

  test("shares a forward transfer-rate bucket across both directions", async () => {
    const target = await listen((socket) => socket.write("four"));
    const frames: TunnelFrameInput[] = [];
    const service = createService(frames, {
      getWorkspace: async () => ({ workspaceId: "workspace-1", archivedAt: null }),
      sendFrame: (frame) => frames.push(frame),
      logger: pino({ level: "silent" }),
      now: () => 1_000,
      limits: {
        maxTransferBytesPerSecondPerForward: 8,
        maxTransferBytesPerSecondPerHost: 100,
      },
    });
    const created = await service.createForward({ workspaceId: "workspace-1", port: target.port });
    if (!created.ok) throw new Error(created.message);
    service.handleFrame({
      opcode: TunnelOpcode.Open,
      forwardId: created.forward.forwardId,
      streamId: "rate-duplex",
    });
    await waitFor(() => frameData(frames, "rate-duplex").join("") === "four");

    service.handleFrame({
      opcode: TunnelOpcode.Data,
      forwardId: created.forward.forwardId,
      streamId: "rate-duplex",
      payload: Buffer.from("12345"),
    });
    expect(frames.at(-1)).toMatchObject({
      opcode: TunnelOpcode.Close,
      streamId: "rate-duplex",
      reason: "transfer_rate_exceeded",
    });
  });

  test("shares the host transfer-rate bucket across forwards", async () => {
    const firstTarget = await listen(() => {});
    const secondTarget = await listen(() => {});
    const frames: TunnelFrameInput[] = [];
    const service = createService(frames, {
      getWorkspace: async () => ({ workspaceId: "workspace-1", archivedAt: null }),
      sendFrame: (frame) => frames.push(frame),
      logger: pino({ level: "silent" }),
      now: () => 1_000,
      limits: {
        maxTransferBytesPerSecondPerForward: 10,
        maxTransferBytesPerSecondPerHost: 10,
      },
    });
    const first = await service.createForward({
      workspaceId: "workspace-1",
      port: firstTarget.port,
    });
    const second = await service.createForward({
      workspaceId: "workspace-1",
      port: secondTarget.port,
    });
    if (!first.ok) throw new Error(first.message);
    if (!second.ok) throw new Error(second.message);
    for (const [forwardId, streamId] of [
      [first.forward.forwardId, "rate-host-a"],
      [second.forward.forwardId, "rate-host-b"],
    ] as const) {
      service.handleFrame({ opcode: TunnelOpcode.Open, forwardId, streamId });
    }
    await waitFor(
      () => frames.filter((frame) => frame.opcode === TunnelOpcode.OpenResult).length === 2,
    );

    service.handleFrame({
      opcode: TunnelOpcode.Data,
      forwardId: first.forward.forwardId,
      streamId: "rate-host-a",
      payload: Buffer.from("123456"),
    });
    service.handleFrame({
      opcode: TunnelOpcode.Data,
      forwardId: second.forward.forwardId,
      streamId: "rate-host-b",
      payload: Buffer.from("12345"),
    });
    expect(frames.at(-1)).toMatchObject({
      opcode: TunnelOpcode.Close,
      streamId: "rate-host-b",
      reason: "transfer_rate_exceeded",
    });
  });
});
