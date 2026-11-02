import { emitNativeChatToggled } from '@/lib/native-chat-telemetry'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { findTabAndWorktree, patchTab, updateGroup } from '../tab-group-state'
import {
  applyTabOrderSortValues,
  dedupeTabOrder,
  partitionPinnedTabOrder
} from '../../../../../shared/workspace-layout/tab-order'
import {
  mirrorTabPinnedToHost,
  mirrorTabViewModeToHost,
  patchTerminalTabRow
} from './tabs-host-mirroring'
import { sendTabChangeToLayoutOwner } from '../../terminals/tab-change-through-layout-owner'
import { recordTabOrderInLayoutOwner } from './tab-order-layout-owner'
import { withPreviewEnded } from './tab-preview-flag'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'

function oppositeViewMode(mode: 'terminal' | 'chat'): 'terminal' | 'chat' {
  return mode === 'chat' ? 'terminal' : 'chat'
}

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
  function setTabViewModeHere(tabId: string, mode: 'terminal' | 'chat'): void {
    set((state) => {
      const tabPatch = patchTab(state.unifiedTabsByWorktree, tabId, { viewMode: mode })
      const rowPatch = patchTerminalTabRow(state.tabsByWorktree, tabId, { viewMode: mode })
      if (!tabPatch && !rowPatch.tabsByWorktree) {
        return state
      }
      return {
        ...tabPatch,
        // Why the row too: viewMode is declared on both types and host-sync
        // already writes it to the row. Only these local toggles skipped it, so
        // readers had to OR the two indices to find out who owns the surface.
        ...rowPatch
      }
    })
    mirrorTabViewModeToHost(get(), tabId, mode)
  }

  /** `to`: the mode main switched to, which a frame may already show. */
  function toggleTabViewModeHere(tabId: string, to?: 'terminal' | 'chat'): void {
    let toggled: {
      from: 'terminal' | 'chat'
      to: 'terminal' | 'chat'
      agent: TuiAgent | null
    } | null = null
    set((state) => {
      const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
      if (!found) {
        return state
      }
      // Why: viewMode defaults to 'terminal' for legacy/missing, so the first toggle flips to 'chat'.
      const fromMode: 'terminal' | 'chat' = to
        ? oppositeViewMode(to)
        : found.tab.viewMode === 'chat'
          ? 'chat'
          : 'terminal'
      const nextMode = oppositeViewMode(fromMode)
      // Why: launchAgent lives on the legacy terminal tab (keyed by entityId); resolve it here so toggle telemetry can attribute by agent.
      const agent =
        (state.tabsByWorktree[found.worktreeId] ?? []).find(
          (terminal) => terminal.id === found.tab.entityId
        )?.launchAgent ?? null
      toggled = { from: fromMode, to: nextMode, agent }
      return {
        ...patchTab(state.unifiedTabsByWorktree, tabId, { viewMode: nextMode }),
        ...patchTerminalTabRow(state.tabsByWorktree, tabId, { viewMode: nextMode })
      }
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
  }

  /** Tab-bar id → the mode last sent to main and not yet answered: a toggle flips from that. */
  const viewModeSent = new Map<string, { mode: 'terminal' | 'chat' }>()

  function sendViewMode(tabId: string, mode: 'terminal' | 'chat', local: () => void): boolean {
    const state = get()
    // Why an object: only this send's answer clears its entry, not an earlier send's of the same mode.
    const entry = { mode }
    const settle = (): void => {
      if (viewModeSent.get(tabId) === entry) {
        viewModeSent.delete(tabId)
      }
    }
    const sent = sendTabChangeToLayoutOwner(
      state,
      findTabAndWorktree(state.unifiedTabsByWorktree, tabId)?.tab,
      (id) => ({ type: 'setTabProps', tabId: id, viewMode: mode }),
      () => {
        settle()
        local()
      },
      settle
    )
    if (sent) {
      viewModeSent.set(tabId, entry)
    }
    return sent
  }

  function sendViewModeToggle(tabId: string): boolean {
    const shown = findTabAndWorktree(get().unifiedTabsByWorktree, tabId)?.tab.viewMode
    const to = oppositeViewMode(
      viewModeSent.get(tabId)?.mode ?? (shown === 'chat' ? 'chat' : 'terminal')
    )
    return sendViewMode(tabId, to, () => toggleTabViewModeHere(tabId, to))
  }

  return {
    reorderUnifiedTabs: (groupId, tabIds, opts) => {
      let reordered = false
      const changes: { worktreeId: string; from: string[]; to: string[] }[] = []
      set((state) => {
        for (const [worktreeId, groups] of Object.entries(state.groupsByWorktree)) {
          const group = groups.find((candidate) => candidate.id === groupId)
          if (!group) {
            continue
          }
          // Why: dedupe at the store boundary so each tab keeps one canonical position and later group ops don't branch on duplicate ids.
          const nextTabOrder = dedupeTabOrder(tabIds)
          reordered = true
          changes.push({ worktreeId, from: group.tabOrder, to: nextTabOrder })
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
        return state
      })
      // Switch point: main takes the window's new order unless the caller already asked it.
      if (ORCA_LAYOUT_OWNER_IS_MAIN && !opts?.layoutOwnerHandled) {
        for (const change of changes) {
          recordTabOrderInLayoutOwner(get(), groupId, change)
        }
      }
      if (reordered && opts?.recordInteraction !== false) {
        get().recordFeatureInteraction?.('terminal-tabs')
      }
    },

    setTabLabel: (tabId, label) => {
      set((state) => patchTab(state.unifiedTabsByWorktree, tabId, { label }) ?? state)
    },

    setTabViewMode: (tabId, mode) => {
      const local = (): void => setTabViewModeHere(tabId, mode)
      // Switch point: main switches its copy first, then the window shows the same mode.
      if (!ORCA_LAYOUT_OWNER_IS_MAIN || !sendViewMode(tabId, mode, local)) {
        local()
      }
    },

    toggleTabViewMode: (tabId) => {
      // Switch point: as setTabViewMode, with the mode chosen before main is asked.
      if (!ORCA_LAYOUT_OWNER_IS_MAIN || !sendViewModeToggle(tabId)) {
        toggleTabViewModeHere(tabId)
      }
    },

    setTabCustomLabel: (tabId, label, opts) => {
      const exists = get().getTab(tabId) !== null
      set((state) => patchTab(state.unifiedTabsByWorktree, tabId, { customLabel: label }) ?? state)
      if (exists && opts?.recordInteraction !== false) {
        get().recordFeatureInteraction?.('terminal-tabs')
      }
    },

    setUnifiedTabColor: (tabId, color) => {
      const exists = get().getTab(tabId) !== null
      set((state) => patchTab(state.unifiedTabsByWorktree, tabId, { color }) ?? state)
      if (exists) {
        get().recordFeatureInteraction?.('terminal-tabs')
      }
    },

    pinTab: (tabId) => {
      const exists = get().getTab(tabId) !== null
      set((state) => {
        const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
        if (!found) {
          return state
        }
        const { tab, worktreeId } = found
        const tabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).map((candidate) =>
          candidate.id === tabId ? withPreviewEnded({ ...candidate, isPinned: true }) : candidate
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
          ...patchTerminalTabRow(state.tabsByWorktree, tabId, { isPinned: true }),
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
          return state
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
          ...patchTerminalTabRow(state.tabsByWorktree, tabId, { isPinned: false }),
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
