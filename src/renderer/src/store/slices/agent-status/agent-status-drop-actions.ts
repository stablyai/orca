import type {
  DropAgentStatusByTabPrefixOptions,
  DropAgentStatusOptions
} from './agent-status-contract'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { AgentStatusRuntime } from './agent-status-runtime'
import { buildAgentStatusTabPrefixDropPatch } from './agent-status-drop-reducer'
import { pruneMigrationUnsupportedEntries } from './agent-status-migration-unsupported-entries'
import { retireAgentPaneAuthorityAliasesByOwnerTab } from './agent-pane-authority'
import { removePaneKeys } from './agent-status-pane-keyed-records'

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
      set((s, changedPaneKeys) => {
        const hasLive = s.agentStatusByPaneKey.has(paneKey)
        liveExisted = hasLive
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey === paneKey
        )
        const nextAck = removeAcknowledgement(s.acknowledgedAgentsByPaneKey, paneKey)
        // Dismissal preserves cutoff/manual-unread because live panes can republish cleared history.
        const nextClearedAt = opts?.paneRemoved
          ? removeAcknowledgement(s.activityClearedAtByPaneKey, paneKey)
          : s.activityClearedAtByPaneKey
        const nextManualUnread = opts?.paneRemoved
          ? removeAcknowledgement(s.manuallyUnreadTurnsByPaneKey, paneKey)
          : s.manuallyUnreadTurnsByPaneKey
        const nextConversations = opts?.paneRemoved
          ? removePaneKeys(s.agentConversationsByPaneKey, new Set([paneKey]))
          : s.agentConversationsByPaneKey
        const hasLaunchConfig = paneKey in s.agentLaunchConfigByPaneKey
        const nextLaunchConfigs = hasLaunchConfig
          ? { ...s.agentLaunchConfigByPaneKey }
          : s.agentLaunchConfigByPaneKey
        if (hasLaunchConfig) {
          delete nextLaunchConfigs[paneKey]
        }
        if (!hasLive && !migrationUnsupported.changed) {
          const cleanupPatch = {
            ...(nextConversations !== s.agentConversationsByPaneKey
              ? { agentConversationsByPaneKey: nextConversations }
              : {}),
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
        const nextLive = hasLive
          ? s.agentStatusByPaneKey.replace([[paneKey, null]])
          : s.agentStatusByPaneKey
        if (hasLive) {
          changedPaneKeys.add(paneKey)
        }
        return {
          agentStatusByPaneKey: nextLive,
          agentConversationsByPaneKey: nextConversations,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          activityClearedAtByPaneKey: nextClearedAt,
          manuallyUnreadTurnsByPaneKey: nextManualUnread,
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
      set((s, changedPaneKeys) => {
        const dropped = buildAgentStatusTabPrefixDropPatch(
          s,
          tabIdPrefix,
          retiredAliasPaneKeys,
          opts
        )
        hadLive = dropped.hadLive
        for (const key of dropped.removedPaneKeys) {
          changedPaneKeys.add(key)
        }
        return dropped.patch
      })
      if (hadLive) {
        freshness.scheduleDeferred()
      }
      if (typeof window !== 'undefined') {
        window.api?.agentStatus?.dropByTabPrefix?.(tabIdPrefix)
      }
    },

    dropHibernatedAgentStatusPane: (_worktreeId, paneKey) => {
      let hadLive = false
      set((s, changedPaneKeys) => {
        const row = s.agentStatusByPaneKey.get(paneKey)
        hadLive = row !== undefined && !(row.state === 'done' && row.paneSleep)
        const keys = new Set([paneKey])
        const agentStatusByPaneKey = hadLive
          ? removePaneKeys(s.agentStatusByPaneKey, keys)
          : s.agentStatusByPaneKey
        const agentLaunchConfigByPaneKey = removePaneKeys(s.agentLaunchConfigByPaneKey, keys)
        const migration = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey === paneKey
        )
        if (
          !hadLive &&
          agentLaunchConfigByPaneKey === s.agentLaunchConfigByPaneKey &&
          !migration.changed
        ) {
          return s
        }
        if (hadLive) {
          changedPaneKeys.add(paneKey)
        }
        // The sleeping pane still owns its read/clear state.
        return {
          agentStatusByPaneKey,
          agentLaunchConfigByPaneKey,
          migrationUnsupportedByPtyId: migration.next,
          agentStatusEpoch:
            hadLive || migration.changed ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          sortEpoch: hadLive || migration.changed ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      if (hadLive) {
        freshness.scheduleDeferred()
      }
    }
  }
}
