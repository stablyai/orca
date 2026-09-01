import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { AgentStatusRuntime } from './agent-status-runtime'
import {
  collectWorktreeIdsForConnection,
  pruneMigrationUnsupportedEntries
} from './agent-status-map-helpers'

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
      if (
        !(paneKey in current.agentStatusByPaneKey) &&
        !(paneKey in current.agentLaunchConfigByPaneKey) &&
        !Object.values(current.migrationUnsupportedByPtyId).some(
          (entry) => entry.paneKey === paneKey
        )
      ) {
        return
      }
      set((s) => {
        const hasLive = paneKey in s.agentStatusByPaneKey
        const next = hasLive ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        if (hasLive) {
          delete next[paneKey]
        }
        const hasLaunchConfig = paneKey in s.agentLaunchConfigByPaneKey
        const nextLaunchConfigs = hasLaunchConfig
          ? { ...s.agentLaunchConfigByPaneKey }
          : s.agentLaunchConfigByPaneKey
        if (hasLaunchConfig) {
          delete nextLaunchConfigs[paneKey]
        }
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey === paneKey
        )
        // Ack entries belong to the pane lifecycle; never let a reused key inherit one.
        let nextAck = s.acknowledgedAgentsByPaneKey
        if (paneKey in nextAck) {
          nextAck = { ...nextAck }
          delete nextAck[paneKey]
        }
        return {
          agentStatusByPaneKey: next,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
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
      const toRemove = Object.keys(current.agentStatusByPaneKey).filter((key) =>
        key.startsWith(prefix)
      )
      const launchConfigKeys = Object.keys(current.agentLaunchConfigByPaneKey).filter((key) =>
        key.startsWith(prefix)
      )
      const hasMigrationUnsupported = Object.values(current.migrationUnsupportedByPtyId).some(
        (entry) => entry.paneKey?.startsWith(prefix)
      )
      if (toRemove.length === 0 && launchConfigKeys.length === 0 && !hasMigrationUnsupported) {
        return
      }
      set((s) => {
        const next = { ...s.agentStatusByPaneKey }
        for (const key of toRemove) {
          delete next[key]
        }
        const nextLaunchConfigs = { ...s.agentLaunchConfigByPaneKey }
        for (const key of launchConfigKeys) {
          delete nextLaunchConfigs[key]
        }
        const migrationUnsupported = pruneMigrationUnsupportedEntries(
          s.migrationUnsupportedByPtyId,
          (entry) => entry.paneKey?.startsWith(prefix) ?? false
        )
        let nextAck = s.acknowledgedAgentsByPaneKey
        const ackKeys = Object.keys(nextAck).filter((key) => key.startsWith(prefix))
        if (ackKeys.length > 0) {
          nextAck = { ...nextAck }
          for (const key of ackKeys) {
            delete nextAck[key]
          }
        }
        return {
          agentStatusByPaneKey: next,
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          migrationUnsupportedByPtyId: migrationUnsupported.next,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
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
      let removed = false
      set((s) => {
        const worktreeIdsOnConnection = collectWorktreeIdsForConnection(s, connectionId)
        let next: Record<string, (typeof s.agentStatusByPaneKey)[string]> | null = null
        for (const [paneKey, existing] of Object.entries(s.agentStatusByPaneKey)) {
          if (existing.updatedAt > clearedAt) {
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
          next ??= { ...s.agentStatusByPaneKey }
          delete next[paneKey]
        }
        const alreadyBlocked = connectionId in s.transientClearedAgentStatusConnectionIds
        if (!next && alreadyBlocked) {
          return s
        }
        removed = next !== null
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
      if (removed) {
        freshness.scheduleDeferred()
      }
    }
  }
}
