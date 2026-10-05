import { emitNativeChatToggled } from '@/lib/native-chat-telemetry'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { findTabAndWorktree, patchTab, updateGroup, dedupeTabOrder } from '../tab-group-state'
import { applyTabOrderSortValues, partitionPinnedTabOrder } from './tabs-tab-order'
import {
  mirrorTabPinnedToHost,
  mirrorTabViewModeToHost,
  patchTerminalTabRow
} from './tabs-host-mirroring'
import { applyChatPairToState, readTerminalChatPair } from './terminal-chat-pair-state'
import { resolveEffectiveChatPair } from './terminal-chat-pair-effective'
import {
  findHostOwnedTerminalWorktree,
  findStoreOwnedTerminalTab,
  writeHostOwnedChatPair
} from './terminal-chat-pair-routing'
import { locateTerminalTab } from '../../terminals/terminal-tab-location'
import { resolveAgentExitRetirement } from './terminal-chat-exit-retirement'
import { noteTerminalPresentationIntent } from './terminal-presentation-stamp'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'

export function createTabsLabelActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<
  TabsSlice,
  | 'reorderUnifiedTabs'
  | 'setTabLabel'
  | 'applyTerminalChatPair'
  | 'retireTerminalChatForAgentExit'
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
        return state
      })
      if (reordered && opts?.recordInteraction !== false) {
        get().recordFeatureInteraction?.('terminal-tabs')
      }
    },

    setTabLabel: (tabId, label) => {
      set((state) => patchTab(state.unifiedTabsByWorktree, tabId, { label }) ?? state)
    },

    applyTerminalChatPair: (terminalTabId, leafId, mode, options) => {
      const hostWorktreeId = findHostOwnedTerminalWorktree(get(), terminalTabId)
      if (hostWorktreeId) {
        return writeHostOwnedChatPair(
          { getState: get, setState: set },
          hostWorktreeId,
          terminalTabId,
          { leafId, viewMode: mode },
          options
        )
      }
      if (options?.intent) {
        // Why even to the shown value: a user's or client's switch orders after older exits.
        noteTerminalPresentationIntent(terminalTabId)
        // Why: a same-value switch changes no state, yet its new token must reach paired clients.
        scheduleRuntimeGraphSync()
      }
      const toggle: { committed: { from: 'terminal' | 'chat'; to: 'terminal' | 'chat' } | null } = {
        committed: null
      }
      set((state) => {
        const applied = applyChatPairToState(state, terminalTabId, {
          leafId,
          viewMode: mode,
          ownerPickLeafId: options?.ownerPickLeafId
        })
        if (!applied) {
          return state
        }
        if (options?.userToggle && applied.from !== applied.to) {
          toggle.committed = { from: applied.from, to: applied.to }
        }
        return applied.patch
      })
      const { committed } = toggle
      if (committed) {
        const agent = locateTerminalTab(get().tabsByWorktree, terminalTabId)?.tab.launchAgent
        emitNativeChatToggled({ ...committed, agent: agent ?? null })
      }
      return readTerminalChatPair(get(), terminalTabId)
    },

    retireTerminalChatForAgentExit: (terminalTabId, condition) => {
      const outcome: { disposition: ReturnType<typeof resolveAgentExitRetirement>['disposition'] } =
        { disposition: 'missing' }
      // Why inside set: the condition check and the pair + hint patch are one store turn.
      set((state) => {
        const resolved = resolveAgentExitRetirement(state, terminalTabId, condition)
        outcome.disposition = resolved.disposition
        return resolved.patch ?? state
      })
      if (outcome.disposition === 'applied') {
        scheduleRuntimeGraphSync()
      }
      return outcome.disposition
    },

    setTabViewMode: (tabId, mode) => {
      const owned = findStoreOwnedTerminalTab(get(), tabId)
      if (owned) {
        get().applyTerminalChatPair(owned.tab.entityId, null, mode, { intent: true })
        return
      }
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
    },

    toggleTabViewMode: (tabId) => {
      const owned = findStoreOwnedTerminalTab(get(), tabId)
      if (owned) {
        const currentMode =
          owned.authority === 'host'
            ? resolveEffectiveChatPair(get(), owned.worktreeId, owned.tab.entityId).viewMode
            : owned.tab.viewMode
        const nextMode = currentMode === 'chat' ? 'terminal' : 'chat'
        get().applyTerminalChatPair(owned.tab.entityId, null, nextMode, {
          userToggle: true,
          intent: true
        })
        return
      }
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
        const fromMode: 'terminal' | 'chat' = found.tab.viewMode === 'chat' ? 'chat' : 'terminal'
        const nextMode = fromMode === 'chat' ? 'terminal' : 'chat'
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
