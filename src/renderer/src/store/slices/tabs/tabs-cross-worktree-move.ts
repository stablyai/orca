import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { collapseGroupLayout } from '../../../../../shared/workspace-layout/tab-group-layout-tree'
import { buildActiveSurfacePatch } from './tabs-surface'
import {
  ensureGroup,
  findGroupForTab,
  findTabAndWorktree,
  pickNextActiveTab,
  pushRecentTabId,
  sanitizeRecentTabIds,
  updateGroup
} from '../tab-group-state'
import { dedupeTabOrder } from '../../../../../shared/workspace-layout/tab-order'

export function createMoveTabToWorktreeAction(
  set: TabsSliceSet,
  get: TabsSliceGet
): TabsSlice['moveTabToWorktree'] {
  return (tabId, targetWorktreeId, opts) => {
    let moved = false
    set((state) => {
      if (!targetWorktreeId) {
        return state
      }
      let foundTab = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
      if (!foundTab) {
        for (const [wtId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
          const byEntity = tabs.find((candidate) => candidate.entityId === tabId)
          if (byEntity) {
            foundTab = { tab: byEntity, worktreeId: wtId }
            break
          }
        }
      }
      if (!foundTab || foundTab.worktreeId === targetWorktreeId) {
        return state
      }

      const { tab, worktreeId: sourceWorktreeId } = foundTab
      const unifiedTabId = tab.id
      const sourceGroups = state.groupsByWorktree[sourceWorktreeId] ?? []
      const sourceGroup = findGroupForTab(state.groupsByWorktree, sourceWorktreeId, tab.groupId)

      moved = true

      let nextSourceGroups = sourceGroups
      let nextLayoutByWorktree = { ...state.layoutByWorktree }
      let nextActiveGroupIdByWorktree = { ...state.activeGroupIdByWorktree }

      if (sourceGroup) {
        const dedupedSourceOrder = dedupeTabOrder(sourceGroup.tabOrder)
        const sourceOrder = dedupeTabOrder(dedupedSourceOrder.filter((id) => id !== unifiedTabId))
        const sourceRecentTabIds = sanitizeRecentTabIds(
          (sourceGroup.recentTabIds ?? []).filter((id) => id !== unifiedTabId),
          sourceOrder
        )
        const nextSourceActiveTabId =
          sourceGroup.activeTabId === unifiedTabId
            ? pickNextActiveTab(
                dedupedSourceOrder,
                sourceGroup.recentTabIds,
                unifiedTabId,
                state.unifiedTabsByWorktree[sourceWorktreeId]
              )
            : sourceGroup.activeTabId

        nextSourceGroups = sourceGroups.map((group) =>
          group.id === sourceGroup.id
            ? {
                ...group,
                activeTabId: nextSourceActiveTabId,
                tabOrder: sourceOrder,
                recentTabIds: sourceRecentTabIds
              }
            : group
        )

        if (sourceOrder.length === 0 && sourceGroups.length > 1) {
          const fallbackGroup = sourceGroups.find((g) => g.id !== sourceGroup.id)
          if (fallbackGroup) {
            nextSourceGroups = nextSourceGroups.filter((g) => g.id !== sourceGroup.id)
            const collapsed = collapseGroupLayout(
              nextLayoutByWorktree,
              nextActiveGroupIdByWorktree,
              sourceWorktreeId,
              sourceGroup.id,
              fallbackGroup.id
            )
            nextLayoutByWorktree = collapsed.layoutByWorktree
            nextActiveGroupIdByWorktree = collapsed.activeGroupIdByWorktree
          }
        }
      }

      const baseGroupsByWorktree = {
        ...state.groupsByWorktree,
        [sourceWorktreeId]: nextSourceGroups
      }
      const ensured = ensureGroup(
        baseGroupsByWorktree,
        nextActiveGroupIdByWorktree,
        targetWorktreeId,
        nextActiveGroupIdByWorktree[targetWorktreeId]
      )
      const targetGroup = ensured.group
      const nextTargetOrder = dedupeTabOrder([
        ...targetGroup.tabOrder.filter((id) => id !== unifiedTabId),
        unifiedTabId
      ])
      const nextTargetRecent = pushRecentTabId(
        sanitizeRecentTabIds(targetGroup.recentTabIds, nextTargetOrder),
        unifiedTabId
      )
      const updatedTargetGroups = updateGroup(
        ensured.groupsByWorktree[targetWorktreeId] ?? [targetGroup],
        {
          ...targetGroup,
          activeTabId: unifiedTabId,
          tabOrder: nextTargetOrder,
          recentTabIds: nextTargetRecent
        }
      )
      const nextGroupsByWorktree = {
        ...ensured.groupsByWorktree,
        [targetWorktreeId]: updatedTargetGroups
      }
      nextActiveGroupIdByWorktree = {
        ...ensured.activeGroupIdByWorktree,
        [targetWorktreeId]: targetGroup.id
      }
      if (!nextLayoutByWorktree[targetWorktreeId]) {
        nextLayoutByWorktree[targetWorktreeId] = {
          type: 'leaf',
          groupId: targetGroup.id
        }
      }

      const movedUnifiedTab = {
        ...tab,
        worktreeId: targetWorktreeId,
        groupId: targetGroup.id
      }
      const sourceUnifiedTabs = (state.unifiedTabsByWorktree[sourceWorktreeId] ?? []).filter(
        (candidate) => candidate.id !== unifiedTabId
      )
      const targetUnifiedTabs = [
        ...(state.unifiedTabsByWorktree[targetWorktreeId] ?? []).filter(
          (candidate) => candidate.id !== unifiedTabId
        ),
        movedUnifiedTab
      ]
      const nextUnifiedTabsByWorktree = {
        ...state.unifiedTabsByWorktree,
        [sourceWorktreeId]: sourceUnifiedTabs,
        [targetWorktreeId]: targetUnifiedTabs
      }

      let nextTabsByWorktree = state.tabsByWorktree
      let nextActiveTabIdByWorktree = state.activeTabIdByWorktree
      let nextTabBarOrderByWorktree = state.tabBarOrderByWorktree
      let nextGlobalActiveTabId = state.activeTabId

      const sourceTerminalTabs = state.tabsByWorktree?.[sourceWorktreeId] ?? []
      const terminalTab = sourceTerminalTabs.find(
        (candidate) => candidate.id === tab.entityId || candidate.id === unifiedTabId
      )
      if (terminalTab) {
        const remainingSourceTerminals = sourceTerminalTabs.filter(
          (candidate) => candidate.id !== terminalTab.id
        )
        const existingTargetTerminals = (state.tabsByWorktree?.[targetWorktreeId] ?? []).filter(
          (candidate) => candidate.id !== terminalTab.id
        )
        const movedTerminalTab = {
          ...terminalTab,
          worktreeId: targetWorktreeId,
          sortOrder: existingTargetTerminals.length
        }
        nextTabsByWorktree = {
          ...state.tabsByWorktree,
          [sourceWorktreeId]: remainingSourceTerminals,
          [targetWorktreeId]: [...existingTargetTerminals, movedTerminalTab]
        }
        const prevSourceActiveTerm = state.activeTabIdByWorktree?.[sourceWorktreeId]
        const nextSourceActiveTerm =
          prevSourceActiveTerm === terminalTab.id
            ? (remainingSourceTerminals.at(-1)?.id ?? null)
            : (prevSourceActiveTerm ?? null)
        nextActiveTabIdByWorktree = {
          ...state.activeTabIdByWorktree,
          [sourceWorktreeId]: nextSourceActiveTerm,
          [targetWorktreeId]: terminalTab.id
        }
        if (
          state.tabBarOrderByWorktree?.[sourceWorktreeId] ||
          state.tabBarOrderByWorktree?.[targetWorktreeId]
        ) {
          nextTabBarOrderByWorktree = {
            ...state.tabBarOrderByWorktree,
            [sourceWorktreeId]: (state.tabBarOrderByWorktree?.[sourceWorktreeId] ?? []).filter(
              (id) => id !== terminalTab.id
            ),
            [targetWorktreeId]: dedupeTabOrder([
              ...(state.tabBarOrderByWorktree?.[targetWorktreeId] ?? []).filter(
                (id) => id !== terminalTab.id
              ),
              terminalTab.id
            ])
          }
        }
        if (opts?.activateWorktree !== false) {
          nextGlobalActiveTabId = terminalTab.id
        } else if (state.activeTabId === terminalTab.id) {
          nextGlobalActiveTabId = nextSourceActiveTerm
        }
      }

      const shouldActivateWorktree = opts?.activateWorktree !== false
      const nextActiveWorktreeId = shouldActivateWorktree
        ? targetWorktreeId
        : state.activeWorktreeId
      const surfaceWorktreeId = nextActiveWorktreeId ?? targetWorktreeId
      const surfaceGroupId = nextActiveGroupIdByWorktree[surfaceWorktreeId] ?? null

      const basePatch = {
        unifiedTabsByWorktree: nextUnifiedTabsByWorktree,
        groupsByWorktree: nextGroupsByWorktree,
        layoutByWorktree: nextLayoutByWorktree,
        activeGroupIdByWorktree: nextActiveGroupIdByWorktree,
        tabsByWorktree: nextTabsByWorktree,
        activeTabIdByWorktree: nextActiveTabIdByWorktree,
        tabBarOrderByWorktree: nextTabBarOrderByWorktree,
        activeTabId: nextGlobalActiveTabId,
        ...(shouldActivateWorktree ? { activeWorktreeId: targetWorktreeId } : {})
      }

      return {
        ...basePatch,
        ...(nextActiveWorktreeId
          ? buildActiveSurfacePatch(
              {
                ...state,
                ...basePatch
              },
              surfaceWorktreeId,
              surfaceGroupId
            )
          : {})
      }
    })
    if (moved && opts?.recordInteraction !== false) {
      get().recordFeatureInteraction?.('terminal-tabs')
    }
    return moved
  }
}
