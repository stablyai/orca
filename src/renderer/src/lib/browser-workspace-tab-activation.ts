import { useAppStore } from '@/store'

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
}): boolean {
  const state = useAppStore.getState()
  const unifiedTab = (state.unifiedTabsByWorktree[params.worktreeId] ?? []).find(
    (candidate) => candidate.contentType === 'browser' && candidate.entityId === params.workspaceId
  )
  if (!unifiedTab) {
    return false
  }
  state.focusGroup(params.worktreeId, unifiedTab.groupId)
  state.activateTab(unifiedTab.id)
  state.setActiveBrowserTab(params.workspaceId)
  if (params.pageId) {
    state.setActiveBrowserPage(params.workspaceId, params.pageId)
  }
  return true
}
