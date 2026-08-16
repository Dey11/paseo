import type { TerminalRootPid } from "../../terminal/terminal-manager.js";
import {
  collectDescendantPids,
  createNodeProcAdapter,
  isLoopbackOrWildcardAddress,
  parseListeningSocketsV4,
  parseListeningSocketsV6,
  parseProcStat,
  parseSocketFdLink,
  toPpidMap,
  type ListeningSocket,
  type ProcAdapter,
  type ProcProcessStat,
} from "./proc.js";

/**
 * Workspace-scoped listening-port observation. One instance per daemon
 * session; it polls /proc only while the session watches Ports or has an
 * active forward, refreshes eagerly on terminal lifecycle signals, and emits
 * a stable deduplicated per-workspace snapshot.
 */

export interface ObservedPort {
  port: number;
  address: string;
  source: "terminal" | "service";
  terminalId?: string;
  processName?: string;
  scriptName?: string;
  eligible: boolean;
}

export interface WorkspacePortSnapshot {
  workspaceId: string;
  ports: ObservedPort[];
}

export interface ServicePortEntry {
  port: number;
  scriptName: string;
}

export type TimerHandle = ReturnType<typeof setTimeout> | number;

export interface TimerAdapter {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const nodeTimerAdapter: TimerAdapter = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle);
  },
};

export interface WorkspacePortObserverDeps {
  proc?: ProcAdapter;
  listTerminalRootPids: () => TerminalRootPid[];
  listServicePorts: (workspaceId: string) => Promise<ServicePortEntry[]>;
  subscribeTerminalsChanged?: (listener: () => void) => () => void;
  pollIntervalMs?: number;
  refreshDebounceMs?: number;
  timers?: TimerAdapter;
  onRefresh?: () => void;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_REFRESH_DEBOUNCE_MS = 250;

export class WorkspacePortObserver {
  private readonly proc: ProcAdapter;
  private readonly listTerminalRootPids: () => TerminalRootPid[];
  private readonly listServicePorts: (workspaceId: string) => Promise<ServicePortEntry[]>;
  private readonly subscribeTerminalsChanged?: (listener: () => void) => () => void;
  private readonly pollIntervalMs: number;
  private readonly refreshDebounceMs: number;
  private readonly timers: TimerAdapter;
  private readonly depsOnRefresh?: () => void;

  private readonly watching = new Set<string>();
  private forwardActive = false;
  private started = false;
  private pollTimer: TimerHandle | null = null;
  private refreshTimer: TimerHandle | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private readonly lastSnapshotByWorkspace = new Map<string, string>();
  private readonly lastPortsByWorkspace = new Map<string, ObservedPort[]>();
  private unsubscribeTerminalsChanged: (() => void) | null = null;

  private onSnapshot: (snapshot: WorkspacePortSnapshot) => void = () => {};

  constructor(deps: WorkspacePortObserverDeps) {
    this.proc = deps.proc ?? createNodeProcAdapter();
    this.listTerminalRootPids = deps.listTerminalRootPids;
    this.listServicePorts = deps.listServicePorts;
    this.subscribeTerminalsChanged = deps.subscribeTerminalsChanged;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.refreshDebounceMs = deps.refreshDebounceMs ?? DEFAULT_REFRESH_DEBOUNCE_MS;
    this.timers = deps.timers ?? nodeTimerAdapter;
    this.depsOnRefresh = deps.onRefresh;
  }

  setOnSnapshot(listener: (snapshot: WorkspacePortSnapshot) => void): void {
    this.onSnapshot = listener;
  }

  setWatching(workspaceId: string, watching: boolean): void {
    if (watching) {
      this.watching.add(workspaceId);
    } else {
      this.watching.delete(workspaceId);
      this.lastSnapshotByWorkspace.delete(workspaceId);
      this.lastPortsByWorkspace.delete(workspaceId);
    }
    this.syncActivity();
  }

  setForwardActive(active: boolean): void {
    this.forwardActive = active;
    this.syncActivity();
  }

  /** Begin lifecycle management; safe to call once per session. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.subscribeTerminalsChanged) {
      this.unsubscribeTerminalsChanged = this.subscribeTerminalsChanged(() => {
        this.scheduleRefresh();
      });
    }
  }

  stop(): void {
    this.started = false;
    if (this.pollTimer !== null) {
      this.timers.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.refreshTimer !== null) {
      this.timers.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.unsubscribeTerminalsChanged?.();
    this.unsubscribeTerminalsChanged = null;
  }

  /** Stop polling and drop all observation state. */
  dispose(): void {
    this.stop();
    this.watching.clear();
    this.forwardActive = false;
    this.lastSnapshotByWorkspace.clear();
  }

  private syncActivity(): void {
    if (!this.started) return;
    const active = this.watching.size > 0 || this.forwardActive;
    if (active && this.pollTimer === null) {
      this.scheduleRefresh();
      this.schedulePoll();
    } else if (!active) {
      if (this.pollTimer !== null) {
        this.timers.clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }
      if (this.refreshTimer !== null) {
        this.timers.clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
      }
    }
  }

  private schedulePoll(): void {
    if (!this.started || this.pollTimer !== null) return;
    this.pollTimer = this.timers.setTimeout(() => {
      this.pollTimer = null;
      this.scheduleRefresh();
      this.schedulePoll();
    }, this.pollIntervalMs);
  }

