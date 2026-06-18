import { useCallback, useState } from 'react'
import { AlertTriangle, Cloud, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '../../store'
import { STATUS_LABELS, statusColor } from '../settings/SshTargetCard'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import type { RemoteWorkspaceSyncStatus } from '../../store/slices/ssh'

function isReconnectable(status: SshConnectionStatus): boolean {
  return ['disconnected', 'reconnection-failed', 'error', 'auth-failed'].includes(status)
}

function syncStatusLabel(status: RemoteWorkspaceSyncStatus | undefined): string | null {
  switch (status?.phase) {
    case 'pulling':
    case 'pushing':
      return 'Workspace syncing'
    case 'conflict':
      return 'Workspace sync conflict'
    case 'error':
      return 'Workspace sync error'
    case 'offline':
      return 'Workspace sync unavailable'
    case 'synced':
    case 'idle':
    case undefined:
      return null
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
    case 'idle':
    case undefined:
      return 'text-muted-foreground'
  }
}

export function SshTargetStatusRow({
  targetId,
  label,
  status,
  syncStatus
}: {
  targetId: string
  label: string
  status: SshConnectionStatus
  syncStatus: RemoteWorkspaceSyncStatus | undefined
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const mountedRef = useMountedRef()
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const visibleSyncStatusLabel = syncStatusLabel(syncStatus)

  const handleConnect = useCallback(async () => {
    setBusy(true)
    try {
      await window.api.ssh.connect({ targetId })
      recordFeatureInteraction('ssh')
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate('auto.components.status.bar.SshStatusSegment.2c29e2de68', 'Connection failed')
      )
    } finally {
      if (mountedRef.current) {
        setBusy(false)
      }
    }
  }, [mountedRef, recordFeatureInteraction, targetId])

  const handleDisconnect = useCallback(async () => {
    setBusy(true)
    try {
      await window.api.ssh.disconnect({ targetId })
      recordFeatureInteraction('ssh')
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate('auto.components.status.bar.SshStatusSegment.bf07aee59e', 'Disconnect failed')
      )
    } finally {
      if (mountedRef.current) {
        setBusy(false)
      }
    }
  }, [mountedRef, recordFeatureInteraction, targetId])

  return (
    <div className="flex items-center gap-2.5 px-2 py-1.5">
      <span className={`size-1.5 shrink-0 rounded-full ${statusColor(status)}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium">{label}</div>
        <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>
            {translate('auto.components.status.bar.SshTargetStatusRow.sshHost', 'SSH Host')}
          </span>
          <span aria-hidden="true">·</span>
          <span>{STATUS_LABELS[status]}</span>
          {visibleSyncStatusLabel ? (
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
                <span className="truncate">{visibleSyncStatusLabel}</span>
              </span>
            </>
          ) : null}
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
          {translate('auto.components.status.bar.SshStatusSegment.63f36455cc', 'Connect')}
        </button>
      ) : status === 'connected' ? (
        <button
          type="button"
          onClick={() => void handleDisconnect()}
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent/70 hover:text-foreground"
        >
          {translate('auto.components.status.bar.SshStatusSegment.59b553e2aa', 'Disconnect')}
        </button>
      ) : null}
    </div>
  )
}
