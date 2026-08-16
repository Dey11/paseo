import type {
  DesktopPortForward,
  DesktopPortForwardingSnapshot,
  WorkspacePortObservation,
  WorkspacePortProtocol,
} from "./types";

export interface WorkspacePortRow {
  key: string;
  remotePort: number;
  bindAddress: string;
  protocol: WorkspacePortProtocol;
  observation: WorkspacePortObservation | null;
  forward: DesktopPortForward | null;
}

function portKey(port: number): string {
  return String(port);
}

export function mergeWorkspacePortRows(input: {
  ports: readonly WorkspacePortObservation[];
  forwards: readonly DesktopPortForward[];
}): WorkspacePortRow[] {
  const rows = new Map<number, WorkspacePortRow>();

  for (const observation of input.ports) {
    rows.set(observation.port, {
      key: portKey(observation.port),
      remotePort: observation.port,
      bindAddress: observation.bindAddress,
      protocol: observation.protocol,
      observation,
      forward: null,
    });
  }

  for (const forward of input.forwards) {
    const existing = rows.get(forward.remotePort);
    rows.set(forward.remotePort, {
      key: existing?.key ?? portKey(forward.remotePort),
      remotePort: forward.remotePort,
      bindAddress: existing?.bindAddress ?? "127.0.0.1",
      protocol: forward.protocol,
      observation: existing?.observation ?? null,
      forward,
    });
  }

  return [...rows.values()].sort((left, right) => left.remotePort - right.remotePort);
}

export function parseManualPort(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,5}$/.test(trimmed)) {
    return null;
  }
  const port = Number(trimmed);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

export function selectWorkspacePortSnapshot(
  snapshot: DesktopPortForwardingSnapshot | null,
  identity: { serverId: string; workspaceId: string | null | undefined },
): DesktopPortForwardingSnapshot | null {
  if (
    !snapshot ||
    snapshot.serverId !== identity.serverId ||
    snapshot.workspaceId !== identity.workspaceId
  ) {
    return null;
  }
  return snapshot;
}

export function canOpenForward(forward: DesktopPortForward): boolean {
  return forward.protocol === "http" || forward.protocol === "https";
}

export function hasDisappearedObservation(row: WorkspacePortRow): boolean {
  return row.forward !== null && row.forward.source !== "manual" && row.observation === null;
}

export function formatForwardUrl(forward: DesktopPortForward): string {
  return `${forward.protocol}://${forward.localHost}:${forward.localPort}`;
}
