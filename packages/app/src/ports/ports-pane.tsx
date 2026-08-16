import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/contexts/toast-context";
import { getDesktopHost } from "@/desktop/host";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeSnapshot, useHosts } from "@/runtime/host-runtime";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { resolveAppVersion } from "@/utils/app-version";
import { buildDesktopPortForwardingLease } from "./lease";
import {
  canOpenForward,
  formatForwardUrl,
  hasDisappearedObservation,
  mergeWorkspacePortRows,
  parseManualPort,
  selectWorkspacePortSnapshot,
  type WorkspacePortRow,
} from "./model";
import type {
  DesktopPortForward,
  DesktopPortForwardingLease,
  DesktopPortForwardingSnapshot,
  WorkspacePortProtocol,
} from "./types";
import { PortErrorAlert } from "./port-error-alert";

interface PortsPaneProps {
  active: boolean;
  serverId: string;
  workspaceId: string | null | undefined;
}

interface PendingPortAction {
  serverId: string;
  workspaceId: string;
  remotePort: number;
}

const MANUAL_PROTOCOL_OPTIONS: SegmentedControlOption<WorkspacePortProtocol>[] = [
  { value: "http", label: "HTTP" },
  { value: "https", label: "HTTPS" },
  { value: "tcp", label: "TCP" },
];

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function ownerLabel(ports: DesktopPortForwardingSnapshot["ports"], port: number): string {
  const observation = ports.find((candidate) => candidate.port === port);
  return observation?.serviceName ?? observation?.processName ?? observation?.terminalTitle ?? "—";
}

function statusVariant(status: DesktopPortForward["status"]): "success" | "error" | "muted" {
  if (status === "forwarded") return "success";
  if (status === "failed") return "error";
  return "muted";
}

type BlockingMessageKey =
  | "workspace.ports.noWorkspace"
  | "workspace.ports.hostDisconnected"
  | "workspace.ports.updateHost"
  | "workspace.ports.errors.desktopUpdate"
  | "workspace.ports.unsupportedConnection";

function resolveBlockingMessageKey(input: {
  hasWorkspace: boolean;
  hostOnline: boolean;
  forwardingSupported: boolean;
  desktopBridgeAvailable: boolean;
  leaseAvailable: boolean;
}): BlockingMessageKey | null {
  if (!input.hasWorkspace) return "workspace.ports.noWorkspace";
  if (!input.hostOnline) return "workspace.ports.hostDisconnected";
  if (!input.forwardingSupported) return "workspace.ports.updateHost";
  if (!input.desktopBridgeAvailable) return "workspace.ports.errors.desktopUpdate";
  if (!input.leaseAvailable) return "workspace.ports.unsupportedConnection";
  return null;
}

function portStateLabel(
  t: (key: string) => string,
  forward: DesktopPortForward | null,
  available: boolean,
): string {
  if (forward) return t(`workspace.ports.states.${forward.status}`);
  return t(available ? "workspace.ports.states.available" : "workspace.ports.states.unavailable");
}

function portStateVariant(
  forward: DesktopPortForward | null,
  available: boolean,
): "success" | "error" | "muted" {
  if (forward) return statusVariant(forward.status);
  return available ? "muted" : "error";
}

interface PortRowProps {
  row: WorkspacePortRow;
  ports: DesktopPortForwardingSnapshot["ports"];
  pendingPort: number | null;
  onCreate(
    remotePort: number,
    protocol: WorkspacePortProtocol,
    source: "observed" | "configured" | "manual",
  ): Promise<void>;
  onStop(forward: DesktopPortForward): Promise<void>;
  onCopy(forward: DesktopPortForward): Promise<void>;
  onOpen(forward: DesktopPortForward): Promise<void>;
}

