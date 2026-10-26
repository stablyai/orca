import { toast } from 'sonner'
import { useAppStore } from '@/store'
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
  const text = sshTargetConnectFailureText(targetId, error, fallback)
  const recovery = thisComputerNodeMirrorRecovery(
    useAppStore.getState().sshConnectionStates.get(targetId)?.managedServer,
    ownerEnvironmentId
  )
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
