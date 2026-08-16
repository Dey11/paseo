import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import { encodeTunnelFrame, type TunnelFrame } from "@getpaseo/protocol/binary-frames/index";
import type { WorkspacePortObservation as ProtocolPortObservation } from "@getpaseo/protocol/messages";
import { WebSocket } from "ws";
import type {
  DesktopPortForwardingLease,
  PortForwardingConnectionStatus,
  PortForwardingLogger,
  WorkspacePortProtocol,
} from "./types.js";

export type TunnelFrameInput = Parameters<typeof encodeTunnelFrame>[0];

export interface TunnelPortUpdate {
  workspaceId: string;
  ports: ProtocolPortObservation[];
}

export interface TunnelClient {
  readonly serverId: string;
  getConnectionStatus(): PortForwardingConnectionStatus;
  getFeatures(): { forwardingSupported: boolean | null; discoverySupported: boolean | null };
  getLastError(): string | null;
  connect(): Promise<void>;
  close(): Promise<void>;
  watchPorts(workspaceId: string): Promise<{ success: boolean; error: string | null }>;
  unwatchPorts(workspaceId: string): Promise<{ success: boolean; error: string | null }>;
  createForward(input: {
    workspaceId: string;
    port: number;
    protocol: WorkspacePortProtocol;
    source?: ProtocolPortObservation["source"];
  }): Promise<{ forwardId: string | null; error: string | null }>;
  deleteForward(workspaceId: string, forwardId: string): Promise<void>;
  sendTunnelFrame(frame: TunnelFrameInput): void;
  onTunnelFrame(handler: (frame: TunnelFrame) => void): () => void;
  onPortUpdate(handler: (update: TunnelPortUpdate) => void): () => void;
  onConnectionStatus(handler: (status: PortForwardingConnectionStatus) => void): () => void;
}

export interface TunnelClientFactory {
  create(input: {
    lease: DesktopPortForwardingLease;
    clientId: string;
    logger: PortForwardingLogger;
  }): TunnelClient;
}

export function createNodeWebSocketFactory(
  url: string,
  options?: { headers?: Record<string, string>; protocols?: string[] },
): WebSocketLike {
  return new WebSocket(url, options?.protocols, {
    headers: options?.headers,
  }) as unknown as WebSocketLike;
}

// Bound on the first connection attempt so manager actions never hang behind
// DaemonClient's internal reconnect loop.
const CONNECT_WAIT_MS = 15_000;

