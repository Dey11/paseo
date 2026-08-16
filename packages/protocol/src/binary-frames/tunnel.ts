import { asUint8Array } from "./terminal.js";

// Tunnel binary frames carry port-forward stream traffic over the dedicated
// daemon connection (fork plan: docs/fork-docs/desktop-port-forwarding.md,
// ticket 2). Frames are length-prefixed and validated strictly: every frame
// must parse exactly, with no unknown opcodes, truncated fields, dangling
// trailing bytes, or oversized values.
//
// Layout (all lengths are 1-byte big-endian):
//
//   byte 0                 opcode
//   byte 1                 forwardId byte length (1..64)
//   bytes 2..              forwardId (opaque forward identifier)
//   next byte              streamId byte length (1..64)
//   next bytes             streamId (opaque stream identifier)
//   remaining              opcode-specific body
//
// Opcodes 0x20-0x25 are a distinct family: terminal streams use 0x01-0x05 and
// file transfer uses 0x10-0x12, so the central demux can route by opcode.
export const TunnelOpcode = {
  Open: 0x20,
  OpenResult: 0x21,
  Data: 0x22,
  WindowUpdate: 0x23,
  HalfClose: 0x24,
  Close: 0x25,
} as const;

export type TunnelOpcode = (typeof TunnelOpcode)[keyof typeof TunnelOpcode];

/** Opaque forward and stream identifiers are capped at 64 bytes. */
export const MAX_TUNNEL_ID_LENGTH = 64;

/** A single data frame carries at most 64 KiB; larger chunks are split by the sender. */
export const MAX_TUNNEL_PAYLOAD_LENGTH = 64 * 1024;

/** Close reasons and open-result errors are short strings, capped at 255 bytes. */
export const MAX_TUNNEL_REASON_LENGTH = 255;

export interface TunnelOpenFrame {
  opcode: typeof TunnelOpcode.Open;
  forwardId: string;
  streamId: string;
}

export interface TunnelOpenResultFrame {
  opcode: typeof TunnelOpcode.OpenResult;
  forwardId: string;
  streamId: string;
  ok: boolean;
  error: string | null;
}

export interface TunnelDataFrame {
  opcode: typeof TunnelOpcode.Data;
  forwardId: string;
  streamId: string;
  payload: Uint8Array;
}

export interface TunnelWindowUpdateFrame {
  opcode: typeof TunnelOpcode.WindowUpdate;
  forwardId: string;
  streamId: string;
  credit: number;
}

export interface TunnelHalfCloseFrame {
  opcode: typeof TunnelOpcode.HalfClose;
  forwardId: string;
  streamId: string;
}

export interface TunnelCloseFrame {
  opcode: typeof TunnelOpcode.Close;
  forwardId: string;
  streamId: string;
  reason: string;
}

export type TunnelFrame =
  | TunnelOpenFrame
  | TunnelOpenResultFrame
  | TunnelDataFrame
  | TunnelWindowUpdateFrame
  | TunnelHalfCloseFrame
  | TunnelCloseFrame;

type TunnelFrameInput =
  | { opcode: typeof TunnelOpcode.Open; forwardId: string; streamId: string }
  | { opcode: typeof TunnelOpcode.OpenResult; forwardId: string; streamId: string; ok: true }
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
      payload?: Uint8Array | ArrayBuffer | string;
    }
  | {
      opcode: typeof TunnelOpcode.WindowUpdate;
      forwardId: string;
      streamId: string;
      credit: number;
    }
  | { opcode: typeof TunnelOpcode.HalfClose; forwardId: string; streamId: string }
  | { opcode: typeof TunnelOpcode.Close; forwardId: string; streamId: string; reason: string };