function PortRow({ row, ports, pendingPort, onCreate, onStop, onCopy, onOpen }: PortRowProps) {
  const { t } = useTranslation();
  const forward = row.forward;
  const available = row.observation?.available !== false;
  const observationMissing = hasDisappearedObservation(row);
  const handleCreate = useCallback(
    () => onCreate(row.remotePort, row.protocol, row.observation?.source ?? "manual"),
    [onCreate, row.observation?.source, row.protocol, row.remotePort],
  );
  const handleStop = useCallback(
    () => (forward ? onStop(forward) : Promise.resolve()),
    [forward, onStop],
  );
  const handleCopy = useCallback(
    () => (forward ? onCopy(forward) : Promise.resolve()),
    [forward, onCopy],
  );
  const handleOpen = useCallback(
    () => (forward ? onOpen(forward) : Promise.resolve()),
    [forward, onOpen],
  );

  return (
    <View style={styles.portRow}>
      <View style={styles.portDetails}>
        <View style={styles.portTitleRow}>
          <Text style={styles.portNumber}>{row.remotePort}</Text>
          <StatusBadge
            label={portStateLabel(t, forward, available)}
            variant={portStateVariant(forward, available)}
          />
        </View>
        <Text style={styles.meta}>
          {ownerLabel(ports, row.remotePort)}
          {" · "}
          {row.bindAddress}
        </Text>
        {forward ? <Text style={styles.endpoint}>{formatForwardUrl(forward)}</Text> : null}
        {forward && forward.localPort !== forward.remotePort ? (
          <Text style={styles.meta}>
            {t("workspace.ports.fallbackPort", {
              requestedPort: forward.remotePort,
              localPort: forward.localPort,
            })}
          </Text>
        ) : null}
        {observationMissing ? (
          <Text style={styles.warningText}>{t("workspace.ports.observationMissing")}</Text>
        ) : null}
        {!available && row.observation?.unavailableReason ? (
          <Text style={styles.errorText}>{row.observation.unavailableReason}</Text>
        ) : null}
        {forward?.error ? (
          <Text style={styles.errorText}>
            {t("workspace.ports.errors.forward")} {forward.error}
          </Text>
        ) : null}
      </View>

      <View style={styles.actions}>
        {!forward ? (
          <Button
            size="xs"
            variant="secondary"
            disabled={!available || pendingPort !== null}
            loading={pendingPort === row.remotePort}
            onPress={handleCreate}
          >
            {t("workspace.ports.actions.forward")}
          </Button>
        ) : (
          <>
            {canOpenForward(forward) && (
              <Button size="xs" variant="ghost" onPress={handleOpen}>
                {t("workspace.ports.actions.open")}
              </Button>
            )}
            <Button size="xs" variant="ghost" onPress={handleCopy}>
              {t("workspace.ports.actions.copy")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={pendingPort !== null}
              loading={pendingPort === row.remotePort}
              onPress={handleStop}
            >
              {t("workspace.ports.actions.stop")}
            </Button>
          </>
        )}
      </View>
    </View>
  );
}

function PortNotices(props: {
  discoverySupported: boolean;
  loading: boolean;
  rowsLength: number;
  snapshot: DesktopPortForwardingSnapshot | null;
}) {
  const { t } = useTranslation();
  const disconnected =
    props.snapshot?.connectionStatus === "disconnected" ||
    props.snapshot?.connectionStatus === "failed";
  let alert = null;
  if (props.snapshot?.error) {
    alert = (
      <Alert
        variant="error"
        title={t("workspace.ports.errors.runtime")}
        description={props.snapshot.error}
      />
    );
  } else if (disconnected) {
    alert = <Alert variant="warning" title={t("workspace.ports.hostDisconnected")} />;
  } else if (!props.discoverySupported) {
    alert = <Alert variant="info" title={t("workspace.ports.discoveryUnavailable")} />;
  }
  return (
    <>
      {alert}
      {props.loading && props.rowsLength === 0 ? (
        <Text style={styles.empty}>{t("workspace.ports.loading")}</Text>
      ) : null}
      {!props.loading && props.discoverySupported && props.rowsLength === 0 ? (
        <Text style={styles.empty}>{t("workspace.ports.empty")}</Text>
      ) : null}
    </>
  );
}

function usePortWatch(input: {
  active: boolean;
  forwardingSupported: boolean;
  lease: DesktopPortForwardingLease | null;
  serverId: string;
  workspaceId: string | null | undefined;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<DesktopPortForwardingSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const retry = useCallback(() => setRetryVersion((version) => version + 1), []);
  const dismissError = useCallback(() => setError(null), []);

  useEffect(() => {
    const { active, forwardingSupported, lease, serverId, workspaceId } = input;
    if (!active || !workspaceId || !lease || !forwardingSupported) return;
    const bridge = getDesktopHost()?.ports;
    if (!bridge?.watch || !bridge.onStatus) return;
    const watch = bridge.watch;
    const onStatus = bridge.onStatus;

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    const handleStatus = (next: DesktopPortForwardingSnapshot) => {
      if (!cancelled && next.serverId === serverId && next.workspaceId === workspaceId) {
        setSnapshot(next);
      }
    };

    setError(null);
    setLoading(true);
    const startWatch = async () => {
      try {
        const cleanup = await onStatus(handleStatus);
        if (cancelled) cleanup();
        else unsubscribe = cleanup;
      } catch (watchError) {
        if (!cancelled) setError(messageFromError(watchError, t("workspace.ports.errors.watch")));
      }
      try {
        const next = await watch({ lease, workspaceId });
        if (!cancelled) setSnapshot(next);
      } catch (watchError) {
        if (!cancelled) setError(messageFromError(watchError, t("workspace.ports.errors.watch")));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void startWatch();

    return () => {
      cancelled = true;
      unsubscribe?.();
      void bridge
        .unwatch?.({ serverId, connectionId: lease.connectionId, workspaceId })
        .catch(() => undefined);
    };
  }, [input, retryVersion, t]);

  const scopedSnapshot = selectWorkspacePortSnapshot(snapshot, {
    serverId: input.serverId,
    workspaceId: input.workspaceId,
  });
  return { dismissError, error, loading, retry, setSnapshot, snapshot: scopedSnapshot };
}

export function PortsPane({ active, serverId, workspaceId }: PortsPaneProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const hosts = useHosts();
  const runtime = useHostRuntimeSnapshot(serverId);
  const forwardingSupported = useHostFeature(serverId, "workspacePortForwarding");
  const discoverySupported = useHostFeature(serverId, "workspacePortDiscovery");
  const host = hosts.find((candidate) => candidate.serverId === serverId);
  const lease = useMemo(
    () =>
      buildDesktopPortForwardingLease({
        host,
        activeConnectionId: runtime?.activeConnectionId,
        appVersion: resolveAppVersion(),
      }),
    [host, runtime?.activeConnectionId],
  );
  const watchInput = useMemo(
    () => ({ active, forwardingSupported, lease, serverId, workspaceId }),
    [active, forwardingSupported, lease, serverId, workspaceId],
  );
  const {
    dismissError: dismissWatchError,
    error: watchError,
    loading,
    retry: retryWatch,
    setSnapshot,
    snapshot,
  } = usePortWatch(watchInput);
  const [manualPort, setManualPort] = useState("");
  const [manualProtocol, setManualProtocol] = useState<WorkspacePortProtocol>("http");
  const [pendingAction, setPendingAction] = useState<PendingPortAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const dismissActionError = useCallback(() => setActionError(null), []);
  const pendingPort =
    pendingAction?.serverId === serverId && pendingAction.workspaceId === workspaceId
      ? pendingAction.remotePort
      : null;

  const createForward = useCallback(
    async (
      remotePort: number,
      protocol: WorkspacePortProtocol,
      source: "observed" | "configured" | "manual",
    ) => {
      if (!lease || !workspaceId) return;
      const create = getDesktopHost()?.ports?.create;
      if (!create) {
        setActionError(t("workspace.ports.errors.desktopUpdate"));
        return;
      }
      const action = { serverId, workspaceId, remotePort };
      setActionError(null);
      setPendingAction(action);
      try {
        const next = await create({
          lease,
          workspaceId,
          remotePort,
          protocol,
          source,
          requestedLocalPort: remotePort,
        });
        setSnapshot(next);
        setManualPort("");
      } catch (error) {
        setActionError(messageFromError(error, t("workspace.ports.errors.forward")));
      } finally {
        setPendingAction((current) => (current === action ? null : current));
      }
    },
    [lease, serverId, setSnapshot, t, workspaceId],
  );

  const stopForward = useCallback(
    async (forward: DesktopPortForward) => {
      const stop = getDesktopHost()?.ports?.stop;
      if (!stop) return;
      const action = { serverId, workspaceId: forward.workspaceId, remotePort: forward.remotePort };
      setActionError(null);
      setPendingAction(action);
      try {
        setSnapshot(await stop({ serverId, forwardId: forward.forwardId }));
      } catch (error) {
        setActionError(messageFromError(error, t("workspace.ports.errors.stop")));
      } finally {
        setPendingAction((current) => (current === action ? null : current));
      }
    },
    [serverId, setSnapshot, t],
  );

  const copyForward = useCallback(
    async (forward: DesktopPortForward) => {
      setActionError(null);
      try {
        await copyToClipboard(formatForwardUrl(forward));
        toast.copied(t("workspace.ports.endpoint"));
      } catch (error) {
        setActionError(messageFromError(error, t("workspace.ports.errors.copy")));
      }
    },
    [t, toast],
  );

  const openForward = useCallback(
    async (forward: DesktopPortForward) => {
      setActionError(null);
      try {
        await getDesktopHost()?.opener?.openUrl?.(formatForwardUrl(forward));
      } catch (error) {
        setActionError(messageFromError(error, t("workspace.ports.errors.open")));
      }
    },
    [t],
  );

  const parsedManualPort = parseManualPort(manualPort);
  const handleManualForward = useCallback(() => {
    if (parsedManualPort !== null) {
      return createForward(parsedManualPort, manualProtocol, "manual");
    }
    return Promise.resolve();
  }, [createForward, manualProtocol, parsedManualPort]);

  const blockingMessageKey = resolveBlockingMessageKey({
    hasWorkspace: Boolean(workspaceId),
    hostOnline: runtime?.connectionStatus === "online",
    forwardingSupported,
    desktopBridgeAvailable: Boolean(getDesktopHost()?.ports),
    leaseAvailable: Boolean(lease),
  });
  if (blockingMessageKey) return <PaneMessage text={t(blockingMessageKey)} />;

  const rows = mergeWorkspacePortRows({
    ports: snapshot?.ports ?? [],
    forwards: snapshot?.forwards ?? [],
  });

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <View style={styles.intro}>
        <Text style={styles.title}>{t("workspace.ports.title")}</Text>
        <Text style={styles.description}>{t("workspace.ports.description")}</Text>
      </View>

      <View style={styles.manualForm}>
        <View style={styles.manualRow}>
          <FormTextInput
            size="sm"
            value={manualPort}
            onChangeText={setManualPort}
            placeholder={t("workspace.ports.manualPlaceholder")}
            keyboardType="number-pad"
            accessibilityLabel={t("workspace.ports.manualPlaceholder")}
            style={styles.manualInput}
          />
          <Button
            size="sm"
            variant="default"
            disabled={parsedManualPort === null || pendingPort !== null}
            loading={parsedManualPort !== null && pendingPort === parsedManualPort}
            onPress={handleManualForward}
          >
            {t("workspace.ports.actions.forward")}
          </Button>
        </View>
        <View style={styles.protocolRow}>
          <Text style={styles.fieldLabel}>{t("workspace.ports.protocol")}</Text>
          <SegmentedControl
            size="sm"
            value={manualProtocol}
            options={MANUAL_PROTOCOL_OPTIONS}
            onValueChange={setManualProtocol}
          />
        </View>
      </View>

      {watchError ? (
        <PortErrorAlert
          testID="ports-watch-error"
          title={t("workspace.ports.errors.watch")}
          message={watchError}
          onRetry={retryWatch}
          onDismiss={dismissWatchError}
        />
      ) : null}

      {actionError ? (
        <PortErrorAlert
          testID="ports-action-error"
          title={t("workspace.ports.errors.runtime")}
          message={actionError}
          onDismiss={dismissActionError}
        />
      ) : null}

      <PortNotices
        discoverySupported={discoverySupported}
        loading={loading}
        rowsLength={rows.length}
        snapshot={snapshot}
      />

      {rows.map((row) => (
        <PortRow
          key={row.key}
          row={row}
          ports={snapshot?.ports ?? []}
          pendingPort={pendingPort}
          onCreate={createForward}
          onStop={stopForward}
          onCopy={copyForward}
          onOpen={openForward}
        />
      ))}
    </ScrollView>
  );
}

function PaneMessage({ text }: { text: string }) {
  return (
    <View style={styles.messageContainer}>
      <Text style={styles.messageText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: { flex: 1 },
  content: { padding: theme.spacing[4], gap: theme.spacing[3] },
  intro: { gap: theme.spacing[1] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  manualForm: { gap: theme.spacing[2] },
  manualRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  manualInput: { flex: 1 },
  protocolRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  fieldLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  empty: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, paddingVertical: 24 },
  portRow: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  portDetails: { gap: theme.spacing[1] },
  portTitleRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  portNumber: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    fontFamily: theme.fontFamily.mono,
  },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  endpoint: { color: theme.colors.foreground, fontSize: theme.fontSize.xs },
  warningText: { color: theme.colors.palette.amber[500], fontSize: theme.fontSize.xs },
  errorText: { color: theme.colors.statusDanger, fontSize: theme.fontSize.xs },
  actions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.spacing[1] },
  messageContainer: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  messageText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
