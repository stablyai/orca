import { collapseGroupLayoutEdit } from './tab-group-layout-edits'
import { editSessionSource, type SessionSourceEdit } from '../../session-source-edits'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { TabSplitTarget, TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { activeSurfacePatchMatchesState, buildActiveSurfacePatch } from './tabs-surface'
import type { TabGroup } from '../../../../../shared/tab-types'
import {
  buildSplitNode,
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
  edit: SessionSourceEdit<SplitGroupState>,
  worktreeId: string,
  target: TabSplitTarget,
  newGroup: TabGroup
): void {
  const state = edit.view()
  const { sourceGroupId, splitDirection } = target
  const currentLayout =
    state.layoutByWorktree[worktreeId] ?? ({ type: 'leaf', groupId: sourceGroupId } as const)
  const replacement = buildSplitNode(
    sourceGroupId,
    newGroup.id,
    splitDirection === 'left' || splitDirection === 'right' ? 'horizontal' : 'vertical',
    splitDirection === 'left' || splitDirection === 'up' ? 'first' : 'second'
  )
  edit.set('groupsByWorktree', worktreeId, [
    ...(state.groupsByWorktree[worktreeId] ?? []),
    newGroup
  ])
  edit.set('layoutByWorktree', worktreeId, replaceLeaf(currentLayout, sourceGroupId, replacement))
  if (target.activate !== false) {
    edit.set('activeGroupIdByWorktree', worktreeId, newGroup.id)
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
          return undefined
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
        const edit = editSessionSource(state)
        edit.set(
          'groupsByWorktree',
          worktreeId,
          groups.length
            ? groups.map((entry) => (entry.id === groupId ? nextGroup : entry))
            : [nextGroup]
        )
        edit.set(
          'layoutByWorktree',
          worktreeId,
          (orderSlot && state.layoutByWorktree[worktreeId]) || { type: 'leaf', groupId }
        )
        if (!groups.length) {
          edit.set('activeGroupIdByWorktree', worktreeId, groupId)
        }
        return edit.finish()
      })
      return groupId
    },

    focusGroup: (worktreeId, groupId) =>
      set((state) => {
        const groupAlreadyFocused = state.activeGroupIdByWorktree[worktreeId] === groupId
        const edit = editSessionSource(state)
        if (!groupAlreadyFocused) {
          edit.set('activeGroupIdByWorktree', worktreeId, groupId)
        }
        if (state.activeWorktreeId !== worktreeId) {
          return groupAlreadyFocused ? undefined : edit.finish()
        }
        const activeSurfacePatch = buildActiveSurfacePatch(edit, worktreeId, groupId)
        if (
          groupAlreadyFocused &&
          activeSurfacePatchMatchesState(state, worktreeId, {
            ...edit.view(),
            ...activeSurfacePatch
          })
        ) {
          return undefined
        }
        return edit.finish(activeSurfacePatch)
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
        const edit = editSessionSource(current)
        edit.set('groupsByWorktree', worktreeId, remainingGroups)
        collapseGroupLayoutEdit(edit, worktreeId, groupId, remainingGroups[0]?.id ?? null)
        // Retire the closed group's quick-command history.
        const { [groupId]: _droppedRecent, ...remainingRecent } =
          current.recentQuickCommandIdByGroup
        return edit.finish({
          recentQuickCommandIdByGroup: remainingRecent,
          ...(ownsGlobalSelection(current, worktreeId)
            ? buildActiveSurfacePatch(
                edit,
                worktreeId,
                edit.entry('activeGroupIdByWorktree', worktreeId) ?? null
              )
            : {})
        })
      })
      return true
    },

    createEmptySplitGroup: (worktreeId, sourceGroupId, direction, opts) => {
      const newGroupId = createBrowserUuid()
      set((state) => {
        const edit = editSessionSource(state)
        insertSplitGroup(
          edit,
          worktreeId,
          { sourceGroupId, splitDirection: direction, activate: opts?.activate },
          emptySplitGroup(worktreeId, newGroupId)
        )
        return edit.finish()
      })
      get().recordFeatureInteraction?.('terminal-panes')
      return newGroupId
    }
  }
}
