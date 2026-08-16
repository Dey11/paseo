import net from "node:net";
import crypto from "node:crypto";
import { TunnelOpcode, type TunnelFrame } from "@getpaseo/protocol/binary-frames/index";
import type { WorkspacePortObservation as ProtocolPortObservation } from "@getpaseo/protocol/messages";
import { TunnelStream } from "./tunnel-stream.js";
import type { TunnelClient } from "./tunnel-client.js";
import type {
  DesktopPortForward,
  DesktopPortForwardingCreateInput,
  DesktopPortForwardingLease,
  DesktopPortForwardingListInput,
  DesktopPortForwardingSnapshot,
  DesktopPortForwardingStopInput,
  DesktopPortForwardingUnwatchInput,
  PortForwardingConnectionStatus,
  PortForwardingLogger,
  WorkspacePortObservation,
  WorkspacePortProtocol,
} from "./types.js";

// Forwards are explicit and last for the current desktop session. The manager
// keeps one dedicated tunnel client per host lease and multiplexes every
// forward and stream over it (docs/fork-docs/desktop-port-forwarding.md).

const DEFAULT_IDLE_TEARDOWN_MS = 30_000;
const LOCAL_BIND_HOST = "127.0.0.1";
const MAX_STREAMS_PER_FORWARD = 16;
const MAX_STREAMS_PER_HOST = 128;

export interface DesktopTunnelLimits {
  maxAggregateRetainedBytes: number;
  maxTransferBytesPerSecondPerForward: number;
  maxTransferBytesPerSecondPerHost: number;
}

// One second of burst is allowed, then token-bucket refill bounds sustained
// traffic. Retained data stays below the tunnel WebSocket high-water mark.
const DEFAULT_TUNNEL_LIMITS: DesktopTunnelLimits = {
  maxAggregateRetainedBytes: 4 * 1024 * 1024,
  maxTransferBytesPerSecondPerForward: 8 * 1024 * 1024,
  maxTransferBytesPerSecondPerHost: 32 * 1024 * 1024,
};

interface RateBucket {
  tokens: number;
  updatedAt: number;
}

class HostTransferLimiter {
  private readonly forwardBuckets = new Map<string, RateBucket>();
  private readonly hostBucket: RateBucket;

  constructor(
    private readonly limits: DesktopTunnelLimits,
    private readonly now: () => number,
  ) {
    this.hostBucket = this.createBucket(limits.maxTransferBytesPerSecondPerHost);
  }

  consume(forwardId: string, bytes: number): boolean {
    const forwardBucket =
      this.forwardBuckets.get(forwardId) ??
      this.createBucket(this.limits.maxTransferBytesPerSecondPerForward);
    this.forwardBuckets.set(forwardId, forwardBucket);
    this.refill(this.hostBucket, this.limits.maxTransferBytesPerSecondPerHost);
    this.refill(forwardBucket, this.limits.maxTransferBytesPerSecondPerForward);
    if (this.hostBucket.tokens < bytes || forwardBucket.tokens < bytes) {
      return false;
    }
    this.hostBucket.tokens -= bytes;
    forwardBucket.tokens -= bytes;
    return true;
  }

  deleteForward(forwardId: string): void {
    this.forwardBuckets.delete(forwardId);
  }

  private createBucket(capacity: number): RateBucket {
    return { tokens: capacity, updatedAt: this.now() };
  }

  private refill(bucket: RateBucket, rate: number): void {
    const now = this.now();
    const elapsedMs = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(rate, bucket.tokens + (elapsedMs * rate) / 1000);
    bucket.updatedAt = now;
  }
}

export function mapProtocolObservation(
  observation: ProtocolPortObservation,
): WorkspacePortObservation {
  return {
    port: observation.port,
    bindAddress: observation.bindAddress,
    protocol: observation.protocol ?? "tcp",
    source: observation.source,
    available: observation.available,
    unavailableReason: observation.unavailableReason,
    terminalId: observation.terminalId ?? null,
    terminalTitle: observation.terminalTitle ?? null,
    processName: observation.processName ?? null,
    serviceName: observation.serviceName ?? null,
  };
}

