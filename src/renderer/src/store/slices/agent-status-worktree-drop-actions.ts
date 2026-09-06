import type { DropAgentStatusByWorktreeOptions, RetainedAgentEntry } from './agent-status-contract'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { AgentStatusRuntime } from './agent-status-runtime'
import { pruneMigrationUnsupportedEntries } from './agent-status-migration-unsupported-entries'
import {
  normalizePaneKeySet,
  paneKeyMatchesAnyTabPrefix,
  retainedAgentEntryFromLive,
  shouldReplaceRetainedWithLive
} from './agent-status-pane-key-tab-binding'
import { removePaneKeys } from './agent-status-pane-keyed-records'

export function createAgentStatusWorktreeDropActions(
  runtime: AgentStatusRuntime
): Pick<AgentStatusSlice, 'dropAgentStatusByWorktree'> {
  const { set, freshness } = runtime
  return {
    dropAgentStatusByWorktree: (worktreeId, opts?: DropAgentStatusByWorktreeOptions) => {
      let hadLive = false
      set((s) => {
        const tabPrefixes = (s.tabsByWorktree[worktreeId] ?? []).map((tab) => `${tab.id}:`)
        const liveEntries = Object.entries(s.agentStatusByPaneKey).filter(
          ([paneKey, entry]) =>
            entry.worktreeId === worktreeId || paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes)
        )
        const liveKeys = liveEntries.map(([paneKey]) => paneKey)
        const liveKeySet = new Set(liveKeys)
        const launchConfigKeys = Object.keys(s.agentLaunchConfigByPaneKey).filter(
          (paneKey) => paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes) || liveKeySet.has(paneKey)
        )
        const retainedKeys = Object.entries(s.retainedAgentsByPaneKey)
          .filter(
            ([paneKey, retained]) =>
              retained.worktreeId === worktreeId || paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes)
          )
          .map(([paneKey]) => paneKey)
        const retainedKeySet = new Set(retainedKeys)
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) =>
            entry.worktreeId === worktreeId ||
            (entry.paneKey ? paneKeyMatchesAnyTabPrefix(entry.paneKey, tabPrefixes) : false)
        )
        const allowedPaneKeys = normalizePaneKeySet(opts?.sleepingPaneKeys)
        const preserveHibernatedEvidence =
          opts?.shutdownReason === 'auto-hibernate-completed-agent' &&
          allowedPaneKeys !== null &&
          allowedPaneKeys.size > 0
        const liveEntryByPaneKey = new Map(liveEntries)
        const retainedEvidence = new Map<string, RetainedAgentEntry>()
        if (preserveHibernatedEvidence) {
          for (const retained of opts?.retainedCompletionEvidence ?? []) {
            if (
              allowedPaneKeys.has(retained.entry.paneKey) &&
              !liveEntryByPaneKey.has(retained.entry.paneKey) &&
              shouldReplaceRetainedWithLive(retainedEvidence.get(retained.entry.paneKey), retained)
            ) {
              retainedEvidence.set(retained.entry.paneKey, retained)
            }
          }
          for (const [paneKey, entry] of liveEntries) {
            if (
              allowedPaneKeys.has(paneKey) &&
              entry.state === 'done' &&
              entry.agentType !== undefined &&
              entry.interrupted !== true
            ) {
              retainedEvidence.set(
                paneKey,
                retainedAgentEntryFromLive(s, worktreeId, entry, entry.agentType)
              )
            }
          }
        }
        const retainedEvidenceKeys = new Set(retainedEvidence.keys())
        // Completion evidence keeps its read/clear state; every fully retired pane drops all three maps.
        const activityStateKeys = new Set(
          [
            ...Object.keys(s.acknowledgedAgentsByPaneKey),
            ...Object.keys(s.activityClearedAtByPaneKey),
            ...Object.keys(s.manuallyUnreadTurnsByPaneKey)
          ].filter(
            (key) =>
              !retainedEvidenceKeys.has(key) &&
              (paneKeyMatchesAnyTabPrefix(key, tabPrefixes) ||
                liveKeySet.has(key) ||
                retainedKeySet.has(key))
          )
        )
        const nextAck = removePaneKeys(s.acknowledgedAgentsByPaneKey, activityStateKeys)
        const nextClearedAt = removePaneKeys(s.activityClearedAtByPaneKey, activityStateKeys)
        const nextManualUnread = removePaneKeys(s.manuallyUnreadTurnsByPaneKey, activityStateKeys)
        if (
          liveKeys.length === 0 &&
          launchConfigKeys.length === 0 &&
          retainedKeys.length === 0 &&
          retainedEvidence.size === 0 &&
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
        const nextLive =
          liveKeys.length > 0 ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        for (const key of liveKeys) {
          delete nextLive[key]
        }
        const nextLaunchConfigs =
          launchConfigKeys.length > 0
            ? { ...s.agentLaunchConfigByPaneKey }
            : s.agentLaunchConfigByPaneKey
        for (const key of launchConfigKeys) {
          delete nextLaunchConfigs[key]
        }
        const nextRetained =
          retainedKeys.length > 0 || retainedEvidence.size > 0
            ? { ...s.retainedAgentsByPaneKey }
            : s.retainedAgentsByPaneKey
        for (const key of retainedKeys) {
          if (!retainedEvidenceKeys.has(key)) {
            delete nextRetained[key]
          }
        }
        for (const [paneKey, retained] of retainedEvidence) {
          if (shouldReplaceRetainedWithLive(nextRetained[paneKey], retained)) {
            nextRetained[paneKey] = retained
          }
        }
        const suppressorAdds = liveKeys.filter(
          (key) => !retainedEvidenceKeys.has(key) && !(key in s.retentionSuppressedPaneKeys)
        )
        let nextRetentionSuppressedPaneKeys = s.retentionSuppressedPaneKeys
        if (suppressorAdds.length > 0) {
          nextRetentionSuppressedPaneKeys = { ...s.retentionSuppressedPaneKeys }
          for (const key of suppressorAdds) {
            nextRetentionSuppressedPaneKeys[key] = true
          }
        }
        return {
          agentStatusByPaneKey: nextLive,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          retainedAgentsByPaneKey: nextRetained,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          retentionSuppressedPaneKeys: nextRetentionSuppressedPaneKeys,
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