  private scheduleRefresh(): void {
    if (!this.started || this.refreshTimer !== null || this.refreshInFlight !== null) return;
    this.refreshTimer = this.timers.setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshNow();
    }, this.refreshDebounceMs);
  }

  /** Last collected ports for a watched workspace (empty when never observed). */
  peekPorts(workspaceId: string): ObservedPort[] {
    return this.lastPortsByWorkspace.get(workspaceId) ?? [];
  }

  /** Run one full snapshot pass and emit changed workspaces. */
  refreshNow(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.collectAndEmit().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async collectAndEmit(): Promise<void> {
    this.depsOnRefresh?.();
    if (this.watching.size === 0) return;

    const tcp4Content = await this.readOptional("/proc/net/tcp");
    const tcp6Content = await this.readOptional("/proc/net/tcp6");
    const listeningSockets: ListeningSocket[] = [
      ...(tcp4Content ? parseListeningSocketsV4(tcp4Content) : []),
      ...(tcp6Content ? parseListeningSocketsV6(tcp6Content) : []),
    ];
    const socketByInode = new Map<string, ListeningSocket>();
    for (const socket of listeningSockets) {
      socketByInode.set(socket.inode, socket);
    }

    const statByPid = await this.readProcessStats();
    const ppidByPid = toPpidMap([...statByPid.values()]);

    const rowsByWorkspace = new Map<string, Map<number, ObservedPort>>();
    for (const terminal of this.listTerminalRootPids()) {
      if (!this.watching.has(terminal.workspaceId)) continue;
      const rows = this.rowsForWorkspace(terminal.workspaceId, rowsByWorkspace);
      // The root pid itself is part of the lineage: an exec-replaced shell
      // (the terminal command runs as the PTY root) can own the listener.
      const candidates = [terminal.rootPid, ...collectDescendantPids(terminal.rootPid, ppidByPid)];
      for (const pid of candidates) {
        const stat = statByPid.get(pid);
        const fdEntries = await this.readDirOptional(`/proc/${pid}/fd`);
        for (const fd of fdEntries) {
          const link = await this.readLinkOptional(`/proc/${pid}/fd/${fd}`);
          const inode = link === null ? null : parseSocketFdLink(link);
          if (inode === null) continue;
          const socket = socketByInode.get(inode);
          if (!socket) continue;
          upsertPortRow(rows, {
            port: socket.port,
            address: socket.address,
            source: "terminal",
            ...(stat ? { processName: stat.comm } : {}),
            terminalId: terminal.terminalId,
            eligible: isLoopbackOrWildcardAddress(socket.address),
          });
        }
      }
    }

    for (const workspaceId of this.watching) {
      const rows = this.rowsForWorkspace(workspaceId, rowsByWorkspace);
      let services: ServicePortEntry[];
      try {
        services = await this.listServicePorts(workspaceId);
      } catch {
        // A failing service-port source (e.g. workspace scripts unavailable on
        // this daemon) must not kill the whole observation pass.
        services = [];
      }
      for (const service of services) {
        upsertPortRow(rows, {
          port: service.port,
          address: "127.0.0.1",
          source: "service",
          scriptName: service.scriptName,
          eligible: true,
        });
      }
    }

    for (const workspaceId of this.watching) {
      const rows = rowsByWorkspace.get(workspaceId);
      const ports = rows ? [...rows.values()].sort((a, b) => a.port - b.port) : [];
      this.emitIfChanged({ workspaceId, ports });
    }
  }

  private rowsForWorkspace(
    workspaceId: string,
    rowsByWorkspace: Map<string, Map<number, ObservedPort>>,
  ): Map<number, ObservedPort> {
    let rows = rowsByWorkspace.get(workspaceId);
    if (!rows) {
      rows = new Map();
      rowsByWorkspace.set(workspaceId, rows);
    }
    return rows;
  }

  private emitIfChanged(snapshot: WorkspacePortSnapshot): void {
    const serialized = JSON.stringify(snapshot.ports);
    if (this.lastSnapshotByWorkspace.get(snapshot.workspaceId) === serialized) {
      return;
    }
    this.lastSnapshotByWorkspace.set(snapshot.workspaceId, serialized);
    this.lastPortsByWorkspace.set(snapshot.workspaceId, snapshot.ports);
    this.onSnapshot(snapshot);
  }

  private async readProcessStats(): Promise<Map<number, ProcProcessStat>> {
    const entries = await this.readDirOptional("/proc");
    const statByPid = new Map<number, ProcProcessStat>();
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const content = await this.readOptional(`/proc/${entry}/stat`);
      if (content === null) continue;
      const parsed = parseProcStat(content);
      if (parsed) statByPid.set(parsed.pid, parsed);
    }
    return statByPid;
  }

  private async readOptional(path: string): Promise<string | null> {
    try {
      return await this.proc.readFile(path);
    } catch {
      return null;
    }
  }

  private async readDirOptional(path: string): Promise<string[]> {
    try {
      return await this.proc.readDir(path);
    } catch {
      return [];
    }
  }

  private async readLinkOptional(path: string): Promise<string | null> {
    try {
      return await this.proc.readLink(path);
    } catch {
      return null;
    }
  }
}

function upsertPortRow(rows: Map<number, ObservedPort>, row: ObservedPort): void {
  const existing = rows.get(row.port);
  if (!existing) {
    rows.set(row.port, row);
    return;
  }
  // Duplicate socket for the same port inside one workspace: prefer the
  // eligible bind (loopback/wildcard) over an exact non-loopback one; the
  // first terminal-owned row wins otherwise.
  if (!existing.eligible && row.eligible) {
    rows.set(row.port, row);
  }
}