interface ForwardEntry {
  forwardId: string;
  daemonForwardId: string | null;
  workspaceId: string;
  remotePort: number;
  protocol: WorkspacePortProtocol;
  source: WorkspacePortObservation["source"];
  localHost: "127.0.0.1";
  localPort: number;
  listener: net.Server;
  status: DesktopPortForward["status"];
  error: string | null;
  ownerWebContentsId: number;
}

interface HostSession {
  serverId: string;
  lease: DesktopPortForwardingLease;
  client: TunnelClient;
  lastError: string | null;
  // workspaceId -> windows currently watching it
  watchers: Map<string, Set<number>>;
  portObservations: Map<string, WorkspacePortObservation[]>;
  forwards: Map<string, ForwardEntry>;
  streams: Map<string, TunnelStream>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  restoreInFlight: Promise<void> | null;
  retainedBytes: number;
  transferLimiter: HostTransferLimiter;
}

interface SnapshotKey {
  serverId: string;
  workspaceId: string;
}

export interface PortForwardingManagerOptions {
  createTunnelClient(input: {
    lease: DesktopPortForwardingLease;
    clientId: string;
    logger: PortForwardingLogger;
  }): TunnelClient;
  logger: PortForwardingLogger;
  idleTeardownMs?: number;
  limits?: Partial<DesktopTunnelLimits>;
  now?: () => number;
}

export class PortForwardingManager {
  private readonly hosts = new Map<string, HostSession>();
  private readonly snapshotHandlers = new Map<
    string,
    Set<(snapshot: DesktopPortForwardingSnapshot) => void>
  >();
  private readonly createTunnelClient: PortForwardingManagerOptions["createTunnelClient"];
  private readonly logger: PortForwardingLogger;
  private readonly idleTeardownMs: number;
  private readonly limits: DesktopTunnelLimits;
  private readonly now: () => number;

  constructor(options: PortForwardingManagerOptions) {
    this.createTunnelClient = options.createTunnelClient;
    this.logger = options.logger;
    this.idleTeardownMs = options.idleTeardownMs ?? DEFAULT_IDLE_TEARDOWN_MS;
    this.limits = { ...DEFAULT_TUNNEL_LIMITS, ...options.limits };
    this.now = options.now ?? (() => Date.now());
  }

  async watch(
    input: DesktopPortForwardingListInput,
    ownerWebContentsId: number,
  ): Promise<DesktopPortForwardingSnapshot> {
    const host = await this.ensureConnectedHost(input.lease, ownerWebContentsId);
    this.cancelIdleTeardown(host);
    host.lastError = null;

    const watchers = host.watchers.get(input.workspaceId) ?? new Set<number>();
    const isFirstWatcher = watchers.size === 0;
    watchers.add(ownerWebContentsId);
    host.watchers.set(input.workspaceId, watchers);

    const features = host.client.getFeatures();
    // A watch registered while the dedicated connection is still coming up is
    // sent by restoreAfterReconnect once server capabilities are available.
    if (isFirstWatcher && this.isConnected(host) && features.discoverySupported === true) {
      try {
        const result = await host.client.watchPorts(input.workspaceId);
        if (!result.success) {
          host.lastError = result.error ?? "The host rejected the port watch";
        }
      } catch (error) {
        host.lastError = describeError(error);
      }
    }

    const snapshot = this.buildSnapshot(host, input.workspaceId);
    this.emitSnapshot(host, snapshot);
    return snapshot;
  }

