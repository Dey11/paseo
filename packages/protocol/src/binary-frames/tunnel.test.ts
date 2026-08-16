import { describe, expect, it } from "vitest";

import {
  FileTransferOpcode,
  MAX_TUNNEL_ID_LENGTH,
  MAX_TUNNEL_PAYLOAD_LENGTH,
  MAX_TUNNEL_REASON_LENGTH,
  TerminalStreamOpcode,
  TunnelOpcode,
  decodeBinaryFrame,
  decodeTunnelFrame,
  encodeFileTransferFrame,
  encodeTerminalStreamFrame,
  encodeTunnelFrame,
} from "./index.js";

const encoder = new TextEncoder();

function header(
  opcode: TunnelOpcode,
  forwardId: string,
  streamId: string,
): { bytes: Uint8Array; offset: number } {
  const forward = encoder.encode(forwardId);
  const stream = encoder.encode(streamId);
  const bytes = new Uint8Array(1 + 1 + forward.byteLength + 1 + stream.byteLength);
  bytes[0] = opcode;
  bytes[1] = forward.byteLength;
  bytes.set(forward, 2);
  bytes[2 + forward.byteLength] = stream.byteLength;
  bytes.set(stream, 3 + forward.byteLength);
  return { bytes, offset: 3 + forward.byteLength };
}

