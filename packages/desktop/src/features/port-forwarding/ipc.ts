import type {
  DesktopPortForwardingCreateInput,
  DesktopPortForwardingLease,
  DesktopPortForwardingListInput,
  DesktopPortForwardingStopInput,
  DesktopPortForwardingUnwatchInput,
  WorkspacePortProtocol,
} from "./types.js";
import { PortForwardingManager } from "./tunnel-manager.js";

// Narrow validated IPC surface for the Ports tab. Every renderer input is
// re-validated here; the manager only ever sees typed values.

export interface IpcRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

interface PortForwardingIpcDeps {
  ipc: IpcRegistry;
  manager: PortForwardingManager;
  sendEvent(webContentsId: number, channel: string, payload: unknown): void;
}

function readWebContentsId(event: unknown): number {
  if (!isRecord(event) || !isRecord(event.sender)) {
    return 0;
  }
  return typeof event.sender.id === "number" ? event.sender.id : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readPortNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    return null;
  }
  return value;
}

function readProtocol(value: unknown): WorkspacePortProtocol | null {
  return value === "http" || value === "https" || value === "tcp" ? value : null;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readLease(record: Record<string, unknown>): DesktopPortForwardingLease | null {
  const lease = record.lease;
  if (!isRecord(lease)) {
    return null;
  }
  const serverId = readNonEmptyString(lease, "serverId");
  const connectionId = readNonEmptyString(lease, "connectionId");
  const url = readNonEmptyString(lease, "url");
  if (
    !serverId ||
    !connectionId ||
    !url ||
    !(url.startsWith("ws://") || url.startsWith("wss://"))
  ) {
    return null;
  }
  return {
    serverId,
    connectionId,
    url,
    password: readOptionalString(lease, "password"),
    daemonPublicKeyB64: readOptionalString(lease, "daemonPublicKeyB64"),
    appVersion: readOptionalString(lease, "appVersion"),
  };
}

function readListInput(rawInput: unknown): DesktopPortForwardingListInput | null {
  if (!isRecord(rawInput)) {
    return null;
  }
  const lease = readLease(rawInput);
  const workspaceId = readNonEmptyString(rawInput, "workspaceId");
  if (!lease || !workspaceId) {
    return null;
  }
  return { lease, workspaceId };
}

function readCreateInput(rawInput: unknown): DesktopPortForwardingCreateInput | null {
  const base = readListInput(rawInput);
  if (!base || !isRecord(rawInput)) {
    return null;
  }
  const remotePort = readPortNumber(rawInput, "remotePort");
  const protocol = readProtocol(rawInput.protocol);
  if (!remotePort || !protocol) {
    return null;
  }
  let requestedLocalPort: number | undefined;
  if (rawInput.requestedLocalPort !== undefined) {
    const parsed = readPortNumber(rawInput, "requestedLocalPort");
    if (parsed === null) {
      return null;
    }
    requestedLocalPort = parsed;
  }
  const source = rawInput.source;
  if (
    source !== undefined &&
    source !== "observed" &&
    source !== "configured" &&
    source !== "manual"
  ) {
    return null;
  }
  return {
    ...base,
    remotePort,
    protocol,
    source,
    requestedLocalPort,
  };
}

function readStopInput(rawInput: unknown): DesktopPortForwardingStopInput | null {
  if (!isRecord(rawInput)) {
    return null;
  }
  const serverId = readNonEmptyString(rawInput, "serverId");
  const forwardId = readNonEmptyString(rawInput, "forwardId");
  if (!serverId || !forwardId) {
    return null;
  }
  return { serverId, forwardId };
}

function readUnwatchInput(rawInput: unknown): DesktopPortForwardingUnwatchInput | null {
  if (!isRecord(rawInput)) {
    return null;
  }
  const serverId = readNonEmptyString(rawInput, "serverId");
  const connectionId = readNonEmptyString(rawInput, "connectionId");
  const workspaceId = readNonEmptyString(rawInput, "workspaceId");
  if (!serverId || !connectionId || !workspaceId) {
    return null;
  }
  return { serverId, connectionId, workspaceId };
}

const STATUS_EVENT_CHANNEL = "paseo:event:ports-status";

export function registerPortForwardingIpc(deps: PortForwardingIpcDeps): {
  removeWindow(webContentsId: number): void;
} {
  const { ipc, manager, sendEvent } = deps;
  const subscriptions = new Map<string, () => void>();

  const unsubscribeWindow = (webContentsId: number): void => {
    const prefix = `${webContentsId}:`;
    for (const [key, unsubscribe] of Array.from(subscriptions.entries())) {
      if (key.startsWith(prefix)) {
        unsubscribe();
        subscriptions.delete(key);
      }
    }
  };

  const subscribeStatus = (
    webContentsId: number,
    serverId: string,
    connectionId: string,
    workspaceId: string,
  ): void => {
    const key = `${webContentsId}:${serverId}:${connectionId}:${workspaceId}`;
    subscriptions.get(key)?.();
    subscriptions.set(
      key,
      manager.onSnapshot({ serverId, workspaceId }, (snapshot) => {
        sendEvent(webContentsId, STATUS_EVENT_CHANNEL, snapshot);
      }),
    );
  };

  ipc.handle("paseo:ports:watch", async (event, rawInput: unknown) => {
    const input = readListInput(rawInput);
    if (!input) {
      throw new Error("Invalid port forwarding watch input");
    }
    const webContentsId = readWebContentsId(event);
    const snapshot = await manager.watch(input, webContentsId);
    if (webContentsId > 0) {
      subscribeStatus(
        webContentsId,
        snapshot.serverId,
        input.lease.connectionId,
        snapshot.workspaceId,
      );
    }
    return snapshot;
  });

  ipc.handle("paseo:ports:create", async (event, rawInput: unknown) => {
    const input = readCreateInput(rawInput);
    if (!input) {
      throw new Error("Invalid port forwarding create input");
    }
    const webContentsId = readWebContentsId(event);
    const snapshot = await manager.create(input, webContentsId);
    if (webContentsId > 0) {
      subscribeStatus(
        webContentsId,
        snapshot.serverId,
        input.lease.connectionId,
        snapshot.workspaceId,
      );
    }
    return snapshot;
  });

  ipc.handle("paseo:ports:stop", async (event, rawInput: unknown) => {
    const input = readStopInput(rawInput);
    if (!input) {
      throw new Error("Invalid port forwarding stop input");
    }
    return manager.stop(input, readWebContentsId(event));
  });

  ipc.handle("paseo:ports:unwatch", async (event, rawInput: unknown) => {
    const input = readUnwatchInput(rawInput);
    if (!input) {
      throw new Error("Invalid port forwarding unwatch input");
    }
    const webContentsId = readWebContentsId(event);
    const key = `${webContentsId}:${input.serverId}:${input.connectionId}:${input.workspaceId}`;
    subscriptions.get(key)?.();
    subscriptions.delete(key);
    await manager.unwatch(input, webContentsId);
  });

  return { removeWindow: unsubscribeWindow };
}
