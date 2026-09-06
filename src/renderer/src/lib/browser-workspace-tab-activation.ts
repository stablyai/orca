import { useAppStore } from '@/store'
import type { Tab } from '../../../shared/tab-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  findAmbiguousWorktreeIds,
  getPaletteOwnershipWorktreeIds,
  isUnifiedTabOwnedByWorktree
} from './unified-tab-host-ownership'

type BrowserWorkspaceTabTarget = {
  worktreeId: string
  workspaceId: string
  pageId?: string
  executionHostId?: ExecutionHostId
}

export function getActivatableBrowserWorkspaceTab(params: BrowserWorkspaceTabTarget): Tab | null {
  const state = useAppStore.getState()
  // A hostless tab cannot be attributed when the same worktree ID exists on several hosts.
  const ambiguousWorktreeIds = findAmbiguousWorktreeIds(getPaletteOwnershipWorktreeIds(state))
  if (!params.executionHostId && ambiguousWorktreeIds.has(params.worktreeId)) {
    return null
  }
  const worktree = state.getKnownWorktreeById(params.worktreeId, params.executionHostId)
  if (!worktree) {
    return null
  }
  // setActiveBrowserTab resolves its backing tab globally by workspace ID.
  const tabs = Object.values(state.unifiedTabsByWorktree).flat()
  const browserTabs = tabs.filter(
    (candidate) => candidate.contentType === 'browser' && candidate.entityId === params.workspaceId
  )
  const unifiedTab = browserTabs[0]
  if (
    browserTabs.some(
      (tab) =>
        tab.worktreeId !== params.worktreeId ||
        (worktree && !isUnifiedTabOwnedByWorktree(tab, worktree, ambiguousWorktreeIds))
    ) ||
    !unifiedTab ||
    tabs.filter((candidate) => candidate.id === unifiedTab.id).length !== 1
  ) {
    return null
  }
  return unifiedTab
}

export function activateBrowserWorkspaceTab(params: BrowserWorkspaceTabTarget): boolean {
  const unifiedTab = getActivatableBrowserWorkspaceTab(params)
  if (!unifiedTab) {
    return false
  }
  const state = useAppStore.getState()
  state.focusGroup(params.worktreeId, unifiedTab.groupId)
  state.activateTab(unifiedTab.id, { worktreeId: params.worktreeId })
  state.setActiveBrowserTab(params.workspaceId)
  if (params.pageId) {
    state.setActiveBrowserPage(params.workspaceId, params.pageId)
  }
  return true
}
