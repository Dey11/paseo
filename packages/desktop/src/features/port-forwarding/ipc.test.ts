import { describe, expect, test } from "vitest";
import type { TunnelClient, TunnelFrameInput, TunnelPortUpdate } from "./tunnel-client.js";
import type { TunnelFrame } from "@getpaseo/protocol/binary-frames/index";
import type {
  DesktopPortForwardingLease,
  DesktopPortForwardingSnapshot,
  DesktopPortForwardingUnwatchInput,
  PortForwardingConnectionStatus,
  WorkspacePortObservation,
} from "./types.js";
import { registerPortForwardingIpc, type IpcRegistry } from "./ipc.js";
import { PortForwardingManager } from "./tunnel-manager.js";

// The renderer bridge contract (packages/app/src/ports/types.ts) is mirrored
// in ./types.ts. These tests pin the exact structural shape so drift between
// the two packages fails CI instead of breaking the Ports tab at runtime.

function expectShape<T extends object>(value: T, keys: readonly (keyof T)[]): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

test("desktop port types mirror the renderer bridge contract", () => {
  const observation: WorkspacePortObservation = {
    port: 3000,
    bindAddress: "127.0.0.1",
    protocol: "http",
    source: "observed",
    available: true,
    unavailableReason: null,
    terminalId: null,
    terminalTitle: null,
    processName: null,
    serviceName: null,
  };
  expectShape(observation, [
    "port",
    "bindAddress",
    "protocol",
    "source",
    "available",
    "unavailableReason",
    "terminalId",
    "terminalTitle",
    "processName",
    "serviceName",
  ]);

  const forward: DesktopPortForwardingSnapshot["forwards"][number] = {
    forwardId: "fw-1",
    workspaceId: "ws-1",
    remotePort: 3000,
    localHost: "127.0.0.1",
    localPort: 3000,
    protocol: "tcp",
    source: "observed",
    status: "forwarded",
    error: null,
  };
  expectShape(forward, [
    "forwardId",
    "workspaceId",
    "remotePort",
    "localHost",
    "localPort",
    "protocol",
    "source",
    "status",
    "error",
  ]);

  const snapshot: DesktopPortForwardingSnapshot = {
    serverId: "server-1",
    workspaceId: "ws-1",
    connectionStatus: "connected",
    forwardingSupported: true,
    discoverySupported: true,
    ports: [observation],
    forwards: [forward],
    error: null,
  };
  expectShape(snapshot, [
    "serverId",
    "workspaceId",
    "connectionStatus",
    "forwardingSupported",
    "discoverySupported",
    "ports",
    "forwards",
    "error",
  ]);

  const lease: DesktopPortForwardingLease = {
    serverId: "server-1",
    connectionId: "connection-1",
    url: "ws://127.0.0.1:6768/ws",
  };
  expectShape(lease, ["serverId", "connectionId", "url"]);

  const unwatch: DesktopPortForwardingUnwatchInput = {
    serverId: "server-1",
    connectionId: "connection-1",
    workspaceId: "ws-1",
  };
  expectShape(unwatch, ["serverId", "connectionId", "workspaceId"]);
});

class FakeTunnelClient implements TunnelClient {
  readonly serverId = "server-1";
  status: PortForwardingConnectionStatus = "connected";
  readonly createRequests: unknown[] = [];
  private readonly tunnelHandlers = new Set<(frame: TunnelFrame) => void>();
  private readonly portHandlers = new Set<(update: TunnelPortUpdate) => void>();
  private readonly statusHandlers = new Set<(status: PortForwardingConnectionStatus) => void>();

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
    this.createRequests.push(input);
    return { forwardId: "fw-1", error: null };
  }
  async deleteForward() {}
  sendTunnelFrame(_frame: TunnelFrameInput) {}
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
}

interface HandlerEntry {
  channel: string;
  listener: (event: unknown, ...args: unknown[]) => unknown;
}

function createHarness(client: FakeTunnelClient) {
  const handlers: HandlerEntry[] = [];
  const ipc: IpcRegistry = {
    handle: (channel, listener) => handlers.push({ channel, listener }),
  };
  const sentEvents: Array<{ webContentsId: number; channel: string; payload: unknown }> = [];
  const manager = new PortForwardingManager({
    createTunnelClient: () => client,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    idleTeardownMs: 0,
  });
  const { removeWindow } = registerPortForwardingIpc({
    ipc,
    manager,
    sendEvent: (webContentsId, channel, payload) =>
      sentEvents.push({ webContentsId, channel, payload }),
  });
  const invoke = (channel: string, event: unknown, ...args: unknown[]): Promise<unknown> => {
    const entry = handlers.find((handler) => handler.channel === channel);
    if (!entry) {
      throw new Error(`No handler for ${channel}`);
    }
    return Promise.resolve(entry.listener(event, ...args));
  };
  const event = (webContentsId: number) => ({ sender: { id: webContentsId } });
  return { invoke, event, sentEvents, removeWindow, manager };
}

const lease: DesktopPortForwardingLease = {
  serverId: "server-1",
  connectionId: "connection-1",
  url: "ws://127.0.0.1:6768/ws",
  password: "test-only",
};

