import net from "node:net";
import { once } from "node:events";
import { describe, expect, test } from "vitest";
import { WorkspacePortObserver, type WorkspacePortSnapshot } from "./observer.js";

describe.runIf(process.platform === "linux")("WorkspacePortObserver Linux integration", () => {
  test("attributes a real root-process loopback listener to its workspace", async () => {
    const listener = net.createServer();
    listener.listen({ host: "127.0.0.1", port: 0 });
    await once(listener, "listening");
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const snapshots: WorkspacePortSnapshot[] = [];
    const observer = new WorkspacePortObserver({
      listTerminalRootPids: () => [
        { terminalId: "terminal-real", workspaceId: "workspace-real", rootPid: process.pid },
      ],
      listServicePorts: async () => [],
    });
    observer.setOnSnapshot((snapshot) => snapshots.push(snapshot));
    observer.start();
    observer.setWatching("workspace-real", true);

    try {
      await observer.refreshNow();
      expect(
        snapshots
          .at(-1)
          ?.ports.some(
            (port) =>
              port.port === address.port &&
              port.address === "127.0.0.1" &&
              port.terminalId === "terminal-real" &&
              port.eligible,
          ),
      ).toBe(true);
    } finally {
      observer.dispose();
      listener.close();
    }
  });
});
