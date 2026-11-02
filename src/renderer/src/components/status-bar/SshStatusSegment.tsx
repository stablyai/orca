import React, { useCallback, useMemo, useState } from 'react'
import { Loader2, MonitorSmartphone, Server, ServerOff } from 'lucide-react'
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
import {
  isRuntimeOwnedSshTargetId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import { buildExecutionHostRegistry } from '../../../../shared/execution-host-registry'
import { pickerExecutionHosts } from '../../../../shared/managed-orcad-execution-host'
import { isListedRemoteServer } from '../../../../shared/runtime-environments'
import { RuntimeHostStatusRow } from './RuntimeHostStatusRow'
import { connectedHostCountLabel, connectingHostsLabel } from './ssh-status-segment-copy'
import { SshTargetStatusRow } from './SshTargetStatusRow'
import { syncSshConfigTargetsPassively } from '../../lib/ssh-config-passive-sync'
import { connectRuntimeHostAndReloadProjects } from './runtime-environment-explicit-connect'
import {
  overallDotColor,
  overallStatus,
  runtimeHostBlockedCopy,
  runtimeHostConnectionDetail,
  runtimeHostStatusForOverall,
  sshStatusForOverall
} from './remote-host-connection-status'
import {
  isConnectedRuntimeHostState,
  runtimeHostConnectionStateForEntry
} from '@/runtime/runtime-host-connection-state'
import { RuntimeRepairDialog } from '../settings/RuntimeRepairDialog'

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
  const readRuntimeHostStatusSnapshots = useAppStore((s) => s.readRuntimeHostStatusSnapshots)
  const hydrateRuntimeEnvironmentStatuses = useAppStore((s) => s.hydrateRuntimeEnvironmentStatuses)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [menuOpen, setMenuOpen] = useState(false)
  const [repairTarget, setRepairTarget] = useState<{ id: string; label: string } | null>(null)

  const hostLabelOverrides = useMemo(() => getHostDisplayLabelOverrides(settings), [settings])
  const userManagedEnvironments = runtimeEnvironments.filter(isListedRemoteServer)
  // Why the registry: a managed server and its SSH host are one machine, shown on its active route.
  const visibleHosts = new Map(
    pickerExecutionHosts(
      buildExecutionHostRegistry({
        repos: [],
        settings,
        hostSource: 'configured-only',
        sshTargetLabels,
        sshConnectionStates,
        runtimeEnvironments: userManagedEnvironments,
        runtimeStatusByEnvironmentId,
        hostLabelOverrides
      })
    ).map((host) => [host.id, host])
  )
  const targets = Array.from(sshTargetLabels.entries())
    // Why: runtime-owned (per-workspace-env) SSH targets are hidden — never list them
    // as a user-facing SSH host in the status bar.
    .filter(([id]) => !isRuntimeOwnedSshTargetId(id) && visibleHosts.has(toSshExecutionHostId(id)))
    .map(([id, label]) => {
      const state = sshConnectionStates.get(id)
      return {
        id,
        label: visibleHosts.get(toSshExecutionHostId(id))?.label || label,
        status: state?.status ?? ('disconnected' satisfies SshConnectionStatus)
      }
    })
  const runtimeHosts = userManagedEnvironments
    .filter((environment) => visibleHosts.has(toRuntimeExecutionHostId(environment.id)))
    .map((environment) => {
      const statusEntry = runtimeStatusByEnvironmentId.get(environment.id)
      const registryHost = visibleHosts.get(toRuntimeExecutionHostId(environment.id))
      // Why the registry's verdict: it is the same blocked reason the sidebar and Settings show.
      const blockedReason =
        registryHost?.health === 'blocked' ? registryHost.blockedReason : undefined
      return {
        id: environment.id,
        label: registryHost?.label || environment.name || environment.id,
        blockedReason,
        blocked: blockedReason
          ? {
              ...runtimeHostBlockedCopy(blockedReason, registryHost?.compatibility),
              canRepair: blockedReason === 'access-revoked'
            }
          : null,
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
      if (await connectRuntimeHostAndReloadProjects(environmentId)) {
        recordFeatureInteraction('ssh')
      }
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
    ...runtimeHostRows.map((host) => runtimeHostStatusForOverall(host.state, host.blockedReason))
  ]
  const overall = overallStatus(statuses)
  const connectedHostCount = statuses.filter((status) => status === 'connected').length
  const anyConnecting = overall === 'connecting'
  const openRepair = (host: { id: string; label: string }): void => {
    // Why close first: the dialog must not open underneath the menu's focus trap.
    setMenuOpen(false)
    setRepairTarget({ id: host.id, label: host.label })
  }
  return (
    <DropdownMenu
      open={menuOpen}
      onOpenChange={(open) => {
        setMenuOpen(open)
        if (open) {
          void hydrateRuntimeEnvironmentStatuses()
          void syncSshConfigTargetsPassively()
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
                className={`inline-block size-2 rounded-full ${overallDotColor(overall, connectedHostCount)}`}
              />
              {anyConnecting ? (
                <Loader2 className="size-3 animate-spin text-muted-foreground" />
              ) : (
                <MonitorSmartphone className="size-3 text-muted-foreground" />
              )}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              {anyConnecting ? (
                <Loader2 className="size-3 animate-spin text-yellow-500" />
              ) : overall === 'connected' ? (
                <Server className="size-3 text-emerald-500" />
              ) : overall === 'attention' ? (
                connectedHostCount > 0 ? (
                  <Server className="size-3 text-destructive" />
                ) : (
                  <ServerOff className="size-3 text-destructive" />
                )
              ) : overall === 'partial' ? (
                <Server className="size-3 text-muted-foreground" />
              ) : (
                <ServerOff className="size-3 text-muted-foreground" />
              )}
              {!compact && (
                <span className="text-[11px]">
                  <span className="text-muted-foreground">
                    {anyConnecting
                      ? connectingHostsLabel()
                      : connectedHostCountLabel(connectedHostCount)}
                  </span>
                </span>
              )}
              <span
                className={`inline-block size-1.5 rounded-full ${overallDotColor(overall, connectedHostCount)}`}
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
            diagnostics={host.remoteControl}
            blocked={host.blocked}
            onConnect={() => connectRuntimeHost(host.id)}
            onDisconnect={() => disconnectRuntimeHost(host.id)}
            onRepair={() => openRepair(host)}
          />
        ))}
        {connectedTargets.map((t) => (
          <SshTargetStatusRow key={t.id} targetId={t.id} label={t.label} status={t.status} />
        ))}
        {inactiveRuntimeHosts.map((host) => (
          <RuntimeHostStatusRow
            key={host.id}
            label={host.label}
            state={host.state}
            detail={runtimeHostConnectionDetail(host.remoteControl)}
            diagnostics={host.remoteControl}
            blocked={host.blocked}
            onConnect={() => connectRuntimeHost(host.id)}
            onDisconnect={() => disconnectRuntimeHost(host.id)}
            onRepair={() => openRepair(host)}
          />
        ))}
        {disconnectedTargets.map((t) => (
          <SshTargetStatusRow key={t.id} targetId={t.id} label={t.label} status={t.status} />
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
      {repairTarget && (
        <RuntimeRepairDialog
          open
          onOpenChange={(open) => !open && setRepairTarget(null)}
          environmentId={repairTarget.id}
          name={repairTarget.label}
        />
      )}
    </DropdownMenu>
  )
}
