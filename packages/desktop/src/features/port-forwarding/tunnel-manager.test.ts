import net from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, test } from "vitest";
import { TunnelOpcode, type TunnelFrame } from "@getpaseo/protocol/binary-frames/index";
import { PortForwardingManager } from "./tunnel-manager.js";
import type { TunnelClient, TunnelFrameInput, TunnelPortUpdate } from "./tunnel-client.js";
import type {
  DesktopPortForwardingLease,
  DesktopPortForwardingSnapshot,
  PortForwardingConnectionStatus,
  WorkspacePortObservation,
} from "./types.js";

class FakeTunnelClient implements TunnelClient {
  readonly serverId = "server-1";
  status: PortForwardingConnectionStatus = "connected";
  frames: TunnelFrameInput[] = [];
  createRequests: Array<{ source?: WorkspacePortObservation["source"] }> = [];
  deleteRequests: string[] = [];
  createForwardPromise: Promise<{ forwardId: string | null; error: string | null }> | null = null;
  deleteForwardPromise: Promise<void> | null = null;
  private nextForward = 1;
  private tunnelHandlers = new Set<(frame: TunnelFrame) => void>();
  private portHandlers = new Set<(update: TunnelPortUpdate) => void>();
  private statusHandlers = new Set<(status: PortForwardingConnectionStatus) => void>();

  getConnectionStatus() {
    return this.status;
  }
  getFeatures() {
    return { forwardingSupported: true, discoverySupported: true };
  }
  getLastError() {
    return null;
  }
  async connect() {}
  async close() {}
  async watchPorts() {
    return { success: true, error: null };
  }
  async unwatchPorts() {
    return { success: true, error: null };
  }
  async createForward(input: { source?: WorkspacePortObservation["source"] }) {
    this.createRequests.push({ source: input.source });
    if (this.createForwardPromise) {
      const pending = this.createForwardPromise;
      this.createForwardPromise = null;
      return pending;
    }
    return { forwardId: `fw-${this.nextForward++}`, error: null };
  }
  async deleteForward(_workspaceId: string, forwardId: string) {
    this.deleteRequests.push(forwardId);
    await this.deleteForwardPromise;
  }
  sendTunnelFrame(frame: TunnelFrameInput) {
    this.frames.push(frame);
  }
  onTunnelFrame(handler: (frame: TunnelFrame) => void) {
    this.tunnelHandlers.add(handler);
    return () => this.tunnelHandlers.delete(handler);
  }
  onPortUpdate(handler: (update: TunnelPortUpdate) => void) {
    this.portHandlers.add(handler);
    return () => this.portHandlers.delete(handler);
  }
  onConnectionStatus(handler: (status: PortForwardingConnectionStatus) => void) {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }
  emitFrame(frame: TunnelFrame) {
    for (const handler of this.tunnelHandlers) handler(frame);
  }
  emitStatus(status: PortForwardingConnectionStatus) {
    this.status = status;
    for (const handler of this.statusHandlers) handler(status);
  }
}

const managers: PortForwardingManager[] = [];
const servers: net.Server[] = [];

const lease: DesktopPortForwardingLease = {
  serverId: "server-1",
  connectionId: "connection-1",
  url: "ws://127.0.0.1:6768/ws",
  password: "test-only",
};

function createManager(
  client: FakeTunnelClient,
  options: ConstructorParameters<typeof PortForwardingManager>[0] = {
    createTunnelClient: () => client,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    idleTeardownMs: 1,
  },
): PortForwardingManager {
  const manager = new PortForwardingManager({
    ...options,
    createTunnelClient: () => client,
  });
  managers.push(manager);
  return manager;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for port-forward state");
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (!resolvePromise) throw new Error("Deferred promise is not initialized");
      resolvePromise(value);
    },
  };
}

function openFrameCount(frames: readonly TunnelFrameInput[]): number {
  return frames.filter((frame) => frame.opcode === TunnelOpcode.Open).length;
}

function closeFrameCount(
  frames: readonly TunnelFrameInput[],
  reason: string,
  streamId?: string,
): number {
  return frames.filter(
    (frame) =>
      frame.opcode === TunnelOpcode.Close &&
      frame.reason === reason &&
      (streamId === undefined || frame.streamId === streamId),
  ).length;
}

