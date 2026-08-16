import net from "node:net";
import { MAX_TUNNEL_PAYLOAD_LENGTH, TunnelOpcode } from "@getpaseo/protocol/binary-frames/index";
import type { TunnelFrameInput } from "./tunnel-client.js";

// Credit-based flow control per tunnel stream
// (docs/fork-docs/desktop-port-forwarding.md, "Security and resource limits").
// Each side grants the peer an initial window and tops it up with
// WindowUpdate frames as bytes drain; the sender pauses its source socket
// while its outbound window is exhausted. Chunks are capped at 64 KiB.

export const DEFAULT_TUNNEL_WINDOW_BYTES = 256 * 1024;
const MAX_LOCAL_BUFFER_BYTES = 1024 * 1024;

// Below this many queued Node-side bytes the local socket has drained far
// enough to restore inbound credit. The kernel socket buffer absorbs the rest.
const INBOUND_LOW_WATER_BYTES = 16 * 1024;

export interface TunnelStreamOptions {
  forwardId: string;
  streamId: string;
  sendFrame(frame: TunnelFrameInput): void;
  onClosed(reason: string): void;
  reserveRetainedBytes?(delta: number): boolean;
  windowBytes?: number;
  chunkSize?: number;
}

export class TunnelStream {
  readonly forwardId: string;
  readonly streamId: string;

  private readonly sendFrame: (frame: TunnelFrameInput) => void;
  private readonly onClosed: (reason: string) => void;
  private readonly reserveRetainedBytes: (delta: number) => boolean;
  private readonly windowBytes: number;
  private readonly chunkSize: number;

  private socket: net.Socket | null = null;
  private closed = false;
  private openResultReceived = false;
  private closeFrameSent = false;
  private outboundCredit = 0;
  private outboundUncreditedBytes = 0;
  private localBuffer = Buffer.alloc(0);
  private localEnded = false;
  private halfCloseSent = false;
  private inboundCredit: number;
  private inboundReceivedSinceGrant = 0;

  constructor(options: TunnelStreamOptions) {
    this.forwardId = options.forwardId;
    this.streamId = options.streamId;
    this.sendFrame = options.sendFrame;
    this.onClosed = options.onClosed;
    this.reserveRetainedBytes = options.reserveRetainedBytes ?? (() => true);
    this.windowBytes = options.windowBytes ?? DEFAULT_TUNNEL_WINDOW_BYTES;
    this.chunkSize = Math.min(
      options.chunkSize ?? MAX_TUNNEL_PAYLOAD_LENGTH,
      MAX_TUNNEL_PAYLOAD_LENGTH,
    );
    this.inboundCredit = this.windowBytes;
  }

  attach(socket: net.Socket): void {
    this.socket = socket;
    // Nothing is sent until the daemon confirms the remote connection, so the
    // local client's early bytes stay buffered by the kernel.
    socket.pause();
    socket.on("data", (chunk) => this.handleLocalData(chunk));
    socket.on("end", () => this.handleLocalEnd());
    socket.on("error", () => this.closeLocal("local connection error"));
    socket.on("close", () => this.closeLocal("local connection closed"));
    socket.on("drain", () => this.flushInboundCredit());
  }

  handleOpenResult(ok: boolean, error: string | null): void {
    if (this.closed) {
      return;
    }
    if (this.openResultReceived) {
      this.closeLocal("flow control violation");
      return;
    }
    this.openResultReceived = true;
    if (ok) {
      this.outboundCredit = this.windowBytes;
      this.socket?.resume();
      this.maybeSendHalfClose();
      return;
    }
    this.closeLocal(error ?? "remote connection rejected");
  }

  handleData(payload: Uint8Array): void {
    if (this.closed || !this.socket) {
      return;
    }
    if (!this.openResultReceived || payload.byteLength > this.inboundCredit) {
      this.closeLocal("flow control violation");
      return;
    }
    if (!this.reserveRetainedBytes(payload.byteLength)) {
      this.closeLocal("backpressure exceeded");
      return;
    }
    const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
    this.inboundCredit -= bytes.byteLength;
    this.inboundReceivedSinceGrant += bytes.byteLength;
    const writable = this.socket.write(bytes);
    if (
      writable &&
      this.inboundReceivedSinceGrant > 0 &&
      this.socket.writableLength <= INBOUND_LOW_WATER_BYTES
    ) {
      this.flushInboundCredit();
    }
  }

