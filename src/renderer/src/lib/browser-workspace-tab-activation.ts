import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { isUnifiedTabOwnedByWorktree } from './unified-tab-host-ownership'

/**
 * Bring a browser workspace forward as the surface the reader is in.
 *
 * Why the unified tab and not just the browser state: the pane renders whatever its group's active
 * tab is, so selecting the workspace alone leaves the page live behind a tab that never shows it.
 * Returns false when the workspace has no unified tab yet, which is the caller's cue that there is
 * nothing to bring forward.
 */
export function activateBrowserWorkspaceTab(params: {
  worktreeId: string
  workspaceId: string
  pageId?: string
  executionHostId?: ExecutionHostId
}): boolean {
  const state = useAppStore.getState()
  const worktree = params.executionHostId
    ? state.getKnownWorktreeById(params.worktreeId, params.executionHostId)
    : undefined
  const unifiedTab = (state.unifiedTabsByWorktree[params.worktreeId] ?? []).find(
    (candidate) =>
      candidate.contentType === 'browser' &&
      candidate.entityId === params.workspaceId &&
      (!worktree || isUnifiedTabOwnedByWorktree(candidate, worktree, new Set()))
  )
  if (!unifiedTab) {
    return false
  }
  state.activateTab(unifiedTab.id)
  state.setActiveBrowserTab(params.workspaceId)
  if (params.pageId) {
    state.setActiveBrowserPage(params.workspaceId, params.pageId)
  }
  // Refocus the host-owned group if stale mirrored state temporarily repeats a UUID.
  state.focusGroup(params.worktreeId, unifiedTab.groupId)
  return true
}
