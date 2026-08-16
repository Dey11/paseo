import type { HostProfile } from "@/types/host-connection";
import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
  shouldUseTlsForDefaultHostedRelay,
} from "@/utils/daemon-endpoints";
import type { DesktopPortForwardingLease } from "./types";

export function buildDesktopPortForwardingLease(input: {
  host: HostProfile | null | undefined;
  activeConnectionId: string | null | undefined;
  appVersion: string | null;
}): DesktopPortForwardingLease | null {
  const { host, activeConnectionId } = input;
  if (!host || !activeConnectionId) {
    return null;
  }

  const connection = host.connections.find((candidate) => candidate.id === activeConnectionId);
  if (!connection) {
    return null;
  }

  const base = {
    serverId: host.serverId,
    connectionId: connection.id,
    ...(input.appVersion ? { appVersion: input.appVersion } : {}),
  };

  if (connection.type === "directTcp") {
    return {
      ...base,
      url: buildDaemonWebSocketUrl(connection.endpoint, {
        useTls: connection.useTls ?? false,
      }),
      ...(connection.password ? { password: connection.password } : {}),
    };
  }

  if (connection.type === "relay") {
    return {
      ...base,
      url: buildRelayWebSocketUrl({
        endpoint: connection.relayEndpoint,
        useTls: connection.useTls ?? shouldUseTlsForDefaultHostedRelay(connection.relayEndpoint),
        serverId: host.serverId,
      }),
      daemonPublicKeyB64: connection.daemonPublicKeyB64,
    };
  }

  // The Electron main process intentionally accepts only WebSocket leases. The
  // renderer never transfers local socket or named-pipe paths across this IPC.
  return null;
}
