/* eslint-disable max-nested-callbacks */
import { afterEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import {
  decodeBinaryFrame,
  encodeTunnelFrame,
  TunnelOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import type { SessionOutboundMessage, WorkspaceMutation } from "@getpaseo/protocol/messages";
import { Session, type SessionOptions } from "./session.js";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import {
  asAgentManager,
  asAgentStorage,
  asCheckoutDiffManager,
  asDaemonConfigStore,
  asDownloadTokenStore,
  asGitHubService,
  asPushNotifications,
  asScheduleService,
  asSessionLogger,
  asTerminalManager,
  asWorkspaceGitService,
  createProviderSnapshotManagerStub,
} from "./test-utils/session-stubs.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";

const logger = pino({ level: "silent" });

function persistedWorkspace(workspaceId: string) {
  return {
    workspaceId,
    projectId: "proj-1",
    cwd: "/tmp/workspace-a",
    kind: "directory" as const,
    displayName: "workspace-a",
    title: null,
    branch: null,
    worktreeRoot: null,
    baseBranch: null,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    autoArchivedChangeRequestUrl: null,
    pinnedAt: null,
  };
}

interface MutableRegistry {
  registry: SessionOptions["workspaceRegistry"];
  fireMutation: (mutation: WorkspaceMutation) => void;
}

function makeWorkspaceRegistry(): MutableRegistry {
  const mutationListeners = new Set<(mutation: WorkspaceMutation) => void>();
  const registry: SessionOptions["workspaceRegistry"] = {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => [persistedWorkspace("ws-1")],
    get: async (workspaceId: string) =>
      workspaceId === "ws-1" ? persistedWorkspace("ws-1") : null,
    update: async () => null,
    upsert: async () => {},
    archive: async () => {},
    remove: async () => {},
    subscribeToMutations: (listener) => {
      mutationListeners.add(listener);
      return () => {
        mutationListeners.delete(listener);
      };
    },
  };
  return {
    registry,
    fireMutation: (mutation) => {
      for (const listener of mutationListeners) listener(mutation);
    },
  };
}

const trackedServers: Server[] = [];
const trackedSockets = new Set<import("node:net").Socket>();
const tempHomes: string[] = [];

afterEach(async () => {
  for (const socket of trackedSockets) {
    socket.destroy();
  }
  trackedSockets.clear();
  for (const server of trackedServers) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of trackedSockets) {
        socket.destroy();
      }
    }).catch(() => {});
  }
  trackedServers.length = 0;
  for (const home of tempHomes) {
    rmSync(home, { recursive: true, force: true });
  }
  tempHomes.length = 0;
});

function startEchoServer(): Promise<{ server: Server; port: number; received: string[] }> {
  const received: string[] = [];
  const server = createServer();
  trackedServers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.on("connection", (socket) => {
        trackedSockets.add(socket);
        socket.on("close", () => trackedSockets.delete(socket));
        socket.on("data", (chunk: Buffer) => {
          received.push(chunk.toString());
          socket.write(chunk);
        });
      });
      resolve({ server, port: address.port, received });
    });
  });
}

