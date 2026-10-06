import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import {
  notificationExecutionHostForOwner,
  resolveNotificationTabOwner
} from '@/attention/notification-subject-owner'
import { focusExistingWorkspaceTab } from './focus-existing-workspace-tab'
import { resolveWindowTabIdForHostTab } from './host-session-tab-target'
import { useAppStore } from '../../store'
import { isCurrentKnownPaneKey } from '@/components/terminal-pane/terminal-notification-state'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { activateNotificationRuntimeTarget } from './notification-runtime-navigation'

// Activate existing surfaces only; a closed target leaves the workspace selected.
export async function focusNotificationPaneAfterActivation(args: {
  worktreeId: string
  notificationSurface?: 'terminal' | 'agent-session'
  notificationPaneKey?: string | null
  executionHostId: ExecutionHostId | null
  isCurrentIntent: () => boolean
}): Promise<void> {
  const { worktreeId, notificationPaneKey, notificationSurface, executionHostId, isCurrentIntent } =
    args
  const activateWorkspaceOnly = async (): Promise<void> => {
    if (executionHostId) {
      await activateNotificationRuntimeTarget({ executionHostId, worktreeId })
    }
  }

  if (!isCurrentIntent()) {
    return
  }
  const isKnownTarget = (): boolean => {
    if (!notificationPaneKey || !executionHostId) {
      return false
    }
    if (notificationSurface !== 'agent-session') {
      return isCurrentKnownPaneKey(
        useAppStore.getState(),
        worktreeId,
        notificationPaneKey,
        executionHostId
      )
    }
    const pane = parsePaneKey(notificationPaneKey)
    if (!pane) {
      return false
    }
    const state = useAppStore.getState()
    const localTabId = resolveWindowTabIdForHostTab(worktreeId, pane.tabId)
    const tab = state.unifiedTabsByWorktree[worktreeId]?.find((item) => item.id === localTabId)
    return Boolean(
      tab?.contentType === 'agent-session' &&
      structuredAgentSessionPaneKey(pane.tabId, tab.entityId) === notificationPaneKey &&
      notificationExecutionHostForOwner(resolveNotificationTabOwner(state, tab)) === executionHostId
    )
  }
  const pane = notificationPaneKey ? parsePaneKey(notificationPaneKey) : null
  if (!notificationPaneKey || !pane || !isKnownTarget()) {
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
      ...(notificationSurface !== 'agent-session' ? { leafId: pane.leafId } : {})
    })) ||
    !isCurrentIntent() ||
    !isKnownTarget()
  ) {
    return
  }

  if (notificationSurface === 'agent-session') {
    focusExistingWorkspaceTab({ tabId: pane.tabId, worktreeId, userInitiated: true })
    return
  }

  activateTabAndFocusPane(pane.tabId, pane.leafId, {
    ackPaneKeyOnSuccess: notificationPaneKey,
    flashFocusedPane: true,
    scrollToBottomIfOutputSinceLastView: true
  })
}
