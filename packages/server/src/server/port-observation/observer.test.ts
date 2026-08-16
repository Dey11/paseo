import { describe, expect, test } from "vitest";
import type { ProcAdapter } from "./proc.js";
import {
  WorkspacePortObserver,
  type TimerAdapter,
  type TimerHandle,
  type WorkspacePortSnapshot,
} from "./observer.js";
import type { TerminalRootPid } from "../../terminal/terminal-manager.js";

interface FakeFiles {
  files: Record<string, string>;
  dirs: Record<string, string[]>;
  links: Record<string, string>;
}

function makeFakeProc(fixture: FakeFiles): ProcAdapter {
  return {
    readFile: async (path) => {
      const content = fixture.files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    readDir: async (path) => {
      const entries = fixture.dirs[path];
      if (entries === undefined) throw new Error(`ENOENT: ${path}`);
      return entries;
    },
    readLink: async (path) => {
      const link = fixture.links[path];
      if (link === undefined) throw new Error(`ENOENT: ${path}`);
      return link;
    },
  };
}

class FakeTimers implements TimerAdapter {
  private nextHandle = 1;
  private pending = new Map<number, { callback: () => void; at: number }>();
  now = 0;

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.pending.set(handle, { callback, at: this.now + ms });
    return handle;
  }

  clearTimeout(handle: TimerHandle): void {
    if (typeof handle === "number") {
      this.pending.delete(handle);
    }
  }

  /** Advance the clock and run due tasks in scheduling order. */
  advance(ms: number): void {
    this.now += ms;
    const due = [...this.pending.entries()]
      .filter(([, task]) => task.at <= this.now)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [handle, task] of due) {
      this.pending.delete(handle);
      task.callback();
    }
  }
}

const TCP4 = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000   123        0 111 1 0000000000000000 100 0 0 10 0",
  "   1: 0100000A:2328 00000000:0000 0A 00000000:00000000 00:00000000 00000000   123        0 222 1 0000000000000000 100 0 0 10 0",
  "   2: 0100000A:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 333 1 0000000000000000 100 0 0 10 0",
  "   3: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 444 1 0000000000000000 100 0 0 10 0",
].join("\n");

const TCP6 = [
  "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000   123        0 555 1 0000000000000000 100 0 0 10 0",
].join("\n");

function stat(pid: number, comm: string, ppid: number): string {
  return `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560 0 0 0 0 0 0 0 20 0 1 0 1 2 3`;
}

function makeFixture(options: { withRootPidListener?: boolean } = {}): FakeFiles {
  const files: Record<string, string> = {
    "/proc/net/tcp": TCP4,
    "/proc/net/tcp6": TCP6,
    "/proc/100/stat": stat(100, "bash", 1),
    "/proc/200/stat": stat(200, "node", 100),
    "/proc/300/stat": stat(300, "python3", 200),
    "/proc/400/stat": stat(400, "bash", 1),
    "/proc/500/stat": stat(500, "node", 400),
    "/proc/600/stat": stat(600, "server", 1),
  };
  const dirs: Record<string, string[]> = {
    "/proc": ["1", "100", "200", "300", "400", "500", "600"],
    "/proc/100/fd": ["0", "1", "2"],
    "/proc/200/fd": ["0", "1", "2", "3", "5"],
    "/proc/300/fd": ["0", "1", "2", "4"],
    "/proc/400/fd": ["0", "1", "2"],
    "/proc/500/fd": ["0", "1", "2", "6"],
    "/proc/600/fd": ["0", "1", "2", "7"],
  };
  const links: Record<string, string> = {
    "/proc/200/fd/3": "socket:[111]",
    "/proc/200/fd/5": "socket:[111]",
    "/proc/300/fd/4": "socket:[222]",
    "/proc/500/fd/6": "socket:[333]",
    "/proc/600/fd/7": options.withRootPidListener ? "socket:[555]" : "/dev/null",
  };
  return { files, dirs, links };
}

interface Harness {
  observer: WorkspacePortObserver;
  timers: FakeTimers;
  snapshots: WorkspacePortSnapshot[];
  setRoots: (roots: TerminalRootPid[]) => void;
  setServices: (workspaceId: string, ports: Array<{ port: number; scriptName: string }>) => void;
  fireTerminalsChanged: () => void;
  refreshCount: () => number;
}