describe("tunnel binary frames", () => {
  it("uses opcodes that do not overlap terminal or file-transfer families", () => {
    const terminal = Object.values(TerminalStreamOpcode);
    const fileTransfer = Object.values(FileTransferOpcode);
    for (const opcode of Object.values(TunnelOpcode)) {
      expect(terminal).not.toContain(opcode);
      expect(fileTransfer).not.toContain(opcode);
    }
  });

  it("round-trips an open frame", () => {
    const encoded = encodeTunnelFrame({
      opcode: TunnelOpcode.Open,
      forwardId: "fwd-1",
      streamId: "stream-7",
    });

    expect(encoded[0]).toBe(TunnelOpcode.Open);
    expect(encoded[1]).toBe(5);
    expect(new TextDecoder().decode(encoded.subarray(2, 7))).toBe("fwd-1");
    expect(encoded[7]).toBe(8);
    expect(new TextDecoder().decode(encoded.subarray(8))).toBe("stream-7");

    expect(decodeTunnelFrame(encoded)).toEqual({
      opcode: TunnelOpcode.Open,
      forwardId: "fwd-1",
      streamId: "stream-7",
    });
  });

  it("round-trips an open-result success frame", () => {
    const encoded = encodeTunnelFrame({
      opcode: TunnelOpcode.OpenResult,
      forwardId: "fwd-1",
      streamId: "stream-7",
      ok: true,
    });

    expect(decodeTunnelFrame(encoded)).toEqual({
      opcode: TunnelOpcode.OpenResult,
      forwardId: "fwd-1",
      streamId: "stream-7",
      ok: true,
      error: null,
    });
  });

  it("round-trips an open-result failure frame with a concrete error", () => {
    const encoded = encodeTunnelFrame({
      opcode: TunnelOpcode.OpenResult,
      forwardId: "fwd-1",
      streamId: "stream-7",
      ok: false,
      error: "connection refused",
    });

    expect(decodeTunnelFrame(encoded)).toEqual({
      opcode: TunnelOpcode.OpenResult,
      forwardId: "fwd-1",
      streamId: "stream-7",
      ok: false,
      error: "connection refused",
    });
  });

  it("round-trips a data frame with binary payload byte-exactly", () => {
    const payload = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    const encoded = encodeTunnelFrame({
      opcode: TunnelOpcode.Data,
      forwardId: "fwd-1",
      streamId: "stream-7",
      payload,
    });

    const decoded = decodeTunnelFrame(encoded);
    expect(decoded).toEqual({
      opcode: TunnelOpcode.Data,
      forwardId: "fwd-1",
      streamId: "stream-7",
      payload,
    });
    expect(decoded?.payload).toBeInstanceOf(Uint8Array);
  });

  it("round-trips a window-update frame", () => {
    const encoded = encodeTunnelFrame({
      opcode: TunnelOpcode.WindowUpdate,
      forwardId: "fwd-1",
      streamId: "stream-7",
      credit: 262144,
    });

    expect(decodeTunnelFrame(encoded)).toEqual({
      opcode: TunnelOpcode.WindowUpdate,
      forwardId: "fwd-1",
      streamId: "stream-7",
      credit: 262144,
    });
  });

  it("round-trips a half-close frame", () => {
    const encoded = encodeTunnelFrame({
      opcode: TunnelOpcode.HalfClose,
      forwardId: "fwd-1",
      streamId: "stream-7",
    });

    expect(decodeTunnelFrame(encoded)).toEqual({
      opcode: TunnelOpcode.HalfClose,
      forwardId: "fwd-1",
      streamId: "stream-7",
    });
  });

  it("round-trips a close frame with a concrete reason", () => {
    const encoded = encodeTunnelFrame({
      opcode: TunnelOpcode.Close,
      forwardId: "fwd-1",
      streamId: "stream-7",
      reason: "host disconnected",
    });

    expect(decodeTunnelFrame(encoded)).toEqual({
      opcode: TunnelOpcode.Close,
      forwardId: "fwd-1",
      streamId: "stream-7",
      reason: "host disconnected",
    });
  });

  it("accepts empty data payloads", () => {
    const encoded = encodeTunnelFrame({
      opcode: TunnelOpcode.Data,
      forwardId: "fwd-1",
      streamId: "stream-7",
    });

    expect(decodeTunnelFrame(encoded)).toEqual({
      opcode: TunnelOpcode.Data,
      forwardId: "fwd-1",
      streamId: "stream-7",
      payload: new Uint8Array(),
    });
  });

  it("round-trips the maximum 64 KiB data payload", () => {
    const payload = new Uint8Array(MAX_TUNNEL_PAYLOAD_LENGTH);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = index % 251;
    }
    const encoded = encodeTunnelFrame({
      opcode: TunnelOpcode.Data,
      forwardId: "fwd-1",
      streamId: "stream-7",
      payload,
    });

    expect(decodeTunnelFrame(encoded)?.payload.byteLength).toBe(MAX_TUNNEL_PAYLOAD_LENGTH);
  });

  it("rejects data payloads over 64 KiB on encode and decode", () => {
    expect(() =>
      encodeTunnelFrame({
        opcode: TunnelOpcode.Data,
        forwardId: "fwd-1",
        streamId: "stream-7",
        payload: new Uint8Array(MAX_TUNNEL_PAYLOAD_LENGTH + 1),
      }),
    ).toThrow(RangeError);

    const { bytes } = header(TunnelOpcode.Data, "fwd-1", "stream-7");
    const oversize = new Uint8Array(bytes.byteLength + MAX_TUNNEL_PAYLOAD_LENGTH + 1);
    oversize.set(bytes, 0);
    expect(decodeTunnelFrame(oversize)).toBeNull();
  });

  it("round-trips maximum-length ids and rejects longer ones", () => {
    const maxId = "x".repeat(MAX_TUNNEL_ID_LENGTH);
    const encoded = encodeTunnelFrame({
      opcode: TunnelOpcode.HalfClose,
      forwardId: maxId,
      streamId: maxId,
    });
    expect(decodeTunnelFrame(encoded)).toEqual({
      opcode: TunnelOpcode.HalfClose,
      forwardId: maxId,
      streamId: maxId,
    });

    expect(() =>
      encodeTunnelFrame({
        opcode: TunnelOpcode.HalfClose,
        forwardId: maxId + "y",
        streamId: "stream-7",
      }),
    ).toThrow(RangeError);
    expect(() =>
      encodeTunnelFrame({
        opcode: TunnelOpcode.HalfClose,
        forwardId: "fwd-1",
        streamId: maxId + "y",
      }),
    ).toThrow(RangeError);

    const tooLong = new Uint8Array([TunnelOpcode.HalfClose, MAX_TUNNEL_ID_LENGTH + 1]);
    expect(decodeTunnelFrame(tooLong)).toBeNull();
  });

  it("rejects empty ids on encode and decode", () => {
    expect(() =>
      encodeTunnelFrame({ opcode: TunnelOpcode.Open, forwardId: "", streamId: "stream-7" }),
    ).toThrow(RangeError);
    expect(() =>
      encodeTunnelFrame({ opcode: TunnelOpcode.Open, forwardId: "fwd-1", streamId: "" }),
    ).toThrow(RangeError);

    expect(decodeTunnelFrame(new Uint8Array([TunnelOpcode.Open, 0, 1, 2]))).toBeNull();
  });

  it("rejects malformed UTF-8 in ids and reasons", () => {
    expect(decodeTunnelFrame(new Uint8Array([TunnelOpcode.Open, 1, 0xff, 1, 0x73]))).toBeNull();

    const { bytes } = header(TunnelOpcode.Close, "fwd-1", "stream-7");
    const malformedReason = new Uint8Array(bytes.byteLength + 2);
    malformedReason.set(bytes, 0);
    malformedReason[bytes.byteLength] = 1;
    malformedReason[bytes.byteLength + 1] = 0xff;
    expect(decodeTunnelFrame(malformedReason)).toBeNull();
  });

  it("round-trips a maximum-length close reason and rejects longer or empty ones", () => {
    const maxReason = "r".repeat(MAX_TUNNEL_REASON_LENGTH);
    const encoded = encodeTunnelFrame({
      opcode: TunnelOpcode.Close,
      forwardId: "fwd-1",
      streamId: "stream-7",
      reason: maxReason,
    });
    expect(decodeTunnelFrame(encoded)).toEqual({
      opcode: TunnelOpcode.Close,
      forwardId: "fwd-1",
      streamId: "stream-7",
      reason: maxReason,
    });

    expect(() =>
      encodeTunnelFrame({
        opcode: TunnelOpcode.Close,
        forwardId: "fwd-1",
        streamId: "stream-7",
        reason: "",
      }),
    ).toThrow(RangeError);
    expect(() =>
      encodeTunnelFrame({
        opcode: TunnelOpcode.Close,
        forwardId: "fwd-1",
        streamId: "stream-7",
        reason: maxReason + "s",
      }),
    ).toThrow(RangeError);
  });

  it("rejects open-result frames without an error body on failure", () => {
    const { bytes } = header(TunnelOpcode.OpenResult, "fwd-1", "stream-7");
    const failed = new Uint8Array(bytes.byteLength + 1);
    failed.set(bytes, 0);
    failed[bytes.byteLength] = 0;
    expect(decodeTunnelFrame(failed)).toBeNull();
  });

  it("rejects open-result success frames with trailing bytes", () => {
    const { bytes } = header(TunnelOpcode.OpenResult, "fwd-1", "stream-7");
    const trailing = new Uint8Array(bytes.byteLength + 3);
    trailing.set(bytes, 0);
    trailing[bytes.byteLength] = 1;
    trailing[bytes.byteLength + 1] = 0;
    expect(decodeTunnelFrame(trailing)).toBeNull();
  });

  it("rejects unknown opcodes", () => {
    expect(decodeTunnelFrame(new Uint8Array([0xff, 1, 2, 3, 4]))).toBeNull();
    expect(decodeTunnelFrame(new Uint8Array([0x00, 1, 2, 3, 4]))).toBeNull();
    expect(decodeTunnelFrame(new Uint8Array([TerminalStreamOpcode.Output, 1, 2, 3, 4]))).toBeNull();
    expect(
      decodeTunnelFrame(new Uint8Array([FileTransferOpcode.FileBegin, 1, 2, 3, 4])),
    ).toBeNull();
  });

  it("rejects truncated headers", () => {
    const valid = encodeTunnelFrame({
      opcode: TunnelOpcode.Open,
      forwardId: "fwd-1",
      streamId: "stream-7",
    });
    for (let length = 0; length < valid.byteLength; length += 1) {
      expect(decodeTunnelFrame(valid.subarray(0, length))).toBeNull();
    }
  });

  it("rejects dangling trailing bytes", () => {
    const { bytes } = header(TunnelOpcode.Open, "fwd-1", "stream-7");
    const trailing = new Uint8Array(bytes.byteLength + 1);
    trailing.set(bytes, 0);
    expect(decodeTunnelFrame(trailing)).toBeNull();
  });

  it("rejects truncated window-update credit", () => {
    const { bytes } = header(TunnelOpcode.WindowUpdate, "fwd-1", "stream-7");
    for (let length = 0; length < 4; length += 1) {
      const truncated = new Uint8Array(bytes.byteLength + length);
      truncated.set(bytes, 0);
      expect(decodeTunnelFrame(truncated)).toBeNull();
    }
  });

  it("round-trips window-update credit bounds and rejects out-of-range encode", () => {
    for (const credit of [0, 1, 0xffffffff]) {
      expect(
        decodeTunnelFrame(
          encodeTunnelFrame({
            opcode: TunnelOpcode.WindowUpdate,
            forwardId: "fwd-1",
            streamId: "stream-7",
            credit,
          }),
        ),
      ).toEqual({
        opcode: TunnelOpcode.WindowUpdate,
        forwardId: "fwd-1",
        streamId: "stream-7",
        credit,
      });
    }

    expect(() =>
      encodeTunnelFrame({
        opcode: TunnelOpcode.WindowUpdate,
        forwardId: "fwd-1",
        streamId: "stream-7",
        credit: 0x1_0000_0000,
      }),
    ).toThrow(RangeError);
    expect(() =>
      encodeTunnelFrame({
        opcode: TunnelOpcode.WindowUpdate,
        forwardId: "fwd-1",
        streamId: "stream-7",
        credit: -1,
      }),
    ).toThrow(RangeError);
  });

  it("demuxes tunnel frames without changing terminal or file-transfer routing", () => {
    const tunnel = encodeTunnelFrame({
      opcode: TunnelOpcode.Data,
      forwardId: "fwd-1",
      streamId: "stream-7",
      payload: new TextEncoder().encode("tunnel bytes"),
    });
    expect(decodeBinaryFrame(tunnel)).toEqual({
      kind: "tunnel",
      frame: {
        opcode: TunnelOpcode.Data,
        forwardId: "fwd-1",
        streamId: "stream-7",
        payload: new TextEncoder().encode("tunnel bytes"),
      },
    });

    const terminal = encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Input,
      slot: 7,
      payload: "ls",
    });
    expect(decodeBinaryFrame(terminal)?.kind).toBe("terminal");

    const fileTransfer = encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileChunk,
      requestId: "req-upload",
      payload: new TextEncoder().encode("hello"),
    });
    expect(decodeBinaryFrame(fileTransfer)?.kind).toBe("file_transfer");
  });
});
