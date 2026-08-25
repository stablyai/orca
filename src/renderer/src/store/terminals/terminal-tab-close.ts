import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { sweepRetiredTerminalTabState } from '../slices/retired-terminal-tab-state-sweep'
import {
  getRecentlyClosedTabPosition,
  pushClosedTerminalTabSnapshot,
  pushRecentlyClosedTabKind
} from '../slices/recently-closed-tabs'
// Why: use the store-free registry (not terminal-parked-tab-watchers, which imports @/store) to avoid re-entering store creation during this slice's eval.
import { retireParkedTerminalTab } from '@/components/terminal-pane/terminal-parked-watcher-registry'
import {
  buildTerminalTabRetirementPlan,
  removeSleepingAgentSessionsForTab
} from '../slices/terminal-tab-retirement'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { startTerminalTabProviderRetirement } from './terminal-tab-close-providers'

export function createTerminalTabCloseActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'closeTab'> {
  return {
    closeTab: (tabId, opts) => {
      const closeReason = opts?.reason ?? 'user'
      const retiresSession = closeReason === 'user' || closeReason === 'cleanup'
      const retirementPlan =
        opts?.precomputedRetirementPlan?.tabId === tabId
          ? opts.precomputedRetirementPlan
          : buildTerminalTabRetirementPlan(get(), tabId)
      let closingWorktreeId: string | null = null
      // Why: a parked tab has no mounted TerminalPane cleanup, so revoke its observer/candidate state before provider exit races.
      retireParkedTerminalTab(tabId)
      if (retiresSession) {
        startTerminalTabProviderRetirement({
          localPtyTeardownOwnedExternally: opts?.localPtyTeardownOwnedExternally === true,
          remoteCloseOwnedByHost: opts?.remoteCloseOwnedByHost === true,
          retirementPlan,
          state: get(),
          tabId
        })
      }
      set((s) => {
        const next = { ...s.tabsByWorktree }
        let closedTab: TerminalTab | null = null
        let closedWorktreeId: string | null = null
        for (const wId of Object.keys(next)) {
          const before = next[wId]
          const closing = before.find((t) => t.id === tabId)
          if (closing) {
            closingWorktreeId = wId
            // Why: capture the first-matched tab's snapshot for the Cmd+Shift+T reopen stack (see capturedSnapshot below).
            if (!closedTab) {
              closedTab = closing
              closedWorktreeId = wId
            }
          }
          const after = before.filter((t) => t.id !== tabId)
          if (after.length !== before.length) {
            next[wId] = after
          }
        }
        // Why: only explicit user closes feed the Cmd+Shift+T reopen stack; cleanup/PTY-exit closes must not pollute undo history.
        const closedPosition =
          closedWorktreeId && closedTab
            ? getRecentlyClosedTabPosition(s, closedWorktreeId, closedTab.id)
            : undefined
        const capturedSnapshot =
          closeReason === 'user' &&
          opts?.captureRecentlyClosed !== false &&
          closedTab &&
          closedWorktreeId
            ? {
                ...(closedTab.startupCwd ? { startupCwd: closedTab.startupCwd } : {}),
                ...(closedTab.shellOverride ? { shellOverride: closedTab.shellOverride } : {}),
                ...(closedTab.customTitle ? { customTitle: closedTab.customTitle } : {}),
                ...(closedTab.color ? { color: closedTab.color } : {}),
                ...(closedPosition ? { position: closedPosition } : {})
              }
            : null
        const nextExpanded = { ...s.expandedPaneByTabId }
        delete nextExpanded[tabId]
        const nextCanExpand = { ...s.canExpandPaneByTabId }
        delete nextCanExpand[tabId]
        const nextLayouts = { ...s.terminalLayoutsByTabId }
        delete nextLayouts[tabId]
        const nextPtyIdsByTabId = { ...s.ptyIdsByTabId }
        delete nextPtyIdsByTabId[tabId]
        const nextLastKnownRelay = { ...s.lastKnownRelayPtyIdByTabId }
        delete nextLastKnownRelay[tabId]
        const nextDeferredSshSessionIdsByTabId = { ...s.deferredSshSessionIdsByTabId }
        delete nextDeferredSshSessionIdsByTabId[tabId]
        const nextPendingReconnectPtyIdByTabId = { ...s.pendingReconnectPtyIdByTabId }
        delete nextPendingReconnectPtyIdByTabId[tabId]
        const nextRuntimePaneTitlesByTabId = { ...s.runtimePaneTitlesByTabId }
        delete nextRuntimePaneTitlesByTabId[tabId]
        const nextDirectSshPaneRetryByTabId = { ...s.directSshPaneRetryByTabId }
        delete nextDirectSshPaneRetryByTabId[tabId]
        const nextDirectSshLivePtyBindingByTabId = {
          ...s.directSshLivePtyBindingByTabId
        }
        delete nextDirectSshLivePtyBindingByTabId[tabId]
        const nextDirectSshPaneRetryHistoryByTabId = {
          ...s.directSshPaneRetryHistoryByTabId
        }
        delete nextDirectSshPaneRetryHistoryByTabId[tabId]
        // Why: keep the same reference when the closing tab had no unread flag, so unrelated closes don't force full-state selector re-eval.
        let nextUnreadTerminalTabs = s.unreadTerminalTabs
        if (s.unreadTerminalTabs[tabId]) {
          nextUnreadTerminalTabs = { ...s.unreadTerminalTabs }
          delete nextUnreadTerminalTabs[tabId]
        }
        let nextUnreadTerminalPanes = s.unreadTerminalPanes
        for (const paneKey of Object.keys(s.unreadTerminalPanes)) {
          if (paneKey.startsWith(`${tabId}:`)) {
            if (nextUnreadTerminalPanes === s.unreadTerminalPanes) {
              nextUnreadTerminalPanes = { ...s.unreadTerminalPanes }
            }
            delete nextUnreadTerminalPanes[paneKey]
          }
        }
        let nextUnreadAgentCompletionPanes = s.unreadAgentCompletionPanes
        for (const paneKey of Object.keys(s.unreadAgentCompletionPanes)) {
          if (paneKey.startsWith(`${tabId}:`)) {
            if (nextUnreadAgentCompletionPanes === s.unreadAgentCompletionPanes) {
              nextUnreadAgentCompletionPanes = { ...s.unreadAgentCompletionPanes }
            }
            delete nextUnreadAgentCompletionPanes[paneKey]
          }
        }
        const nextLastTerminalInputAtByPaneKey = { ...s.lastTerminalInputAtByPaneKey }
        for (const paneKey of Object.keys(nextLastTerminalInputAtByPaneKey)) {
          if (paneKey.startsWith(`${tabId}:`)) {
            delete nextLastTerminalInputAtByPaneKey[paneKey]
          }
        }
        const nextSleepingAgentSessionsByPaneKey = retiresSession
          ? removeSleepingAgentSessionsForTab(s.sleepingAgentSessionsByPaneKey, tabId)
          : s.sleepingAgentSessionsByPaneKey
        const nextPendingStartupByTabId = { ...s.pendingStartupByTabId }
        delete nextPendingStartupByTabId[tabId]
        const nextAutomaticAgentResumeClaimsByTabId = { ...s.automaticAgentResumeClaimsByTabId }
        delete nextAutomaticAgentResumeClaimsByTabId[tabId]
        const nextNativeChatLaunchPromptByTabId = { ...s.nativeChatLaunchPromptByTabId }
        delete nextNativeChatLaunchPromptByTabId[tabId]
        const nextNativeChatLaunchDraftByTabId = { ...s.nativeChatLaunchDraftByTabId }
        delete nextNativeChatLaunchDraftByTabId[tabId]
        const nextPendingInitialCwdByTabId = { ...s.pendingInitialCwdByTabId }
        delete nextPendingInitialCwdByTabId[tabId]
        const nextPendingSetupSplitByTabId = { ...s.pendingSetupSplitByTabId }
        delete nextPendingSetupSplitByTabId[tabId]
        const nextPendingIssueCommandSplitByTabId = { ...s.pendingIssueCommandSplitByTabId }
        delete nextPendingIssueCommandSplitByTabId[tabId]
        const nextCacheTimer = { ...s.cacheTimerByKey }
        // Why: cache timer keys are `${tabId}:${leafId}` composites; remove all entries for the closing tab.
        for (const key of Object.keys(nextCacheTimer)) {
          if (key.startsWith(`${tabId}:`)) {
            delete nextCacheTimer[key]
          }
        }
        // Why: keep activeTabIdByWorktree in sync when closing a background-worktree tab, else the stale remembered tab falls back to tabs[0] on switch.
        const nextActiveTabIdByWorktree = { ...s.activeTabIdByWorktree }
        for (const [wId, tabs] of Object.entries(next)) {
          if (nextActiveTabIdByWorktree[wId] === tabId) {
            nextActiveTabIdByWorktree[wId] = tabs[0]?.id ?? null
          }
        }
        // Why: keep tabBarOrderByWorktree in sync so stale terminal IDs don't linger and shift positions on later tab operations.
        const nextTabBarOrderByWorktree: Record<string, string[]> = {
          ...s.tabBarOrderByWorktree
        }
        for (const wId of Object.keys(nextTabBarOrderByWorktree)) {
          const order = nextTabBarOrderByWorktree[wId]
          if (order?.includes(tabId)) {
            nextTabBarOrderByWorktree[wId] = order.filter((entryId) => entryId !== tabId)
          }
        }
        // Why: clean up unconsumed snapshot/cold-restore data (e.g. tab closed before TerminalPane mounted) to prevent unbounded store growth across restarts.
        let nextSnapshots = s.pendingSnapshotByPtyId
        let nextColdRestores = s.pendingColdRestoreByPtyId
        const closingPtyIds = new Set([
          ...retirementPlan.localOrSshPtyIds,
          ...retirementPlan.runtimeTerminals.map((terminal) => terminal.ptyId),
          ...retirementPlan.cleanupOnlyPtyIds,
          ...retirementPlan.unroutablePtyIds
        ])
        for (const closingId of closingPtyIds) {
          if (closingId in nextSnapshots) {
            nextSnapshots = { ...nextSnapshots }
            delete nextSnapshots[closingId]
          }
          if (closingId in nextColdRestores) {
            nextColdRestores = { ...nextColdRestores }
            delete nextColdRestores[closingId]
          }
        }
        return {
          tabsByWorktree: next,
          activeTabId: s.activeTabId === tabId ? null : s.activeTabId,
          activeTabIdByWorktree: nextActiveTabIdByWorktree,
          ptyIdsByTabId: nextPtyIdsByTabId,
          lastKnownRelayPtyIdByTabId: nextLastKnownRelay,
          deferredSshSessionIdsByTabId: nextDeferredSshSessionIdsByTabId,
          pendingReconnectPtyIdByTabId: nextPendingReconnectPtyIdByTabId,
          runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId,
          directSshPaneRetryByTabId: nextDirectSshPaneRetryByTabId,
          directSshLivePtyBindingByTabId: nextDirectSshLivePtyBindingByTabId,
          directSshPaneRetryHistoryByTabId: nextDirectSshPaneRetryHistoryByTabId,
          ...(nextSleepingAgentSessionsByPaneKey !== s.sleepingAgentSessionsByPaneKey
            ? { sleepingAgentSessionsByPaneKey: nextSleepingAgentSessionsByPaneKey }
            : {}),
          // Why: skip writing unreadTerminalTabs when unchanged to avoid a no-op state allocation that re-evaluates full-state selectors. Mirrors tabs.ts.
          ...(nextUnreadTerminalTabs !== s.unreadTerminalTabs
            ? { unreadTerminalTabs: nextUnreadTerminalTabs }
            : {}),
          ...(nextUnreadTerminalPanes !== s.unreadTerminalPanes
            ? { unreadTerminalPanes: nextUnreadTerminalPanes }
            : {}),
          ...(nextUnreadAgentCompletionPanes !== s.unreadAgentCompletionPanes
            ? { unreadAgentCompletionPanes: nextUnreadAgentCompletionPanes }
            : {}),
          lastTerminalInputAtByPaneKey: nextLastTerminalInputAtByPaneKey,
          expandedPaneByTabId: nextExpanded,
          canExpandPaneByTabId: nextCanExpand,
          terminalLayoutsByTabId: nextLayouts,
          pendingStartupByTabId: nextPendingStartupByTabId,
          automaticAgentResumeClaimsByTabId: nextAutomaticAgentResumeClaimsByTabId,
          nativeChatLaunchPromptByTabId: nextNativeChatLaunchPromptByTabId,
          nativeChatLaunchDraftByTabId: nextNativeChatLaunchDraftByTabId,
          pendingInitialCwdByTabId: nextPendingInitialCwdByTabId,
          pendingSetupSplitByTabId: nextPendingSetupSplitByTabId,
          pendingIssueCommandSplitByTabId: nextPendingIssueCommandSplitByTabId,
          cacheTimerByKey: nextCacheTimer,
          tabBarOrderByWorktree: nextTabBarOrderByWorktree,
          pendingSnapshotByPtyId: nextSnapshots,
          pendingColdRestoreByPtyId: nextColdRestores,
          ...(capturedSnapshot && closedWorktreeId
            ? {
                recentlyClosedTerminalTabsByWorktree: pushClosedTerminalTabSnapshot(
                  s.recentlyClosedTerminalTabsByWorktree,
                  closedWorktreeId,
                  capturedSnapshot
                ),
                recentlyClosedTabKindsByWorktree: pushRecentlyClosedTabKind(
                  s.recentlyClosedTabKindsByWorktree,
                  closedWorktreeId,
                  'terminal'
                )
              }
            : {})
        }
      })
      // Why shared with the paired snapshot apply: every path that removes a tab owes it the same sweep, and a second copy of the list is how one path silently misses a new entry.
      sweepRetiredTerminalTabState(get(), tabId, closingWorktreeId)
      for (const tabs of Object.values(get().unifiedTabsByWorktree)) {
        const workspaceItem = tabs.find(
          (entry) => entry.contentType === 'terminal' && entry.entityId === tabId
        )
        if (workspaceItem) {
          get().closeUnifiedTab(workspaceItem.id, {
            recordInteraction: opts?.recordInteraction,
            terminalRetirementHandled: true
          })
        }
      }
    }
  }
}