function makeHarness(fixture?: FakeFiles): Harness {
  const timers = new FakeTimers();
  const snapshots: WorkspacePortSnapshot[] = [];
  let roots: TerminalRootPid[] = [];
  const services = new Map<string, Array<{ port: number; scriptName: string }>>();
  const terminalListeners = new Set<() => void>();
  const refreshCount = { value: 0 };
  const observer = new WorkspacePortObserver({
    proc: makeFakeProc(fixture ?? makeFixture()),
    listTerminalRootPids: () => roots,
    listServicePorts: async (workspaceId) => services.get(workspaceId) ?? [],
    subscribeTerminalsChanged: (listener) => {
      terminalListeners.add(listener);
      return () => {
        terminalListeners.delete(listener);
      };
    },
    pollIntervalMs: 2000,
    refreshDebounceMs: 250,
    timers,
    onRefresh: () => {
      refreshCount.value += 1;
    },
  });
  observer.setOnSnapshot((snapshot) => snapshots.push(snapshot));
  observer.start();
  return {
    observer,
    timers,
    snapshots,
    setRoots: (next) => {
      roots = next;
    },
    setServices: (workspaceId, ports) => {
      services.set(workspaceId, ports);
    },
    fireTerminalsChanged: () => {
      for (const listener of terminalListeners) listener();
    },
    refreshCount: () => refreshCount.value,
  };
}

function terminal(terminalId: string, workspaceId: string, rootPid: number): TerminalRootPid {
  return { terminalId, workspaceId, rootPid };
}

