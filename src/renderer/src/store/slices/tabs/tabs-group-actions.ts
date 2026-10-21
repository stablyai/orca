import { createBrowserUuid } from '@/lib/browser-uuid'
import type { TabSplitTarget, TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { activeSurfacePatchMatchesState, buildActiveSurfacePatch } from './tabs-surface'
import type { TabGroup } from '../../../../../shared/tab-types'
import {
  buildSplitNode,
  collapseGroupLayout,
  replaceLeaf
} from '../../../../../shared/workspace-layout/tab-group-layout-tree'
import { workspaceRootGroupId } from '../../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { insertTabIdIntoOrder } from '../../../../../shared/workspace-layout/tab-order'
import { resolveUnifiedTabCreatePlacement } from './tabs-create-placement'
import { ownsGlobalSelection } from '../../global-selection-owner'

type SplitGroupState = Pick<
  TabsSlice,
  'groupsByWorktree' | 'layoutByWorktree' | 'activeGroupIdByWorktree'
>

/** Places `newGroup` beside the target's source group; callers that fill it do so in the same update. */
export function insertSplitGroup(
  state: SplitGroupState,
  worktreeId: string,
  target: TabSplitTarget,
  newGroup: TabGroup
): SplitGroupState {
  const { sourceGroupId, splitDirection } = target
  const currentLayout =
    state.layoutByWorktree[worktreeId] ?? ({ type: 'leaf', groupId: sourceGroupId } as const)
  const replacement = buildSplitNode(
    sourceGroupId,
    newGroup.id,
    splitDirection === 'left' || splitDirection === 'right' ? 'horizontal' : 'vertical',
    splitDirection === 'left' || splitDirection === 'up' ? 'first' : 'second'
  )
  return {
    groupsByWorktree: {
      ...state.groupsByWorktree,
      [worktreeId]: [...(state.groupsByWorktree[worktreeId] ?? []), newGroup]
    },
    layoutByWorktree: {
      ...state.layoutByWorktree,
      [worktreeId]: replaceLeaf(currentLayout, sourceGroupId, replacement)
    },
    activeGroupIdByWorktree:
      target.activate === false
        ? state.activeGroupIdByWorktree
        : { ...state.activeGroupIdByWorktree, [worktreeId]: newGroup.id }
  }
}

export function emptySplitGroup(worktreeId: string, groupId: string): TabGroup {
  return { id: groupId, worktreeId, activeTabId: null, tabOrder: [] }
}

export function createTabsGroupActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<
  TabsSlice,
  'ensureWorktreeRootGroup' | 'focusGroup' | 'closeEmptyGroup' | 'createEmptySplitGroup'
> {
  return {
    ensureWorktreeRootGroup: (worktreeId, orderSlot) => {
      const existingGroups = get().groupsByWorktree[worktreeId] ?? []
      if (!orderSlot && existingGroups.length > 0) {
        return get().activeGroupIdByWorktree[worktreeId] ?? existingGroups[0].id
      }

      let groupId = workspaceRootGroupId(worktreeId)
      set((state) => {
        const groups = state.groupsByWorktree[worktreeId] ?? []
        const reserved =
          orderSlot && groups.find((group) => group.tabOrder.includes(orderSlot.tabId))
        if (reserved) {
          groupId = reserved.id
          return state
        }
        const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
        const placement = resolveUnifiedTabCreatePlacement({
          groups,
          tabs,
          activeGroupId: state.activeGroupIdByWorktree[worktreeId],
          targetGroupId: orderSlot?.targetGroupId,
          lookupWorktrees: () => []
        })
        const group =
          groups.find((entry) => entry.id === placement.groupId) ??
          groups[0] ??
          emptySplitGroup(worktreeId, groupId)
        groupId = group.id
        let tabOrder = group.tabOrder
        if (orderSlot) {
          const { tabId, precedingTabIds } = orderSlot
          const preceding = new Set(precedingTabIds)
          const anchor = tabOrder.findLast((id) => preceding.has(id))
          tabOrder = insertTabIdIntoOrder(tabOrder, tabs, tabId, false, anchor)
          if (!anchor && precedingTabIds.length === 0) {
            tabOrder.splice(tabOrder.indexOf(tabId), 1)
            const firstUnpinned = tabOrder.findIndex(
              (id) => !tabs.find((tab) => tab.id === id)?.isPinned
            )
            tabOrder.splice(firstUnpinned === -1 ? tabOrder.length : firstUnpinned, 0, tabId)
          }
        }
        // A new root and its first order member must become observable together.
        const nextGroup = { ...group, tabOrder }
        return {
          groupsByWorktree: {
            ...state.groupsByWorktree,
            [worktreeId]: groups.length
              ? groups.map((entry) => (entry.id === groupId ? nextGroup : entry))
              : [nextGroup]
          },
          layoutByWorktree: {
            ...state.layoutByWorktree,
            [worktreeId]: (orderSlot && state.layoutByWorktree[worktreeId]) || {
              type: 'leaf',
              groupId
            }
          },
          activeGroupIdByWorktree: groups.length
            ? state.activeGroupIdByWorktree
            : {
                ...state.activeGroupIdByWorktree,
                [worktreeId]: groupId
              }
        }
      })
      return groupId
    },

    focusGroup: (worktreeId, groupId) =>
      set((state) => {
        const groupAlreadyFocused = state.activeGroupIdByWorktree[worktreeId] === groupId
        const nextActiveGroupIdByWorktree = groupAlreadyFocused
          ? state.activeGroupIdByWorktree
          : {
              ...state.activeGroupIdByWorktree,
              [worktreeId]: groupId
            }
        // Why: focusing a group surfaces its active terminal tab, so dismiss the tab-level bell.
        // Why (activeWorktree guard below): only when the group is in the active worktree, else the unseen tab's bell is swallowed.
        if (state.activeWorktreeId !== worktreeId) {
          if (groupAlreadyFocused) {
            return state
          }
          return {
            activeGroupIdByWorktree: nextActiveGroupIdByWorktree
          }
        }
        const activeSurfacePatch = buildActiveSurfacePatch(
          {
            ...state,
            activeGroupIdByWorktree: nextActiveGroupIdByWorktree
          },
          worktreeId,
          groupId
        )
        if (
          groupAlreadyFocused &&
          activeSurfacePatchMatchesState(state, worktreeId, activeSurfacePatch)
        ) {
          return state
        }
        return {
          ...(groupAlreadyFocused ? {} : { activeGroupIdByWorktree: nextActiveGroupIdByWorktree }),
          ...activeSurfacePatch
        }
      }),

    closeEmptyGroup: (worktreeId, groupId) => {
      const state = get()
      const group = (state.groupsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.id === groupId
      )
      const realIds = new Set((state.unifiedTabsByWorktree[worktreeId] ?? []).map((tab) => tab.id))
      if (!group || group.tabOrder.some((id) => realIds.has(id))) {
        return false
      }
      set((current) => {
        const remainingGroups = (current.groupsByWorktree[worktreeId] ?? []).filter(
          (candidate) => candidate.id !== groupId
        )
        const collapsedState = collapseGroupLayout(
          current.layoutByWorktree,
          current.activeGroupIdByWorktree,
          worktreeId,
          groupId,
          remainingGroups[0]?.id ?? null
        )
        // Why: drop the dead group's recent-quick-command entry so the map can't grow unbounded as groups open/close.
        const { [groupId]: _droppedRecent, ...remainingRecent } =
          current.recentQuickCommandIdByGroup
        return {
          groupsByWorktree: { ...current.groupsByWorktree, [worktreeId]: remainingGroups },
          layoutByWorktree: collapsedState.layoutByWorktree,
          activeGroupIdByWorktree: collapsedState.activeGroupIdByWorktree,
          recentQuickCommandIdByGroup: remainingRecent,
          ...(ownsGlobalSelection(current, worktreeId)
            ? buildActiveSurfacePatch(
                {
                  ...current,
                  groupsByWorktree: {
                    ...current.groupsByWorktree,
                    [worktreeId]: remainingGroups
                  },
                  layoutByWorktree: collapsedState.layoutByWorktree,
                  activeGroupIdByWorktree: collapsedState.activeGroupIdByWorktree
                },
                worktreeId,
                collapsedState.activeGroupIdByWorktree[worktreeId] ?? null
              )
            : {})
        }
      })
      return true
    },

    createEmptySplitGroup: (worktreeId, sourceGroupId, direction, opts) => {
      const newGroupId = createBrowserUuid()
      set((state) =>
        insertSplitGroup(
          state,
          worktreeId,
          { sourceGroupId, splitDirection: direction, activate: opts?.activate },
          emptySplitGroup(worktreeId, newGroupId)
        )
      )
      get().recordFeatureInteraction?.('terminal-panes')
      return newGroupId
    }
  }
}