export function encodeTunnelFrame(input: TunnelFrameInput): Uint8Array {
  const header = encodeTunnelHeader(input.opcode, input.forwardId, input.streamId);

  switch (input.opcode) {
    case TunnelOpcode.Open:
    case TunnelOpcode.HalfClose:
      return header;

    case TunnelOpcode.OpenResult: {
      if (input.ok) {
        const bytes = new Uint8Array(header.byteLength + 1);
        bytes.set(header, 0);
        bytes[header.byteLength] = 1;
        return bytes;
      }
      const error = encodeReason(input.error, "Tunnel open-result error");
      const bytes = new Uint8Array(header.byteLength + 2 + error.byteLength);
      bytes.set(header, 0);
      bytes[header.byteLength] = 0;
      bytes[header.byteLength + 1] = error.byteLength;
      bytes.set(error, header.byteLength + 2);
      return bytes;
    }

    case TunnelOpcode.Data: {
      const payload = asUint8Array(input.payload ?? new Uint8Array()) ?? new Uint8Array();
      if (payload.byteLength > MAX_TUNNEL_PAYLOAD_LENGTH) {
        throw new RangeError(
          `Tunnel data payload is too long (${payload.byteLength} > ${MAX_TUNNEL_PAYLOAD_LENGTH})`,
        );
      }
      const bytes = new Uint8Array(header.byteLength + payload.byteLength);
      bytes.set(header, 0);
      bytes.set(payload, header.byteLength);
      return bytes;
    }

    case TunnelOpcode.WindowUpdate: {
      if (!Number.isInteger(input.credit) || input.credit < 0 || input.credit > 0xffffffff) {
        throw new RangeError("Tunnel window-update credit must be a uint32");
      }
      const bytes = new Uint8Array(header.byteLength + 4);
      bytes.set(header, 0);
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
        header.byteLength,
        input.credit,
      );
      return bytes;
    }

    case TunnelOpcode.Close: {
      const reason = encodeReason(input.reason, "Tunnel close reason");
      const bytes = new Uint8Array(header.byteLength + 1 + reason.byteLength);
      bytes.set(header, 0);
      bytes[header.byteLength] = reason.byteLength;
      bytes.set(reason, header.byteLength + 1);
      return bytes;
    }
  }
}

export function decodeTunnelFrame(bytes: Uint8Array): TunnelFrame | null {
  const opcode = bytes[0];
  if (!isTunnelOpcode(opcode)) {
    return null;
  }
  const forwardId = decodeTunnelId(bytes, 1);
  if (!forwardId) {
    return null;
  }
  const streamId = decodeTunnelId(bytes, forwardId.next);
  if (!streamId) {
    return null;
  }
  const body = bytes.subarray(streamId.next);

  switch (opcode) {
    case TunnelOpcode.Open:
    case TunnelOpcode.HalfClose:
      return decodeEmptyBodyFrame(opcode, forwardId.value, streamId.value, body);
    case TunnelOpcode.OpenResult:
      return decodeOpenResultFrame(forwardId.value, streamId.value, body);
    case TunnelOpcode.Data:
      return decodeDataFrame(forwardId.value, streamId.value, body);
    case TunnelOpcode.WindowUpdate:
      return decodeWindowUpdateFrame(forwardId.value, streamId.value, body);
    case TunnelOpcode.Close:
      return decodeCloseFrame(forwardId.value, streamId.value, body);
  }
}

function decodeEmptyBodyFrame(
  opcode: typeof TunnelOpcode.Open | typeof TunnelOpcode.HalfClose,
  forwardId: string,
  streamId: string,
  body: Uint8Array,
): TunnelOpenFrame | TunnelHalfCloseFrame | null {
  if (body.byteLength !== 0) {
    return null;
  }
  return { opcode, forwardId, streamId };
}

function decodeOpenResultFrame(
  forwardId: string,
  streamId: string,
  body: Uint8Array,
): TunnelOpenResultFrame | null {
  if (body.byteLength < 1) {
    return null;
  }
  const ok = body[0];
  if (ok === 1) {
    if (body.byteLength !== 1) {
      return null;
    }
    return { opcode: TunnelOpcode.OpenResult, forwardId, streamId, ok: true, error: null };
  }
  if (ok !== 0) {
    return null;
  }
  const error = decodeReason(body, 1);
  if (!error || error.next !== body.byteLength) {
    return null;
  }
  return { opcode: TunnelOpcode.OpenResult, forwardId, streamId, ok: false, error: error.value };
}

function decodeDataFrame(
  forwardId: string,
  streamId: string,
  body: Uint8Array,
): TunnelDataFrame | null {
  if (body.byteLength > MAX_TUNNEL_PAYLOAD_LENGTH) {
    return null;
  }
  return { opcode: TunnelOpcode.Data, forwardId, streamId, payload: body };
}