  handleWindowUpdate(credit: number): void {
    if (this.closed) {
      return;
    }
    if (credit > this.outboundUncreditedBytes) {
      this.closeLocal("flow control violation");
      return;
    }
    this.outboundUncreditedBytes -= credit;
    this.reserveRetainedBytes(-credit);
    this.outboundCredit += credit;
    if (this.localBuffer.byteLength > 0) {
      this.flushLocalBuffer();
    }
    if (
      this.localBuffer.byteLength === 0 &&
      this.socket &&
      this.socket.isPaused() &&
      this.outboundCredit > 0
    ) {
      this.socket.resume();
    }
  }

  handleHalfClose(): void {
    if (this.closed || !this.socket) {
      return;
    }
    // The daemon's target finished sending; signal EOF to the local client.
    // The local client may still send, and that data keeps flowing.
    this.socket.end();
  }

  handleCloseFrame(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.releaseRetainedBytes();
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    this.onClosed(reason);
  }

  closeLocal(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.releaseRetainedBytes();
    if (!this.closeFrameSent) {
      this.closeFrameSent = true;
      this.sendCloseFrame(reason);
    }
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    this.onClosed(reason);
  }

  private sendCloseFrame(reason: string): void {
    this.sendFrame({
      opcode: TunnelOpcode.Close,
      forwardId: this.forwardId,
      streamId: this.streamId,
      reason,
    });
  }

  private flushInboundCredit(): void {
    if (this.closed || this.inboundReceivedSinceGrant <= 0) {
      return;
    }
    const credit = this.inboundReceivedSinceGrant;
    this.inboundReceivedSinceGrant = 0;
    this.reserveRetainedBytes(-credit);
    this.inboundCredit += credit;
    this.sendFrame({
      opcode: TunnelOpcode.WindowUpdate,
      forwardId: this.forwardId,
      streamId: this.streamId,
      credit,
    });
  }

  private handleLocalData(chunk: Buffer): void {
    if (this.closed || !this.openResultReceived) {
      return;
    }
    if (
      this.localBuffer.byteLength + chunk.byteLength > MAX_LOCAL_BUFFER_BYTES ||
      !this.reserveRetainedBytes(chunk.byteLength)
    ) {
      this.closeLocal("backpressure exceeded");
      return;
    }
    this.localBuffer = Buffer.concat([this.localBuffer, chunk]);
    this.flushLocalBuffer();
    if (this.localBuffer.byteLength > 0 && this.socket?.isPaused() === false) {
      this.socket.pause();
    }
  }

  private flushLocalBuffer(): void {
    while (!this.closed && this.localBuffer.byteLength > 0 && this.outboundCredit > 0) {
      const pieceLength = Math.min(
        this.localBuffer.byteLength,
        this.chunkSize,
        this.outboundCredit,
      );
      const piece = this.localBuffer.subarray(0, pieceLength);
      this.outboundCredit -= piece.byteLength;
      this.outboundUncreditedBytes += piece.byteLength;
      this.localBuffer = this.localBuffer.subarray(piece.byteLength);
      this.sendFrame({
        opcode: TunnelOpcode.Data,
        forwardId: this.forwardId,
        streamId: this.streamId,
        payload: piece,
      });
    }
    this.maybeSendHalfClose();
  }

  private handleLocalEnd(): void {
    if (this.closed) {
      return;
    }
    this.localEnded = true;
    this.maybeSendHalfClose();
  }

  private releaseRetainedBytes(): void {
    const retainedBytes =
      this.localBuffer.byteLength + this.outboundUncreditedBytes + this.inboundReceivedSinceGrant;
    this.localBuffer = Buffer.alloc(0);
    this.outboundUncreditedBytes = 0;
    this.inboundReceivedSinceGrant = 0;
    if (retainedBytes > 0) {
      this.reserveRetainedBytes(-retainedBytes);
    }
  }

  private maybeSendHalfClose(): void {
    if (
      this.closed ||
      !this.openResultReceived ||
      !this.localEnded ||
      this.localBuffer.byteLength > 0 ||
      this.halfCloseSent
    ) {
      return;
    }
    this.halfCloseSent = true;
    this.sendFrame({
      opcode: TunnelOpcode.HalfClose,
      forwardId: this.forwardId,
      streamId: this.streamId,
    });
  }
}
