import type { DropAgentStatusByWorktreeOptions } from './agent-status-contract'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { AgentStatusRuntime } from './agent-status-runtime'
import { pruneMigrationUnsupportedEntries } from './agent-status-migration-unsupported-entries'
import {
  getTabIdFromPaneKey,
  openNonTerminalTabIds,
  paneKeyMatchesAnyTabPrefix
} from './agent-status-pane-key-tab-binding'
import { removePaneKeys } from './agent-status-pane-keyed-records'
import { isSleepingAgentStatus } from './agent-status-process-retirement'

export function createAgentStatusWorktreeDropActions(
  runtime: AgentStatusRuntime
): Pick<AgentStatusSlice, 'dropAgentStatusByWorktree'> {
  const { set, freshness } = runtime
  return {
    dropAgentStatusByWorktree: (worktreeId, opts?: DropAgentStatusByWorktreeOptions) => {
      let hadLive = false
      set((s, changedPaneKeys) => {
        const tabPrefixes = (s.tabsByWorktree[worktreeId] ?? []).map((tab) => `${tab.id}:`)
        // An open chat's row is its host's: the chat tab's projection removes it on close.
        const chatTabIds = openNonTerminalTabIds(s, worktreeId)
        const ownedByWorktree = (paneKey: string, entryWorktreeId: string | undefined): boolean =>
          !chatTabIds.has(getTabIdFromPaneKey(paneKey) ?? '') &&
          (entryWorktreeId === worktreeId || paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes))
        const paneSurvives =
          opts?.shutdownReason === 'manual-sleep' ||
          opts?.shutdownReason === 'auto-hibernate-completed-agent'
        const liveEntries = Array.from(s.agentStatusByPaneKey.entries()).filter(
          ([paneKey, entry]) =>
            ownedByWorktree(paneKey, entry.worktreeId) &&
            !(paneSurvives && isSleepingAgentStatus(entry))
        )
        const liveKeys = liveEntries.map(([paneKey]) => paneKey)
        const liveKeySet = new Set(liveKeys)
        const launchConfigKeys = Object.keys(s.agentLaunchConfigByPaneKey).filter(
          (paneKey) => paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes) || liveKeySet.has(paneKey)
        )
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) =>
            entry.worktreeId === worktreeId ||
            (entry.paneKey ? paneKeyMatchesAnyTabPrefix(entry.paneKey, tabPrefixes) : false)
        )
        // Read/clear state belongs to the pane, including while it sleeps.
        const activityStateKeys = new Set(
          [
            ...Object.keys(s.acknowledgedAgentsByPaneKey),
            ...Object.keys(s.activityClearedAtByPaneKey),
            ...Object.keys(s.manuallyUnreadTurnsByPaneKey)
          ].filter(
            (key) =>
              !paneSurvives && (paneKeyMatchesAnyTabPrefix(key, tabPrefixes) || liveKeySet.has(key))
          )
        )
        const nextAck = removePaneKeys(s.acknowledgedAgentsByPaneKey, activityStateKeys)
        const nextClearedAt = removePaneKeys(s.activityClearedAtByPaneKey, activityStateKeys)
        const nextManualUnread = removePaneKeys(s.manuallyUnreadTurnsByPaneKey, activityStateKeys)
        if (
          liveKeys.length === 0 &&
          launchConfigKeys.length === 0 &&
          !migrationUnsupported.changed
        ) {
          const cleanupPatch = {
            ...(nextAck !== s.acknowledgedAgentsByPaneKey
              ? { acknowledgedAgentsByPaneKey: nextAck }
              : {}),
            ...(nextClearedAt !== s.activityClearedAtByPaneKey
              ? { activityClearedAtByPaneKey: nextClearedAt }
              : {}),
            ...(nextManualUnread !== s.manuallyUnreadTurnsByPaneKey
              ? { manuallyUnreadTurnsByPaneKey: nextManualUnread }
              : {})
          }
          return Object.keys(cleanupPatch).length > 0 ? cleanupPatch : s
        }
        hadLive = liveKeys.length > 0
        const nextLive = removePaneKeys(s.agentStatusByPaneKey, liveKeySet)
        for (const key of liveKeys) {
          changedPaneKeys.add(key)
        }
        const nextLaunchConfigs =
          launchConfigKeys.length > 0
            ? { ...s.agentLaunchConfigByPaneKey }
            : s.agentLaunchConfigByPaneKey
        for (const key of launchConfigKeys) {
          delete nextLaunchConfigs[key]
        }
        return {
          agentStatusByPaneKey: nextLive,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          ...(nextClearedAt !== s.activityClearedAtByPaneKey
            ? { activityClearedAtByPaneKey: nextClearedAt }
            : {}),
          ...(nextManualUnread !== s.manuallyUnreadTurnsByPaneKey
            ? { manuallyUnreadTurnsByPaneKey: nextManualUnread }
            : {}),
          agentStatusEpoch:
            hadLive || migrationUnsupported.changed ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          sortEpoch: hadLive || migrationUnsupported.changed ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      if (hadLive) {
        freshness.scheduleDeferred()
      }
    }
  }
}
