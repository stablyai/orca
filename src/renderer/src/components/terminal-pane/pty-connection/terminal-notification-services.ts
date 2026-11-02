import type { NotificationWorkspaceOwner } from '../../../../../shared/notification-source'
import type { PtyConnectionDeps } from '../pty-connection-types'

export type TerminalNotificationServices = {
  paneKey: string
  worktreeId: string
  tabId: string
  getWorkspaceOwner: () => NotificationWorkspaceOwner | undefined
  getPtyId: () => string | null
  isLive: () => boolean
  hasPendingHookDoneCompletion: () => boolean
  markTerminalBell: PtyConnectionDeps['markTerminalBell']
  dispatchNotification: PtyConnectionDeps['dispatchNotification']
}
