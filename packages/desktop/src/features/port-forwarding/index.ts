import { ipcMain, webContents } from "electron";
import { registerPortForwardingIpc, type IpcRegistry } from "./ipc.js";
import { createDaemonTunnelClientFactory, type TunnelClientFactory } from "./tunnel-client.js";
import { PortForwardingManager } from "./tunnel-manager.js";
import type { PortForwardingLogger } from "./types.js";

// Desktop-side workspace port forwarding (fork plan:
// docs/fork-docs/desktop-port-forwarding.md, ticket 4). The main process owns
// the dedicated tunnel connections and the loopback listeners; the renderer
// only exchanges validated snapshots and commands over IPC.

export interface PortForwardingFeature {
  disposeAll(): void;
  removeWindow(webContentsId: number): void;
}

export interface PortForwardingFeatureOptions {
  ipc?: IpcRegistry;
  logger?: PortForwardingLogger;
  createTunnelClient?: TunnelClientFactory["create"];
  idleTeardownMs?: number;
  sendEvent?(webContentsId: number, channel: string, payload: unknown): void;
  getWebContents?(
    webContentsId: number,
  ): { isDestroyed(): boolean; send(channel: string, payload: unknown): void } | null;
}

function defaultLogger(): PortForwardingLogger {
  return {
    info: (obj, msg) => console.info(`[port-forwarding] ${msg}`, obj),
    warn: (obj, msg) => console.warn(`[port-forwarding] ${msg}`, obj),
    error: (obj, msg) => console.error(`[port-forwarding] ${msg}`, obj),
  };
}

export function registerPortForwardingFeature(
  options: PortForwardingFeatureOptions = {},
): PortForwardingFeature {
  const logger = options.logger ?? defaultLogger();
  const manager = new PortForwardingManager({
    createTunnelClient: options.createTunnelClient ?? createDaemonTunnelClientFactory().create,
    logger,
    idleTeardownMs: options.idleTeardownMs,
  });

  const sendEvent =
    options.sendEvent ??
    ((webContentsId, channel, payload) => {
      const contents = options.getWebContents
        ? options.getWebContents(webContentsId)
        : webContents.fromId(webContentsId);
      if (contents && !contents.isDestroyed()) {
        contents.send(channel, payload);
      }
    });

  const ipc = registerPortForwardingIpc({
    ipc: options.ipc ?? ipcMain,
    manager,
    sendEvent,
  });

  return {
    disposeAll: () => {
      void manager.disposeAll();
    },
    removeWindow: (webContentsId) => {
      ipc.removeWindow(webContentsId);
      void manager.removeWindow(webContentsId);
    },
  };
}
