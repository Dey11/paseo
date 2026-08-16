export type WorkspacePortProtocol = "http" | "https" | "tcp";

export interface WorkspacePortObservation {
  port: number;
  bindAddress: string;
  protocol: WorkspacePortProtocol;
  source: "observed" | "configured" | "manual";
  available: boolean;
  unavailableReason: string | null;
  terminalId: string | null;
  terminalTitle: string | null;
  processName: string | null;
  serviceName: string | null;
}

export type DesktopPortForwardStatus = "starting" | "forwarded" | "disconnected" | "failed";

export interface DesktopPortForward {
  forwardId: string;
  workspaceId: string;
  remotePort: number;
  localHost: "127.0.0.1";
  localPort: number;
  protocol: WorkspacePortProtocol;
  source: WorkspacePortObservation["source"];
  status: DesktopPortForwardStatus;
  error: string | null;
}

export interface DesktopPortForwardingSnapshot {
  serverId: string;
  workspaceId: string;
  connectionStatus: "connecting" | "connected" | "disconnected" | "failed";
  forwardingSupported: boolean | null;
  discoverySupported: boolean | null;
  ports: WorkspacePortObservation[];
  forwards: DesktopPortForward[];
  error: string | null;
}

export interface DesktopPortForwardingLease {
  serverId: string;
  connectionId: string;
  url: string;
  password?: string;
  daemonPublicKeyB64?: string;
  appVersion?: string;
}

export interface DesktopPortForwardingListInput {
  lease: DesktopPortForwardingLease;
  workspaceId: string;
}

export interface DesktopPortForwardingCreateInput extends DesktopPortForwardingListInput {
  remotePort: number;
  protocol: WorkspacePortProtocol;
  source?: WorkspacePortObservation["source"];
  requestedLocalPort?: number;
}

export interface DesktopPortForwardingStopInput {
  serverId: string;
  forwardId: string;
}

export interface DesktopPortForwardingUnwatchInput {
  serverId: string;
  connectionId: string;
  workspaceId: string;
}