function createSessionForPortForwardingTest(options?: {
  workspaceRegistry?: SessionOptions["workspaceRegistry"];
  terminalManager?: SessionOptions["terminalManager"];
}): {
  session: Session;
  messages: SessionOutboundMessage[];
  binaryFrames: Uint8Array[];
} {
  const messages: SessionOutboundMessage[] = [];
  const binaryFrames: Uint8Array[] = [];
  const tempHome = mkdtempSync(join(tmpdir(), "session-port-forwarding-"));
  tempHomes.push(tempHome);
  const session = new Session({
    clientId: "test-client",
    permissions: OWNER_PERMISSIONS,
    onMessage: (message) => messages.push(message),
    onBinaryMessage: (frame) => binaryFrames.push(frame),
    logger: asSessionLogger(logger),
    downloadTokenStore: asDownloadTokenStore(),
    pushNotifications: asPushNotifications(),
    paseoHome: tempHome,
    agentManager: asAgentManager({
      listAgents: () => [],
      listProviderSubagentActivity: () => [],
      subscribe: () => () => {},
    }),
    agentStorage: asAgentStorage({ list: async () => [], get: async () => undefined }),
    projectRegistry: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => [],
      get: async () => null,
      getOrCreateActiveByRoot: async (input) => ({
        projectId: "proj-1",
        rootPath: input.rootPath,
        kind: input.kind,
        displayName: input.displayName,
        projectKey: null,
        customName: null,
        customIconRevision: null,
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
        archivedAt: null,
      }),
      upsert: async () => {},
      update: async () => null,
      archive: async () => {},
      remove: async () => {},
    },
    workspaceRegistry: options?.workspaceRegistry ?? makeWorkspaceRegistry().registry,
    scheduleService: asScheduleService(),
    checkoutDiffManager: asCheckoutDiffManager({
      scheduleRefreshForCwd: () => {},
    }),
    github: asGitHubService({}),
    workspaceGitService: asWorkspaceGitService(createNoopWorkspaceGitService()),
    daemonConfigStore: asDaemonConfigStore({
      get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
      onChange: () => () => {},
    }),
    stt: null,
    tts: null,
    terminalManager:
      options?.terminalManager ??
      asTerminalManager({
        listTerminalRootPids: () => [],
        subscribeTerminalsChanged: () => () => {},
      }),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    serverId: "server-1",
    daemonVersion: "0.4.0",
  });
  return { session, messages, binaryFrames };
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function decodedFrames(binaryFrames: Uint8Array[]) {
  return binaryFrames
    .map((frame) => decodeBinaryFrame(frame))
    .filter((frame): frame is NonNullable<typeof frame> => frame !== null)
    .filter((decoded) => decoded.kind === "tunnel")
    .map((decoded) => decoded.frame);
}

function findCreateResponse(messages: SessionOutboundMessage[]): {
  forwardId: string;
  index: number;
} {
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.type === "workspace.port_forward.create.response") {
      index = i;
      break;
    }
  }
  const message = messages[index];
  if (message?.type !== "workspace.port_forward.create.response") {
    throw new Error("expected create response");
  }
  const forwardId = message.payload.forwardId;
  if (!forwardId) throw new Error("expected forward id");
  return { forwardId, index };
}

async function openStream(
  session: Session,
  binaryFrames: Uint8Array[],
  forwardId: string,
  streamId: string,
): Promise<void> {
  const before = binaryFrames.length;
  await session.handleBinaryFrame({
    kind: "tunnel",
    frame: { opcode: TunnelOpcode.Open, forwardId, streamId },
  });
  await waitForCondition(() => decodedFrames(binaryFrames).length >= before + 1);
  const openResult = decodedFrames(binaryFrames)[before];
  expect(openResult?.opcode).toBe(TunnelOpcode.OpenResult);
  if (openResult?.opcode === TunnelOpcode.OpenResult) {
    expect(openResult.ok).toBe(true);
  }
}

