import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { WorktreeHostConnection } from '@/lib/worktree-host-connection-phase'
import { selectRuntimeAwareSshTargetLabel } from '@/store/slices/runtime-environment-ssh'
import { useSshConnectInFlight } from '@/ssh/ssh-connect-in-flight'
import { connectSshTargetForUser } from '@/ssh/ssh-user-connect'

export type UserDisconnectedHostConnect = {
  hostLabel: string
  connecting: boolean
  connect: () => void
}

/**
 * The Connect a pane card offers while the user's own Disconnect holds its host down. Null for
 * any other host state, so the card keeps its usual copy and actions there.
 */
export function useUserDisconnectedHostConnect(
  host: WorktreeHostConnection
): UserDisconnectedHostConnect | null {
  const targetId = host.unavailableReason === 'user-disconnected' ? host.targetId : null
  const hostLabel = useAppStore((state) =>
    targetId ? selectRuntimeAwareSshTargetLabel(state, host.environmentId, targetId) : ''
  )
  const connecting = useSshConnectInFlight(targetId ?? '')
  const { environmentId, publishedStatus } = host
  const connect = useCallback(() => {
    if (!targetId) {
      return
    }
    void connectSshTargetForUser({
      targetId,
      status: publishedStatus,
      environmentId,
      connectFailedMessage: translate(
        'auto.components.terminal.pane.TerminalSshReconnectOverlay.connectFailed',
        'SSH connection failed'
      )
    })
  }, [environmentId, publishedStatus, targetId])
  return targetId ? { hostLabel, connecting, connect } : null
}