describe("WorkspacePortObserver", () => {
  test("emits a snapshot on watch and polls every 2s while watching", async () => {
    const harness = makeHarness();
    harness.setRoots([terminal("term-a", "ws-a", 100)]);
    harness.observer.setWatching("ws-a", true);
    await harness.observer.refreshNow();
    expect(harness.snapshots).toHaveLength(1);
    expect(harness.snapshots[0]?.workspaceId).toBe("ws-a");

    harness.timers.advance(2000);
    await waitForMicrotasks();
    expect(harness.snapshots).toHaveLength(1); // unchanged snapshot is not re-emitted
    expect(harness.refreshCount()).toBe(2); // but the poll still ran
  });

  test("stops polling when nothing watches and no forward is active", async () => {
    const harness = makeHarness();
    harness.setRoots([terminal("term-a", "ws-a", 100)]);
    harness.observer.setWatching("ws-a", true);
    await harness.observer.refreshNow();
    const refreshesAfterWatch = harness.refreshCount();

    harness.observer.setWatching("ws-a", false);
    harness.timers.advance(10_000);
    await waitForMicrotasks();
    expect(harness.refreshCount()).toBe(refreshesAfterWatch);
  });

  test("keeps polling while a forward is active even without a watch", async () => {
    const harness = makeHarness();
    harness.setRoots([terminal("term-a", "ws-a", 100)]);
    harness.observer.setWatching("ws-a", true);
    await harness.observer.refreshNow();
    const refreshesAfterWatch = harness.refreshCount();

    harness.observer.setWatching("ws-a", false);
    harness.observer.setForwardActive(true);
    harness.timers.advance(2000);
    await waitForMicrotasks();
    harness.timers.advance(2000);
    await waitForMicrotasks();
    expect(harness.refreshCount()).toBeGreaterThan(refreshesAfterWatch);

    harness.observer.setForwardActive(false);
    harness.timers.advance(10_000);
    await waitForMicrotasks();
    expect(harness.refreshCount()).toBeGreaterThan(0);
  });

  test("refreshes eagerly on terminal lifecycle signals", async () => {
    const harness = makeHarness();
    harness.setRoots([terminal("term-a", "ws-a", 100)]);
    harness.observer.setWatching("ws-a", true);
    await harness.observer.refreshNow();
    const refreshesBefore = harness.refreshCount();

    harness.fireTerminalsChanged();
    harness.timers.advance(250);
    await waitForMicrotasks();
    expect(harness.refreshCount()).toBe(refreshesBefore + 1);
  });

  test("attributes ports by terminal lineage per workspace and dedupes duplicate sockets", async () => {
    const harness = makeHarness();
    harness.setRoots([terminal("term-a", "ws-a", 100)]);
    harness.observer.setWatching("ws-a", true);
    await harness.observer.refreshNow();

    const ports = harness.snapshots[0]?.ports ?? [];
    expect(ports).toEqual([
      {
        port: 8080,
        address: "127.0.0.1",
        source: "terminal",
        terminalId: "term-a",
        processName: "node",
        eligible: true,
      },
      {
        port: 9000,
        address: "10.0.0.1",
        source: "terminal",
        terminalId: "term-a",
        processName: "python3",
        eligible: false,
      },
    ]);
  });

  test("includes the root pid itself in the lineage (exec-replaced shell)", async () => {
    const harness = makeHarness(makeFixture({ withRootPidListener: true }));
    harness.setRoots([terminal("term-root", "ws-root", 600)]);
    harness.observer.setWatching("ws-root", true);
    await harness.observer.refreshNow();
    const ports = harness.snapshots[0]?.ports ?? [];
    expect(ports).toEqual([
      {
        port: 8080,
        address: "::1",
        source: "terminal",
        terminalId: "term-root",
        processName: "server",
        eligible: true,
      },
    ]);
  });

  test("keeps same-cwd sibling workspaces isolated", async () => {
    const harness = makeHarness();
    harness.setRoots([terminal("term-a", "ws-a", 100), terminal("term-b", "ws-b", 400)]);
    harness.observer.setWatching("ws-a", true);
    harness.observer.setWatching("ws-b", true);
    await harness.observer.refreshNow();

    const byWorkspace = new Map(harness.snapshots.map((s) => [s.workspaceId, s.ports]));
    expect(byWorkspace.get("ws-a")?.map((p) => p.port)).toEqual([8080, 9000]);
    expect(byWorkspace.get("ws-b")?.map((p) => p.port)).toEqual([3000]);
  });

  test("prefers the eligible bind when a port is duplicated across sockets", async () => {
    // Port 3000 listens on 0.0.0.0 (inode 333, ws-b child) and 127.0.0.1
    // (inode 444). Give ws-b both and expect the 127.0.0.1 row to win.
    const fixture = makeFixture();
    fixture.links["/proc/500/fd/6"] = "socket:[333]";
    fixture.links["/proc/500/fd/8"] = "socket:[444]";
    fixture.dirs["/proc/500/fd"] = ["0", "1", "2", "6", "8"];
    const harness = makeHarness(fixture);
    harness.setRoots([terminal("term-b", "ws-b", 400)]);
    harness.observer.setWatching("ws-b", true);
    await harness.observer.refreshNow();
    const ports = harness.snapshots[0]?.ports ?? [];
    expect(ports).toEqual([
      {
        port: 3000,
        address: "127.0.0.1",
        source: "terminal",
        terminalId: "term-b",
        processName: "node",
        eligible: true,
      },
    ]);
  });

  test("merges configured service ports into the workspace snapshot", async () => {
    const harness = makeHarness();
    harness.setRoots([terminal("term-a", "ws-a", 100)]);
    harness.setServices("ws-a", [{ port: 4000, scriptName: "web" }]);
    harness.observer.setWatching("ws-a", true);
    await harness.observer.refreshNow();

    const ports = harness.snapshots[0]?.ports ?? [];
    const servicePort = ports.find((port) => port.source === "service");
    expect(servicePort).toEqual({
      port: 4000,
      address: "127.0.0.1",
      source: "service",
      scriptName: "web",
      eligible: true,
    });
  });

  test("peekPorts returns the last collected rows", async () => {
    const harness = makeHarness();
    harness.setRoots([terminal("term-a", "ws-a", 100)]);
    harness.observer.setWatching("ws-a", true);
    await harness.observer.refreshNow();
    const peeked = harness.observer.peekPorts("ws-a");
    expect(peeked.map((p) => p.port)).toEqual([8080, 9000]);
  });

  test("exact non-loopback binds are marked ineligible", async () => {
    const harness = makeHarness();
    harness.setRoots([terminal("term-a", "ws-a", 100)]);
    harness.observer.setWatching("ws-a", true);
    await harness.observer.refreshNow();
    const rows = harness.observer.peekPorts("ws-a");
    const nonLoopback = rows.find((row) => row.address === "10.0.0.1");
    expect(nonLoopback?.eligible).toBe(false);
  });
});

function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
