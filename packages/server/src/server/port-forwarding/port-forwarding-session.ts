import type pino from "pino";
import type { Socket } from "node:net";
import { encodeTunnelFrame, type TunnelFrame } from "@getpaseo/protocol/binary-frames/index";
import type {
  SessionInboundMessage,
  SessionOutboundMessage,
  WorkspacePortObservation,
  WorkspacePortForwardCreateRequest,
  WorkspacePortForwardDeleteRequest,
  WorkspacePortUnwatchRequest,
  WorkspacePortWatchRequest,
} from "../messages.js";
import {
  PortForwardService,
  type PortForwardServiceLimits,
  type WorkspaceRef,
} from "./forward-service.js";
import { WorkspacePortObserver, type ObservedPort } from "../port-observation/observer.js";
import type { TerminalRootPid } from "../../terminal/terminal-manager.js";

export type PortForwardingInboundMessage = Extract<
  SessionInboundMessage,
  {
    type:
      | "workspace.port.watch.request"
      | "workspace.port.unwatch.request"
      | "workspace.port_forward.create.request"
      | "workspace.port_forward.delete.request";
  }
>;

export interface PortForwardingSessionHost {
  emit(message: SessionOutboundMessage): void;
  emitBinary(frame: Uint8Array): void;
}

export interface PortForwardingSessionOptions {
  host: PortForwardingSessionHost;
  getWorkspace: (workspaceId: string) => Promise<WorkspaceRef | null>;
  listTerminalRootPids: () => TerminalRootPid[];
  listServicePorts: (workspaceId: string) => Promise<Array<{ port: number; scriptName: string }>>;
  resolveTerminalTitle?: (terminalId: string) => string | undefined;
  subscribeTerminalsChanged?: (listener: () => void) => () => void;
  logger: pino.Logger;
  connectTcp?: (host: string, port: number) => Promise<Socket>;
  limits?: Partial<PortForwardServiceLimits>;
}

function toObservation(
  input: ObservedPort,
  resolveTerminalTitle?: (id: string) => string | undefined,
): WorkspacePortObservation {
  return {
    port: input.port,
    bindAddress: input.address,
    source: input.source === "service" ? "configured" : "observed",
    available: input.eligible,
    unavailableReason: input.eligible ? null : "Remote bind is not loopback",
    // Display hint only; the tunnel is raw TCP either way. Development ports
    // default to HTTP per the fork plan.
    protocol: "http",
    ...(input.terminalId ? { terminalId: input.terminalId } : {}),
    ...(input.terminalId && resolveTerminalTitle?.(input.terminalId)
      ? { terminalTitle: resolveTerminalTitle(input.terminalId) }
      : {}),
    ...(input.processName ? { processName: input.processName } : {}),
    ...(input.scriptName ? { serviceName: input.scriptName } : {}),
  };
}

/**
 * A client's workspace port surface: observation subscription (Ports tab),
 * forward lifecycle, and tunnel stream frames. Owns the observer and the
 * forward service; both tear down with the session.
 */
export class PortForwardingSession {
  private readonly host: PortForwardingSessionHost;
  private readonly observer: WorkspacePortObserver;
  private readonly forwards: PortForwardService;
  private readonly options: PortForwardingSessionOptions;
  private disposed = false;

  constructor(options: PortForwardingSessionOptions) {
    this.options = options;
    this.host = options.host;
    this.forwards = new PortForwardService({
      getWorkspace: options.getWorkspace,
      sendFrame: (frame) => {
        if (this.disposed) return;
        this.host.emitBinary(encodeTunnelFrame(frame));
      },
      logger: options.logger,
      ...(options.connectTcp ? { connectTcp: options.connectTcp } : {}),
      limits: options.limits,
    });
    this.observer = new WorkspacePortObserver({
      listTerminalRootPids: options.listTerminalRootPids,
      listServicePorts: options.listServicePorts,
      subscribeTerminalsChanged: options.subscribeTerminalsChanged,
    });
    this.observer.setOnSnapshot((snapshot) => {
      if (this.disposed) return;
      this.host.emit({
        type: "workspace.port.update",
        payload: {
          workspaceId: snapshot.workspaceId,
          ports: snapshot.ports.map((port) => toObservation(port, options.resolveTerminalTitle)),
        },
      });
    });
    this.observer.start();
  }

  handleMessage(message: PortForwardingInboundMessage): Promise<void> {
    switch (message.type) {
      case "workspace.port.watch.request":
        return this.handleWatchRequest(message);
      case "workspace.port.unwatch.request":
        return this.handleUnwatchRequest(message);
      case "workspace.port_forward.create.request":
        return this.handleCreateForwardRequest(message);
      case "workspace.port_forward.delete.request":
        this.handleDeleteForwardRequest(message);
        return Promise.resolve();
    }
  }

  /** Route one already-decoded tunnel frame (central demux path). */
  handleTunnelFrame(frame: TunnelFrame): void {
    if (this.disposed) return;
    this.forwards.handleFrame(frame);
  }

