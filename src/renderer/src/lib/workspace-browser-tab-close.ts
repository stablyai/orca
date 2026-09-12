import { useAppStore } from '@/store'
import { destroyWorkspaceWebviews } from '@/store/slices/browser-webview-cleanup'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import { closeBrowserWorkspaceTabOnHosts } from '@/runtime/browser-workspace-tab-close'

export function closeWorkspaceBrowserTab(worktreeId: string, workspaceId: string, tabId?: string) {
  const state = useAppStore.getState()
  const { closeBrowserTab, closeUnifiedTab } = state
  const plan = closeBrowserWorkspaceTabOnHosts({
    state,
    worktreeId,
    workspaceId,
    visibleTabId: tabId ?? workspaceId,
    focusedEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  })
  // Cleanup closes must preserve workspace selection at both teardown sites.
  const cleanupOptions =
    plan.localCloseReason === 'cleanup'
      ? { preserveWorktreeSelection: true, recordInteraction: false }
      : undefined
  if (plan.closesLocally) {
    // Announce the MRU page selection before guest teardown triggers focus fallback.
    closeBrowserTab(
      workspaceId,
      plan.localCloseReason ? { reason: plan.localCloseReason } : undefined
    )
    destroyWorkspaceWebviews(state.browserPagesByWorkspace, workspaceId)
  }
  if (plan.removesVisibleTab && tabId) {
    closeUnifiedTab(tabId, cleanupOptions)
  }
  return plan
}