  async create(
    input: DesktopPortForwardingCreateInput,
    ownerWebContentsId: number,
  ): Promise<DesktopPortForwardingSnapshot> {
    const host = await this.ensureConnectedHost(input.lease, ownerWebContentsId);
    this.cancelIdleTeardown(host);
    host.lastError = null;

    const existing = this.findForward(host, input.workspaceId, input.remotePort);
    if (existing) {
      host.lastError = `Port ${input.remotePort} is already forwarded for this workspace`;
      const snapshot = this.buildSnapshot(host, input.workspaceId);
      this.emitSnapshot(host, snapshot);
      return snapshot;
    }

    if (host.client.getConnectionStatus() !== "connected") {
      host.lastError = "Port tunnel is not connected yet";
      const snapshot = this.buildSnapshot(host, input.workspaceId);
      this.emitSnapshot(host, snapshot);
      return snapshot;
    }

    const features = host.client.getFeatures();
    if (this.isConnected(host) && features.forwardingSupported !== true) {
      host.lastError = "Update the host to use port forwarding";
      this.emitSnapshot(host, this.buildSnapshot(host, input.workspaceId));
      return this.buildSnapshot(host, input.workspaceId);
    }

    let listener: net.Server | null = null;
    let localPort: number | null = null;
    try {
      const bound = await bindLoopbackListener({
        requestedPort: input.requestedLocalPort ?? input.remotePort,
        onConnection: (socket) =>
          this.acceptConnection(host, input.workspaceId, input.remotePort, socket),
      });
      listener = bound.listener;
      localPort = bound.localPort;
    } catch (error) {
      host.lastError = `Failed to bind 127.0.0.1:${input.requestedLocalPort ?? input.remotePort}: ${describeError(error)}`;
      this.emitSnapshot(host, this.buildSnapshot(host, input.workspaceId));
      return this.buildSnapshot(host, input.workspaceId);
    }

    const pendingForwardId = `pending_${crypto.randomUUID()}`;
    const entry: ForwardEntry = {
      forwardId: pendingForwardId,
      daemonForwardId: null,
      workspaceId: input.workspaceId,
      remotePort: input.remotePort,
      protocol: input.protocol,
      source: input.source ?? "manual",
      localHost: LOCAL_BIND_HOST,
      localPort,
      listener,
      status: "starting",
      error: null,
      ownerWebContentsId,
    };
    host.forwards.set(pendingForwardId, entry);
    this.emitSnapshot(host, this.buildSnapshot(host, input.workspaceId));

    let forwardId: string | null = null;
    try {
      const result = await host.client.createForward({
        workspaceId: input.workspaceId,
        port: input.remotePort,
        protocol: input.protocol,
        source: input.source,
      });
      forwardId = result.forwardId;
      if (!forwardId) {
        if (host.forwards.get(pendingForwardId) === entry) {
          host.lastError = result.error ?? "The host rejected the port forward";
          entry.listener.close();
          host.forwards.delete(pendingForwardId);
        }
        this.emitSnapshot(host, this.buildSnapshot(host, input.workspaceId));
        return this.buildSnapshot(host, input.workspaceId);
      }
    } catch (error) {
      if (host.forwards.get(pendingForwardId) === entry) {
        host.lastError = describeError(error);
        entry.listener.close();
        host.forwards.delete(pendingForwardId);
      }
      this.emitSnapshot(host, this.buildSnapshot(host, input.workspaceId));
      return this.buildSnapshot(host, input.workspaceId);
    }

    if (host.forwards.get(pendingForwardId) !== entry) {
      await deleteForwardBestEffort(host.client, input.workspaceId, forwardId);
      return this.buildSnapshot(host, input.workspaceId);
    }
    host.forwards.delete(pendingForwardId);
    entry.forwardId = forwardId;
    entry.daemonForwardId = forwardId;
    entry.status = "forwarded";
    host.forwards.set(forwardId, entry);
    this.logger.info(
      {
        serverId: host.serverId,
        workspaceId: input.workspaceId,
        forwardId,
        remotePort: input.remotePort,
        localPort,
      },
      "port_forward_created",
    );

    const snapshot = this.buildSnapshot(host, input.workspaceId);
    this.emitSnapshot(host, snapshot);
    return snapshot;
  }

  async stop(
    input: DesktopPortForwardingStopInput,
    ownerWebContentsId: number,
  ): Promise<DesktopPortForwardingSnapshot> {
    const host = this.hosts.get(input.serverId);
    const entry = host?.forwards.get(input.forwardId);
    if (!host || !entry) {
      throw new Error(`Port forward not found: ${input.forwardId}`);
    }
    if (entry.ownerWebContentsId !== ownerWebContentsId) {
      throw new Error("Port forward belongs to another window");
    }
    await this.stopForward(host, entry, "stopped");
    const snapshot = this.buildSnapshot(host, entry.workspaceId);
    this.emitSnapshot(host, snapshot);
    return snapshot;
  }

