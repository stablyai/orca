import { sshConnectFailureText } from '@/components/settings/ssh-host-server-status-copy'
import { useAppStore } from '@/store'

/** A failed connect's toast text: an unserved host's translated reason, else the error message. */
export function sshTargetConnectFailureText(
  targetId: string,
  error: unknown,
  fallback: string
): string {
  return sshConnectFailureText(
    {},
    useAppStore.getState().sshConnectionStates.get(targetId),
    error instanceof Error ? error.message : fallback
  )
}
