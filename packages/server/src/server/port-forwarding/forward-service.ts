import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type pino from "pino";
import { TunnelOpcode, type TunnelFrame } from "@getpaseo/protocol/binary-frames/index";

/**
 * Session-owned port-forward service. Validates workspaceId + TCP port,
 * restricts the target host to daemon loopback, and opens one real node:net
 * socket per incoming tunnel stream with half-close/close propagation and
 * credit-based flow control in both directions. Everything is torn down with
 * the owning session.
 *
 * Frames are the protocol tunnel family (`@getpaseo/protocol/binary-frames`):
 * forwardId and streamId are opaque strings, data payloads are capped at
 * 64 KiB by the codec, and close/open-result reasons are short strings.
 */

/**
 * Frames this service sends; mirrors the protocol codec's encode input
 * contract (ok:true carries no error; ok:false requires one).
 */
export type TunnelFrameInput =
  | { opcode: typeof TunnelOpcode.Open; forwardId: string; streamId: string }
  | {
      opcode: typeof TunnelOpcode.OpenResult;
      forwardId: string;
      streamId: string;
      ok: true;
    }
  | {
      opcode: typeof TunnelOpcode.OpenResult;
      forwardId: string;
      streamId: string;
      ok: false;
      error: string;
    }
  | {
      opcode: typeof TunnelOpcode.Data;
      forwardId: string;
      streamId: string;
      payload: Uint8Array;
    }
  | {
      opcode: typeof TunnelOpcode.WindowUpdate;
      forwardId: string;
      streamId: string;
      credit: number;
    }
  | { opcode: typeof TunnelOpcode.HalfClose; forwardId: string; streamId: string }
  | { opcode: typeof TunnelOpcode.Close; forwardId: string; streamId: string; reason: string };
export type TunnelCloseReason =
  | "refused"
  | "connect_failed"
  | "forward_deleted"
  | "session_cleanup"
  | "transport_disconnected"
  | "flow_control_violation"
  | "backpressure_exceeded"
  | "transfer_rate_exceeded"
  | "max_streams"
  | "duplicate_stream"
  | "unknown_forward"
  | "unknown_stream"
  | "invalid_target"
  | "stream_aborted";

export type ForwardCreateError =
  | "workspace_not_found"
  | "workspace_archived"
  | "invalid_port"
  | "invalid_host"
  | "forward_limit"
  | "already_forwarded";

export type ForwardCreateResult =
  | { ok: true; forward: PortForwardState }
  | { ok: false; code: ForwardCreateError; message: string };

export interface PortForwardState {
  forwardId: string;
  workspaceId: string;
  port: number;
  host: string;
  createdAt: number;
}

export interface WorkspaceRef {
  workspaceId: string;
  archivedAt: string | null;
}

export interface PortForwardServiceLimits {
  maxForwards: number;
  maxStreamsPerForward: number;
  maxChunkBytes: number;
  initialWindowBytes: number;
  maxQueuedBytesPerStream: number;
  maxAggregateQueuedBytes: number;
  maxTransferBytesPerSecondPerForward: number;
  maxTransferBytesPerSecondPerHost: number;
}

export interface PortForwardServiceDeps {
  getWorkspace: (workspaceId: string) => Promise<WorkspaceRef | null>;
  sendFrame: (frame: TunnelFrameInput) => void;
  logger: pino.Logger;
  connectTcp?: (host: string, port: number) => Promise<Socket>;
  now?: () => number;
  limits?: Partial<PortForwardServiceLimits>;
}

const DEFAULT_LIMITS: PortForwardServiceLimits = {
  maxForwards: 8,
  maxStreamsPerForward: 16,
  maxChunkBytes: 64 * 1024,
  initialWindowBytes: 256 * 1024,
  maxQueuedBytesPerStream: 1024 * 1024,
  maxAggregateQueuedBytes: 4 * 1024 * 1024,
  maxTransferBytesPerSecondPerForward: 8 * 1024 * 1024,
  maxTransferBytesPerSecondPerHost: 32 * 1024 * 1024,
};

const LOOPBACK_HOSTS = new Map<string, string>([
  ["127.0.0.1", "127.0.0.1"],
  ["localhost", "127.0.0.1"],
  ["::1", "::1"],
]);