  async unwatch(
    input: DesktopPortForwardingUnwatchInput,
    ownerWebContentsId: number,
  ): Promise<void> {
    const host = this.hosts.get(input.serverId);
    if (!host || host.lease.connectionId !== input.connectionId) {
      return;
    }
    const watchers = host.watchers.get(input.workspaceId);
    if (watchers) {
      watchers.delete(ownerWebContentsId);
      if (watchers.size === 0) {
        host.watchers.delete(input.workspaceId);
        await this.unwatchWorkspacePorts(host, input.workspaceId);
      }
    }
    this.scheduleIdleTeardown(host);
  }

  async removeWindow(webContentsId: number): Promise<void> {
    const cleanupTasks: Promise<unknown>[] = [];
    const changedHosts: HostSession[] = [];
    for (const host of Array.from(this.hosts.values())) {
      let changedAny = false;
      for (const entry of Array.from(host.forwards.values())) {
        if (entry.ownerWebContentsId === webContentsId) {
          cleanupTasks.push(this.stopForward(host, entry, "window closed"));
          changedAny = true;
        }
      }
      for (const [workspaceId, watchers] of Array.from(host.watchers.entries())) {
        if (watchers.delete(webContentsId) && watchers.size === 0) {
          host.watchers.delete(workspaceId);
          cleanupTasks.push(this.unwatchWorkspacePorts(host, workspaceId));
          changedAny = true;
        }
      }
      if (changedAny) {
        changedHosts.push(host);
      }
    }
    await Promise.all(cleanupTasks);
    for (const host of changedHosts) {
      for (const workspaceId of this.workspaceIdsOf(host)) {
        this.emitSnapshot(host, this.buildSnapshot(host, workspaceId));
      }
      this.scheduleIdleTeardown(host);
    }
  }

  async disposeAll(): Promise<void> {
    const hostCleanupTasks: Promise<void>[] = [];
    for (const host of Array.from(this.hosts.values())) {
      this.cancelIdleTeardown(host);
      for (const stream of host.streams.values()) {
        stream.closeLocal("app quit");
      }
      host.streams.clear();
      const deleteTasks: Promise<boolean>[] = [];
      for (const entry of host.forwards.values()) {
        entry.listener.close();
        if (entry.daemonForwardId) {
          deleteTasks.push(
            deleteForwardBestEffort(host.client, entry.workspaceId, entry.daemonForwardId),
          );
        }
      }
      host.forwards.clear();
      host.watchers.clear();
      hostCleanupTasks.push(
        (async () => {
          await Promise.all(deleteTasks);
          await host.client.close().catch(() => {});
        })(),
      );
    }
    this.hosts.clear();
    await Promise.all(hostCleanupTasks);
  }