function mapConnectionStatus(
  status: ReturnType<DaemonClient["getConnectionState"]>,
): PortForwardingConnectionStatus {
  switch (status.status) {
    case "connected":
      return "connected";
    case "disconnected":
      return "disconnected";
    case "disposed":
      return "failed";
    case "idle":
    case "connecting":
      return "connecting";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DaemonTunnelClient implements TunnelClient {
  readonly serverId: string;
  private readonly client: DaemonClient;
  private readonly connectionStatusHandlers = new Set<
    (status: PortForwardingConnectionStatus) => void
  >();
  private readonly tunnelFrameHandlers = new Set<(frame: TunnelFrame) => void>();
  private readonly portUpdateHandlers = new Set<(update: TunnelPortUpdate) => void>();
  private lastConnectionStatus: PortForwardingConnectionStatus = "connecting";

  constructor(input: {
    lease: DesktopPortForwardingLease;
    clientId: string;
    logger: PortForwardingLogger;
  }) {
    this.serverId = input.lease.serverId;
    this.client = new DaemonClient({
      url: input.lease.url,
      clientId: input.clientId,
      clientType: "browser",
      ...(input.lease.appVersion ? { appVersion: input.lease.appVersion } : {}),
      ...(input.lease.password ? { password: input.lease.password } : {}),
      ...(input.lease.daemonPublicKeyB64
        ? { e2ee: { enabled: true, daemonPublicKeyB64: input.lease.daemonPublicKeyB64 } }
        : {}),
      logger: {
        debug: () => {},
        info: (obj, msg) => input.logger.info(obj, msg ?? ""),
        warn: (obj, msg) => input.logger.warn(obj, msg ?? ""),
        error: (obj, msg) => input.logger.error(obj, msg ?? ""),
      },
      connectTimeoutMs: 10_000,
      suppressSendErrors: true,
      webSocketFactory: createNodeWebSocketFactory,
      reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 10_000 },
    });

    this.client.subscribeConnectionStatus((state) => {
      this.lastConnectionStatus = mapConnectionStatus(state);
      for (const handler of this.connectionStatusHandlers) {
        try {
          handler(this.lastConnectionStatus);
        } catch {
          // no-op
        }
      }
    });
    this.client.subscribeTunnelFrames((frame) => {
      for (const handler of this.tunnelFrameHandlers) {
        try {
          handler(frame);
        } catch {
          // no-op
        }
      }
    });
    this.client.on("workspace.port.update", (message) => {
      const update: TunnelPortUpdate = {
        workspaceId: message.payload.workspaceId,
        ports: message.payload.ports,
      };
      for (const handler of this.portUpdateHandlers) {
        try {
          handler(update);
        } catch {
          // no-op
        }
      }
    });
  }

  getConnectionStatus(): PortForwardingConnectionStatus {
    return this.lastConnectionStatus;
  }

  getFeatures(): { forwardingSupported: boolean | null; discoverySupported: boolean | null } {
    const features = this.client.getLastServerInfoMessage()?.features;
    return {
      forwardingSupported:
        typeof features?.workspacePortForwarding === "boolean"
          ? features.workspacePortForwarding
          : null,
      discoverySupported:
        typeof features?.workspacePortDiscovery === "boolean"
          ? features.workspacePortDiscovery
          : null,
    };
  }

  getLastError(): string | null {
    return this.client.lastError;
  }

  async connect(): Promise<void> {
    if (this.client.isConnected || this.client.isConnecting) {
      return;
    }
    // DaemonClient keeps retrying internally, so its connect() promise can stay
    // pending while the daemon is unreachable. Bound the wait here; queued RPCs
    // flush once the connection lands.
    await Promise.race([
      this.client.connect().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, CONNECT_WAIT_MS)),
    ]);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async watchPorts(workspaceId: string): Promise<{ success: boolean; error: string | null }> {
    const payload = await this.client.watchWorkspacePorts(workspaceId);
    return { success: payload.success, error: payload.error };
  }

  async unwatchPorts(workspaceId: string): Promise<{ success: boolean; error: string | null }> {
    const payload = await this.client.unwatchWorkspacePorts(workspaceId);
    return { success: payload.success, error: payload.error };
  }

  async createForward(input: {
    workspaceId: string;
    port: number;
    protocol: WorkspacePortProtocol;
    source?: ProtocolPortObservation["source"];
  }): Promise<{ forwardId: string | null; error: string | null }> {
    const payload = await this.client.createPortForward({
      workspaceId: input.workspaceId,
      port: input.port,
      ...(input.protocol ? { protocol: input.protocol } : {}),
      ...(input.source ? { source: input.source } : {}),
    });
    return { forwardId: payload.forwardId, error: payload.error };
  }

  async deleteForward(workspaceId: string, forwardId: string): Promise<void> {
    await this.client.deletePortForward(workspaceId, forwardId);
  }

  sendTunnelFrame(frame: TunnelFrameInput): void {
    this.client.sendTunnelFrame(frame);
  }

  onTunnelFrame(handler: (frame: TunnelFrame) => void): () => void {
    this.tunnelFrameHandlers.add(handler);
    return () => {
      this.tunnelFrameHandlers.delete(handler);
    };
  }

  onPortUpdate(handler: (update: TunnelPortUpdate) => void): () => void {
    this.portUpdateHandlers.add(handler);
    return () => {
      this.portUpdateHandlers.delete(handler);
    };
  }

  onConnectionStatus(handler: (status: PortForwardingConnectionStatus) => void): () => void {
    this.connectionStatusHandlers.add(handler);
    return () => {
      this.connectionStatusHandlers.delete(handler);
    };
  }
}

export function createDaemonTunnelClientFactory(): TunnelClientFactory {
  return {
    create: (input) => new DaemonTunnelClient(input),
  };
}

// Kept as a named export so callers can depend on the codec input shape
// without importing the protocol module directly in IPC-facing files.
export type { TunnelFrame };
export { describeError };