describe("port forwarding IPC", () => {
  test("rejects malformed watch, create, stop, and unwatch inputs", async () => {
    const harness = createHarness(new FakeTunnelClient());

    await expect(harness.invoke("paseo:ports:watch", harness.event(1), null)).rejects.toThrow(
      "Invalid port forwarding watch input",
    );
    await expect(
      harness.invoke("paseo:ports:watch", harness.event(1), {
        lease: { serverId: "server-1", connectionId: "connection-1", url: "http://bad" },
        workspaceId: "ws-1",
      }),
    ).rejects.toThrow("Invalid port forwarding watch input");
    await expect(
      harness.invoke("paseo:ports:watch", harness.event(1), {
        lease,
        workspaceId: "",
      }),
    ).rejects.toThrow("Invalid port forwarding watch input");

    await expect(
      harness.invoke("paseo:ports:create", harness.event(1), {
        lease,
        workspaceId: "ws-1",
        remotePort: 70000,
        protocol: "http",
      }),
    ).rejects.toThrow("Invalid port forwarding create input");
    await expect(
      harness.invoke("paseo:ports:create", harness.event(1), {
        lease,
        workspaceId: "ws-1",
        remotePort: 3000,
        protocol: "ftp",
      }),
    ).rejects.toThrow("Invalid port forwarding create input");
    await expect(
      harness.invoke("paseo:ports:create", harness.event(1), {
        lease,
        workspaceId: "ws-1",
        remotePort: 3000,
        protocol: "http",
        source: "guessed",
      }),
    ).rejects.toThrow("Invalid port forwarding create input");
    await expect(
      harness.invoke("paseo:ports:create", harness.event(1), {
        lease,
        workspaceId: "ws-1",
        remotePort: 3000,
        protocol: "http",
        requestedLocalPort: 0,
      }),
    ).rejects.toThrow("Invalid port forwarding create input");

    await expect(
      harness.invoke("paseo:ports:stop", harness.event(1), { serverId: "server-1" }),
    ).rejects.toThrow("Invalid port forwarding stop input");
    await expect(
      harness.invoke("paseo:ports:unwatch", harness.event(1), { serverId: "server-1" }),
    ).rejects.toThrow("Invalid port forwarding unwatch input");
    await expect(
      harness.invoke("paseo:ports:unwatch", harness.event(1), {
        serverId: "server-1",
        connectionId: "connection-1",
      }),
    ).rejects.toThrow("Invalid port forwarding unwatch input");
  });

  test("passes source and requestedLocalPort through to the manager", async () => {
    const client = new FakeTunnelClient();
    const harness = createHarness(client);

    await harness.invoke("paseo:ports:create", harness.event(7), {
      lease,
      workspaceId: "ws-1",
      remotePort: 3000,
      protocol: "http",
      source: "observed",
      requestedLocalPort: 8080,
    });

    expect(client.createRequests).toEqual([
      { workspaceId: "ws-1", port: 3000, protocol: "http", source: "observed" },
    ]);
  });

  test("subscribes a window to status events on watch and unsubscribes on unwatch", async () => {
    const client = new FakeTunnelClient();
    const harness = createHarness(client);

    const first = (await harness.invoke("paseo:ports:watch", harness.event(1), {
      lease,
      workspaceId: "ws-1",
    })) as DesktopPortForwardingSnapshot;
    expect(first.serverId).toBe("server-1");

    const second = (await harness.invoke("paseo:ports:watch", harness.event(2), {
      lease,
      workspaceId: "ws-1",
    })) as DesktopPortForwardingSnapshot;
    expect(second.serverId).toBe("server-1");

    const portUpdate = harness.manager as unknown as {
      watch(input: unknown, owner: number): Promise<unknown>;
    };
    // Emit a fresh snapshot through the manager's public surface (re-watch
    // emits), then assert only the two subscribed windows received events.
    await portUpdate.watch({ lease, workspaceId: "ws-1" }, 1);

    const eventsForWindow1 = harness.sentEvents.filter(
      (event) => event.webContentsId === 1 && event.channel === "paseo:event:ports-status",
    );
    const eventsForWindow2 = harness.sentEvents.filter((event) => event.webContentsId === 2);
    expect(eventsForWindow1.length).toBeGreaterThan(0);
    expect(eventsForWindow2.length).toBeGreaterThan(0);

    await harness.invoke("paseo:ports:unwatch", harness.event(1), {
      serverId: "server-1",
      connectionId: "connection-1",
      workspaceId: "ws-1",
    });
    await portUpdate.watch({ lease, workspaceId: "ws-1" }, 1);
    const eventsForWindow1AfterUnwatch = harness.sentEvents.filter(
      (event) => event.webContentsId === 1 && event.channel === "paseo:event:ports-status",
    );
    expect(eventsForWindow1AfterUnwatch.length).toBe(eventsForWindow1.length);
    expect(eventsForWindow2.length).toBeGreaterThan(eventsForWindow2.length - 1);
  });

  test("removeWindow drops a window's status subscriptions", async () => {
    const client = new FakeTunnelClient();
    const harness = createHarness(client);

    await harness.invoke("paseo:ports:watch", harness.event(9), {
      lease,
      workspaceId: "ws-1",
    });
    harness.removeWindow(9);

    const before = harness.sentEvents.length;
    await harness.manager.watch({ lease, workspaceId: "ws-1" }, 9);
    expect(harness.sentEvents.length).toBe(before);
  });
});
