import { useAppStore } from '../../store'
import { isCurrentKnownPaneKey } from '@/components/terminal-pane/terminal-notification-state'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { activateNotificationRuntimeTarget } from './notification-runtime-navigation'

/**
 * Second half of a notification click: activation has resolved the workspace, so select and focus
 * the pane that produced the notification. A pane that has since closed leaves the workspace
 * activated with its current session selected — the closed session is never recreated.
 */
export async function focusNotificationPaneAfterActivation(args: {
  worktreeId: string
  notificationPaneKey?: string | null
  executionHostId: ExecutionHostId | null
  isCurrentIntent: () => boolean
}): Promise<void> {
  const { worktreeId, notificationPaneKey, executionHostId, isCurrentIntent } = args
  const activateWorkspaceOnly = async (): Promise<void> => {
    if (executionHostId) {
      await activateNotificationRuntimeTarget({ executionHostId, worktreeId })
    }
  }

  const pane = notificationPaneKey ? parsePaneKey(notificationPaneKey) : null
  if (
    !notificationPaneKey ||
    !pane ||
    !isCurrentKnownPaneKey(
      useAppStore.getState(),
      worktreeId,
      notificationPaneKey,
      executionHostId ?? undefined
    )
  ) {
    await activateWorkspaceOnly()
    return
  }

  // Why: re-check the pane after the runtime round-trip — it can close, or a newer click can win, while in flight.
  if (
    !executionHostId ||
    !(await activateNotificationRuntimeTarget({
      executionHostId,
      worktreeId,
      tabId: pane.tabId,
      leafId: pane.leafId
    })) ||
    !isCurrentIntent() ||
    !isCurrentKnownPaneKey(useAppStore.getState(), worktreeId, notificationPaneKey, executionHostId)
  ) {
    return
  }

  activateTabAndFocusPane(pane.tabId, pane.leafId, {
    ackPaneKeyOnSuccess: notificationPaneKey,
    flashFocusedPane: true,
    scrollToBottomIfOutputSinceLastView: true
  })
}
