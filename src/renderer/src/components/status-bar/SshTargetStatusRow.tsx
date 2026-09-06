import { useCallback, useState } from 'react'
import { AlertTriangle, Cloud, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '../../store'
import { STATUS_LABELS, statusColor } from '../settings/SshTargetCard'
import { canConnectSshStatus } from '@/ssh/ssh-connection-recoverability'
import { sshConnectVerb } from '@/ssh/ssh-connect-verb'
import {
  beginSshConnect,
  endSshConnect,
  isSshConnectInFlight,
  useSshConnectInFlight
} from '@/ssh/ssh-connect-in-flight'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import type { RemoteWorkspaceSyncStatus } from '../../store/slices/ssh'
import {
  hasSyncDetails,
  SshTargetWorkspaceSyncSubmenu,
  syncStatusLabel,
  syncStatusTone
} from './SshTargetWorkspaceSyncSubmenu'

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
  // Why: shared with the sidebar card control and terminal overlay — a connect started here
  // must disable those too, in the window before main broadcasts 'connecting'.
  const connectInFlight = useSshConnectInFlight(targetId)
  const visibleSyncStatusLabel = syncStatusLabel(syncStatus)
  const hasDetails = hasSyncDetails(syncStatus)

  const handleConnect = useCallback(async () => {
    if (isSshConnectInFlight(targetId)) {
      return
    }
    beginSshConnect(targetId)
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
      endSshConnect(targetId)
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

  const rowDetails = (
    <>
      <span className={`size-1.5 shrink-0 rounded-full ${statusColor(status)}`} />
      <div className="min-w-0 flex-1">
        <div className="break-words text-[12px] font-medium [overflow-wrap:anywhere]">{label}</div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
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
                <span className="break-words [overflow-wrap:anywhere]">
                  {visibleSyncStatusLabel}
                </span>
              </span>
            </>
          ) : null}
        </div>
      </div>
    </>
  )

  const action = canConnectSshStatus(status)
    ? handleConnect
    : status === 'connected'
      ? handleDisconnect
      : null
  const actionLabel = canConnectSshStatus(status)
    ? sshConnectVerb(status)
    : status === 'connected'
      ? translate('auto.components.status.bar.SshStatusSegment.59b553e2aa', 'Disconnect')
      : null
  const actionButton =
    busy || connectInFlight ? (
      <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
    ) : action && actionLabel ? (
      <button
        type="button"
        onClick={() => void action()}
        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] hover:bg-accent/70 ${
          canConnectSshStatus(status)
            ? 'font-medium text-foreground'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        {actionLabel}
      </button>
    ) : null

  if (!hasDetails) {
    return (
      <div className="flex items-center gap-2.5 px-2 py-1.5">
        {rowDetails}
        {actionButton}
      </div>
    )
  }

  return (
    <SshTargetWorkspaceSyncSubmenu
      syncStatus={syncStatus}
      rowDetails={rowDetails}
      action={action}
      actionLabel={actionLabel}
      busy={busy}
      connectInFlight={connectInFlight}
    />
  )
}
