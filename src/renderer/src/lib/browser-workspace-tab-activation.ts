import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Tab } from '../../../shared/tab-types'
import { findAmbiguousWorktreeIds, isUnifiedTabOwnedByWorktree } from './unified-tab-host-ownership'

export function resolveBrowserWorkspaceUnifiedTab(params: {
  executionHostId?: ExecutionHostId
  worktreeId: string
  workspaceId: string
}): Tab | null {
  const state = useAppStore.getState()
  const worktree = params.executionHostId
    ? state.getKnownWorktreeById(params.worktreeId, params.executionHostId)
    : undefined
  if (params.executionHostId && !worktree) {
    return null
  }
  const ambiguousWorktreeIds = params.executionHostId
    ? findAmbiguousWorktreeIds(state.allWorktrees())
    : new Set<string>()
  return (
    (state.unifiedTabsByWorktree[params.worktreeId] ?? []).find(
      (candidate) =>
        candidate.contentType === 'browser' &&
        candidate.entityId === params.workspaceId &&
        (!params.executionHostId ||
          isUnifiedTabOwnedByWorktree(candidate, worktree!, ambiguousWorktreeIds))
    ) ?? null
  )
}

/**
 * Bring a browser workspace forward as the surface the reader is in.
 *
 * Why the unified tab and not just the browser state: the pane renders whatever its group's active
 * tab is, so selecting the workspace alone leaves the page live behind a tab that never shows it.
 * Returns false when the workspace has no unified tab yet, which is the caller's cue that there is
 * nothing to bring forward.
 */
export function activateBrowserWorkspaceTab(params: {
  executionHostId?: ExecutionHostId
  worktreeId: string
  workspaceId: string
  pageId?: string
}): boolean {
  const state = useAppStore.getState()
  const unifiedTab = resolveBrowserWorkspaceUnifiedTab(params)
  if (!unifiedTab) {
    return false
  }
  state.setActiveBrowserTab(params.workspaceId)
  if (params.pageId) {
    state.setActiveBrowserPage(params.workspaceId, params.pageId)
  }
  state.focusGroup(params.worktreeId, unifiedTab.groupId)
  if (params.executionHostId) {
    state.activateTab(unifiedTab.id, { worktreeId: params.worktreeId })
  } else {
    state.activateTab(unifiedTab.id)
  }
  return true
}