interface StreamRecord {
  forwardId: string;
  streamId: string;
  socket: Socket;
  // peer -> daemon direction: bytes the peer may still send before we grant
  // more credit; incremented by window_update, decremented by received data.
  peerCredit: number;
  // daemon -> peer direction: window remaining before delivery pauses;
  // decremented by delivered data, incremented by window_update.
  peerWindow: number;
  // Bytes delivered to the peer but not yet re-credited by a window update.
  // The per-stream and aggregate ceilings bound the transport queue below the
  // physical WebSocket high-water mark.
  pendingOutboundBytes: number;
  // Bytes accepted from the peer whose remote-socket write callbacks have not
  // fired yet. These consume the same aggregate retained-byte budget as the
  // daemon-to-peer queue so many slow targets cannot multiply memory use.
  pendingInboundBytes: number;
  // Bytes read from the remote socket but not yet delivered because the peer
  // window is exhausted. Bounded by maxQueuedBytesPerStream / aggregate cap.
  outboundQueue: Buffer[];
  queuedBytes: number;
  peerClosed: boolean;
  remoteEnded: boolean;
  daemonClosed: boolean;
  closeReason: TunnelCloseReason | null;
}

interface RateBucket {
  tokens: number;
  updatedAt: number;
}

/** One-second burst token buckets shared by both transfer directions. */
class SessionTransferLimiter {
  private readonly forwardBuckets = new Map<string, RateBucket>();
  private readonly hostBucket: RateBucket;

  constructor(
    private readonly limits: PortForwardServiceLimits,
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

  clear(): void {
    this.forwardBuckets.clear();
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

function connectTcpDefault(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port, allowHalfOpen: true });
    socket.once("connect", () => resolve(socket));
    socket.once("error", (error: NodeJS.ErrnoException) => reject(error));
  });
}

export class PortForwardService {
  private readonly deps: PortForwardServiceDeps;
  private readonly limits: PortForwardServiceLimits;
  private readonly forwards = new Map<string, PortForwardState>();
  private readonly streamsByForward = new Map<string, Map<string, StreamRecord>>();
  // Opens awaiting their connect; counted against maxStreamsPerForward because
  // a stream record only exists after the remote socket connects.
  private readonly pendingOpensByForward = new Map<string, number>();
  private readonly pendingStreamIds = new Set<string>();
  private readonly now: () => number;
  private readonly transferLimiter: SessionTransferLimiter;
  private disposed = false;

  constructor(deps: PortForwardServiceDeps) {
    this.deps = deps;
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.now = deps.now ?? (() => Date.now());
    this.transferLimiter = new SessionTransferLimiter(this.limits, this.now);
  }

  get hasActiveForwards(): boolean {
    return this.forwards.size > 0;
  }

  listForwards(): PortForwardState[] {
    return [...this.forwards.values()];
  }

