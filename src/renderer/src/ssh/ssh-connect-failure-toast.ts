import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  canOfferMoveAnywayToast,
  toastSshHostMoveRefused
} from '@/hooks/ipc-events/ssh-managed-server-refusal-toast'
import { sshTargetConnectFailureText } from './ssh-host-server-status-copy'
import { nodeMirrorRecoveryLabel } from './ssh-host-node-download-copy'
import { runNodeMirrorRecovery, thisComputerNodeMirrorRecovery } from './node-dist-mirror-recovery'

/** A failed connect's toast, with the Node.js mirror recovery when the setup couldn't get Node. */
export function toastSshConnectFailure(
  targetId: string,
  error: unknown,
  fallback: string,
  ownerEnvironmentId: string | null = null
): void {
  const status = useAppStore.getState().sshConnectionStates.get(targetId)?.managedServer
  if (!ownerEnvironmentId && canOfferMoveAnywayToast(status)) {
    toastSshHostMoveRefused(targetId, status)
    return
  }
  const text = sshTargetConnectFailureText(targetId, error, fallback)
  const recovery = thisComputerNodeMirrorRecovery(status, ownerEnvironmentId)
  if (!recovery) {
    toast.error(text)
    return
  }
  toast.error(text, {
    action: {
      label: nodeMirrorRecoveryLabel(recovery),
      onClick: () => runNodeMirrorRecovery(targetId)
    }
  })
}
