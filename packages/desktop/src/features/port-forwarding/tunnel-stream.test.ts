import net from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, test } from "vitest";
import { TunnelOpcode } from "@getpaseo/protocol/binary-frames/index";
import { TunnelStream } from "./tunnel-stream.js";
import type { TunnelFrameInput } from "./tunnel-client.js";

interface SocketPair {
  client: net.Socket;
  accepted: net.Socket;
  listener: net.Server;
}

const openPairs: SocketPair[] = [];

async function createSocketPair(): Promise<SocketPair> {
  let resolveAccepted: (socket: net.Socket) => void = () => {};
  const acceptedPromise = new Promise<net.Socket>((resolve) => {
    resolveAccepted = resolve;
  });
  const listener = net.createServer({ allowHalfOpen: true }, resolveAccepted);
  listener.listen({ host: "127.0.0.1", port: 0 });
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP listener address");
  }
  const client = net.createConnection({ host: "127.0.0.1", port: address.port });
  const [accepted] = await Promise.all([acceptedPromise, once(client, "connect")]);
  const pair = { client, accepted, listener };
  openPairs.push(pair);
  return pair;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for socket state");
}

function dataFrames(frames: readonly TunnelFrameInput[]): TunnelFrameInput[] {
  return frames.filter((frame) => frame.opcode === TunnelOpcode.Data);
}

function dataFrameCount(frames: readonly TunnelFrameInput[]): number {
  return dataFrames(frames).length;
}

function dataBytes(frames: readonly TunnelFrameInput[]): number {
  return dataFrames(frames).reduce(
    (total, frame) => total + (frame.payload as Uint8Array).byteLength,
    0,
  );
}

function hasFrame(
  frames: readonly TunnelFrameInput[],
  opcode: TunnelFrameInput["opcode"],
): boolean {
  return frames.some((frame) => frame.opcode === opcode);
}

afterEach(async () => {
  for (const pair of openPairs.splice(0)) {
    pair.client.destroy();
    pair.accepted.destroy();
    pair.listener.close();
  }
});

