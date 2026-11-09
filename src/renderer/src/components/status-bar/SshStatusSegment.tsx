import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { MonitorSmartphone, Server } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import { buildRemoteHostMenuInventory } from './remote-host-menu-inventory'
import { RuntimeHostStatusRow } from './RuntimeHostStatusRow'
import { connectedHostCountLabel, moreSshHostsLabel } from './ssh-status-segment-copy'
import { SshHostFindPopover } from './SshHostFindPopover'
import { splitSshStatusMenuRows } from './ssh-status-menu-rows'
import {
  SshTargetStatusRow,
  connectSshTargetFromStatusMenu,
  disconnectSshTargetFromStatusMenu
} from './SshTargetStatusRow'
import { useRemoteHostMenuState } from './use-remote-host-menu-state'
import { isConnectingSshStatus } from '@/ssh/ssh-connection-recoverability'
import { syncSshConfigTargetsPassively } from '../../lib/ssh-config-passive-sync'
import { connectRuntimeHostAndReloadProjects } from './runtime-environment-explicit-connect'
import {
  ambiguousRemoteHostNames,
  type RuntimeHostBlockedRecovery
} from './remote-host-connection-status'
import { RuntimeRepairDialog } from '../runtime-access/RuntimeRepairDialog'

export function SshStatusSegment({
  compact,
  iconOnly
}: {
  compact: boolean
  iconOnly: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const repos = useAppStore((s) => s.repos)
  const settings = useAppStore((s) => s.settings)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const readRuntimeHostStatusSnapshots = useAppStore((s) => s.readRuntimeHostStatusSnapshots)
  const hydrateRuntimeEnvironmentStatuses = useAppStore((s) => s.hydrateRuntimeEnvironmentStatuses)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [menuOpen, setMenuOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [repairTarget, setRepairTarget] = useState<{ id: string; label: string } | null>(null)

  const projectHostIds = useMemo(
    () => new Set(repos.flatMap((repo) => (repo.connectionId ? [repo.connectionId] : []))),
    [repos]
  )
  const {
    targets,
    runtimeHostRows,
    connectedRuntimeHosts,
    inactiveRuntimeHosts,
    connectedHostCount,
    hostCount
  } = useMemo(
    () =>
      buildRemoteHostMenuInventory(
        {
          runtimeEnvironments,
          settings,
          sshTargetLabels,
          sshConnectionStates,
          runtimeStatusByEnvironmentId
        },
        t
      ),
    [
      runtimeEnvironments,
      settings,
      sshTargetLabels,
      sshConnectionStates,
      runtimeStatusByEnvironmentId,
      t
    ]
  )
  const hostExists = useCallback(
    (id: string) => {
      const host = parseExecutionHostId(id)
      return host?.kind === 'ssh'
        ? sshTargetLabels.has(host.targetId)
        : host?.kind === 'runtime' &&
            runtimeEnvironments.some((environment) => environment.id === host.environmentId)
    },
    [sshTargetLabels, runtimeEnvironments]
  )
  const menu = useRemoteHostMenuState(menuOpen, hostExists)
  const { connect: trackConnect, cancel: cancelConnect } = menu
  const selectPendingSshTargets = useShallow((pending: ReadonlySet<string>) => {
    const targetIds = new Set<string>()
    for (const id of pending) {
      const host = parseExecutionHostId(id)
      if (host?.kind === 'ssh') {
        targetIds.add(host.targetId)
      }
    }
    return targetIds
  })
  const pendingTargetIds = selectPendingSshTargets(menu.pending)
  const {
    connected: connectedTargets,
    inactive: disconnectedTargets,
    hiddenIdleCount
  } = useMemo(
    () => splitSshStatusMenuRows(targets, { projectHostIds, pendingTargetIds }),
    [targets, projectHostIds, pendingTargetIds]
  )
  const displayedTargets = [...connectedTargets, ...disconnectedTargets]
  const displayedHosts = [...connectedRuntimeHosts, ...inactiveRuntimeHosts]
  menu.observe([
    ...displayedHosts.map((host) => ({
      id: toRuntimeExecutionHostId(host.id),
      recovering:
        (menu.pending.has(toRuntimeExecutionHostId(host.id)) &&
          host.state !== 'connected' &&
          host.state !== 'workspace-window-closed') ||
        (!host.blocked && (host.state === 'checking' || host.state === 'reconnecting')),
      attempt:
        host.remoteControl?.state === 'reconnecting' ? host.remoteControl.reconnectAttempt : 0
    })),
    ...displayedTargets.map((target) => ({
      id: toSshExecutionHostId(target.id),
      recovering:
        (menu.pending.has(toSshExecutionHostId(target.id)) && target.status !== 'connected') ||
        isConnectingSshStatus(target.status),
      attempt: target.status === 'reconnecting' ? (target.reconnectAttempt ?? 0) + 1 : 0
    }))
  ])
  const ambiguousNames = ambiguousRemoteHostNames(displayedHosts, displayedTargets)
  const runtimeKind = (label: string) =>
    ambiguousNames.has(label)
      ? t('auto.components.status.bar.RemoteHostStatusRow.server', 'Server')
      : undefined
  const sshKind = (label: string) =>
    ambiguousNames.has(label)
      ? t('auto.components.status.bar.RemoteHostStatusRow.ssh', 'SSH')
      : undefined
  const connectSshHost = (id: string) =>
    trackConnect(toSshExecutionHostId(id), (signal) => connectSshTargetFromStatusMenu(id, signal))
  const disconnectSshHost = async (id: string) => {
    cancelConnect(toSshExecutionHostId(id))
    await disconnectSshTargetFromStatusMenu(id)
  }
  const connectRuntimeHost = useCallback(
    async (environmentId: string): Promise<void> => {
      await trackConnect(toRuntimeExecutionHostId(environmentId), async (signal) => {
        if (
          (await connectRuntimeHostAndReloadProjects(environmentId, undefined, signal)) &&
          !signal.aborted
        ) {
          recordFeatureInteraction('ssh')
        }
      })
    },
    [trackConnect, recordFeatureInteraction]
  )
  const disconnectRuntimeHost = useCallback(
    async (environmentId: string): Promise<void> => {
      cancelConnect(toRuntimeExecutionHostId(environmentId))
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
    [cancelConnect, recordFeatureInteraction, readRuntimeHostStatusSnapshots]
  )

  if (hostCount === 0) {
    return null
  }

  const openRecovery = (host: {
    id: string
    label: string
    blocked: { recovery: RuntimeHostBlockedRecovery | null } | null
  }): void => {
    // Why close first: the dialog must not open underneath the menu's focus trap.
    setMenuOpen(false)
    if (host.blocked?.recovery === 'open-settings') {
      const state = useAppStore.getState()
      state.openSettingsTarget({ pane: 'servers', repoId: null, sectionId: host.id })
      state.openSettingsPage()
      return
    }
    setRepairTarget({ id: host.id, label: host.label })
  }
  const renderRuntimeHost = (host: (typeof runtimeHostRows)[number]) => (
    <RuntimeHostStatusRow
      key={host.id}
      label={host.label}
      kind={runtimeKind(host.label)}
      pending={menu.pending.has(toRuntimeExecutionHostId(host.id))}
      recovery={menu.observations.get(toRuntimeExecutionHostId(host.id))}
      now={menu.now}
      state={host.state}
      diagnostics={host.remoteControl}
      blocked={host.blocked}
      onConnect={() => connectRuntimeHost(host.id)}
      onDisconnect={() => disconnectRuntimeHost(host.id)}
      onRecover={() => openRecovery(host)}
    />
  )
  const renderSshTarget = (target: (typeof targets)[number]) => (
    <SshTargetStatusRow
      key={target.id}
      targetId={target.id}
      label={target.label}
      kind={sshKind(target.label)}
      error={target.error}
      pending={menu.pending.has(toSshExecutionHostId(target.id))}
      recovery={menu.observations.get(toSshExecutionHostId(target.id))}
      now={menu.now}
      onConnect={() => connectSshHost(target.id)}
      onDisconnect={() => disconnectSshHost(target.id)}
      status={target.status}
    />
  )
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
          ref={triggerRef}
          type="button"
          className="inline-flex shrink-0 items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 text-muted-foreground hover:bg-accent/70"
          aria-label={t(
            'auto.components.status.bar.SshStatusSegment.fdc57e9970',
            'Remote host connection status'
          )}
        >
          {iconOnly ? (
            <MonitorSmartphone className="size-3" />
          ) : (
            <>
              <Server className="size-3" />
              {!compact && (
                <span className="inline-grid text-2xs tabular-nums">
                  {/* Reserve both localized forms so count changes don't resize the bar. */}
                  <span aria-hidden className="invisible col-start-1 row-start-1">
                    {connectedHostCountLabel(1, t)}
                  </span>
                  <span aria-hidden className="invisible col-start-1 row-start-1">
                    {connectedHostCountLabel(Math.max(99, hostCount), t)}
                  </span>
                  <span className="col-start-1 row-start-1">
                    {connectedHostCountLabel(connectedHostCount, t)}
                  </span>
                </span>
              )}
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[min(20rem,calc(100vw-1rem))]"
        onCloseAutoFocus={(event) => {
          // Why: the host search takes focus as the menu closes; the trigger must not take it back.
          if (findOpen) {
            event.preventDefault()
          }
        }}
      >
        <div className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
          {t('auto.components.status.bar.SshStatusSegment.6e8a9a4242', 'Remote hosts')}
        </div>
        {connectedRuntimeHosts.map(renderRuntimeHost)}
        {connectedTargets.map(renderSshTarget)}
        {inactiveRuntimeHosts.map(renderRuntimeHost)}
        {disconnectedTargets.map(renderSshTarget)}
        {hiddenIdleCount > 0 ? (
          // Why a search and not a Settings link: web clients connect hosts here but have no SSH pane.
          <DropdownMenuItem onSelect={() => setFindOpen(true)}>
            {moreSshHostsLabel(hiddenIdleCount, t)}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            recordFeatureInteraction('ssh')
            openSettingsTarget({ pane: 'servers', repoId: null })
            setActiveView('settings')
          }}
        >
          {t('auto.components.status.bar.SshStatusSegment.3ad70e0365', 'Manage remote hosts…')}
        </DropdownMenuItem>
      </DropdownMenuContent>
      <SshHostFindPopover
        open={findOpen}
        onOpenChange={setFindOpen}
        targets={targets}
        anchorRef={triggerRef}
      />
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
