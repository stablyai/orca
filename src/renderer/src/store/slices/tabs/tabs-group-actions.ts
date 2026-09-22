import { createBrowserUuid } from '@/lib/browser-uuid'
import type { TabGroup } from '../../../../../shared/tab-types'
import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { activeSurfacePatchMatchesState, buildActiveSurfacePatch } from './tabs-surface'
import { buildSplitNode, collapseGroupLayout, replaceLeaf } from './tabs-layout'

export function createTabsGroupActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<
  TabsSlice,
  'ensureWorktreeRootGroup' | 'focusGroup' | 'closeEmptyGroup' | 'createEmptySplitGroup'
> {
  return {
    ensureWorktreeRootGroup: (worktreeId) => {
      const existingGroups = get().groupsByWorktree[worktreeId] ?? []
      if (existingGroups.length > 0) {
        return get().activeGroupIdByWorktree[worktreeId] ?? existingGroups[0].id
      }

      const groupId = createBrowserUuid()
      set((state) => ({
        // Why: a zero-tab worktree still needs a canonical root group so new tabs and splits land in a deterministic place.
        groupsByWorktree: {
          ...state.groupsByWorktree,
          [worktreeId]: [{ id: groupId, worktreeId, activeTabId: null, tabOrder: [] }]
        },
        layoutByWorktree: {
          ...state.layoutByWorktree,
          [worktreeId]: { type: 'leaf', groupId }
        },
        activeGroupIdByWorktree: {
          ...state.activeGroupIdByWorktree,
          [worktreeId]: groupId
        }
      }))
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
        const groups = state.groupsByWorktree[worktreeId] ?? []
        const unifiedTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
        const visibleTerminalEntityIds = new Set(
          groups
            .map((group) =>
              group.activeTabId ? unifiedTabs.find((tab) => tab.id === group.activeTabId) : null
            )
            .filter((tab): tab is (typeof unifiedTabs)[number] => tab?.contentType === 'terminal')
            .map((tab) => tab.entityId)
        )
        const nextUnreadTerminalTabs =
          visibleTerminalEntityIds.size > 0
            ? (() => {
                let changed = false
                const copy = { ...state.unreadTerminalTabs }
                for (const terminalEntityId of visibleTerminalEntityIds) {
                  if (!copy[terminalEntityId]) {
                    continue
                  }
                  delete copy[terminalEntityId]
                  changed = true
                }
                return changed ? copy : state.unreadTerminalTabs
              })()
            : state.unreadTerminalTabs
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
          nextUnreadTerminalTabs === state.unreadTerminalTabs &&
          activeSurfacePatchMatchesState(state, worktreeId, activeSurfacePatch)
        ) {
          return state
        }
        return {
          ...(groupAlreadyFocused ? {} : { activeGroupIdByWorktree: nextActiveGroupIdByWorktree }),
          // Why: only write unreadTerminalTabs when it changed — preserving the reference keeps selectors/subscribers from firing spuriously.
          ...(nextUnreadTerminalTabs !== state.unreadTerminalTabs
            ? { unreadTerminalTabs: nextUnreadTerminalTabs }
            : {}),
          ...activeSurfacePatch
        }
      }),

    closeEmptyGroup: (worktreeId, groupId) => {
      const state = get()
      const group = (state.groupsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.id === groupId
      )
      if (!group || group.tabOrder.length > 0) {
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
          ...(current.activeWorktreeId === worktreeId
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
      const newGroup: TabGroup = {
        id: newGroupId,
        worktreeId,
        activeTabId: null,
        tabOrder: []
      }
      const shouldActivate = opts?.activate !== false
      set((state) => {
        const existing = state.groupsByWorktree[worktreeId] ?? []
        const currentLayout =
          state.layoutByWorktree[worktreeId] ?? ({ type: 'leaf', groupId: sourceGroupId } as const)
        const replacement = buildSplitNode(
          sourceGroupId,
          newGroupId,
          direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical',
          direction === 'left' || direction === 'up' ? 'first' : 'second'
        )
        return {
          groupsByWorktree: { ...state.groupsByWorktree, [worktreeId]: [...existing, newGroup] },
          layoutByWorktree: {
            ...state.layoutByWorktree,
            [worktreeId]: replaceLeaf(currentLayout, sourceGroupId, replacement)
          },
          ...(shouldActivate
            ? {
                activeGroupIdByWorktree: {
                  ...state.activeGroupIdByWorktree,
                  [worktreeId]: newGroupId
                }
              }
            : {})
        }
      })
      get().recordFeatureInteraction?.('terminal-panes')
      return newGroupId
    }
  }
}
