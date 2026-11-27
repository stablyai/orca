import {
  CHAT_PANE_ADDRESS_PREFIX,
  chatPaneKeySessionId
} from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import {
  CHAT_READ_MARK_FIELDS,
  someChatReadMarkAlias,
  type ChatReadMarks
} from '../../../../../../shared/agent-session/view/chat-read-mark-move'
import {
  chatReadMarkAliases,
  removeChatReadMark
} from '../structured-sessions/chat-read-mark-aliases'
import type { AgentStatusSlice } from '../contracts/agent-status-slice-contract'
import type { AgentStatusRuntime } from '../status-ownership/agent-status-runtime'
import { collectWorktreeIdsForConnection } from './agent-status-connection-worktree-scope'
import { pruneMigrationUnsupportedEntries } from './agent-status-migration-unsupported-entries'
import {
  removePaneKeys,
  removePaneKeysByTabPrefix
} from '../pane-authority/agent-status-pane-keyed-records'
import { agentProcessRetirementPatch } from './agent-status-process-retirement'

function hasChatReadMark(marks: ChatReadMarks, key: string): boolean {
  return (
    key.startsWith(CHAT_PANE_ADDRESS_PREFIX) &&
    chatPaneKeySessionId(key) !== null &&
    CHAT_READ_MARK_FIELDS.some(
      (field) =>
        Object.hasOwn(marks[field], key) ||
        someChatReadMarkAlias(chatReadMarkAliases(field, key), (alias) =>
          Object.hasOwn(marks[field], alias)
        )
    )
  )
}

/** Actions for removing transient rows and migration-era cache entries. */
export function createAgentStatusCleanupActions(
  runtime: AgentStatusRuntime
): Pick<
  AgentStatusSlice,
  | 'setMigrationUnsupportedPty'
  | 'clearMigrationUnsupportedPty'
  | 'removeAgentStatus'
  | 'removeAgentStatusByTabPrefix'
  | 'clearTransientAgentStatuses'