describe("TunnelStream", () => {
  test("sends partial credit without stalling and defers half-close until buffered bytes drain", async () => {
    const pair = await createSocketPair();
    const frames: TunnelFrameInput[] = [];
    const stream = new TunnelStream({
      forwardId: "fw-1",
      streamId: "stream-1",
      windowBytes: 8,
      chunkSize: 8,
      sendFrame: (frame) => frames.push(frame),
      onClosed: () => {},
    });
    stream.attach(pair.accepted);
    stream.handleOpenResult(true, null);

    pair.client.write("abcdefgh");
    await waitFor(() => hasFrame(frames, TunnelOpcode.Data));
    stream.handleWindowUpdate(3);
    pair.client.end("12345");

    await waitFor(() => dataFrameCount(frames) === 2);
    expect(
      frames
        .filter((frame) => frame.opcode === TunnelOpcode.Data)
        .map((frame) => Buffer.from(frame.payload).toString()),
    ).toEqual(["abcdefgh", "123"]);
    expect(hasFrame(frames, TunnelOpcode.HalfClose)).toBe(false);

    stream.handleWindowUpdate(5);
    await waitFor(() => hasFrame(frames, TunnelOpcode.HalfClose));
    expect(
      frames
        .filter((frame) => frame.opcode === TunnelOpcode.Data)
        .map((frame) => Buffer.from(frame.payload).toString()),
    ).toEqual(["abcdefgh", "123", "45"]);
  });

  test("rejects data beyond the granted inbound window", async () => {
    const pair = await createSocketPair();
    const frames: TunnelFrameInput[] = [];
    const stream = new TunnelStream({
      forwardId: "fw-1",
      streamId: "stream-1",
      windowBytes: 8,
      sendFrame: (frame) => frames.push(frame),
      onClosed: () => {},
    });
    stream.attach(pair.accepted);
    stream.handleOpenResult(true, null);

    stream.handleData(Buffer.alloc(9));

    expect(frames).toContainEqual({
      opcode: TunnelOpcode.Close,
      forwardId: "fw-1",
      streamId: "stream-1",
      reason: "flow control violation",
    });
  });

  test("rejects window credit for bytes that were never sent", async () => {
    const pair = await createSocketPair();
    const frames: TunnelFrameInput[] = [];
    const stream = new TunnelStream({
      forwardId: "fw-1",
      streamId: "stream-1",
      windowBytes: 8,
      sendFrame: (frame) => frames.push(frame),
      onClosed: () => {},
    });
    stream.attach(pair.accepted);
    stream.handleOpenResult(true, null);

    pair.client.write("hi");
    await waitFor(() => hasFrame(frames, TunnelOpcode.Data));
    stream.handleWindowUpdate(3);

    expect(frames.at(-1)).toEqual({
      opcode: TunnelOpcode.Close,
      forwardId: "fw-1",
      streamId: "stream-1",
      reason: "flow control violation",
    });
  });

  test("splits local data into chunks of at most 64 KiB", async () => {
    const pair = await createSocketPair();
    const frames: TunnelFrameInput[] = [];
    const stream = new TunnelStream({
      forwardId: "fw-1",
      streamId: "stream-1",
      sendFrame: (frame) => frames.push(frame),
      onClosed: () => {},
    });
    stream.attach(pair.accepted);
    stream.handleOpenResult(true, null);

    const payload = Buffer.alloc(150 * 1024, 0xab);
    pair.client.write(payload);
    await waitFor(() => dataBytes(frames) === payload.byteLength);

    expect(dataFrames(frames).length).toBeGreaterThan(2);
    for (const frame of dataFrames(frames)) {
      expect((frame.payload as Uint8Array).byteLength).toBeLessThanOrEqual(64 * 1024);
    }
  });

  test("pauses the local socket while its outbound window is exhausted", async () => {
    const pair = await createSocketPair();
    const frames: TunnelFrameInput[] = [];
    const stream = new TunnelStream({
      forwardId: "fw-1",
      streamId: "stream-1",
      windowBytes: 16 * 1024,
      chunkSize: 4 * 1024,
      sendFrame: (frame) => frames.push(frame),
      onClosed: () => {},
    });
    stream.attach(pair.accepted);
    stream.handleOpenResult(true, null);

    pair.client.write(Buffer.alloc(64 * 1024, 0x11));
    await waitFor(() => dataBytes(frames) === 16 * 1024);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dataBytes(frames)).toBe(16 * 1024);
    expect(pair.accepted.isPaused()).toBe(true);

    // Credit may only repay bytes the stream already sent; each grant must
    // stay within the uncredited window.
    stream.handleWindowUpdate(8 * 1024);
    await waitFor(() => dataBytes(frames) === 24 * 1024);

    stream.handleWindowUpdate(16 * 1024);
    await waitFor(() => dataBytes(frames) === 40 * 1024);

    stream.handleWindowUpdate(16 * 1024);
    await waitFor(() => dataBytes(frames) === 56 * 1024);

    stream.handleWindowUpdate(8 * 1024);
    await waitFor(() => dataBytes(frames) === 64 * 1024);

    // The daemon consumed the whole payload: its next credit grant resumes
    // the paused local socket.
    stream.handleWindowUpdate(16 * 1024);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pair.accepted.isPaused()).toBe(false);
  });

  test("restores inbound credit only as the local socket drains", async () => {
    const pair = await createSocketPair();
    const frames: TunnelFrameInput[] = [];
    const stream = new TunnelStream({
      forwardId: "fw-1",
      streamId: "stream-1",
      windowBytes: 64 * 1024,
      chunkSize: 16 * 1024,
      sendFrame: (frame) => frames.push(frame),
      onClosed: () => {},
    });
    stream.attach(pair.accepted);
    stream.handleOpenResult(true, null);

    const windowUpdates = () =>
      frames
        .filter((frame) => frame.opcode === TunnelOpcode.WindowUpdate)
        .map((frame) => frame.credit);

    // Corked writes stay in Node's write buffer, so writableLength grows above
    // the low-water mark and no credit is restored while nothing drains.
    pair.accepted.cork();
    const windowBytes = 64 * 1024;
    for (let offset = 0; offset < windowBytes; offset += 16 * 1024) {
      stream.handleData(Buffer.alloc(16 * 1024, 0xcd));
    }
    // The first frame drained into the kernel while writableLength was still
    // at the low-water mark; the remaining 48 KiB stay buffered.
    expect(windowUpdates()).toEqual([16 * 1024]);

    const drainPromise = once(pair.accepted, "drain");
    pair.accepted.uncork();
    await drainPromise;
    await waitFor(() => pair.client.bytesRead >= windowBytes);

    expect(windowUpdates()).toEqual([16 * 1024, 48 * 1024]);
  });

  test("sends half-close when the local client ends its write side", async () => {
    const pair = await createSocketPair();
    const frames: TunnelFrameInput[] = [];
    const stream = new TunnelStream({
      forwardId: "fw-1",
      streamId: "stream-1",
      sendFrame: (frame) => frames.push(frame),
      onClosed: () => {},
    });
    stream.attach(pair.accepted);
    stream.handleOpenResult(true, null);

    pair.client.end();
    await waitFor(() => hasFrame(frames, TunnelOpcode.HalfClose));

    expect(frames).toContainEqual({
      opcode: TunnelOpcode.HalfClose,
      forwardId: "fw-1",
      streamId: "stream-1",
    });
  });

  test("defers a local half-close until the remote open succeeds", async () => {
    const pair = await createSocketPair();
    const frames: TunnelFrameInput[] = [];
    const stream = new TunnelStream({
      forwardId: "fw-1",
      streamId: "stream-1",
      sendFrame: (frame) => frames.push(frame),
      onClosed: () => {},
    });
    stream.attach(pair.accepted);

    pair.client.end();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(hasFrame(frames, TunnelOpcode.HalfClose)).toBe(false);

    stream.handleOpenResult(true, null);
    await waitFor(() => hasFrame(frames, TunnelOpcode.HalfClose));
    expect(frames).toContainEqual({
      opcode: TunnelOpcode.HalfClose,
      forwardId: "fw-1",
      streamId: "stream-1",
    });
  });

  test("destroys the local socket when the daemon closes the stream", async () => {
    const pair = await createSocketPair();
    const closed: string[] = [];
    const stream = new TunnelStream({
      forwardId: "fw-1",
      streamId: "stream-1",
      sendFrame: () => {},
      onClosed: (reason) => closed.push(reason),
    });
    stream.attach(pair.accepted);
    stream.handleOpenResult(true, null);

    const acceptedClosed = once(pair.accepted, "close");
    stream.handleCloseFrame("forward stopped");
    await acceptedClosed;
    expect(closed).toEqual(["forward stopped"]);
  });

  test("propagates the daemon half-close to the local socket", async () => {
    const pair = await createSocketPair();
    const stream = new TunnelStream({
      forwardId: "fw-1",
      streamId: "stream-1",
      sendFrame: () => {},
      onClosed: () => {},
    });
    stream.attach(pair.accepted);
    stream.handleOpenResult(true, null);

    const ended = once(pair.client, "end");
    stream.handleHalfClose();
    await ended;
  });
});
