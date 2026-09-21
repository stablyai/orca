import type {
  RetainedAgentEntry,
  DropAgentStatusByTabPrefixOptions,
  DropAgentStatusOptions,
  DropHibernatedAgentPaneOptions
} from './agent-status-contract'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { AgentStatusRuntime } from './agent-status-runtime'
import { buildAgentStatusTabPrefixDropPatch } from './agent-status-drop-reducer'
import { pruneMigrationUnsupportedEntries } from './agent-status-migration-unsupported-entries'
import {
  retainedAgentEntryFromLive,
  shouldReplaceRetainedWithLive
} from './agent-status-pane-key-tab-binding'
import { retireAgentPaneAuthorityAliasesByOwnerTab } from './agent-pane-authority'

function removeAcknowledgement(
  acknowledgements: Record<string, number>,
  paneKey: string
): Record<string, number> {
  if (!(paneKey in acknowledgements)) {
    return acknowledgements
  }
  const next = { ...acknowledgements }
  delete next[paneKey]
  return next
}

export function createAgentStatusDropActions(
  runtime: AgentStatusRuntime
): Pick<
  AgentStatusSlice,
  'dropAgentStatus' | 'dropAgentStatusByTabPrefix' | 'dropHibernatedAgentStatusPane'
> {
  const { set, freshness } = runtime
  return {
    dropAgentStatus: (paneKey, opts?: DropAgentStatusOptions) => {
      let liveExisted = false
      set((s) => {
        const hasLive = paneKey in s.agentStatusByPaneKey
        liveExisted = hasLive
        const hasRetained = paneKey in s.retainedAgentsByPaneKey
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey === paneKey
        )
        const nextAck = removeAcknowledgement(s.acknowledgedAgentsByPaneKey, paneKey)
        // Row dismissal keeps cutoff/manual-unread: the pane may still be live, and its next
        // hook event would replay every cleared stateHistory event as unread without them.
        const nextClearedAt = opts?.paneRemoved
          ? removeAcknowledgement(s.activityClearedAtByPaneKey, paneKey)
          : s.activityClearedAtByPaneKey
        const nextManualUnread = opts?.paneRemoved
          ? removeAcknowledgement(s.manuallyUnreadTurnsByPaneKey, paneKey)
          : s.manuallyUnreadTurnsByPaneKey
        const hasLaunchConfig = paneKey in s.agentLaunchConfigByPaneKey
        const nextLaunchConfigs = hasLaunchConfig
          ? { ...s.agentLaunchConfigByPaneKey }
          : s.agentLaunchConfigByPaneKey
        if (hasLaunchConfig) {
          delete nextLaunchConfigs[paneKey]
        }
        if (!hasLive && !hasRetained && !migrationUnsupported.changed) {
          const cleanupPatch = {
            ...(hasLaunchConfig ? { agentLaunchConfigByPaneKey: nextLaunchConfigs } : {}),
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
        const nextLive = hasLive ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        if (hasLive) {
          delete nextLive[paneKey]
        }
        const nextRetained = hasRetained
          ? { ...s.retainedAgentsByPaneKey }
          : s.retainedAgentsByPaneKey
        if (hasRetained) {
          delete nextRetained[paneKey]
        }
        const needsSuppressor = hasLive && !(paneKey in s.retentionSuppressedPaneKeys)
        return {
          agentStatusByPaneKey: nextLive,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          retainedAgentsByPaneKey: nextRetained,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          activityClearedAtByPaneKey: nextClearedAt,
          manuallyUnreadTurnsByPaneKey: nextManualUnread,
          ...(needsSuppressor
            ? {
                retentionSuppressedPaneKeys: {
                  ...s.retentionSuppressedPaneKeys,
                  [paneKey]: true
                }
              }
            : {}),
          agentStatusEpoch:
            hasLive || migrationUnsupported.changed ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          sortEpoch: hasLive || migrationUnsupported.changed ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      if (liveExisted) {
        freshness.scheduleDeferred()
      }
      if (typeof window !== 'undefined') {
        window.api?.agentStatus?.drop?.(paneKey)
      }
    },

    dropAgentStatusByTabPrefix: (tabIdPrefix, opts?: DropAgentStatusByTabPrefixOptions) => {
      const retiredAliasPaneKeys = retireAgentPaneAuthorityAliasesByOwnerTab(tabIdPrefix)
      let hadLive = false
      set((s) => {
        const dropped = buildAgentStatusTabPrefixDropPatch(
          s,
          tabIdPrefix,
          retiredAliasPaneKeys,
          opts
        )
        hadLive = dropped.hadLive
        return dropped.patch
      })
      if (hadLive) {
        freshness.scheduleDeferred()
      }
      if (typeof window !== 'undefined') {
        window.api?.agentStatus?.dropByTabPrefix?.(tabIdPrefix)
      }
    },

    dropHibernatedAgentStatusPane: (worktreeId, paneKey, opts?: DropHibernatedAgentPaneOptions) => {
      let hadLive = false
      set((s) => {
        const liveEntry = s.agentStatusByPaneKey[paneKey]
        const hasLive = liveEntry !== undefined
        const hasRetained = paneKey in s.retainedAgentsByPaneKey
        const hasLaunchConfig = paneKey in s.agentLaunchConfigByPaneKey
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey === paneKey
        )
        const retainedEvidence = new Map<string, RetainedAgentEntry>()
        for (const retained of opts?.retainedCompletionEvidence ?? []) {
          if (
            retained.entry.paneKey === paneKey &&
            !liveEntry &&
            shouldReplaceRetainedWithLive(retainedEvidence.get(paneKey), retained)
          ) {
            retainedEvidence.set(paneKey, retained)
          }
        }
        if (
          liveEntry?.state === 'done' &&
          liveEntry.agentType !== undefined &&
          liveEntry.interrupted !== true
        ) {
          retainedEvidence.set(
            paneKey,
            retainedAgentEntryFromLive(s, worktreeId, liveEntry, liveEntry.agentType)
          )
        }
        const keepsCompletionEvidence = retainedEvidence.has(paneKey)
        const nextAck = !keepsCompletionEvidence
          ? removeAcknowledgement(s.acknowledgedAgentsByPaneKey, paneKey)
          : s.acknowledgedAgentsByPaneKey
        const nextClearedAt = !keepsCompletionEvidence
          ? removeAcknowledgement(s.activityClearedAtByPaneKey, paneKey)
          : s.activityClearedAtByPaneKey
        const nextManualUnread = !keepsCompletionEvidence
          ? removeAcknowledgement(s.manuallyUnreadTurnsByPaneKey, paneKey)
          : s.manuallyUnreadTurnsByPaneKey
        if (
          !hasLive &&
          !hasRetained &&
          !hasLaunchConfig &&
          !migrationUnsupported.changed &&
          !keepsCompletionEvidence
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
        hadLive = hasLive
        const nextLive = hasLive ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        if (hasLive) {
          delete nextLive[paneKey]
        }
        const nextLaunchConfigs = hasLaunchConfig
          ? { ...s.agentLaunchConfigByPaneKey }
          : s.agentLaunchConfigByPaneKey
        if (hasLaunchConfig) {
          delete nextLaunchConfigs[paneKey]
        }
        const nextRetained =
          hasRetained || keepsCompletionEvidence
            ? { ...s.retainedAgentsByPaneKey }
            : s.retainedAgentsByPaneKey
        if (hasRetained && !keepsCompletionEvidence) {
          delete nextRetained[paneKey]
        }
        for (const [key, retained] of retainedEvidence) {
          if (shouldReplaceRetainedWithLive(nextRetained[key], retained)) {
            nextRetained[key] = retained
          }
        }
        const needsSuppressor =
          hasLive && !keepsCompletionEvidence && !(paneKey in s.retentionSuppressedPaneKeys)
        return {
          agentStatusByPaneKey: nextLive,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          retainedAgentsByPaneKey: nextRetained,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          activityClearedAtByPaneKey: nextClearedAt,
          manuallyUnreadTurnsByPaneKey: nextManualUnread,
          ...(needsSuppressor
            ? {
                retentionSuppressedPaneKeys: {
                  ...s.retentionSuppressedPaneKeys,
                  [paneKey]: true
                }
              }
            : {}),
          agentStatusEpoch:
            hasLive || migrationUnsupported.changed ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          sortEpoch: hasLive || migrationUnsupported.changed ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      if (hadLive) {
        freshness.scheduleDeferred()
      }
    }
  }
}