function hasForwardStatus(
  snapshots: readonly DesktopPortForwardingSnapshot[],
  status: "starting" | "forwarded" | "disconnected" | "failed",
): boolean {
  return snapshots.some((snapshot) => snapshot.forwards[0]?.status === status);
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
  for (const server of servers.splice(0)) server.close();
});

describe("PortForwardingManager", () => {
  test("emits a starting row while daemon authorization is pending", async () => {
    const client = new FakeTunnelClient();
    const authorization = deferred<{ forwardId: string | null; error: string | null }>();
    client.createForwardPromise = authorization.promise;
    const manager = createManager(client);
    const snapshots: DesktopPortForwardingSnapshot[] = [];
    manager.onSnapshot({ serverId: lease.serverId, workspaceId: "workspace-1" }, (snapshot) => {
      snapshots.push(snapshot);
    });

    const creation = manager.create(
      {
        lease,
        workspaceId: "workspace-1",
        remotePort: 2999,
        protocol: "http",
        source: "manual",
        requestedLocalPort: 0,
      },
      40,
    );
    await waitFor(() => hasForwardStatus(snapshots, "starting"));
    expect(snapshots.at(-1)?.forwards[0]).toMatchObject({
      remotePort: 2999,
      status: "starting",
    });

    authorization.resolve({ forwardId: "fw-started", error: null });
    await expect(creation).resolves.toMatchObject({
      forwards: [expect.objectContaining({ forwardId: "fw-started", status: "forwarded" })],
    });
  });

  test("falls back from an occupied port, multiplexes streams, and cleans up its window", async () => {
    const occupied = net.createServer();
    servers.push(occupied);
    occupied.listen({ host: "127.0.0.1", port: 0 });
    await once(occupied, "listening");
    const occupiedAddress = occupied.address();
    if (!occupiedAddress || typeof occupiedAddress === "string") throw new Error("No address");

    const client = new FakeTunnelClient();
    const manager = createManager(client);
    const snapshot = await manager.create(
      {
        lease,
        workspaceId: "workspace-1",
        remotePort: 3000,
        protocol: "http",
        source: "observed",
        requestedLocalPort: occupiedAddress.port,
      },
      41,
    );
    const forward = snapshot.forwards[0];
    expect(forward?.localHost).toBe("127.0.0.1");
    expect(forward?.localPort).not.toBe(occupiedAddress.port);

    const first = net.createConnection({ host: "127.0.0.1", port: forward!.localPort });
    const second = net.createConnection({ host: "127.0.0.1", port: forward!.localPort });
    await Promise.all([once(first, "connect"), once(second, "connect")]);
    await waitFor(() => openFrameCount(client.frames) === 2);
    const opens = client.frames.filter((frame) => frame.opcode === TunnelOpcode.Open);
    client.emitFrame({ ...opens[0]!, opcode: TunnelOpcode.OpenResult, ok: true, error: null });
    client.emitFrame({ ...opens[1]!, opcode: TunnelOpcode.OpenResult, ok: true, error: null });

    const firstData = once(first, "data");
    const secondData = once(second, "data");
    client.emitFrame({ ...opens[0]!, opcode: TunnelOpcode.Data, payload: Buffer.from("one") });
    client.emitFrame({ ...opens[1]!, opcode: TunnelOpcode.Data, payload: Buffer.from("two") });
    expect(Buffer.from((await firstData)[0] as Buffer).toString()).toBe("one");
    expect(Buffer.from((await secondData)[0] as Buffer).toString()).toBe("two");

    await manager.removeWindow(41);
    expect(client.deleteRequests).toContain(forward!.forwardId);
    first.destroy();
    second.destroy();
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port: forward!.localPort });
        socket.once("connect", () => resolve());
        socket.once("error", reject);
      }),
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  test("rejects a frame whose forward id does not own its stream", async () => {
    const client = new FakeTunnelClient();
    const manager = createManager(client);
    const snapshot = await manager.create(
      {
        lease,
        workspaceId: "workspace-1",
        remotePort: 3010,
        protocol: "tcp",
        source: "manual",
        requestedLocalPort: 0,
      },
      50,
    );
    const socket = net.createConnection({
      host: "127.0.0.1",
      port: snapshot.forwards[0]!.localPort,
    });
    await once(socket, "connect");
    await waitFor(() => openFrameCount(client.frames) === 1);
    const open = client.frames.find((frame) => frame.opcode === TunnelOpcode.Open);
    if (!open || open.opcode !== TunnelOpcode.Open) throw new Error("Expected open frame");

    client.emitFrame({ ...open, forwardId: "fw-wrong", opcode: TunnelOpcode.OpenResult, ok: true });
    await waitFor(() => closeFrameCount(client.frames, "protocol violation", open.streamId) === 1);
    expect(client.frames.at(-1)).toMatchObject({
      opcode: TunnelOpcode.Close,
      forwardId: open.forwardId,
      streamId: open.streamId,
      reason: "protocol violation",
    });
    socket.destroy();
  });

  test("closes owned listeners across hosts before remote delete requests settle", async () => {
    const client = new FakeTunnelClient();
    const manager = createManager(client);
    const first = await manager.create(
      {
        lease,
        workspaceId: "workspace-1",
        remotePort: 3020,
        protocol: "tcp",
        source: "manual",
        requestedLocalPort: 0,
      },
      54,
    );
    const secondLease = { ...lease, serverId: "server-2", connectionId: "connection-2" };
    const second = await manager.create(
      {
        lease: secondLease,
        workspaceId: "workspace-1",
        remotePort: 3021,
        protocol: "tcp",
        source: "manual",
        requestedLocalPort: 0,
      },
      54,
    );
    const ports = [first.forwards[0]!.localPort, second.forwards.at(-1)!.localPort];
    const deletion = deferred<void>();
    client.deleteForwardPromise = deletion.promise;

    const removal = manager.removeWindow(54);
    await waitFor(() => client.deleteRequests.length === 2);
    for (const port of ports) {
      await expect(
        new Promise<void>((resolve, reject) => {
          const socket = net.createConnection({ host: "127.0.0.1", port });
          socket.once("connect", resolve);
          socket.once("error", reject);
        }),
      ).rejects.toMatchObject({ code: "ECONNREFUSED" });
    }
    deletion.resolve();
    await removal;
  });

  test("reports a remote stream failure and clears it after a later open succeeds", async () => {
    const client = new FakeTunnelClient();
    const manager = createManager(client);
    const snapshot = await manager.create(
      {
        lease,
        workspaceId: "workspace-1",
        remotePort: 3014,
        protocol: "tcp",
        source: "manual",
        requestedLocalPort: 0,
      },
      53,
    );
    const snapshots: (typeof snapshot)[] = [];
    manager.onSnapshot({ serverId: lease.serverId, workspaceId: "workspace-1" }, (next) => {
      snapshots.push(next);
    });
    const localPort = snapshot.forwards[0]!.localPort;
    const rejectedSocket = net.createConnection({ host: "127.0.0.1", port: localPort });
    await once(rejectedSocket, "connect");
    await waitFor(() => openFrameCount(client.frames) === 1);
    const rejectedOpen = client.frames.find((frame) => frame.opcode === TunnelOpcode.Open);
    if (!rejectedOpen || rejectedOpen.opcode !== TunnelOpcode.Open) {
      throw new Error("Expected rejected open frame");
    }
    client.emitFrame({
      ...rejectedOpen,
      opcode: TunnelOpcode.OpenResult,
      ok: false,
      error: "refused",
    });
    await waitFor(() => snapshots.at(-1)?.forwards[0]?.error === "refused");

    const successfulSocket = net.createConnection({ host: "127.0.0.1", port: localPort });
    await once(successfulSocket, "connect");
    await waitFor(() => openFrameCount(client.frames) === 2);
    const successfulOpen = client.frames.filter((frame) => frame.opcode === TunnelOpcode.Open)[1];
    if (!successfulOpen || successfulOpen.opcode !== TunnelOpcode.Open) {
      throw new Error("Expected successful open frame");
    }
    client.emitFrame({ ...successfulOpen, opcode: TunnelOpcode.OpenResult, ok: true });
    await waitFor(() => snapshots.at(-1)?.forwards[0]?.error === null);
    rejectedSocket.destroy();
    successfulSocket.destroy();
  });

  test("caps aggregate retained bytes across a host", async () => {
    const client = new FakeTunnelClient();
    const manager = createManager(client, {
      createTunnelClient: () => client,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      idleTeardownMs: 1,
      limits: { maxAggregateRetainedBytes: 6 },
    });
    const snapshot = await manager.create(
      {
        lease,
        workspaceId: "workspace-1",
        remotePort: 3011,
        protocol: "tcp",
        source: "manual",
        requestedLocalPort: 0,
      },
      51,
    );
    const sockets = Array.from({ length: 2 }, () =>
      net.createConnection({ host: "127.0.0.1", port: snapshot.forwards[0]!.localPort }),
    );
    await Promise.all(sockets.map((socket) => once(socket, "connect")));
    await waitFor(() => openFrameCount(client.frames) === 2);
    const opens = client.frames.filter((frame) => frame.opcode === TunnelOpcode.Open);
    for (const open of opens) {
      if (open.opcode === TunnelOpcode.Open) {
        client.emitFrame({ ...open, opcode: TunnelOpcode.OpenResult, ok: true });
      }
    }
    for (const socket of sockets) socket.write("four");
    await waitFor(() => closeFrameCount(client.frames, "backpressure exceeded") === 1);
    expect(
      client.frames.filter(
        (frame) => frame.opcode === TunnelOpcode.Data || frame.opcode === TunnelOpcode.Close,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ opcode: TunnelOpcode.Data }),
        expect.objectContaining({ opcode: TunnelOpcode.Close, reason: "backpressure exceeded" }),
      ]),
    );
    for (const socket of sockets) socket.destroy();
  });

  test("shares deterministic transfer-rate limits across directions and forwards", async () => {
    const client = new FakeTunnelClient();
    const manager = createManager(client, {
      createTunnelClient: () => client,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      idleTeardownMs: 1,
      now: () => 1_000,
      limits: {
        maxAggregateRetainedBytes: 1024,
        maxTransferBytesPerSecondPerForward: 8,
        maxTransferBytesPerSecondPerHost: 10,
      },
    });
    const firstSnapshot = await manager.create(
      {
        lease,
        workspaceId: "workspace-1",
        remotePort: 3012,
        protocol: "tcp",
        source: "manual",
        requestedLocalPort: 0,
      },
      52,
    );
    const secondSnapshot = await manager.create(
      {
        lease,
        workspaceId: "workspace-1",
        remotePort: 3013,
        protocol: "tcp",
        source: "manual",
        requestedLocalPort: 0,
      },
      52,
    );
    const sockets = [firstSnapshot, secondSnapshot].map((snapshot) =>
      net.createConnection({ host: "127.0.0.1", port: snapshot.forwards.at(-1)!.localPort }),
    );
    await Promise.all(sockets.map((socket) => once(socket, "connect")));
    await waitFor(() => openFrameCount(client.frames) === 2);
    const opens = client.frames.filter((frame) => frame.opcode === TunnelOpcode.Open);
    for (const open of opens) {
      if (open.opcode === TunnelOpcode.Open) {
        client.emitFrame({ ...open, opcode: TunnelOpcode.OpenResult, ok: true });
      }
    }

    client.emitFrame({ ...opens[0]!, opcode: TunnelOpcode.Data, payload: Buffer.from("four") });
    sockets[0]!.write("12345");
    await waitFor(() => closeFrameCount(client.frames, "transfer rate exceeded") === 1);

    sockets[1]!.write("1234567");
    await waitFor(() => closeFrameCount(client.frames, "transfer rate exceeded") === 2);
    for (const socket of sockets) socket.destroy();
  });

  test("recreates a disconnected observed forward with its original source", async () => {
    const client = new FakeTunnelClient();
    const manager = createManager(client);
    await manager.create(
      {
        lease,
        workspaceId: "workspace-1",
        remotePort: 3001,
        protocol: "http",
        source: "observed",
        requestedLocalPort: 0,
      },
      42,
    );

    client.emitStatus("disconnected");
    client.emitStatus("connected");
    await waitFor(() => client.createRequests.length === 2);

    expect(client.createRequests).toEqual([{ source: "observed" }, { source: "observed" }]);
  });

  test("caps local streams before unbounded sockets can reach the daemon", async () => {
    const client = new FakeTunnelClient();
    const manager = createManager(client);
    const snapshot = await manager.create(
      {
        lease,
        workspaceId: "workspace-1",
        remotePort: 3002,
        protocol: "tcp",
        source: "manual",
        requestedLocalPort: 0,
      },
      43,
    );
    const localPort = snapshot.forwards[0]!.localPort;
    const sockets = Array.from({ length: 17 }, () =>
      net.createConnection({ host: "127.0.0.1", port: localPort }),
    );
    await Promise.all(sockets.map((socket) => once(socket, "connect")));
    await waitFor(() => openFrameCount(client.frames) === 16);

    expect(openFrameCount(client.frames)).toBe(16);
    for (const socket of sockets) socket.destroy();
  });
});
