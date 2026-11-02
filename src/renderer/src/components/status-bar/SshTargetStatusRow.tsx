import { useCallback, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { toastSshConnectFailure } from '@/ssh/ssh-connect-failure-toast'
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

export async function connectSshTargetFromStatusMenu(targetId: string): Promise<void> {
  if (isSshConnectInFlight(targetId)) {
    return
  }
  beginSshConnect(targetId)
  try {
    await window.api.ssh.connect({ targetId })
    useAppStore.getState().recordFeatureInteraction('ssh')
  } catch (err) {
    toastSshConnectFailure(
      targetId,
      err,
      translate('auto.components.status.bar.SshStatusSegment.2c29e2de68', 'Connection failed')
    )
  } finally {
    endSshConnect(targetId)
  }
}

export function SshTargetStatusRow({
  targetId,
  label,
  status
}: {
  targetId: string
  label: string
  status: SshConnectionStatus
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const mountedRef = useMountedRef()
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  // Share pending connects across surfaces until main broadcasts connecting, so duplicate attempts stay disabled.
  const connectInFlight = useSshConnectInFlight(targetId)

  const handleConnect = useCallback(async () => {
    setBusy(true)
    try {
      await connectSshTargetFromStatusMenu(targetId)
    } finally {
      if (mountedRef.current) {
        setBusy(false)
      }
    }
  }, [mountedRef, targetId])

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
        </div>
      </div>
      {busy || connectInFlight ? (
        <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
      ) : canConnectSshStatus(status) ? (
        <button
          type="button"
          onClick={() => void handleConnect()}
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:bg-accent/70"
        >
          {sshConnectVerb(status)}
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
