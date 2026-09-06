import { recordClosedTerminalTabTombstone } from '../../../../shared/closed-terminal-tab-tombstones'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
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
import { omitUnverifiedPtyLossTabIds } from './terminal-unverified-pty-loss'
import { omitRecordKey, omitRecordKeys } from '../slices/worktrees/teardown/record-key-omission'

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
        // Why `user` and not retiresSession: a tombstone outlives the host's own record, so the only
        // thing it may ever say is "the user closed this". A pty-exit close is the process ending,
        // and a `cleanup` close retires a tab the app itself created — neither is that claim.
        // Why a non-local worktree only: the tombstone is read solely by the direct-SSH pull merge,
        // and a definitively local tab would just consume the map's cap. An unresolved repo
        // (undefined, not null) still records — losing the tombstone reinstates the resurrection.
        const nextClosedTombstones =
          closeReason === 'user' &&
          closedWorktreeId &&
          getConnectionIdFromState(s, closedWorktreeId) !== null
            ? recordClosedTerminalTabTombstone(
                s.closedTerminalTabTombstonesByTabId,
                tabId,
                closedWorktreeId,
                Date.now()
              )
            : s.closedTerminalTabTombstonesByTabId
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
        const nextExpanded = omitRecordKey(s.expandedPaneByTabId, tabId)
        const nextCanExpand = omitRecordKey(s.canExpandPaneByTabId, tabId)
        const nextLayouts = omitRecordKey(s.terminalLayoutsByTabId, tabId)
        const nextPtyIdsByTabId = omitRecordKey(s.ptyIdsByTabId, tabId)
        const nextLastKnownRelay = omitRecordKey(s.lastKnownRelayPtyIdByTabId, tabId)
        const nextDeferredSshSessionIdsByTabId = omitRecordKey(
          s.deferredSshSessionIdsByTabId,
          tabId
        )
        const nextPendingReconnectPtyIdByTabId = omitRecordKey(
          s.pendingReconnectPtyIdByTabId,
          tabId
        )
        const nextRuntimePaneTitlesByTabId = omitRecordKey(s.runtimePaneTitlesByTabId, tabId)
        const nextDirectSshPaneRetryByTabId = omitRecordKey(s.directSshPaneRetryByTabId, tabId)
        const nextDirectSshLivePtyBindingByTabId = omitRecordKey(
          s.directSshLivePtyBindingByTabId,
          tabId
        )
        const nextDirectSshPaneRetryHistoryByTabId = omitRecordKey(
          s.directSshPaneRetryHistoryByTabId,
          tabId
        )
        const nextUnverifiedPtyLossTabIds = omitUnverifiedPtyLossTabIds(s.unverifiedPtyLossTabIds, [
          tabId
        ])
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
        const nextLastTerminalInputAtByPaneKey = omitRecordKeys(
          s.lastTerminalInputAtByPaneKey,
          Object.keys(s.lastTerminalInputAtByPaneKey).filter((paneKey) =>
            paneKey.startsWith(`${tabId}:`)
          )
        )
        const nextSleepingAgentSessionsByPaneKey = retiresSession
          ? removeSleepingAgentSessionsForTab(s.sleepingAgentSessionsByPaneKey, tabId)
          : s.sleepingAgentSessionsByPaneKey
        const nextPendingStartupByTabId = omitRecordKey(s.pendingStartupByTabId, tabId)
        const nextAutomaticAgentResumeClaimsByTabId = omitRecordKey(
          s.automaticAgentResumeClaimsByTabId,
          tabId
        )
        const nextNativeChatLaunchPromptByTabId = omitRecordKey(
          s.nativeChatLaunchPromptByTabId,
          tabId
        )
        const nextNativeChatLaunchDraftByTabId = omitRecordKey(
          s.nativeChatLaunchDraftByTabId,
          tabId
        )
        const nextPendingInitialCwdByTabId = omitRecordKey(s.pendingInitialCwdByTabId, tabId)
        const nextPendingSetupSplitByTabId = omitRecordKey(s.pendingSetupSplitByTabId, tabId)
        const nextPendingIssueCommandSplitByTabId = omitRecordKey(
          s.pendingIssueCommandSplitByTabId,
          tabId
        )
        // Why: cache timer keys are `${tabId}:${leafId}` composites; remove all entries for the closing tab.
        const nextCacheTimer = omitRecordKeys(
          s.cacheTimerByKey,
          Object.keys(s.cacheTimerByKey).filter((key) => key.startsWith(`${tabId}:`))
        )
        // Why: keep activeTabIdByWorktree in sync when closing a background-worktree tab, else the stale remembered tab falls back to tabs[0] on switch.
        let nextActiveTabIdByWorktree = s.activeTabIdByWorktree
        for (const [wId, tabs] of Object.entries(next)) {
          if (nextActiveTabIdByWorktree[wId] !== tabId) {
            continue
          }
          if (nextActiveTabIdByWorktree === s.activeTabIdByWorktree) {
            nextActiveTabIdByWorktree = { ...s.activeTabIdByWorktree }
          }
          nextActiveTabIdByWorktree[wId] = tabs[0]?.id ?? null
        }
        // Why: keep tabBarOrderByWorktree in sync so stale terminal IDs don't linger and shift positions on later tab operations.
        let nextTabBarOrderByWorktree: Record<string, string[]> = s.tabBarOrderByWorktree
        for (const wId of Object.keys(s.tabBarOrderByWorktree)) {
          const order = s.tabBarOrderByWorktree[wId]
          if (!order?.includes(tabId)) {
            continue
          }
          if (nextTabBarOrderByWorktree === s.tabBarOrderByWorktree) {
            nextTabBarOrderByWorktree = { ...s.tabBarOrderByWorktree }
          }
          nextTabBarOrderByWorktree[wId] = order.filter((entryId) => entryId !== tabId)
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
          ...(nextUnverifiedPtyLossTabIds !== s.unverifiedPtyLossTabIds
            ? { unverifiedPtyLossTabIds: nextUnverifiedPtyLossTabIds }
            : {}),
          ...(nextSleepingAgentSessionsByPaneKey !== s.sleepingAgentSessionsByPaneKey
            ? { sleepingAgentSessionsByPaneKey: nextSleepingAgentSessionsByPaneKey }
            : {}),
          ...(nextClosedTombstones !== s.closedTerminalTabTombstonesByTabId
            ? { closedTerminalTabTombstonesByTabId: nextClosedTombstones }
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
