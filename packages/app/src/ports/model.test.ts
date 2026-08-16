import { describe, expect, it } from "vitest";
import {
  canOpenForward,
  formatForwardUrl,
  hasDisappearedObservation,
  mergeWorkspacePortRows,
  parseManualPort,
  selectWorkspacePortSnapshot,
} from "./model";
import type {
  DesktopPortForward,
  DesktopPortForwardingSnapshot,
  WorkspacePortObservation,
} from "./types";

const observation: WorkspacePortObservation = {
  port: 3000,
  bindAddress: "0.0.0.0",
  protocol: "http",
  source: "observed",
  available: true,
  unavailableReason: null,
  terminalId: "term-1",
  terminalTitle: "web",
  processName: "node",
  serviceName: null,
};

const forward: DesktopPortForward = {
  forwardId: "forward-1",
  workspaceId: "workspace-1",
  remotePort: 3000,
  localHost: "127.0.0.1",
  localPort: 49152,
  protocol: "http",
  source: "observed",
  status: "forwarded",
  error: null,
};

describe("workspace port rows", () => {
  it("merges a local forward into its observed remote port", () => {
    expect(mergeWorkspacePortRows({ ports: [observation], forwards: [forward] })).toEqual([
      {
        key: "3000",
        remotePort: 3000,
        bindAddress: "0.0.0.0",
        protocol: "http",
        observation,
        forward,
      },
    ]);
  });

  it("keeps a forwarded row after automatic discovery no longer sees the port", () => {
    const rows = mergeWorkspacePortRows({ ports: [], forwards: [forward] });
    expect(rows).toEqual([
      {
        key: "3000",
        remotePort: 3000,
        bindAddress: "127.0.0.1",
        protocol: "http",
        observation: null,
        forward,
      },
    ]);
    expect(hasDisappearedObservation(rows[0]!)).toBe(true);
  });

  it("does not label a manual forward as a disappeared observation", () => {
    const rows = mergeWorkspacePortRows({
      ports: [],
      forwards: [{ ...forward, source: "manual" }],
    });
    expect(hasDisappearedObservation(rows[0]!)).toBe(false);
  });

  it("sorts observed and manual ports numerically", () => {
    expect(
      mergeWorkspacePortRows({
        ports: [
          { ...observation, port: 5173 },
          { ...observation, port: 3000 },
        ],
        forwards: [{ ...forward, remotePort: 8080 }],
      }).map((row) => row.remotePort),
    ).toEqual([3000, 5173, 8080]);
  });
});

describe("manual port input", () => {
  it.each([
    ["3000", 3000],
    [" 65535 ", 65535],
    ["0", null],
    ["65536", null],
    ["3.5", null],
    ["abc", null],
  ])("parses %s", (value, expected) => {
    expect(parseManualPort(value)).toBe(expected);
  });
});

describe("workspace snapshot identity", () => {
  const snapshot: DesktopPortForwardingSnapshot = {
    serverId: "host-1",
    workspaceId: "workspace-1",
    connectionStatus: "connected",
    forwardingSupported: true,
    discoverySupported: true,
    ports: [observation],
    forwards: [forward],
    error: null,
  };

  it("hides the previous workspace snapshot immediately after a route switch", () => {
    expect(
      selectWorkspacePortSnapshot(snapshot, {
        serverId: "host-1",
        workspaceId: "workspace-2",
      }),
    ).toBeNull();
    expect(
      selectWorkspacePortSnapshot(snapshot, {
        serverId: "host-2",
        workspaceId: "workspace-1",
      }),
    ).toBeNull();
  });

  it("keeps the snapshot for its owning host and workspace", () => {
    expect(
      selectWorkspacePortSnapshot(snapshot, {
        serverId: "host-1",
        workspaceId: "workspace-1",
      }),
    ).toBe(snapshot);
  });
});

describe("forward endpoints", () => {
  it.each([
    ["http", "http://127.0.0.1:49152", true],
    ["https", "https://127.0.0.1:49152", true],
    ["tcp", "tcp://127.0.0.1:49152", false],
  ] as const)("uses the selected %s protocol", (protocol, endpoint, canOpen) => {
    const protocolForward = { ...forward, protocol };
    expect(formatForwardUrl(protocolForward)).toBe(endpoint);
    expect(canOpenForward(protocolForward)).toBe(canOpen);
  });
});