function decodeWindowUpdateFrame(
  forwardId: string,
  streamId: string,
  body: Uint8Array,
): TunnelWindowUpdateFrame | null {
  if (body.byteLength !== 4) {
    return null;
  }
  const credit = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0);
  return { opcode: TunnelOpcode.WindowUpdate, forwardId, streamId, credit };
}

function decodeCloseFrame(
  forwardId: string,
  streamId: string,
  body: Uint8Array,
): TunnelCloseFrame | null {
  const reason = decodeReason(body, 0);
  if (!reason || reason.next !== body.byteLength) {
    return null;
  }
  return { opcode: TunnelOpcode.Close, forwardId, streamId, reason: reason.value };
}

function isTunnelOpcode(value: number): value is TunnelOpcode {
  return (
    value === TunnelOpcode.Open ||
    value === TunnelOpcode.OpenResult ||
    value === TunnelOpcode.Data ||
    value === TunnelOpcode.WindowUpdate ||
    value === TunnelOpcode.HalfClose ||
    value === TunnelOpcode.Close
  );
}

function encodeTunnelHeader(opcode: number, forwardId: string, streamId: string): Uint8Array {
  const forwardIdBytes = encodeTunnelId(forwardId, "Tunnel forwardId");
  const streamIdBytes = encodeTunnelId(streamId, "Tunnel streamId");
  const bytes = new Uint8Array(3 + forwardIdBytes.byteLength + streamIdBytes.byteLength);
  bytes[0] = opcode;
  bytes[1] = forwardIdBytes.byteLength;
  bytes.set(forwardIdBytes, 2);
  bytes[2 + forwardIdBytes.byteLength] = streamIdBytes.byteLength;
  bytes.set(streamIdBytes, 3 + forwardIdBytes.byteLength);
  return bytes;
}

function encodeTunnelId(id: string, label: string): Uint8Array {
  const bytes = new TextEncoder().encode(id);
  if (bytes.byteLength === 0) {
    throw new RangeError(`${label} is required`);
  }
  if (bytes.byteLength > MAX_TUNNEL_ID_LENGTH) {
    throw new RangeError(`${label} is too long (${bytes.byteLength} > ${MAX_TUNNEL_ID_LENGTH})`);
  }
  return bytes;
}

function encodeReason(reason: string, label: string): Uint8Array {
  const bytes = new TextEncoder().encode(reason);
  if (bytes.byteLength === 0) {
    throw new RangeError(`${label} is required`);
  }
  if (bytes.byteLength > MAX_TUNNEL_REASON_LENGTH) {
    throw new RangeError(
      `${label} is too long (${bytes.byteLength} > ${MAX_TUNNEL_REASON_LENGTH})`,
    );
  }
  return bytes;
}

function decodeTunnelId(bytes: Uint8Array, offset: number): { value: string; next: number } | null {
  if (offset >= bytes.byteLength) {
    return null;
  }
  const length = bytes[offset];
  if (length === 0 || length > MAX_TUNNEL_ID_LENGTH) {
    return null;
  }
  const start = offset + 1;
  const end = start + length;
  if (end > bytes.byteLength) {
    return null;
  }
  const value = decodeUtf8(bytes.subarray(start, end));
  return value === null ? null : { value, next: end };
}

function decodeReason(bytes: Uint8Array, offset: number): { value: string; next: number } | null {
  if (offset >= bytes.byteLength) {
    return null;
  }
  const length = bytes[offset];
  if (length === 0 || length > MAX_TUNNEL_REASON_LENGTH) {
    return null;
  }
  const start = offset + 1;
  const end = start + length;
  if (end > bytes.byteLength) {
    return null;
  }
  const value = decodeUtf8(bytes.subarray(start, end));
  return value === null ? null : { value, next: end };
}

function decodeUtf8(bytes: Uint8Array): string | null {
  const value = new TextDecoder().decode(bytes);
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength !== bytes.byteLength) {
    return null;
  }
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (encoded[index] !== bytes[index]) {
      return null;
    }
  }
  return value;
}
