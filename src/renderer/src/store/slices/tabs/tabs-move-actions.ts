import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { collapseGroupLayout } from '../../../../../shared/workspace-layout/tab-group-layout-tree'
import { buildActiveSurfacePatch } from './tabs-surface'
import { createMoveTabToWorktreeAction } from './tabs-cross-worktree-move'
import {
  findGroupAndWorktree,
  findGroupForTab,
  findTabAndWorktree,
  pickNextActiveTab,
  pushRecentTabId,
  sanitizeRecentTabIds
} from '../tab-group-state'
import { dedupeTabOrder } from '../../../../../shared/workspace-layout/tab-order'

export function createTabsMoveActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'moveUnifiedTabToGroup' | 'moveTabToWorktree'> {
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

        const dedupedSourceOrder = dedupeTabOrder(sourceGroup.tabOrder)
        const sourceOrder = dedupeTabOrder(dedupedSourceOrder.filter((id) => id !== tabId))
        const dedupedTargetOrder = dedupeTabOrder(targetGroup.tabOrder).filter((id) => id !== tabId)
        const clampedIndex = Math.max(
          0,
          Math.min(opts?.index ?? dedupedTargetOrder.length, dedupedTargetOrder.length)
        )
        const nextTargetOrder = [...dedupedTargetOrder]
        nextTargetOrder.splice(clampedIndex, 0, tabId)
        const targetOrder = dedupeTabOrder(nextTargetOrder)
        const shouldActivate = opts?.activate !== false
        const sourceRecentTabIds = sanitizeRecentTabIds(
          (sourceGroup.recentTabIds ?? []).filter((id) => id !== tabId),
          sourceOrder
        )
        const targetRecentBase = sanitizeRecentTabIds(targetGroup.recentTabIds, targetOrder)
        const targetRecentTabIds = shouldActivate
          ? pushRecentTabId(targetRecentBase, tabId)
          : targetRecentBase
        const nextSourceActiveTabId =
          sourceGroup.activeTabId === tabId
            ? pickNextActiveTab(
                dedupedSourceOrder,
                sourceGroup.recentTabIds,
                tabId,
                state.unifiedTabsByWorktree[worktreeId]
              )
            : sourceGroup.activeTabId
        const nextTargetActiveTabId = shouldActivate
          ? tabId
          : (targetGroup.activeTabId ?? targetOrder[0] ?? null)

        moved = true
        const nextTabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).map((candidate) =>
          candidate.id === tabId ? { ...candidate, groupId: targetGroupId } : candidate
        )
        let nextGroups = (state.groupsByWorktree[worktreeId] ?? []).map((group) => {
          if (group.id === sourceGroup.id) {
            return {
              ...group,
              activeTabId: nextSourceActiveTabId,
              tabOrder: sourceOrder,
              recentTabIds: sourceRecentTabIds
            }
          }
          if (group.id === targetGroup.id) {
            return {
              ...group,
              activeTabId: nextTargetActiveTabId,
              tabOrder: targetOrder,
              recentTabIds: targetRecentTabIds
            }
          }
          return group
        })

        let nextLayoutByWorktree = state.layoutByWorktree
        let nextActiveGroupIdByWorktree = state.activeGroupIdByWorktree
        if (sourceOrder.length === 0 && nextGroups.length > 1) {
          nextGroups = nextGroups.filter((group) => group.id !== sourceGroup.id)
          const collapsed = collapseGroupLayout(
            state.layoutByWorktree,
            state.activeGroupIdByWorktree,
            worktreeId,
            sourceGroup.id,
            targetGroup.id
          )
          nextLayoutByWorktree = collapsed.layoutByWorktree
          nextActiveGroupIdByWorktree = collapsed.activeGroupIdByWorktree
        }

        const nextActiveGroupId = shouldActivate
          ? targetGroupId
          : (nextActiveGroupIdByWorktree[worktreeId] ?? targetGroupId)
        const nextActiveGroupIdByWorktreeResolved = {
          ...nextActiveGroupIdByWorktree,
          [worktreeId]: nextActiveGroupId
        }

        return {
          unifiedTabsByWorktree: {
            ...state.unifiedTabsByWorktree,
            [worktreeId]: nextTabs
          },
          groupsByWorktree: {
            ...state.groupsByWorktree,
            [worktreeId]: nextGroups
          },
          layoutByWorktree: nextLayoutByWorktree,
          activeGroupIdByWorktree: nextActiveGroupIdByWorktreeResolved,
          ...(state.activeWorktreeId === worktreeId
            ? buildActiveSurfacePatch(
                {
                  ...state,
                  unifiedTabsByWorktree: {
                    ...state.unifiedTabsByWorktree,
                    [worktreeId]: nextTabs
                  },
                  groupsByWorktree: {
                    ...state.groupsByWorktree,
                    [worktreeId]: nextGroups
                  },
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
    },
    moveTabToWorktree: createMoveTabToWorktreeAction(set, get)
  }
}
