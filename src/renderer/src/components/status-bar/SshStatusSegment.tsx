import React, { useCallback, useId, useMemo } from 'react'
import { AlertTriangle, Loader2, MonitorSmartphone, Server, ServerOff } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import {
  isRuntimeOwnedSshTargetId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import { isUserManagedRuntimeEnvironment } from '../../../../shared/runtime-environments'
import {
  RuntimeHostStatusRow,
  runtimeDotColor,
  runtimeStatusLabel,
  runtimeStatusTone
} from './RuntimeHostStatusRow'
import {
  connectedHostCountLabel,
  connectingHostsLabel,
  workspaceSyncProblemLabel
} from './ssh-status-segment-copy'
import { SshTargetStatusRow } from './SshTargetStatusRow'
import {
  connectRuntimeEnvironmentAndRecordStatus,
  connectRuntimeHostForNavigation
} from './runtime-environment-explicit-connect'
import {
  overallDotColor,
  overallStatus,
  runtimeHostConnectionDetail,
  sshStatusForOverall
} from './remote-host-connection-status'
import {
  isConnectedRuntimeHostState,
  runtimeHostConnectionStateForEntry,
  runtimeStatusForOverall
} from '@/runtime/runtime-host-connection-state'
import { useActiveServerSelection } from './use-active-server-selection'
import { LOCAL_RUNTIME_VALUE } from '../settings/runtime-environment-selection'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'

export function SshStatusSegment({
  compact,
  iconOnly
}: {
  compact: boolean
  iconOnly: boolean
}): React.JSX.Element | null {
  const selection = useActiveServerSelection()
  const statusId = useId()
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const settings = useAppStore((s) => s.settings)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const readRuntimeHostStatusSnapshots = useAppStore((s) => s.readRuntimeHostStatusSnapshots)
  const hydrateRuntimeEnvironmentStatuses = useAppStore((s) => s.hydrateRuntimeEnvironmentStatuses)
  const remoteWorkspaceSyncStatusByTargetId = useAppStore(
    (s) => s.remoteWorkspaceSyncStatusByTargetId
  )
  const setActiveView = useAppStore((s) => s.setActiveView)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)

  const hostLabelOverrides = useMemo(() => getHostDisplayLabelOverrides(settings), [settings])
  const targets = Array.from(sshTargetLabels.entries())
    // Why: runtime-owned (per-workspace-env) SSH targets are hidden — never list them
    // as a user-facing SSH host in the status bar.
    .filter(([id]) => !isRuntimeOwnedSshTargetId(id))
    .map(([id, label]) => {
      const state = sshConnectionStates.get(id)
      return {
        id,
        label,
        status: (state?.status ?? 'disconnected') as SshConnectionStatus,
        syncStatus: remoteWorkspaceSyncStatusByTargetId[id]
      }
    })
  const runtimeHosts = runtimeEnvironments
    .filter(isUserManagedRuntimeEnvironment)
    .map((environment) => {
      const statusEntry = runtimeStatusByEnvironmentId.get(environment.id)
      const override = hostLabelOverrides.get(toRuntimeExecutionHostId(environment.id))
      return {
        id: environment.id,
        label: override || environment.name || environment.id,
        snapshot: statusEntry?.snapshot,
        status: statusEntry?.status ?? null,
        active: settings?.activeRuntimeEnvironmentId === environment.id,
        remoteControl: statusEntry?.remoteControl ?? statusEntry?.status?.remoteControl ?? null
      }
    })
  const runtimeHostRows = runtimeHosts.map((host) => ({
    ...host,
    state: runtimeHostConnectionStateForEntry(runtimeStatusByEnvironmentId.get(host.id))
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
      const store = useAppStore.getState()
      const reachable = await connectRuntimeHostForNavigation({
        environmentId,
        refreshStatus: connectRuntimeEnvironmentAndRecordStatus,
        fetchRepos: store.fetchRuntimeEnvironmentRepos,
        fetchWorktrees: store.fetchWorktrees,
        fetchLineage: store.fetchWorktreeLineage
      })
      if (!reachable) {
        toast.error(
          translate(
            'auto.components.status.bar.SshStatusSegment.runtime_connect_unavailable',
            'Remote host is not reachable'
          )
        )
        return
      }
      recordFeatureInteraction('ssh')
    },
    [recordFeatureInteraction]
  )
  const disconnectRuntimeHost = useCallback(
    async (environmentId: string): Promise<void> => {
      try {
        await window.api.runtimeEnvironments.disconnect({ selector: environmentId })
        await readRuntimeHostStatusSnapshots()
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
    [recordFeatureInteraction, readRuntimeHostStatusSnapshots]
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
    ? workspaceSyncProblemLabel(syncProblem.syncStatus?.phase)
    : null
  const activeHost = runtimeHostRows.find((host) => host.active)
  const activeLabel = settings?.activeRuntimeEnvironmentId
    ? (activeHost?.label ?? settings.activeRuntimeEnvironmentId)
    : selection.localLabel
  const activeState =
    activeHost?.state ?? (settings?.activeRuntimeEnvironmentId ? 'disconnected' : 'connected')
  const activeStatus =
    selection.enabled && activeState !== 'connected' ? runtimeStatusLabel(activeState) : null
  const triggerLabel = selection.enabled
    ? `${translate('auto.components.status.bar.SshStatusSegment.6e8a9a4242', 'Remote Hosts')}: ${activeLabel}`
    : translate(
        'auto.components.status.bar.SshStatusSegment.fdc57e9970',
        'Remote host connection status'
      )
  const dotColor = selection.enabled
    ? runtimeDotColor(activeState)
    : overallDotColor(overall, connectedHostCount)
  const showConnecting =
    selection.switching ||
    (selection.enabled
      ? activeHost?.state === 'checking' || activeHost?.state === 'reconnecting'
      : anyConnecting)
  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (open) {
          void hydrateRuntimeEnvironmentStatuses()
          recordFeatureInteraction('ssh')
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
              {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
              aria-label={triggerLabel}
              aria-describedby={activeStatus ? statusId : undefined}
              aria-busy={selection.switching}
              disabled={selection.switching}
            >
              {iconOnly ? (
                <span className="inline-flex items-center gap-1">
                  <span
                    className={`inline-block size-2 rounded-full ${
                      syncProblem ? 'bg-destructive' : dotColor
                    }`}
                  />
                  {syncProblem ? (
                    <AlertTriangle className="size-3 text-destructive" />
                  ) : showConnecting ? (
                    <Loader2 className="size-3 animate-spin text-muted-foreground" />
                  ) : (
                    <MonitorSmartphone className="size-3 text-muted-foreground" />
                  )}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  {syncProblem ? (
                    <AlertTriangle className="size-3 text-destructive" />
                  ) : showConnecting ? (
                    <Loader2 className="size-3 animate-spin text-yellow-500" />
                  ) : selection.enabled && activeState === 'disconnected' ? (
                    <ServerOff className="size-3 text-destructive" />
                  ) : selection.enabled ? (
                    <Server className="size-3 text-muted-foreground" />
                  ) : overall === 'connected' ? (
                    <Server className="size-3 text-emerald-500" />
                  ) : overall === 'partial' ? (
                    <Server className="size-3 text-muted-foreground" />
                  ) : (
                    <ServerOff className="size-3 text-muted-foreground" />
                  )}
                  {(selection.enabled || !compact) && (
                    <span className="max-w-32 truncate text-[11px]">
                      <span className={syncProblem ? 'text-destructive' : 'text-muted-foreground'}>
                        {selection.enabled
                          ? activeLabel
                          : (syncProblemLabel ??
                            (anyConnecting
                              ? connectingHostsLabel()
                              : connectedHostCountLabel(connectedHostCount)))}
                      </span>
                    </span>
                  )}
                  <span
                    className={`inline-block size-1.5 rounded-full ${
                      syncProblem ? 'bg-destructive' : dotColor
                    }`}
                  />
                </span>
              )}
              {activeStatus && (
                <span
                  id={statusId}
                  className={cn(
                    'shrink-0 text-[11px]',
                    iconOnly ? 'sr-only' : runtimeStatusTone(activeState)
                  )}
                >
                  {iconOnly ? activeStatus : `· ${activeStatus}`}
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        {iconOnly ? (
          <TooltipContent side="top" sideOffset={6}>
            {activeStatus ? `${triggerLabel} · ${activeStatus}` : triggerLabel}
          </TooltipContent>
        ) : null}
      </Tooltip>
      <DropdownMenuContent
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        side="top"
        align="start"
        sideOffset={8}
        className="w-[min(20rem,calc(100vw-1rem))]"
      >
        <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          {translate('auto.components.status.bar.SshStatusSegment.6e8a9a4242', 'Remote Hosts')}
        </div>
        <DropdownMenuRadioGroup
          value={selection.activeValue}
          onValueChange={(value) => void selection.switchServer(value)}
        >
          {selection.enabled ? (
            <>
              <DropdownMenuLabel>
                {translate(
                  'auto.components.settings.RuntimeEnvironmentsPane.64b6bea541',
                  'Active Server'
                )}
              </DropdownMenuLabel>
              <DropdownMenuRadioItem value={LOCAL_RUNTIME_VALUE} disabled={selection.switching}>
                {selection.localLabel}
              </DropdownMenuRadioItem>
            </>
          ) : null}
          {[...connectedRuntimeHosts, ...inactiveRuntimeHosts].map((host) => (
            <RuntimeHostStatusRow
              key={host.id}
              label={host.label}
              state={host.state}
              detail={runtimeHostConnectionDetail(host.remoteControl)}
              diagnostics={host.remoteControl}
              selection={
                selection.enabled ? { value: host.id, disabled: selection.switching } : undefined
              }
              onConnect={() => connectRuntimeHost(host.id)}
              onDisconnect={() => disconnectRuntimeHost(host.id)}
            />
          ))}
        </DropdownMenuRadioGroup>
        {targets.length > 0 && runtimeHosts.length > 0 ? <DropdownMenuSeparator /> : null}
        {connectedTargets.map((t) => (
          <SshTargetStatusRow
            key={t.id}
            targetId={t.id}
            label={t.label}
            status={t.status}
            syncStatus={t.syncStatus}
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