describe("session port-forwarding contract", () => {
  test("watch, forward, and tunnel streams work through the session boundary", async () => {
    const echo = await startEchoServer();
    const { session, messages, binaryFrames } = createSessionForPortForwardingTest();

    await session.handleMessage({
      type: "workspace.port.watch.request",
      workspaceId: "ws-1",
      requestId: "req-1",
    });
    const watchResponse = messages.find(
      (message) => message.type === "workspace.port.watch.response",
    );
    if (watchResponse?.type !== "workspace.port.watch.response") {
      throw new Error("expected watch response");
    }
    expect(watchResponse.payload).toEqual({
      workspaceId: "ws-1",
      success: true,
      error: null,
      requestId: "req-1",
    });
    expect(messages.some((message) => message.type === "workspace.port.update")).toBe(true);

    await session.handleMessage({
      type: "workspace.port_forward.create.request",
      workspaceId: "ws-1",
      port: echo.port,
      requestId: "req-2",
    });
    const { forwardId } = findCreateResponse(messages);

    await openStream(session, binaryFrames, forwardId, "s1");

    await session.handleBinaryFrame({
      kind: "tunnel",
      frame: {
        opcode: TunnelOpcode.Data,
        forwardId,
        streamId: "s1",
        payload: Buffer.from("ping"),
      },
    });
    await waitForCondition(() =>
      decodedFrames(binaryFrames).some(
        (frame) =>
          frame.opcode === TunnelOpcode.Data && Buffer.from(frame.payload).toString() === "ping",
      ),
    );
    expect(echo.received).toEqual(["ping"]);

    await session.cleanup();
  });

  test("wire-encoded tunnel frames route through the demux into the service", async () => {
    const echo = await startEchoServer();
    const { session, messages, binaryFrames } = createSessionForPortForwardingTest();

    await session.handleMessage({
      type: "workspace.port_forward.create.request",
      workspaceId: "ws-1",
      port: echo.port,
      requestId: "req-1",
    });
    const { forwardId } = findCreateResponse(messages);

    const openBytes = encodeTunnelFrame({
      opcode: TunnelOpcode.Open,
      forwardId,
      streamId: "s1",
    });
    const decoded = decodeBinaryFrame(openBytes);
    expect(decoded?.kind).toBe("tunnel");
    if (decoded?.kind !== "tunnel") throw new Error("expected tunnel frame");

    await session.handleBinaryFrame(decoded);
    await waitForCondition(() => decodedFrames(binaryFrames).length >= 1);
    const openResult = decodedFrames(binaryFrames)[0];
    expect(openResult?.opcode).toBe(TunnelOpcode.OpenResult);
    if (openResult?.opcode === TunnelOpcode.OpenResult) {
      expect(openResult.ok).toBe(true);
    }
    await session.cleanup();
  });

  test("transport loss revokes forwards and recreation succeeds after reconnect", async () => {
    const echo = await startEchoServer();
    const { session, messages, binaryFrames } = createSessionForPortForwardingTest();

    await session.handleMessage({
      type: "workspace.port_forward.create.request",
      workspaceId: "ws-1",
      port: echo.port,
      requestId: "req-1",
    });
    const { forwardId } = findCreateResponse(messages);
    await openStream(session, binaryFrames, forwardId, "s1");

    session.revokePortForwardsForTransportLoss();
    await waitForCondition(() =>
      decodedFrames(binaryFrames).some(
        (frame) => frame.opcode === TunnelOpcode.Close && frame.reason === "transport_disconnected",
      ),
    );

    await session.handleMessage({
      type: "workspace.port_forward.create.request",
      workspaceId: "ws-1",
      port: echo.port,
      requestId: "req-2",
    });
    const recreated = findCreateResponse(messages);
    expect(recreated.forwardId).not.toBe(forwardId);
    await session.cleanup();
  });

  test("workspace archive revokes its forwards", async () => {
    const echo = await startEchoServer();
    const registry = makeWorkspaceRegistry();
    const { session, messages, binaryFrames } = createSessionForPortForwardingTest({
      workspaceRegistry: registry.registry,
    });

    await session.handleMessage({
      type: "workspace.port_forward.create.request",
      workspaceId: "ws-1",
      port: echo.port,
      requestId: "req-1",
    });
    const { forwardId } = findCreateResponse(messages);
    await openStream(session, binaryFrames, forwardId, "s1");

    registry.fireMutation({
      kind: "archive",
      workspaceId: "ws-1",
      archivedAt: "2026-01-02T00:00:00.000Z",
    });
    await waitForCondition(() =>
      decodedFrames(binaryFrames).some(
        (frame) => frame.opcode === TunnelOpcode.Close && frame.reason === "forward_deleted",
      ),
    );
    await session.cleanup();
  });
});
