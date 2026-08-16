/* eslint-disable max-nested-callbacks */
import { afterEach, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { isPlatform } from "../../test-utils/platform.js";
import { WorkspacePortObserver } from "./observer.js";

// Linux-only: walks the real /proc filesystem and real process trees.
// The listener process IS the terminal root (exec-replaced shell case).

interface ChildListener {
  pid: number;
  port: number;
  kill: () => void;
}

function startListenerChild(script: string): Promise<ChildListener> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "inherit"],
      // Own process group so a descendant spawned by the script dies with it.
      detached: true,
    });
    let stdout = "";
    const timeout = setTimeout(() => {
      killChildGroup(child);
      reject(new Error(`listener child did not report a port: ${stdout}`));
    }, 10_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      const match = /READY (\d+)/.exec(stdout);
      if (!match) return;
      clearTimeout(timeout);
      child.stdout?.destroy();
      resolve({
        pid: child.pid ?? 0,
        port: Number(match[1]),
        kill: () => killChildGroup(child),
      });
    });
    child.on("exit", () => {
      clearTimeout(timeout);
    });
  });
}

function killChildGroup(child: { pid?: number }): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // group already gone
    }
  }
}

const children: ChildListener[] = [];

afterEach(async () => {
  for (const child of children) {
    child.kill();
  }
  children.length = 0;
  // Give the observer a beat to see the exits before the next test.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

const ECHO_LISTENER = `
const net = require("node:net");
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("READY " + server.address().port + "\\n");
});
setInterval(() => {}, 1000);
`;

function makeRealObserver(options: {
  roots: () => Array<{ terminalId: string; workspaceId: string; rootPid: number }>;
  pollIntervalMs?: number;
}) {
  const snapshots: Array<{ workspaceId: string; ports: unknown[] }> = [];
  const observer = new WorkspacePortObserver({
    listTerminalRootPids: options.roots,
    listServicePorts: async () => [],
    pollIntervalMs: options.pollIntervalMs ?? 100,
    refreshDebounceMs: 10,
  });
  observer.setOnSnapshot((snapshot) => {
    snapshots.push({
      workspaceId: snapshot.workspaceId,
      ports: snapshot.ports.map((port) => ({ ...port })),
    });
  });
  observer.start();
  return { observer, snapshots };
}

function portsFor(
  snapshots: Array<{ workspaceId: string; ports: unknown[] }>,
  workspaceId: string,
) {
  const latest = snapshots.findLast((snapshot) => snapshot.workspaceId === workspaceId);
  return latest ? latest.ports : [];
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 10_000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

describe("WorkspacePortObserver over real /proc", () => {
  test.skipIf(!isPlatform("linux"))(
    "attributes a listener owned by the terminal root pid",
    async () => {
      const child = await startListenerChild(ECHO_LISTENER);
      children.push(child);
      expect(child.pid).toBeGreaterThan(0);

      const { observer, snapshots } = makeRealObserver({
        roots: () => [{ terminalId: "term-root", workspaceId: "ws-root", rootPid: child.pid }],
      });
      observer.setWatching("ws-root", true);

      await waitForCondition(() => {
        const ports = portsFor(snapshots, "ws-root");
        return ports.some((port: unknown) => (port as { port: number }).port === child.port);
      });
      const ports = portsFor(snapshots, "ws-root");
      const observed = ports.find(
        (port: unknown) => (port as { port: number }).port === child.port,
      );
      expect(observed).toMatchObject({
        port: child.port,
        address: "127.0.0.1",
        source: "terminal",
        terminalId: "term-root",
        eligible: true,
      });
      expect((observed as { processName?: string } | undefined)?.processName).toMatch(
        /^(?:MainThread|node)$/,
      );
      observer.dispose();
    },
  );

  test.skipIf(!isPlatform("linux"))(
    "attributes listeners owned by descendants of the terminal root",
    async () => {
      // sh spawns node; the listener is a grandchild of the terminal root.
      const listenerCode = `const net=require("node:net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>process.stdout.write("READY "+s.address().port+"\\n"));setInterval(()=>{},1000);`;
      const child = await startListenerChild(
        `const { spawn } = require("node:child_process"); spawn("sh", ["-c", "exec " + JSON.stringify(process.execPath) + " -e " + JSON.stringify(${JSON.stringify(
          listenerCode,
        )})], { stdio: "inherit" }); setInterval(() => {}, 1000);`,
      );
      children.push(child);
      const { observer, snapshots } = makeRealObserver({
        roots: () => [{ terminalId: "term-desc", workspaceId: "ws-desc", rootPid: child.pid }],
      });
      observer.setWatching("ws-desc", true);

      await waitForCondition(() => {
        const ports = portsFor(snapshots, "ws-desc");
        return ports.some((port: unknown) => (port as { port: number }).port === child.port);
      });
      const ports = portsFor(snapshots, "ws-desc");
      const observed = ports.find(
        (port: unknown) => (port as { port: number }).port === child.port,
      );
      expect(observed).toMatchObject({
        port: child.port,
        address: "127.0.0.1",
        source: "terminal",
        terminalId: "term-desc",
        eligible: true,
      });
      expect((observed as { processName?: string } | undefined)?.processName).toMatch(
        /^(?:MainThread|node)$/,
      );
      observer.dispose();
    },
  );

  test.skipIf(!isPlatform("linux"))("keeps two same-cwd sibling workspaces isolated", async () => {
    const first = await startListenerChild(ECHO_LISTENER);
    const second = await startListenerChild(ECHO_LISTENER);
    children.push(first, second);
    const { observer, snapshots } = makeRealObserver({
      roots: () => [
        { terminalId: "term-a", workspaceId: "ws-a", rootPid: first.pid },
        { terminalId: "term-b", workspaceId: "ws-b", rootPid: second.pid },
      ],
    });
    observer.setWatching("ws-a", true);
    observer.setWatching("ws-b", true);

    await waitForCondition(() => {
      const a = portsFor(snapshots, "ws-a");
      const b = portsFor(snapshots, "ws-b");
      return (
        a.some((port: unknown) => (port as { port: number }).port === first.port) &&
        b.some((port: unknown) => (port as { port: number }).port === second.port)
      );
    });
    const a = portsFor(snapshots, "ws-a");
    const b = portsFor(snapshots, "ws-b");
    expect(a.some((port: unknown) => (port as { port: number }).port === second.port)).toBe(false);
    expect(b.some((port: unknown) => (port as { port: number }).port === first.port)).toBe(false);
    observer.dispose();
  });

  test.skipIf(!isPlatform("linux"))("removes the port when the listener exits", async () => {
    const child = await startListenerChild(ECHO_LISTENER);
    children.push(child);
    const { observer, snapshots } = makeRealObserver({
      roots: () => [{ terminalId: "term-exit", workspaceId: "ws-exit", rootPid: child.pid }],
    });
    observer.setWatching("ws-exit", true);

    await waitForCondition(() => {
      const ports = portsFor(snapshots, "ws-exit");
      return ports.some((port: unknown) => (port as { port: number }).port === child.port);
    });

    child.kill();
    await waitForCondition(() => {
      const ports = portsFor(snapshots, "ws-exit");
      return !ports.some((port: unknown) => (port as { port: number }).port === child.port);
    });
    observer.dispose();
  });
});
