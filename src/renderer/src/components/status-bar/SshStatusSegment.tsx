import React, { useCallback, useMemo } from 'react'
import { AlertTriangle, Loader2, MonitorSmartphone, Server, ServerOff } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { RuntimeHostStatusRow, type RuntimeHostConnectionState } from './RuntimeHostStatusRow'
import { SshTargetStatusRow } from './SshTargetStatusRow'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime-shared-control-types'

function isConnecting(status: SshConnectionStatus): boolean {
  return ['connecting', 'deploying-relay', 'reconnecting'].includes(status)
}

type HostStatus = 'connected' | 'disconnected' | 'connecting'

function overallStatus(
  statuses: HostStatus[]
): 'connected' | 'partial' | 'disconnected' | 'connecting' {
  if (statuses.length === 0) {
    return 'disconnected'
  }
  if (statuses.every((s) => s === 'connected')) {
    return 'connected'
  }
  if (statuses.some((s) => s === 'connecting')) {
    return 'connecting'
  }
  if (statuses.some((s) => s === 'connected')) {
    return 'partial'
  }
  return 'disconnected'
}

function overallDotColor(
  status: 'connected' | 'partial' | 'disconnected' | 'connecting',
  connectedCount: number
): string {
  switch (status) {
    case 'connected':
      return 'bg-emerald-500'
    case 'partial':
      return connectedCount > 0 ? 'bg-emerald-500' : 'bg-muted-foreground/40'
    case 'connecting':
      return 'bg-yellow-500'
    case 'disconnected':
      return 'bg-muted-foreground/40'
  }
}

function connectedHostCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'host' : 'hosts'}`
}

function sshStatusForOverall(status: SshConnectionStatus): HostStatus {
  if (status === 'connected') {
    return 'connected'
  }
  return isConnecting(status) ? 'connecting' : 'disconnected'
}

function runtimeHostConnectionState({
  hasStatus,
  online,
  active,
  remoteControl
}: {
  hasStatus: boolean
  online: boolean
  active: boolean
  remoteControl?: RemoteRuntimeSharedConnectionDiagnostics | null
}): RuntimeHostConnectionState {
  if (!hasStatus) {
    return 'checking'
  }
  if (remoteControl?.state === 'reconnecting') {
    return 'reconnecting'
  }
  if (!online) {
    return 'disconnected'
  }
  if (remoteControl?.state === 'closed' && remoteControl.lastError) {
    return 'disconnected'
  }
  return active ? 'connected' : 'available'
}

function runtimeHostConnectionDetail(
  remoteControl?: RemoteRuntimeSharedConnectionDiagnostics | null
): string | undefined {
  if (!remoteControl) {
    return undefined
  }
  if (remoteControl.lastError) {
    return remoteControl.lastError
  }
  if (remoteControl.lastClose?.reason) {
    return translate(
      'auto.components.status.bar.SshStatusSegment.runtime_last_close_reason',
      'Closed: {{value0}}',
      { value0: remoteControl.lastClose.reason }
    )
  }
  if (remoteControl.state === 'reconnecting') {
    return translate(
      'auto.components.status.bar.SshStatusSegment.runtime_reconnect_attempt',
      'Attempt {{value0}}',
      { value0: String(remoteControl.reconnectAttempt + 1) }
    )
  }
  if (remoteControl.pendingRequestCount > 0 || remoteControl.subscriptionCount > 0) {
    return translate(
      'auto.components.status.bar.SshStatusSegment.runtime_channel_counts',
      '{{value0}} pending · {{value1}} streams',
      {
        value0: String(remoteControl.pendingRequestCount),
        value1: String(remoteControl.subscriptionCount)
      }
    )
  }
  return undefined
}

export function runtimeStatusForOverall(state: RuntimeHostConnectionState): HostStatus {
  switch (state) {
    case 'connected':
    case 'available':
      return 'connected'
    case 'checking':
    case 'reconnecting':
      return 'connecting'
    case 'disconnected':
      return 'disconnected'
  }
}

export function isConnectedRuntimeHostState(state: RuntimeHostConnectionState): boolean {
  return state === 'connected' || state === 'available'
}

export function SshStatusSegment({
  compact,
  iconOnly
}: {
  compact: boolean
  iconOnly: boolean
}): React.JSX.Element | null {
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const settings = useAppStore((s) => s.settings)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const switchRuntimeEnvironment = useAppStore((s) => s.switchRuntimeEnvironment)
  const setRuntimeEnvironmentStatus = useAppStore((s) => s.setRuntimeEnvironmentStatus)
  const hydrateRuntimeEnvironmentStatuses = useAppStore((s) => s.hydrateRuntimeEnvironmentStatuses)
  const refreshRuntimeEnvironmentStatus = useAppStore((s) => s.refreshRuntimeEnvironmentStatus)
  const remoteWorkspaceSyncStatusByTargetId = useAppStore(
    (s) => s.remoteWorkspaceSyncStatusByTargetId
  )
  const setActiveView = useAppStore((s) => s.setActiveView)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)

  const hostLabelOverrides = useMemo(() => getHostDisplayLabelOverrides(settings), [settings])
  const targets = Array.from(sshTargetLabels.entries()).map(([id, label]) => {
    const state = sshConnectionStates.get(id)
    return {
      id,
      label,
      status: (state?.status ?? 'disconnected') as SshConnectionStatus,
      syncStatus: remoteWorkspaceSyncStatusByTargetId[id]
    }
  })
  const runtimeHosts = runtimeEnvironments.map((environment) => {
    const statusEntry = runtimeStatusByEnvironmentId.get(environment.id)
    const override = hostLabelOverrides.get(toRuntimeExecutionHostId(environment.id))
    return {
      id: environment.id,
      label: override || environment.name || environment.id,
      hasStatus: Boolean(statusEntry),
      online: Boolean(statusEntry?.status),
      active: settings?.activeRuntimeEnvironmentId === environment.id,
      remoteControl: statusEntry?.status?.remoteControl ?? null
    }
  })
  const runtimeHostRows = runtimeHosts.map((host) => ({
    ...host,
    state: runtimeHostConnectionState(host)
  }))
  // Available remote servers are online even when they are not the active runtime.
  // Keep host health separate from the advanced active-server selection.
  const connectedRuntimeHosts = runtimeHostRows.filter((host) =>
    isConnectedRuntimeHostState(host.state)
  )
  const inactiveRuntimeHosts = runtimeHostRows.filter(
    (host) => !isConnectedRuntimeHostState(host.state)
  )
  const connectedTargets = targets.filter((target) => target.status === 'connected')
  const disconnectedTargets = targets.filter((target) => target.status !== 'connected')
  const connectRuntimeHost = useCallback(
    async (environmentId: string): Promise<void> => {
      const reachable = await refreshRuntimeEnvironmentStatus(environmentId, 5_000)
      if (!reachable) {
        toast.error(
          translate(
            'auto.components.status.bar.SshStatusSegment.runtime_connect_unavailable',
            'Remote host is not reachable'
          )
        )
        return
      }
      const switched = await switchRuntimeEnvironment(environmentId)
      if (switched) {
        recordFeatureInteraction('ssh')
      }
    },
    [recordFeatureInteraction, refreshRuntimeEnvironmentStatus, switchRuntimeEnvironment]
  )
  const disconnectRuntimeHost = useCallback(
    async (environmentId: string, isActive: boolean): Promise<void> => {
      try {
        if (isActive) {
          const switched = await switchRuntimeEnvironment(null)
          if (!switched) {
            return
          }
        }
        await window.api.runtimeEnvironments.disconnect({ selector: environmentId })
        setRuntimeEnvironmentStatus(environmentId, { status: null, checkedAt: Date.now() })
        recordFeatureInteraction('ssh')
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : translate(
                'auto.components.status.bar.SshStatusSegment.runtime_disconnect_failed',
                'Disconnect failed'
              )
        )
      }
    },
    [recordFeatureInteraction, setRuntimeEnvironmentStatus, switchRuntimeEnvironment]
  )

  if (targets.length === 0 && runtimeHosts.length === 0) {
    return null
  }

  const statuses = [
    ...targets.map((t) => sshStatusForOverall(t.status)),
    ...runtimeHostRows.map((host) => runtimeStatusForOverall(host.state))
  ]
  const overall = overallStatus(statuses)
  const connectedHostCount = statuses.filter((status) => status === 'connected').length
  const anyConnecting = overall === 'connecting'
  const syncProblem = targets.find(
    (t) => t.syncStatus?.phase === 'conflict' || t.syncStatus?.phase === 'error'
  )
  const syncProblemLabel = syncProblem
    ? syncProblem.syncStatus?.phase === 'conflict'
      ? 'Workspace conflict'
      : 'Workspace sync error'
    : null
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          void hydrateRuntimeEnvironmentStatuses()
          recordFeatureInteraction('ssh')
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label={translate(
            'auto.components.status.bar.SshStatusSegment.fdc57e9970',
            'Remote host connection status'
          )}
        >
          {iconOnly ? (
            <span className="inline-flex items-center gap-1">
              <span
                className={`inline-block size-2 rounded-full ${
                  syncProblem ? 'bg-destructive' : overallDotColor(overall, connectedHostCount)
                }`}
              />
              {syncProblem ? (
                <AlertTriangle className="size-3 text-destructive" />
              ) : anyConnecting ? (
                <Loader2 className="size-3 animate-spin text-muted-foreground" />
              ) : (
                <MonitorSmartphone className="size-3 text-muted-foreground" />
              )}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              {syncProblem ? (
                <AlertTriangle className="size-3 text-destructive" />
              ) : anyConnecting ? (
                <Loader2 className="size-3 animate-spin text-yellow-500" />
              ) : overall === 'connected' ? (
                <Server className="size-3 text-emerald-500" />
              ) : overall === 'partial' ? (
                <Server className="size-3 text-muted-foreground" />
              ) : (
                <ServerOff className="size-3 text-muted-foreground" />
              )}
              {!compact && (
                <span className="text-[11px]">
                  <span className={syncProblem ? 'text-destructive' : 'text-muted-foreground'}>
                    {syncProblemLabel ??
                      (anyConnecting ? 'Connecting…' : connectedHostCountLabel(connectedHostCount))}
                  </span>
                </span>
              )}
              <span
                className={`inline-block size-1.5 rounded-full ${
                  syncProblem ? 'bg-destructive' : overallDotColor(overall, connectedHostCount)
                }`}
              />
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[min(20rem,calc(100vw-1rem))]"
      >
        <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          {translate('auto.components.status.bar.SshStatusSegment.6e8a9a4242', 'Remote Hosts')}
        </div>
        {connectedRuntimeHosts.map((host) => (
          <RuntimeHostStatusRow
            key={host.id}
            label={host.label}
            state={host.state}
            detail={runtimeHostConnectionDetail(host.remoteControl)}
            onConnect={() => connectRuntimeHost(host.id)}
            onDisconnect={() => disconnectRuntimeHost(host.id, host.active)}
          />
        ))}
        {connectedTargets.map((t) => (
          <SshTargetStatusRow
            key={t.id}
            targetId={t.id}
            label={t.label}
            status={t.status}
            syncStatus={t.syncStatus}
          />
        ))}
        {inactiveRuntimeHosts.map((host) => (
          <RuntimeHostStatusRow
            key={host.id}
            label={host.label}
            state={host.state}
            detail={runtimeHostConnectionDetail(host.remoteControl)}
            onConnect={() => connectRuntimeHost(host.id)}
            onDisconnect={() => disconnectRuntimeHost(host.id, host.active)}
          />
        ))}
        {disconnectedTargets.map((t) => (
          <SshTargetStatusRow
            key={t.id}
            targetId={t.id}
            label={t.label}
            status={t.status}
            syncStatus={t.syncStatus}
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            recordFeatureInteraction('ssh')
            openSettingsTarget({ pane: 'servers', repoId: null })
            setActiveView('settings')
          }}
        >
          {translate(
            'auto.components.status.bar.SshStatusSegment.3ad70e0365',
            'Manage Remote Hosts…'
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
