import { editSessionSource } from '../../session-source-edits'
import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { collapseGroupLayoutEdit } from './tab-group-layout-edits'
import { buildActiveSurfacePatch } from './tabs-surface'
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
): Pick<TabsSlice, 'moveUnifiedTabToGroup'> {
  return {
    moveUnifiedTabToGroup: (tabId, targetGroupId, opts) => {
      let moved = false
      set((state) => {
        const foundTab = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
        const foundTarget = findGroupAndWorktree(state.groupsByWorktree, targetGroupId)
        if (!foundTab || !foundTarget || foundTab.worktreeId !== foundTarget.worktreeId) {
          return undefined
        }
        const { tab, worktreeId } = foundTab
        if (tab.groupId === targetGroupId) {
          return undefined
        }
        const sourceGroup = findGroupForTab(state.groupsByWorktree, worktreeId, tab.groupId)
        const targetGroup = foundTarget.group
        if (!sourceGroup) {
          return undefined
        }
        moved = true

        const dedupedSourceGroupOrder = dedupeTabOrder(sourceGroup.tabOrder)
        const sourceOrder = dedupeTabOrder(dedupedSourceGroupOrder.filter((id) => id !== tabId))
        // Stale target orders may already contain tabId; dedupe to prevent duplicate React keys (also guarded in dropUnifiedTab).
        const targetOrder = dedupeTabOrder(targetGroup.tabOrder.filter((id) => id !== tabId))
        const targetIndex = Math.max(
          0,
          Math.min(opts?.index ?? targetOrder.length, targetOrder.length)
        )
        targetOrder.splice(targetIndex, 0, tabId)
        const edit = editSessionSource(state)
        edit.set(
          'activeGroupIdByWorktree',
          worktreeId,
          opts?.activate ? targetGroupId : state.activeGroupIdByWorktree[worktreeId]
        )
        const sourceRecentTabIds = sanitizeRecentTabIds(
          (sourceGroup.recentTabIds ?? []).filter((id) => id !== tabId),
          sourceOrder
        )
        const nextGroups = (state.groupsByWorktree[worktreeId] ?? []).map((group) => {
          if (group.id === sourceGroup.id) {
            return {
              ...group,
              activeTabId:
                group.activeTabId === tabId
                  ? // Why: keep MRU-aware selection so the user lands on their previously-focused tab, not a visual neighbor.
                    pickNextActiveTab(
                      dedupedSourceGroupOrder,
                      sourceGroup.recentTabIds,
                      tabId,
                      state.unifiedTabsByWorktree[worktreeId]
                    )
                  : group.activeTabId,
              tabOrder: sourceOrder,
              recentTabIds: sourceRecentTabIds
            }
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
        let filteredGroups = nextGroups
        if (sourceOrder.length === 0) {
          filteredGroups = nextGroups.filter((group) => group.id !== sourceGroup.id)
          collapseGroupLayoutEdit(edit, worktreeId, sourceGroup.id, targetGroupId)
        }
        edit.set('groupsByWorktree', worktreeId, filteredGroups)
        edit.set(
          'unifiedTabsByWorktree',
          worktreeId,
          (state.unifiedTabsByWorktree[worktreeId] ?? []).map((candidate) =>
            candidate.id === tabId ? { ...candidate, groupId: targetGroupId } : candidate
          )
        )
        return edit.finish(
          state.activeWorktreeId === worktreeId
            ? buildActiveSurfacePatch(
                edit,
                worktreeId,
                edit.entry('activeGroupIdByWorktree', worktreeId) ?? null
              )
            : {}
        )
      })
      if (moved && opts?.recordInteraction !== false) {
        get().recordFeatureInteraction?.('tab-splits')
      }
      return moved
    }
  }
}
