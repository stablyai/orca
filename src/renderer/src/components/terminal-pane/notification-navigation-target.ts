import type { NotificationWorkspaceOwner } from '../../../../shared/notification-source'
import { notificationExecutionHostForOwner } from '@/attention/notification-subject-owner'
import type { useAppStore } from '@/store'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { getPtyExecutionHost } from '../../../../shared/terminal-execution-host'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'

export function getNotificationNavigationTarget(
  state: ReturnType<typeof useAppStore.getState>,
  worktreeId: string,
  paneKey: string | undefined,
  capturedOwner?: NotificationWorkspaceOwner | null
): { executionHostId?: ExecutionHostId; paneKey?: string } {
  const pane = paneKey ? parsePaneKey(paneKey) : null
  const tab = pane
    ? (state.tabsByWorktree[worktreeId] ?? []).find((candidate) => candidate.id === pane.tabId)
    : undefined
  const ptyId = pane
    ? (state.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId] ?? tab?.ptyId)
    : null
  const capturedHost = notificationExecutionHostForOwner(capturedOwner ?? null)
  if (capturedHost) {
    const foreignPty = ptyId && getPtyExecutionHost(ptyId) === 'foreign'
    return { executionHostId: capturedHost, ...(!foreignPty && paneKey ? { paneKey } : {}) }
  }
  if (ptyId) {
    const ptyHost = getPtyExecutionHost(ptyId)
    if (ptyHost === 'foreign') {
      const fallbackHost = getResolvedExecutionHostIdForWorktree(state, worktreeId)
      return fallbackHost && fallbackHost !== LOCAL_EXECUTION_HOST_ID
        ? { executionHostId: fallbackHost }
        : {}
    }
    return { executionHostId: ptyHost ?? LOCAL_EXECUTION_HOST_ID, ...(paneKey ? { paneKey } : {}) }
  }
  const executionHostId = getResolvedExecutionHostIdForWorktree(state, worktreeId)
  return executionHostId ? { executionHostId, ...(paneKey ? { paneKey } : {}) } : {}
}
