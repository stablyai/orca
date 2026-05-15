import React, { useCallback, useState } from 'react'
import { AlertTriangle, Cloud, Loader2, MonitorSmartphone, Server, ServerOff } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import { STATUS_LABELS, statusColor } from '../settings/SshTargetCard'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import type { RemoteWorkspaceSyncStatus } from '../../store/slices/ssh'

function isConnecting(status: SshConnectionStatus): boolean {
  return ['connecting', 'deploying-relay', 'reconnecting'].includes(status)
}

function isReconnectable(status: SshConnectionStatus): boolean {
  return ['disconnected', 'reconnection-failed', 'error', 'auth-failed'].includes(status)
}

function overallStatus(
  statuses: SshConnectionStatus[]
): 'connected' | 'partial' | 'disconnected' | 'connecting' {
  if (statuses.length === 0) {
    return 'disconnected'
  }
  if (statuses.every((s) => s === 'connected')) {
    return 'connected'
  }
  if (statuses.some((s) => isConnecting(s))) {
    return 'connecting'
  }
  if (statuses.some((s) => s === 'connected')) {
    return 'partial'
  }
  return 'disconnected'
}

function overallDotColor(status: 'connected' | 'partial' | 'disconnected' | 'connecting'): string {
  switch (status) {
    case 'connected':
      return 'bg-emerald-500'
    case 'partial':
      return 'bg-yellow-500'
    case 'connecting':
      return 'bg-yellow-500'
    default:
      return 'bg-muted-foreground/40'
  }
}

function overallLabel(status: 'connected' | 'partial' | 'disconnected' | 'connecting'): string {
  switch (status) {
    case 'connected':
      return 'Connected'
    case 'partial':
      return 'Partial'
    case 'connecting':
      return 'Connecting…'
    default:
      return 'Disconnected'
  }
}

function syncStatusLabel(status: RemoteWorkspaceSyncStatus | undefined): string {
  switch (status?.phase) {
    case 'pulling':
      return 'Sync pulling'
    case 'pushing':
      return 'Sync pushing'
    case 'synced':
      return status.direction === 'pull' ? 'Sync pulled' : 'Sync uploaded'
    case 'conflict':
      return 'Sync conflict'
    case 'error':
      return 'Sync error'
    case 'offline':
      return 'Sync unavailable'
    default:
      return 'Sync idle'
  }
}

function syncStatusTone(status: RemoteWorkspaceSyncStatus | undefined): string {
  switch (status?.phase) {
    case 'conflict':
    case 'error':
      return 'text-destructive'
    case 'offline':
      return 'text-muted-foreground'
    case 'pulling':
    case 'pushing':
      return 'text-yellow-500'
    case 'synced':
      return 'text-emerald-500'
    default:
      return 'text-muted-foreground'
  }
}

function TargetRow({
  targetId,
  label,
  status,
  syncEnabled,
  syncStatus
}: {
  targetId: string
  label: string
  status: SshConnectionStatus
  syncEnabled: boolean
  syncStatus: RemoteWorkspaceSyncStatus | undefined
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)

  const handleConnect = useCallback(async () => {
    setBusy(true)
    try {
      await window.api.ssh.connect({ targetId })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setBusy(false)
    }
  }, [targetId])

  const handleDisconnect = useCallback(async () => {
    setBusy(true)
    try {
      await window.api.ssh.disconnect({ targetId })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Disconnect failed')
    } finally {
      setBusy(false)
    }
  }, [targetId])

  return (
    <div className="flex items-center gap-2.5 px-2 py-1.5">
      <span className={`size-1.5 shrink-0 rounded-full ${statusColor(status)}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium">{label}</div>
        <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>{STATUS_LABELS[status]}</span>
          {syncEnabled && (
            <>
              <span aria-hidden="true">·</span>
              <span
                className={`inline-flex min-w-0 items-center gap-1 ${syncStatusTone(syncStatus)}`}
              >
                {syncStatus?.phase === 'pulling' || syncStatus?.phase === 'pushing' ? (
                  <Loader2 className="size-2.5 shrink-0 animate-spin" />
                ) : syncStatus?.phase === 'conflict' || syncStatus?.phase === 'error' ? (
                  <AlertTriangle className="size-2.5 shrink-0" />
                ) : (
                  <Cloud className="size-2.5 shrink-0" />
                )}
                <span className="truncate">{syncStatusLabel(syncStatus)}</span>
              </span>
            </>
          )}
        </div>
      </div>
      {busy ? (
        <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
      ) : isReconnectable(status) ? (
        <button
          type="button"
          onClick={() => void handleConnect()}
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:bg-accent/70"
        >
          Connect
        </button>
      ) : status === 'connected' ? (
        <button
          type="button"
          onClick={() => void handleDisconnect()}
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent/70 hover:text-foreground"
        >
          Disconnect
        </button>
      ) : null}
    </div>
  )
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
  const sshTargetRemoteSyncEnabled = useAppStore((s) => s.sshTargetRemoteSyncEnabled)
  const remoteWorkspaceSyncStatusByTargetId = useAppStore(
    (s) => s.remoteWorkspaceSyncStatusByTargetId
  )
  const setActiveView = useAppStore((s) => s.setActiveView)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)

  const targets = Array.from(sshTargetLabels.entries()).map(([id, label]) => {
    const state = sshConnectionStates.get(id)
    return {
      id,
      label,
      status: (state?.status ?? 'disconnected') as SshConnectionStatus,
      syncEnabled: sshTargetRemoteSyncEnabled.get(id) === true,
      syncStatus: remoteWorkspaceSyncStatusByTargetId[id]
    }
  })

  if (targets.length === 0) {
    return null
  }

  const statuses = targets.map((t) => t.status)
  const overall = overallStatus(statuses)
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label="SSH connection status"
        >
          {iconOnly ? (
            <span className="inline-flex items-center gap-1">
              <span
                className={`inline-block size-2 rounded-full ${
                  syncProblem ? 'bg-destructive' : overallDotColor(overall)
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
                  SSH{' '}
                  <span className={syncProblem ? 'text-destructive' : 'text-muted-foreground'}>
                    {syncProblemLabel ?? overallLabel(overall)}
                  </span>
                </span>
              )}
              <span
                className={`inline-block size-1.5 rounded-full ${
                  syncProblem ? 'bg-destructive' : overallDotColor(overall)
                }`}
              />
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-[220px]">
        <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          SSH Connections
        </div>
        {targets.map((t) => (
          <TargetRow
            key={t.id}
            targetId={t.id}
            label={t.label}
            status={t.status}
            syncEnabled={t.syncEnabled}
            syncStatus={t.syncStatus}
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            openSettingsTarget({ pane: 'general', repoId: null, sectionId: 'ssh' })
            setActiveView('settings')
          }}
        >
          Manage SSH…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