  async createForward(input: {
    workspaceId: string;
    port: number;
    host?: string;
  }): Promise<ForwardCreateResult> {
    if (this.disposed) {
      return { ok: false, code: "forward_limit", message: "Port forwarding is not available" };
    }
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
      return {
        ok: false,
        code: "invalid_port",
        message: `Invalid TCP port ${String(input.port)}`,
      };
    }
    const host = LOOPBACK_HOSTS.get(input.host ?? "127.0.0.1");
    if (!host) {
      return {
        ok: false,
        code: "invalid_host",
        message: "Forward target host must be daemon loopback",
      };
    }
    const workspace = await this.deps.getWorkspace(input.workspaceId);
    if (!workspace) {
      return { ok: false, code: "workspace_not_found", message: "Workspace not found" };
    }
    if (workspace.archivedAt !== null) {
      return { ok: false, code: "workspace_archived", message: "Workspace is archived" };
    }
    if (this.forwards.size >= this.limits.maxForwards) {
      return {
        ok: false,
        code: "forward_limit",
        message: `Forward limit of ${this.limits.maxForwards} reached`,
      };
    }
    for (const forward of this.forwards.values()) {
      if (forward.workspaceId === input.workspaceId && forward.port === input.port) {
        return {
          ok: false,
          code: "already_forwarded",
          message: `Port ${input.port} is already forwarded for this workspace`,
        };
      }
    }
    const forward: PortForwardState = {
      forwardId: `fw_${randomUUID()}`,
      workspaceId: input.workspaceId,
      port: input.port,
      host,
      createdAt: this.now(),
    };
    this.forwards.set(forward.forwardId, forward);
    this.streamsByForward.set(forward.forwardId, new Map());
    this.deps.logger.info(
      { forwardId: forward.forwardId, workspaceId: forward.workspaceId, port: forward.port },
      "port_forward.created",
    );
    return { ok: true, forward };
  }

  deleteForward(forwardId: string): boolean {
    const forward = this.forwards.get(forwardId);
    if (!forward) return false;
    this.forwards.delete(forwardId);
    this.deps.logger.info(
      { forwardId, workspaceId: forward.workspaceId, port: forward.port },
      "port_forward.deleted",
    );
    const streams = this.streamsByForward.get(forwardId);
    if (streams) {
      for (const stream of streams.values()) {
        this.closeStream(stream, "forward_deleted");
      }
    }
    this.streamsByForward.delete(forwardId);
    this.transferLimiter.deleteForward(forwardId);
    return true;
  }

  /** Handle one decoded tunnel frame from the peer. */
  handleFrame(frame: TunnelFrame): void {
    switch (frame.opcode) {
      case TunnelOpcode.Open:
        this.handleOpen(frame);
        return;
      case TunnelOpcode.Data:
        this.handleData(frame);
        return;
      case TunnelOpcode.WindowUpdate:
        this.handleWindowUpdate(frame);
        return;
      case TunnelOpcode.HalfClose:
        this.handleHalfClose(frame);
        return;
      case TunnelOpcode.Close:
        this.handlePeerClose(frame);
        return;
      case TunnelOpcode.OpenResult:
        return;
    }
  }

  /** Tear everything down with the owning session. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const forwardId of this.forwards.keys()) {
      const streams = this.streamsByForward.get(forwardId);
      if (streams) {
        for (const stream of streams.values()) {
          this.closeStream(stream, "session_cleanup");
        }
      }
    }
    this.forwards.clear();
    this.streamsByForward.clear();
    this.pendingOpensByForward.clear();
    this.pendingStreamIds.clear();
    this.transferLimiter.clear();
  }

  /**
   * The trusted transport lost its last socket: close every stream and revoke
   * every forward id. The desktop keeps only its local listeners and recreates
   * daemon-side forwards after reconnecting, so no disconnected authorization
   * survives and reconnects never hit "already_forwarded".
   */
  revokeAllForTransportLoss(): void {
    if (this.disposed) return;
    for (const forwardId of this.forwards.keys()) {
      const streams = this.streamsByForward.get(forwardId);
      if (streams) {
        for (const stream of streams.values()) {
          this.closeStream(stream, "transport_disconnected");
        }
      }
      this.deps.logger.info(
        { forwardId, workspaceId: this.forwards.get(forwardId)?.workspaceId },
        "port_forward.revoked.transport_loss",
      );
    }
    this.forwards.clear();
    this.streamsByForward.clear();
    this.pendingOpensByForward.clear();
    this.pendingStreamIds.clear();
    this.transferLimiter.clear();
  }

  private async handleOpen(
    frame: Extract<TunnelFrame, { opcode: typeof TunnelOpcode.Open }>,
  ): Promise<void> {
    const forward = this.forwards.get(frame.forwardId);
    if (!forward) {
      this.deps.logger.warn(
        { forwardId: frame.forwardId, streamId: frame.streamId },
        "port_forward.open.unknown_forward",
      );
      this.sendClose(frame.forwardId, frame.streamId, "unknown_forward");
      return;
    }
    const streams = this.streamsByForward.get(frame.forwardId);
    const pendingStreamKey = streamKey(frame.forwardId, frame.streamId);
    if (!streams || streams.has(frame.streamId) || this.pendingStreamIds.has(pendingStreamKey)) {
      this.deps.logger.warn(
        { forwardId: frame.forwardId, streamId: frame.streamId },
        "port_forward.open.duplicate_stream",
      );
      this.sendOpenResult(frame.forwardId, frame.streamId, {
        ok: false,
        error: "duplicate_stream",
      });
      this.sendClose(frame.forwardId, frame.streamId, "duplicate_stream");
      return;
    }
    const pendingOpens = this.pendingOpensByForward.get(frame.forwardId) ?? 0;
    if (streams.size + pendingOpens >= this.limits.maxStreamsPerForward) {
      this.deps.logger.warn(
        { forwardId: frame.forwardId, streamId: frame.streamId },
        "port_forward.open.max_streams",
      );
      this.sendOpenResult(frame.forwardId, frame.streamId, { ok: false, error: "max_streams" });
      this.sendClose(frame.forwardId, frame.streamId, "max_streams");
      return;
    }
    this.pendingOpensByForward.set(frame.forwardId, pendingOpens + 1);
    this.pendingStreamIds.add(pendingStreamKey);

    let socket: Socket;
    try {
      socket = await (this.deps.connectTcp?.(forward.host, forward.port) ??
        connectTcpDefault(forward.host, forward.port));
    } catch (error) {
      this.finishPendingOpen(frame.forwardId, frame.streamId);
      const code = getErrorCode(error) === "ECONNREFUSED" ? "refused" : "connect_failed";
      this.deps.logger.warn(
        { err: error, forwardId: frame.forwardId, streamId: frame.streamId, port: forward.port },
        "port_forward.open.connect_failed",
      );
      this.sendOpenResult(frame.forwardId, frame.streamId, { ok: false, error: code });
      this.sendClose(frame.forwardId, frame.streamId, code);
      return;
    }

    // The forward may have been deleted or its transport may have disconnected
    // while the TCP connect was pending. Do not resurrect an orphan stream.
    if (
      this.disposed ||
      this.forwards.get(frame.forwardId) !== forward ||
      this.streamsByForward.get(frame.forwardId) !== streams
    ) {
      this.finishPendingOpen(frame.forwardId, frame.streamId);
      socket.destroy();
      this.sendClose(frame.forwardId, frame.streamId, "unknown_forward");
      return;
    }
    this.finishPendingOpen(frame.forwardId, frame.streamId);
    if (streams.has(frame.streamId)) {
      socket.destroy();
      this.sendOpenResult(frame.forwardId, frame.streamId, {
        ok: false,
        error: "duplicate_stream",
      });
      this.sendClose(frame.forwardId, frame.streamId, "duplicate_stream");
      return;
    }

    const stream: StreamRecord = {
      forwardId: frame.forwardId,
      streamId: frame.streamId,
      socket,
      peerCredit: this.limits.initialWindowBytes,
      peerWindow: this.limits.initialWindowBytes,
      pendingOutboundBytes: 0,
      pendingInboundBytes: 0,
      outboundQueue: [],
      queuedBytes: 0,
      peerClosed: false,
      remoteEnded: false,
      daemonClosed: false,
      closeReason: null,
    };
    streams.set(frame.streamId, stream);

    socket.on("data", (chunk: Buffer) => {
      if (stream.daemonClosed) return;
      if (!this.transferLimiter.consume(stream.forwardId, chunk.byteLength)) {
        this.closeStream(stream, "transfer_rate_exceeded");
        return;
      }
      // The remote service is not bound by the peer's window; a chunk may
      // exceed the remaining window near exhaustion. Buffer it boundedly and
      // deliver as the peer grants credit, never treating normal source data
      // as a peer flow violation.
      stream.outboundQueue.push(chunk);
      stream.queuedBytes += chunk.byteLength;
      if (
        stream.queuedBytes + stream.pendingOutboundBytes > this.limits.maxQueuedBytesPerStream ||
        this.aggregateRetainedBytes() > this.limits.maxAggregateQueuedBytes
      ) {
        this.closeStream(stream, "backpressure_exceeded");
        return;
      }
      this.drainOutbound(stream);
      if (stream.queuedBytes > 0 && !stream.daemonClosed) {
        socket.pause();
      }
    });

    socket.on("end", () => {
      if (stream.daemonClosed) return;
      stream.remoteEnded = true;
      this.deps.sendFrame({
        opcode: TunnelOpcode.HalfClose,
        forwardId: frame.forwardId,
        streamId: frame.streamId,
      });
    });

    socket.on("error", (error: Error) => {
      this.deps.logger.warn(
        { err: error, forwardId: frame.forwardId, streamId: frame.streamId },
        "port_forward.stream.error",
      );
      if (!stream.daemonClosed) {
        this.closeStream(stream, "stream_aborted");
      }
    });

    socket.on("close", () => {
      if (stream.daemonClosed) return;
      this.closeStream(stream, stream.remoteEnded ? null : "stream_aborted");
    });

    this.deps.sendFrame({
      opcode: TunnelOpcode.OpenResult,
      forwardId: frame.forwardId,
      streamId: frame.streamId,
      ok: true,
    });
  }

  private handleData(frame: Extract<TunnelFrame, { opcode: typeof TunnelOpcode.Data }>): void {
    const stream = this.resolveStream(frame.forwardId, frame.streamId);
    if (!stream) {
      this.deps.logger.warn(
        { forwardId: frame.forwardId, streamId: frame.streamId },
        "port_forward.data.unknown_stream",
      );
      this.sendClose(frame.forwardId, frame.streamId, "unknown_stream");
      return;
    }
    const bytes = frame.payload.byteLength;
    if (bytes > stream.peerCredit) {
      this.closeStream(stream, "flow_control_violation");
      return;
    }
    if (!stream.socket.writable) {
      this.closeStream(stream, "stream_aborted");
      return;
    }
    if (!this.transferLimiter.consume(stream.forwardId, bytes)) {
      this.closeStream(stream, "transfer_rate_exceeded");
      return;
    }
    if (
      stream.pendingInboundBytes + bytes > this.limits.maxQueuedBytesPerStream ||
      this.aggregateRetainedBytes() + bytes > this.limits.maxAggregateQueuedBytes
    ) {
      this.closeStream(stream, "backpressure_exceeded");
      return;
    }
    stream.peerCredit -= bytes;
    stream.pendingInboundBytes += bytes;
    // The write callback fires once the chunk is flushed to the remote
    // socket, which is the exact backpressure signal: re-credit the peer
    // only for bytes the service actually accepted.
    stream.socket.write(frame.payload, (error?: Error | null) => {
      stream.pendingInboundBytes = Math.max(0, stream.pendingInboundBytes - bytes);
      if (stream.daemonClosed) {
        return;
      }
      if (error) {
        if (!stream.daemonClosed) {
          this.closeStream(stream, "stream_aborted");
        }
        return;
      }
      this.deps.sendFrame({
        opcode: TunnelOpcode.WindowUpdate,
        forwardId: frame.forwardId,
        streamId: frame.streamId,
        credit: bytes,
      });
      stream.peerCredit += bytes;
    });
  }

  private handleWindowUpdate(
    frame: Extract<TunnelFrame, { opcode: typeof TunnelOpcode.WindowUpdate }>,
  ): void {
    const stream = this.resolveStream(frame.forwardId, frame.streamId);
    if (!stream) {
      this.sendClose(frame.forwardId, frame.streamId, "unknown_stream");
      return;
    }
    // The peer can only re-credit bytes we already delivered.
    if (frame.credit > stream.pendingOutboundBytes) {
      this.closeStream(stream, "flow_control_violation");
      return;
    }
    stream.pendingOutboundBytes -= frame.credit;
    stream.peerWindow += frame.credit;
    this.drainOutbound(stream);
  }

  private handleHalfClose(
    frame: Extract<TunnelFrame, { opcode: typeof TunnelOpcode.HalfClose }>,
  ): void {
    const stream = this.resolveStream(frame.forwardId, frame.streamId);
    if (!stream || stream.peerClosed) return;
    stream.peerClosed = true;
    // No more peer data will arrive; FIN our write side toward the service.
    stream.socket.end();
  }

  private handlePeerClose(
    frame: Extract<TunnelFrame, { opcode: typeof TunnelOpcode.Close }>,
  ): void {
    const stream = this.resolveStream(frame.forwardId, frame.streamId);
    if (!stream) return;
    this.closeStream(stream, null);
  }

  /**
   * Deliver queued remote-socket bytes up to the peer's remaining window.
   * Resumes a paused remote socket once the queue drains.
   */
  private drainOutbound(stream: StreamRecord): void {
    if (stream.daemonClosed) return;
    while (stream.queuedBytes > 0 && stream.peerWindow > 0) {
      const chunk = stream.outboundQueue[0];
      if (!chunk) break;
      const deliver = Math.min(chunk.byteLength, stream.peerWindow);
      this.sendDataFrames(stream.forwardId, stream.streamId, chunk.subarray(0, deliver));
      stream.peerWindow -= deliver;
      stream.pendingOutboundBytes += deliver;
      stream.queuedBytes -= deliver;
      if (deliver < chunk.byteLength) {
        stream.outboundQueue[0] = chunk.subarray(deliver);
      } else {
        stream.outboundQueue.shift();
      }
    }
    if (
      stream.queuedBytes === 0 &&
      stream.peerWindow > 0 &&
      stream.socket.isPaused() &&
      !stream.daemonClosed
    ) {
      stream.socket.resume();
    }
  }

  private sendDataFrames(forwardId: string, streamId: string, chunk: Uint8Array): void {
    const maxChunk = this.limits.maxChunkBytes;
    let offset = 0;
    while (offset < chunk.byteLength) {
      const end = Math.min(offset + maxChunk, chunk.byteLength);
      const slice = chunk.subarray(offset, end);
      const copy = new Uint8Array(slice.byteLength);
      copy.set(slice);
      this.deps.sendFrame({
        opcode: TunnelOpcode.Data,
        forwardId,
        streamId,
        payload: copy,
      });
      offset = end;
    }
  }

  private aggregateRetainedBytes(): number {
    let total = 0;
    for (const streams of this.streamsByForward.values()) {
      for (const stream of streams.values()) {
        total += stream.queuedBytes + stream.pendingOutboundBytes + stream.pendingInboundBytes;
      }
    }
    return total;
  }

  private finishPendingOpen(forwardId: string, streamId: string): void {
    this.pendingStreamIds.delete(streamKey(forwardId, streamId));
    const pendingOpens = this.pendingOpensByForward.get(forwardId) ?? 0;
    if (pendingOpens <= 1) {
      this.pendingOpensByForward.delete(forwardId);
    } else {
      this.pendingOpensByForward.set(forwardId, pendingOpens - 1);
    }
  }

  private sendOpenResult(
    forwardId: string,
    streamId: string,
    result: { ok: true } | { ok: false; error: string },
  ): void {
    if (result.ok) {
      this.deps.sendFrame({ opcode: TunnelOpcode.OpenResult, forwardId, streamId, ok: true });
      return;
    }
    this.deps.sendFrame({
      opcode: TunnelOpcode.OpenResult,
      forwardId,
      streamId,
      ok: false,
      error: result.error,
    });
  }

  private sendClose(forwardId: string, streamId: string, reason: TunnelCloseReason): void {
    this.deps.sendFrame({ opcode: TunnelOpcode.Close, forwardId, streamId, reason });
  }

  private closeStream(stream: StreamRecord, reason: TunnelCloseReason | null): void {
    if (stream.daemonClosed) return;
    stream.daemonClosed = true;
    stream.closeReason = reason;
    stream.outboundQueue.length = 0;
    stream.queuedBytes = 0;
    stream.pendingInboundBytes = 0;
    const streams = this.streamsByForward.get(stream.forwardId);
    if (streams) {
      streams.delete(stream.streamId);
    }
    if (reason !== null) {
      this.deps.sendFrame({
        opcode: TunnelOpcode.Close,
        forwardId: stream.forwardId,
        streamId: stream.streamId,
        reason,
      });
    }
    // Handlers check daemonClosed and return early; keep the error listener
    // attached so destroy() cannot surface an unhandled 'error'.
    stream.socket.destroy();
  }

  private resolveStream(forwardId: string, streamId: string): StreamRecord | undefined {
    return this.streamsByForward.get(forwardId)?.get(streamId);
  }
}

function streamKey(forwardId: string, streamId: string): string {
  return `${forwardId}\0${streamId}`;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}
