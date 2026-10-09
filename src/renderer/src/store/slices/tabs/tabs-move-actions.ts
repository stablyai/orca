import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { pushRecentTabId } from '../../../../../shared/tab-group-history'
import { collapseGroupLayout } from './tabs-layout'
import { buildActiveSurfacePatch } from './tabs-surface'
import {
  applyTransferredTabClusterMembership,
  getTabClusterInsertionIndex
} from './tab-cluster-model'
import { pickTabCloseSuccessor } from '../../../../../shared/tab-close-successor'
import {
  dedupeTabOrder,
  findGroupAndWorktree,
  findGroupForTab,
  findTabAndWorktree,
  sanitizeRecentTabIds
} from '../tab-group-state'

export function createTabsMoveActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'moveUnifiedTabToGroup'> {
  return {
    moveUnifiedTabToGroup: (tabId, targetGroupId, opts) => {
      let moved = false
      set((state) => {
        const foundTab = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
        const foundTarget = findGroupAndWorktree(state.groupsByWorktree, targetGroupId)
        if (!foundTab || !foundTarget || foundTab.worktreeId !== foundTarget.worktreeId) {
          return state
        }
        const { tab, worktreeId } = foundTab
        if (tab.groupId === targetGroupId) {
          return state
        }
        const sourceGroup = findGroupForTab(state.groupsByWorktree, worktreeId, tab.groupId)
        const targetGroup = foundTarget.group
        if (!sourceGroup) {
          return state
        }
        moved = true

        const dedupedSourceGroupOrder = dedupeTabOrder(sourceGroup.tabOrder)
        const sourceOrder = dedupedSourceGroupOrder.filter((id) => id !== tabId)
        // Why: defensive dedupe so target order can't grow a duplicate id (stale state); see dropUnifiedTab for the same guard.
        const targetOrder = dedupeTabOrder(targetGroup.tabOrder.filter((id) => id !== tabId))
        const targetIndex = getTabClusterInsertionIndex(
          targetOrder,
          targetGroup.tabClusters,
          opts?.index ?? targetOrder.length
        )
        targetOrder.splice(targetIndex, 0, tabId)
        const nextActiveGroupIdByWorktree = {
          ...state.activeGroupIdByWorktree,
          [worktreeId]: opts?.activate ? targetGroupId : state.activeGroupIdByWorktree[worktreeId]
        }
        const sourceActiveTabId =
          sourceGroup.activeTabId === tabId
            ? pickTabCloseSuccessor(sourceGroup, dedupedSourceGroupOrder, tabId)
            : sourceGroup.activeTabId
        const sanitizedSourceRecent = sanitizeRecentTabIds(sourceGroup.recentTabIds, sourceOrder)
        const sourceRecentTabIds =
          sourceActiveTabId && sourceActiveTabId !== sourceGroup.activeTabId
            ? pushRecentTabId(sanitizedSourceRecent, sourceActiveTabId)
            : sanitizedSourceRecent
        const pinnedTabIds = new Set(
          (state.unifiedTabsByWorktree[worktreeId] ?? [])
            .filter((candidate) => candidate.isPinned)
            .map((candidate) => candidate.id)
        )
        const nextGroups = (state.groupsByWorktree[worktreeId] ?? []).map((group) => {
          if (group.id === sourceGroup.id) {
            return applyTransferredTabClusterMembership(
              {
                ...group,
                activeTabId: sourceActiveTabId,
                tabOrder: sourceOrder,
                recentTabIds: sourceRecentTabIds
              },
              [tabId],
              null,
              pinnedTabIds
            )
          }
          if (group.id === targetGroupId) {
            const sanitizedTargetRecent = sanitizeRecentTabIds(group.recentTabIds, targetOrder)
            return {
              ...group,
              activeTabId: opts?.activate ? tabId : group.activeTabId,
              tabOrder: targetOrder,
              recentTabIds: opts?.activate
                ? pushRecentTabId(sanitizedTargetRecent, tabId)
                : sanitizedTargetRecent
            }
          }
          return group
        })
        let nextLayoutByWorktree = state.layoutByWorktree
        let nextActiveGroupIdByWorktreeResolved = nextActiveGroupIdByWorktree
        let filteredGroups = nextGroups
        if (sourceOrder.length === 0) {
          filteredGroups = nextGroups.filter((group) => group.id !== sourceGroup.id)
          const collapsedState = collapseGroupLayout(
            nextLayoutByWorktree,
            nextActiveGroupIdByWorktreeResolved,
            worktreeId,
            sourceGroup.id,
            targetGroupId
          )
          nextLayoutByWorktree = collapsedState.layoutByWorktree
          nextActiveGroupIdByWorktreeResolved = collapsedState.activeGroupIdByWorktree
        }
        const nextGroupsByWorktree = {
          ...state.groupsByWorktree,
          [worktreeId]: filteredGroups
        }
        const nextUnifiedTabsByWorktree = {
          ...state.unifiedTabsByWorktree,
          [worktreeId]: (state.unifiedTabsByWorktree[worktreeId] ?? []).map((candidate) =>
            candidate.id === tabId ? { ...candidate, groupId: targetGroupId } : candidate
          )
        }
        return {
          unifiedTabsByWorktree: nextUnifiedTabsByWorktree,
          groupsByWorktree: nextGroupsByWorktree,
          layoutByWorktree: nextLayoutByWorktree,
          activeGroupIdByWorktree: nextActiveGroupIdByWorktreeResolved,
          ...(state.activeWorktreeId === worktreeId
            ? buildActiveSurfacePatch(
                {
                  ...state,
                  unifiedTabsByWorktree: nextUnifiedTabsByWorktree,
                  groupsByWorktree: nextGroupsByWorktree,
                  layoutByWorktree: nextLayoutByWorktree,
                  activeGroupIdByWorktree: nextActiveGroupIdByWorktreeResolved
                },
                worktreeId,
                nextActiveGroupIdByWorktreeResolved[worktreeId] ?? null
              )
            : {})
        }
      })
      if (moved && opts?.recordInteraction !== false) {
        get().recordFeatureInteraction?.('tab-splits')
      }
      return moved
    }
  }
}