  /** Close forwards for a workspace (archive/removal). */
  deleteForwardsForWorkspace(workspaceId: string): void {
    for (const forward of this.forwards.listForwards()) {
      if (forward.workspaceId === workspaceId) {
        this.forwards.deleteForward(forward.forwardId);
      }
    }
    this.observer.setWatching(workspaceId, false);
    this.syncForwardActivity();
  }

  /**
   * The trusted transport lost its last socket: revoke every forward id and
   * close every stream so no disconnected authorization survives. The client
   * recreates forwards after reconnecting.
   */
  revokeForTransportLoss(): void {
    this.forwards.revokeAllForTransportLoss();
    this.observer.setForwardActive(false);
  }

  dispose(): void {
    if (this.disposed) return;
    // Forwards first: their session_cleanup close frames still go through the
    // live sendFrame callback, which the disposed guard would drop.
    this.forwards.dispose();
    this.observer.dispose();
    this.disposed = true;
  }

  private async handleWatchRequest(message: WorkspacePortWatchRequest): Promise<void> {
    const workspace = await this.options.getWorkspace(message.workspaceId);
    if (!workspace) {
      this.host.emit({
        type: "workspace.port.watch.response",
        payload: {
          workspaceId: message.workspaceId,
          success: false,
          error: "Workspace not found",
          requestId: message.requestId,
        },
      });
      return;
    }
    if (workspace.archivedAt !== null) {
      this.host.emit({
        type: "workspace.port.watch.response",
        payload: {
          workspaceId: message.workspaceId,
          success: false,
          error: "Workspace is archived",
          requestId: message.requestId,
        },
      });
      return;
    }
    this.observer.setWatching(message.workspaceId, true);
    // The observer emits workspace.port.update with the first snapshot; the
    // response only acknowledges the subscription.
    await this.observer.refreshNow();
    this.host.emit({
      type: "workspace.port.watch.response",
      payload: {
        workspaceId: message.workspaceId,
        success: true,
        error: null,
        requestId: message.requestId,
      },
    });
  }

  private async handleUnwatchRequest(message: WorkspacePortUnwatchRequest): Promise<void> {
    this.observer.setWatching(message.workspaceId, false);
    this.host.emit({
      type: "workspace.port.unwatch.response",
      payload: {
        workspaceId: message.workspaceId,
        success: true,
        error: null,
        requestId: message.requestId,
      },
    });
  }

  private async handleCreateForwardRequest(
    message: WorkspacePortForwardCreateRequest,
  ): Promise<void> {
    const result = await this.forwards.createForward({
      workspaceId: message.workspaceId,
      port: message.port,
      host: this.resolveForwardHost(message),
    });
    this.syncForwardActivity();
    if (result.ok) {
      this.host.emit({
        type: "workspace.port_forward.create.response",
        payload: {
          workspaceId: result.forward.workspaceId,
          port: result.forward.port,
          forwardId: result.forward.forwardId,
          error: null,
          requestId: message.requestId,
        },
      });
      return;
    }
    this.host.emit({
      type: "workspace.port_forward.create.response",
      payload: {
        workspaceId: message.workspaceId,
        port: message.port,
        forwardId: null,
        error: result.message,
        requestId: message.requestId,
      },
    });
  }

  private handleDeleteForwardRequest(message: WorkspacePortForwardDeleteRequest): void {
    const forward = this.forwards
      .listForwards()
      .find((entry) => entry.forwardId === message.forwardId);
    if (!forward || forward.workspaceId !== message.workspaceId) {
      this.host.emit({
        type: "workspace.port_forward.delete.response",
        payload: {
          workspaceId: message.workspaceId,
          forwardId: message.forwardId,
          success: false,
          error: "Forward not found",
          requestId: message.requestId,
        },
      });
      return;
    }
    this.forwards.deleteForward(message.forwardId);
    this.syncForwardActivity();
    this.host.emit({
      type: "workspace.port_forward.delete.response",
      payload: {
        workspaceId: message.workspaceId,
        forwardId: message.forwardId,
        success: true,
        error: null,
        requestId: message.requestId,
      },
    });
  }

  /**
   * Observed targets may bind only loopback addresses; use the observed bind
   * (for example a ::1-only service) so the connection reaches it, otherwise
   * default to 127.0.0.1. The service still rejects anything non-loopback.
   */
  private resolveForwardHost(message: WorkspacePortForwardCreateRequest): string {
    if (message.source !== "observed") {
      return "127.0.0.1";
    }
    const observed = this.observer
      .peekPorts(message.workspaceId)
      .find((port) => port.port === message.port);
    if (!observed) {
      return "127.0.0.1";
    }
    if (observed.address === "::1" || observed.address === "::") {
      return "::1";
    }
    return "127.0.0.1";
  }

  private syncForwardActivity(): void {
    this.observer.setForwardActive(this.forwards.hasActiveForwards);
  }
}
