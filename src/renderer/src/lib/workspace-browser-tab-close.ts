import { useAppStore } from '@/store'
import { destroyWorkspaceWebviews } from '@/store/slices/browser-webview-cleanup'
import { runtimeEnvironmentIdForWorkspaceOwner } from './resolve-owner'
import { warnAmbiguousOwnerOnce } from './ambiguous-owner-warning'
import { closeBrowserWorkspaceTabOnHosts } from '@/runtime/browser-workspace-tab-close'
import type { BrowserWorkspaceTabClosePlan } from '@/runtime/browser-workspace-tab-close-plan'

const REFUSED_CLOSE_PLAN: BrowserWorkspaceTabClosePlan = {
  hostEnvironmentIds: [],
  closesLocally: false,
  removesVisibleTab: false
}

export function closeWorkspaceBrowserTab(worktreeId: string, workspaceId: string, tabId?: string) {
  const state = useAppStore.getState()
  const { closeBrowserTab, closeUnifiedTab } = state
  const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId: worktreeId })
  // Why: only a pageless host mirror is closed by the worktree's owner; pages name their own.
  if (
    owner.kind === 'ambiguous' &&
    (state.browserPagesByWorkspace[workspaceId] ?? []).length === 0
  ) {
    warnAmbiguousOwnerOnce(worktreeId, 'close a browser tab on its host')
    return REFUSED_CLOSE_PLAN
  }
  const plan = closeBrowserWorkspaceTabOnHosts({
    state,
    worktreeId,
    workspaceId,
    visibleTabId: tabId ?? workspaceId,
    focusedEnvironmentId: owner.kind === 'resolved' ? owner.environmentId : null
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