> {
  const { get, set, freshness } = runtime
  return {
    setMigrationUnsupportedPty: (entry) => {
      set((s) => {
        const existing = s.migrationUnsupportedByPtyId[entry.ptyId]
        if (existing && entry.updatedAt < existing.updatedAt) {
          return s
        }
        return {
          migrationUnsupportedByPtyId: {
            ...s.migrationUnsupportedByPtyId,
            [entry.ptyId]: entry
          },
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
    },

    clearMigrationUnsupportedPty: (ptyId) => {
      if (!(ptyId in get().migrationUnsupportedByPtyId)) {
        return
      }
      set((s) => {
        const next = { ...s.migrationUnsupportedByPtyId }
        delete next[ptyId]
        return {
          migrationUnsupportedByPtyId: next,
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
    },

    removeAgentStatus: (paneKey) => {
      const current = get()
      // Transient PTY loss removes occupancy; conversation identity survives until explicit pane retirement.
      if (
        !current.agentStatusByPaneKey.has(paneKey) &&
        !(paneKey in current.agentLaunchConfigByPaneKey) &&
        !hasChatReadMark(current, paneKey) &&
        !Object.values(current.migrationUnsupportedByPtyId).some(
          (entry) => entry.paneKey === paneKey
        )
      ) {
        return
      }
      set((s, changedPaneKeys) => {
        const hasLive = s.agentStatusByPaneKey.has(paneKey)
        const next = hasLive
          ? s.agentStatusByPaneKey.replace([[paneKey, null]])
          : s.agentStatusByPaneKey
        if (hasLive) {
          changedPaneKeys.add(paneKey)
        }
        const processRetirement = agentProcessRetirementPatch(s, paneKey)
        const nextAck = removeChatReadMark(
          s.acknowledgedAgentsByPaneKey,
          'acknowledgedAgentsByPaneKey',
          paneKey
        )
        const nextClearedAt = removeChatReadMark(
          s.activityClearedAtByPaneKey,
          'activityClearedAtByPaneKey',
          paneKey
        )
        const nextManualUnread = removeChatReadMark(
          s.manuallyUnreadTurnsByPaneKey,
          'manuallyUnreadTurnsByPaneKey',
          paneKey
        )
        return {
          agentStatusByPaneKey: next,
          ...processRetirement.patch,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          ...(nextClearedAt !== s.activityClearedAtByPaneKey
            ? { activityClearedAtByPaneKey: nextClearedAt }
            : {}),
          ...(nextManualUnread !== s.manuallyUnreadTurnsByPaneKey
            ? { manuallyUnreadTurnsByPaneKey: nextManualUnread }
            : {}),
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
      freshness.scheduleDeferred()
    },

    removeAgentStatusByTabPrefix: (tabIdPrefix) => {
      const prefix = `${tabIdPrefix}:`
      const current = get()
      const toRemove = Array.from(current.agentStatusByPaneKey.keys()).filter((key) =>
        key.startsWith(prefix)
      )
      const launchConfigKeys = Object.keys(current.agentLaunchConfigByPaneKey).filter((key) =>
        key.startsWith(prefix)
      )
      const hasMigrationUnsupported = Object.values(current.migrationUnsupportedByPtyId).some(
        (entry) => entry.paneKey?.startsWith(prefix)
      )
      const hasPaneActivityState = [
        current.acknowledgedAgentsByPaneKey,
        current.activityClearedAtByPaneKey,
        current.manuallyUnreadTurnsByPaneKey
      ].some((record) => Object.keys(record).some((key) => key.startsWith(prefix)))
      if (
        toRemove.length === 0 &&
        launchConfigKeys.length === 0 &&
        !hasMigrationUnsupported &&
        !hasPaneActivityState
      ) {
        return
      }
      set((s, changedPaneKeys) => {
        const next = removePaneKeys(s.agentStatusByPaneKey, new Set(toRemove))
        for (const key of toRemove) {
          changedPaneKeys.add(key)
        }
        const nextLaunchConfigs = { ...s.agentLaunchConfigByPaneKey }
        for (const key of launchConfigKeys) {
          delete nextLaunchConfigs[key]
        }
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey?.startsWith(prefix) ?? false
        )
        const nextAck = removePaneKeysByTabPrefix(s.acknowledgedAgentsByPaneKey, tabIdPrefix)
        const nextClearedAt = removePaneKeysByTabPrefix(s.activityClearedAtByPaneKey, tabIdPrefix)
        const nextManualUnread = removePaneKeysByTabPrefix(
          s.manuallyUnreadTurnsByPaneKey,
          tabIdPrefix
        )
        return {
          agentStatusByPaneKey: next,
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
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
      freshness.scheduleDeferred()
    },

    clearTransientAgentStatuses: (connectionId, clearedAt) => {
      if (connectionId.length === 0 || !Number.isFinite(clearedAt)) {
        return
      }
      set((s, changedPaneKeys) => {
        const worktreeIdsOnConnection = collectWorktreeIdsForConnection(s, connectionId)
        let next: typeof s.agentStatusByPaneKey | null = null
        for (const [paneKey, existing] of Array.from(s.agentStatusByPaneKey.entries())) {
          if (existing.paneSleep || existing.updatedAt > clearedAt) {
            continue
          }
          const belongsToConnection =
            existing.connectionId === connectionId ||
            (existing.connectionId === undefined &&
              existing.worktreeId !== undefined &&
              worktreeIdsOnConnection.has(existing.worktreeId))
          if (!belongsToConnection) {
            continue
          }
          next = (next ?? s.agentStatusByPaneKey).replace([[paneKey, null]])
          changedPaneKeys.add(paneKey)
        }
        const alreadyBlocked = connectionId in s.transientClearedAgentStatusConnectionIds
        if (!next && alreadyBlocked) {
          return s
        }
        return {
          ...(next
            ? {
                agentStatusByPaneKey: next,
                agentStatusEpoch: s.agentStatusEpoch + 1,
                sortEpoch: s.sortEpoch + 1
              }
            : {}),
          transientClearedAgentStatusConnectionIds: alreadyBlocked
            ? s.transientClearedAgentStatusConnectionIds
            : { ...s.transientClearedAgentStatusConnectionIds, [connectionId]: true }
        }
      })
    }
  }
}