  onSnapshot(
    key: SnapshotKey,
    handler: (snapshot: DesktopPortForwardingSnapshot) => void,
  ): () => void {
    const mapKey = snapshotKey(key);
    let handlers = this.snapshotHandlers.get(mapKey);
    if (!handlers) {
      handlers = new Set();
      this.snapshotHandlers.set(mapKey, handlers);
    }
    handlers.add(handler);
    return () => {
      const current = this.snapshotHandlers.get(mapKey);
      if (!current) {
        return;
      }
      current.delete(handler);
      if (current.size === 0) {
        this.snapshotHandlers.delete(mapKey);
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async ensureConnectedHost(
    lease: DesktopPortForwardingLease,
    ownerWebContentsId: number,
  ): Promise<HostSession> {
    let host = this.hosts.get(lease.serverId);
    if (host && !sameLease(host.lease, lease)) {
      await this.disposeHost(host, "host connection replaced");
      host = undefined;
    }
    if (!host) {
      const client = this.createTunnelClient({
        lease,
        clientId: `paseo-desktop-tunnel-${crypto.randomUUID()}`,
        logger: this.logger,
      });
      host = {
        serverId: lease.serverId,
        lease,
        client,
        lastError: null,
        watchers: new Map(),
        portObservations: new Map(),
        forwards: new Map(),
        streams: new Map(),
        idleTimer: null,
        restoreInFlight: null,
        retainedBytes: 0,
        transferLimiter: new HostTransferLimiter(this.limits, this.now),
      };
      this.hosts.set(lease.serverId, host);
      this.wireHost(host);
      this.logger.info(
        {
          serverId: lease.serverId,
          e2ee: typeof lease.daemonPublicKeyB64 === "string",
          auth: typeof lease.password === "string" ? "bearer" : "none",
          ownerWebContentsId,
        },
        "port_tunnel_host_started",
      );
    }
    const connectedHost = host;
    await connectedHost.client.connect().catch((error) => {
      connectedHost.lastError = describeError(error);
    });
    return connectedHost;
  }

  private isConnected(host: HostSession): boolean {
    return host.client.getConnectionStatus() === "connected";
  }

  private async unwatchWorkspacePorts(host: HostSession, workspaceId: string): Promise<void> {
    const features = host.client.getFeatures();
    if (this.isConnected(host) && features.discoverySupported !== true) {
      return;
    }
    if (!this.isConnected(host)) {
      void host.client.unwatchPorts(workspaceId).catch((error) => {
        this.logger.warn(
          { serverId: host.serverId, workspaceId, error: describeError(error) },
          "port_unwatch_failed",
        );
      });
      return;
    }
    try {
      await host.client.unwatchPorts(workspaceId);
    } catch (error) {
      this.logger.warn(
        { serverId: host.serverId, workspaceId, error: describeError(error) },
        "port_unwatch_failed",
      );
    }
  }

  private wireHost(host: HostSession): void {
    host.client.onTunnelFrame((frame) => this.handleTunnelFrame(host, frame));
    host.client.onPortUpdate((update) => {
      host.portObservations.set(update.workspaceId, update.ports.map(mapProtocolObservation));
      this.emitSnapshot(host, this.buildSnapshot(host, update.workspaceId));
    });
    host.client.onConnectionStatus((status) => this.handleConnectionStatus(host, status));
  }

  private handleConnectionStatus(host: HostSession, status: PortForwardingConnectionStatus): void {
    if (status === "connected") {
      host.lastError = null;
      void this.restoreAfterReconnect(host);
      return;
    }
    if (status === "disconnected" || status === "failed") {
      host.lastError =
        host.client.getLastError() ??
        (status === "failed" ? "Port tunnel connection failed" : "Port tunnel disconnected");
      for (const stream of host.streams.values()) {
        stream.closeLocal("tunnel disconnected");
      }
      host.streams.clear();
      for (const entry of host.forwards.values()) {
        entry.daemonForwardId = null;
        entry.status = "disconnected";
      }
      for (const workspaceId of this.workspaceIdsOf(host)) {
        this.emitSnapshot(host, this.buildSnapshot(host, workspaceId));
      }
    }
  }

  private restoreAfterReconnect(host: HostSession): Promise<void> {
    if (host.restoreInFlight) {
      return host.restoreInFlight;
    }
    host.restoreInFlight = (async () => {
      if (host.client.getFeatures().discoverySupported === true) {
        for (const workspaceId of host.watchers.keys()) {
          try {
            await host.client.watchPorts(workspaceId);
          } catch (error) {
            host.lastError = describeError(error);
          }
        }
      }
      await this.recreateForwardsAfterReconnect(host);
    })().finally(() => {
      host.restoreInFlight = null;
    });
    return host.restoreInFlight;
  }

  private async recreateForwardsAfterReconnect(host: HostSession): Promise<void> {
    for (const entry of Array.from(host.forwards.values())) {
      if (entry.status === "forwarded" || entry.status === "starting") {
        continue;
      }
      entry.status = "starting";
      entry.error = null;
      entry.daemonForwardId = null;
      this.emitSnapshot(host, this.buildSnapshot(host, entry.workspaceId));
      const previousForwardId = entry.forwardId;
      try {
        const result = await host.client.createForward({
          workspaceId: entry.workspaceId,
          port: entry.remotePort,
          protocol: entry.protocol,
          source: entry.source,
        });
        if (!result.forwardId) {
          entry.status = "failed";
          entry.error = result.error ?? "The host rejected the port forward";
        } else {
          if (host.forwards.get(previousForwardId) !== entry) {
            await deleteForwardBestEffort(host.client, entry.workspaceId, result.forwardId);
            continue;
          }
          if (result.forwardId !== entry.forwardId) {
            host.transferLimiter.deleteForward(entry.forwardId);
            host.forwards.delete(entry.forwardId);
            entry.forwardId = result.forwardId;
            host.forwards.set(entry.forwardId, entry);
          }
          entry.daemonForwardId = result.forwardId;
          entry.status = "forwarded";
        }
      } catch (error) {
        entry.status = "failed";
        entry.error = describeError(error);
      }
      this.emitSnapshot(host, this.buildSnapshot(host, entry.workspaceId));
    }
  }

  private handleTunnelFrame(host: HostSession, frame: TunnelFrame): void {
    if (frame.opcode === TunnelOpcode.Open) {
      return;
    }
    const stream = host.streams.get(frame.streamId);
    if (!stream) {
      return;
    }
    if (frame.forwardId !== stream.forwardId) {
      this.logger.warn(
        {
          serverId: host.serverId,
          streamId: frame.streamId,
          expectedForwardId: stream.forwardId,
          receivedForwardId: frame.forwardId,
        },
        "tunnel_stream_forward_mismatch",
      );
      stream.closeLocal("protocol violation");
      host.streams.delete(frame.streamId);
      return;
    }
    if (
      frame.opcode === TunnelOpcode.Data &&
      !host.transferLimiter.consume(stream.forwardId, frame.payload.byteLength)
    ) {
      stream.closeLocal("transfer rate exceeded");
      host.streams.delete(frame.streamId);
      return;
    }
    switch (frame.opcode) {
      case TunnelOpcode.OpenResult: {
        stream.handleOpenResult(frame.ok, frame.error);
        if (frame.ok) {
          const entry = host.forwards.get(stream.forwardId);
          if (entry?.error) {
            entry.error = null;
            this.emitSnapshot(host, this.buildSnapshot(host, entry.workspaceId));
          }
        }
        return;
      }
      case TunnelOpcode.Data: {
        stream.handleData(frame.payload);
        return;
      }
      case TunnelOpcode.WindowUpdate: {
        stream.handleWindowUpdate(frame.credit);
        return;
      }
      case TunnelOpcode.HalfClose: {
        stream.handleHalfClose();
        return;
      }
      case TunnelOpcode.Close: {
        stream.handleCloseFrame(frame.reason);
        host.streams.delete(frame.streamId);
        return;
      }
    }
  }

  private acceptConnection(
    host: HostSession,
    workspaceId: string,
    remotePort: number,
    socket: net.Socket,
  ): void {
    const entry = this.findForward(host, workspaceId, remotePort);
    if (!entry || entry.status !== "forwarded") {
      socket.destroy();
      return;
    }
    let streamsForForward = 0;
    for (const stream of host.streams.values()) {
      if (stream.forwardId === entry.forwardId) streamsForForward += 1;
    }
    if (streamsForForward >= MAX_STREAMS_PER_FORWARD || host.streams.size >= MAX_STREAMS_PER_HOST) {
      this.logger.warn(
        {
          serverId: host.serverId,
          forwardId: entry.forwardId,
          streamsForForward,
          streamsForHost: host.streams.size,
        },
        "tunnel_stream_limit_reached",
      );
      socket.destroy();
      return;
    }
    const streamId = crypto.randomUUID();
    const stream = new TunnelStream({
      forwardId: entry.forwardId,
      streamId,
      sendFrame: (frame) => this.sendHostFrame(host, frame),
      onClosed: (reason) => {
        host.streams.delete(streamId);
        const currentEntry = host.forwards.get(entry.forwardId);
        if (currentEntry && isForwardStreamError(reason)) {
          currentEntry.error = reason;
          this.emitSnapshot(host, this.buildSnapshot(host, currentEntry.workspaceId));
        }
        this.logger.info(
          { serverId: host.serverId, forwardId: entry.forwardId, streamId, reason },
          "tunnel_stream_closed",
        );
      },
      reserveRetainedBytes: (delta) => {
        if (delta > 0 && host.retainedBytes + delta > this.limits.maxAggregateRetainedBytes) {
          return false;
        }
        host.retainedBytes = Math.max(0, host.retainedBytes + delta);
        return true;
      },
    });
    host.streams.set(streamId, stream);
    stream.attach(socket);
    this.sendHostFrame(host, {
      opcode: TunnelOpcode.Open,
      forwardId: entry.forwardId,
      streamId,
    });
  }

  private sendHostFrame(
    host: HostSession,
    frame: Parameters<TunnelClient["sendTunnelFrame"]>[0],
  ): void {
    if (host.client.getConnectionStatus() !== "connected") {
      return;
    }
    if (frame.opcode === TunnelOpcode.Data) {
      const stream = host.streams.get(frame.streamId);
      const payload = frame.payload;
      if (!(payload instanceof Uint8Array)) {
        stream?.closeLocal("protocol violation");
        return;
      }
      if (!stream || !host.transferLimiter.consume(frame.forwardId, payload.byteLength)) {
        stream?.closeLocal("transfer rate exceeded");
        return;
      }
    }
    try {
      host.client.sendTunnelFrame(frame);
    } catch (error) {
      host.lastError = describeError(error);
    }
  }

  private findForward(
    host: HostSession,
    workspaceId: string,
    remotePort: number,
  ): ForwardEntry | null {
    for (const entry of host.forwards.values()) {
      if (entry.workspaceId === workspaceId && entry.remotePort === remotePort) {
        return entry;
      }
    }
    return null;
  }

  private async stopForward(host: HostSession, entry: ForwardEntry, reason: string): Promise<void> {
    this.logger.info(
      { serverId: host.serverId, forwardId: entry.forwardId, reason },
      "port_forward_stopped",
    );
    for (const stream of Array.from(host.streams.values())) {
      if (stream.forwardId === entry.forwardId) {
        stream.closeLocal(reason);
        host.streams.delete(stream.streamId);
      }
    }
    entry.listener.close();
    host.forwards.delete(entry.forwardId);
    host.transferLimiter.deleteForward(entry.forwardId);
    if (
      entry.daemonForwardId &&
      !(await deleteForwardBestEffort(host.client, entry.workspaceId, entry.daemonForwardId))
    ) {
      this.logger.warn(
        { serverId: host.serverId, forwardId: entry.forwardId },
        "port_forward_delete_failed",
      );
    }
    this.scheduleIdleTeardown(host);
  }

  private buildSnapshot(host: HostSession, workspaceId: string): DesktopPortForwardingSnapshot {
    const forwards: DesktopPortForward[] = [];
    for (const entry of host.forwards.values()) {
      if (entry.workspaceId === workspaceId) {
        forwards.push({
          forwardId: entry.forwardId,
          workspaceId: entry.workspaceId,
          remotePort: entry.remotePort,
          localHost: entry.localHost,
          localPort: entry.localPort,
          protocol: entry.protocol,
          source: entry.source,
          status: entry.status,
          error: entry.error,
        });
      }
    }
    const features = host.client.getFeatures();
    return {
      serverId: host.serverId,
      workspaceId,
      connectionStatus: host.client.getConnectionStatus(),
      forwardingSupported: features.forwardingSupported,
      discoverySupported: features.discoverySupported,
      ports: host.portObservations.get(workspaceId) ?? [],
      forwards,
      error: host.lastError,
    };
  }

  private emitSnapshot(host: HostSession, snapshot: DesktopPortForwardingSnapshot): void {
    const handlers = this.snapshotHandlers.get(
      snapshotKey({ serverId: host.serverId, workspaceId: snapshot.workspaceId }),
    );
    if (!handlers) {
      return;
    }
    for (const handler of Array.from(handlers)) {
      try {
        handler(snapshot);
      } catch {
        // no-op
      }
    }
  }

  private workspaceIdsOf(host: HostSession): string[] {
    return Array.from(
      new Set([
        ...host.watchers.keys(),
        ...Array.from(host.forwards.values(), (entry) => entry.workspaceId),
      ]),
    );
  }

  private scheduleIdleTeardown(host: HostSession): void {
    this.cancelIdleTeardown(host);
    if (this.idleTeardownMs <= 0 || this.workspaceIdsOf(host).length > 0) {
      return;
    }
    host.idleTimer = setTimeout(() => {
      host.idleTimer = null;
      void this.teardownHost(host);
    }, this.idleTeardownMs);
  }

  private cancelIdleTeardown(host: HostSession): void {
    if (host.idleTimer) {
      clearTimeout(host.idleTimer);
      host.idleTimer = null;
    }
  }

  private async teardownHost(host: HostSession): Promise<void> {
    if (this.workspaceIdsOf(host).length > 0) {
      return;
    }
    this.hosts.delete(host.serverId);
    for (const stream of host.streams.values()) {
      stream.closeLocal("tunnel idle");
    }
    host.streams.clear();
    await host.client.close().catch(() => {});
    this.logger.info({ serverId: host.serverId }, "port_tunnel_host_stopped");
  }

  private async disposeHost(host: HostSession, reason: string): Promise<void> {
    this.cancelIdleTeardown(host);
    this.hosts.delete(host.serverId);
    for (const stream of host.streams.values()) {
      stream.closeLocal(reason);
    }
    host.streams.clear();
    const deleteTasks: Promise<boolean>[] = [];
    for (const entry of host.forwards.values()) {
      entry.listener.close();
      if (entry.daemonForwardId) {
        deleteTasks.push(
          deleteForwardBestEffort(host.client, entry.workspaceId, entry.daemonForwardId),
        );
      }
    }
    host.forwards.clear();
    host.watchers.clear();
    await Promise.all(deleteTasks);
    await host.client.close().catch(() => {});
  }
}

function snapshotKey(key: SnapshotKey): string {
  return `${key.serverId}:${key.workspaceId}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function isForwardStreamError(reason: string): boolean {
  return ![
    "local connection closed",
    "stopped",
    "window closed",
    "app quit",
    "tunnel disconnected",
    "host connection replaced",
    "tunnel idle",
  ].includes(reason);
}

function sameLease(left: DesktopPortForwardingLease, right: DesktopPortForwardingLease): boolean {
  return (
    left.serverId === right.serverId &&
    left.connectionId === right.connectionId &&
    left.url === right.url &&
    left.password === right.password &&
    left.daemonPublicKeyB64 === right.daemonPublicKeyB64
  );
}

async function deleteForwardBestEffort(
  client: TunnelClient,
  workspaceId: string,
  forwardId: string,
): Promise<boolean> {
  return Promise.race([
    client.deleteForward(workspaceId, forwardId).then(
      () => true,
      () => false,
    ),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      timer.unref?.();
    }).then(() => false),
  ]);
}

async function bindLoopbackListener(input: {
  requestedPort: number;
  onConnection: (socket: net.Socket) => void;
}): Promise<{ listener: net.Server; localPort: number }> {
  const attempt = (port: number): Promise<{ listener: net.Server; localPort: number }> =>
    new Promise((resolve, reject) => {
      const listener = net.createServer({ pauseOnConnect: true, allowHalfOpen: true }, (socket) => {
        input.onConnection(socket);
      });
      const onError = (error: Error) => {
        listener.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        listener.removeListener("error", onError);
        const address = listener.address();
        if (!address || typeof address === "string") {
          reject(new Error("Listener bound to an unexpected address"));
          return;
        }
        resolve({ listener, localPort: address.port });
      };
      listener.once("error", onError);
      listener.once("listening", onListening);
      // exclusive: never share the port with another process's socket.
      listener.listen({ host: LOCAL_BIND_HOST, port, exclusive: true });
    });

  try {
    return await attempt(input.requestedPort);
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "EADDRINUSE" || code === "EACCES") {
      return attempt(0);
    }
    throw error;
  }
}
