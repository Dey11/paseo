import { describe, expect, it } from "vitest";

import {
  decodeBinaryFrame,
  encodeFileTransferFrame,
  encodeTerminalStreamFrame,
  encodeTunnelFrame,
  FileTransferOpcode,
  TerminalStreamOpcode,
  TunnelOpcode,
} from "./index.js";

describe("binary frame demux", () => {
  it("routes terminal frames by opcode", () => {
    expect(
      decodeBinaryFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          slot: 7,
          payload: "ls",
        }),
      ),
    ).toEqual({
      kind: "terminal",
      frame: {
        opcode: TerminalStreamOpcode.Input,
        slot: 7,
        payload: new TextEncoder().encode("ls"),
      },
    });
  });

  it("routes file-transfer frames by opcode", () => {
    expect(
      decodeBinaryFrame(
        encodeFileTransferFrame({
          opcode: FileTransferOpcode.FileChunk,
          requestId: "req-upload",
          payload: new TextEncoder().encode("hello"),
        }),
      ),
    ).toEqual({
      kind: "file_transfer",
      frame: {
        opcode: FileTransferOpcode.FileChunk,
        requestId: "req-upload",
        payload: new TextEncoder().encode("hello"),
      },
    });
  });

  it("routes tunnel frames by opcode", () => {
    expect(
      decodeBinaryFrame(
        encodeTunnelFrame({
          opcode: TunnelOpcode.Data,
          forwardId: "fwd-1",
          streamId: "stream-7",
          payload: new TextEncoder().encode("hello"),
        }),
      ),
    ).toEqual({
      kind: "tunnel",
      frame: {
        opcode: TunnelOpcode.Data,
        forwardId: "fwd-1",
        streamId: "stream-7",
        payload: new TextEncoder().encode("hello"),
      },
    });
  });

  it("rejects unknown binary opcodes", () => {
    expect(decodeBinaryFrame(new Uint8Array([0xff, 0]))).toBeNull();
  });
});
