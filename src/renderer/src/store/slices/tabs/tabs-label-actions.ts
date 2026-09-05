import { emitNativeChatToggled } from '@/lib/native-chat-telemetry'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { findTabAndWorktree, patchTab, updateGroup, dedupeTabOrder } from '../tab-group-state'
import { applyTabOrderSortValues, partitionPinnedTabOrder } from './tabs-tab-order'
import {
  mirrorTabPinnedToHost,
  mirrorTabViewModeToHost,
  patchTerminalTabPinned
} from './tabs-host-mirroring'

export function createTabsLabelActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<
  TabsSlice,
  | 'reorderUnifiedTabs'
  | 'setTabLabel'
  | 'setTabViewMode'
  | 'toggleTabViewMode'
  | 'setTabCustomLabel'
  | 'setUnifiedTabColor'
  | 'pinTab'
  | 'unpinTab'
> {
  return {
    reorderUnifiedTabs: (groupId, tabIds, opts) => {
      let reordered = false
      set((state) => {
        for (const [worktreeId, groups] of Object.entries(state.groupsByWorktree)) {
          const group = groups.find((candidate) => candidate.id === groupId)
          if (!group) {
            continue
          }
          // Why: dedupe at the store boundary so each tab keeps one canonical position and later group ops don't branch on duplicate ids.
          const nextTabOrder = dedupeTabOrder(tabIds)
          reordered = true
          const orderMap = new Map(nextTabOrder.map((id, index) => [id, index]))
          return {
            groupsByWorktree: {
              ...state.groupsByWorktree,
              [worktreeId]: updateGroup(groups, { ...group, tabOrder: nextTabOrder })
            },
            unifiedTabsByWorktree: {
              ...state.unifiedTabsByWorktree,
              [worktreeId]: (state.unifiedTabsByWorktree[worktreeId] ?? []).map((tab) => {
                const sortOrder = orderMap.get(tab.id)
                return sortOrder === undefined ? tab : { ...tab, sortOrder }
              })
            }
          }
        }
        return {}
      })
      if (reordered && opts?.recordInteraction !== false) {
        get().recordFeatureInteraction?.('terminal-tabs')
      }
    },

    setTabLabel: (tabId, label) => {
      set((state) => patchTab(state.unifiedTabsByWorktree, tabId, { label }) ?? {})
    },

    setTabViewMode: (tabId, mode) => {
      set((state) => patchTab(state.unifiedTabsByWorktree, tabId, { viewMode: mode }) ?? {})
      mirrorTabViewModeToHost(get(), tabId, mode)
    },

    toggleTabViewMode: (tabId) => {
      let toggled: {
        from: 'terminal' | 'chat'
        to: 'terminal' | 'chat'
        agent: TuiAgent | null
      } | null = null
      set((state) => {
        const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
        if (!found) {
          return {}
        }
        // Why: viewMode defaults to 'terminal' for legacy/missing, so the first toggle flips to 'chat'.
        const fromMode: 'terminal' | 'chat' = found.tab.viewMode === 'chat' ? 'chat' : 'terminal'
        const nextMode = fromMode === 'chat' ? 'terminal' : 'chat'
        // Why: launchAgent lives on the legacy terminal tab (keyed by entityId); resolve it here so toggle telemetry can attribute by agent.
        const agent =
          (state.tabsByWorktree[found.worktreeId] ?? []).find(
            (terminal) => terminal.id === found.tab.entityId
          )?.launchAgent ?? null
        toggled = { from: fromMode, to: nextMode, agent }
        return patchTab(state.unifiedTabsByWorktree, tabId, { viewMode: nextMode }) ?? {}
      })
      // Why: emit after the state write so the event reflects the committed mode.
      const committed = toggled as {
        from: 'terminal' | 'chat'
        to: 'terminal' | 'chat'
        agent: TuiAgent | null
      } | null
      if (committed) {
        emitNativeChatToggled(committed)
        mirrorTabViewModeToHost(get(), tabId, committed.to)
      }
    },

    setTabCustomLabel: (tabId, label, opts) => {
      const exists = get().getTab(tabId) !== null
      set((state) => patchTab(state.unifiedTabsByWorktree, tabId, { customLabel: label }) ?? {})
      if (exists && opts?.recordInteraction !== false) {
        get().recordFeatureInteraction?.('terminal-tabs')
      }
    },

    setUnifiedTabColor: (tabId, color) => {
      const exists = get().getTab(tabId) !== null
      set((state) => patchTab(state.unifiedTabsByWorktree, tabId, { color }) ?? {})
      if (exists) {
        get().recordFeatureInteraction?.('terminal-tabs')
      }
    },

    pinTab: (tabId) => {
      const exists = get().getTab(tabId) !== null
      set((state) => {
        const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
        if (!found) {
          return {}
        }
        const { tab, worktreeId } = found
        const tabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).map((candidate) =>
          candidate.id === tabId ? { ...candidate, isPinned: true, isPreview: false } : candidate
        )
        const groups = state.groupsByWorktree[worktreeId] ?? []
        const group = groups.find((candidate) => candidate.id === tab.groupId)
        if (!group) {
          return {
            unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, [worktreeId]: tabs }
          }
        }
        const tabOrder = partitionPinnedTabOrder(group.tabOrder, tabs, tabId)
        return {
          unifiedTabsByWorktree: {
            ...state.unifiedTabsByWorktree,
            [worktreeId]: applyTabOrderSortValues(tabs, tabOrder)
          },
          // Why: reconcile derives pin from the TerminalTab, so mirror it there too or a host snapshot recomputes isPinned:false and un-pins during the echo window.
          ...patchTerminalTabPinned(state.tabsByWorktree, worktreeId, tabId, true),
          groupsByWorktree: {
            ...state.groupsByWorktree,
            [worktreeId]: updateGroup(groups, { ...group, tabOrder })
          }
        }
      })
      mirrorTabPinnedToHost(get(), tabId, true)
      if (exists) {
        get().recordFeatureInteraction?.('terminal-tabs')
      }
    },

    unpinTab: (tabId) => {
      const exists = get().getTab(tabId) !== null
      set((state) => {
        const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
        if (!found) {
          return {}
        }
        const { tab, worktreeId } = found
        const tabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).map((candidate) =>
          candidate.id === tabId ? { ...candidate, isPinned: false } : candidate
        )
        const groups = state.groupsByWorktree[worktreeId] ?? []
        const group = groups.find((candidate) => candidate.id === tab.groupId)
        if (!group) {
          return {
            unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, [worktreeId]: tabs }
          }
        }
        const tabOrder = partitionPinnedTabOrder(group.tabOrder, tabs, tabId)
        return {
          unifiedTabsByWorktree: {
            ...state.unifiedTabsByWorktree,
            [worktreeId]: applyTabOrderSortValues(tabs, tabOrder)
          },
          ...patchTerminalTabPinned(state.tabsByWorktree, worktreeId, tabId, false),
          groupsByWorktree: {
            ...state.groupsByWorktree,
            [worktreeId]: updateGroup(groups, { ...group, tabOrder })
          }
        }
      })
      mirrorTabPinnedToHost(get(), tabId, false)
      if (exists) {
        get().recordFeatureInteraction?.('terminal-tabs')
      }
    }
  }
}
