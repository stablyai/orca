import type { AppState } from '../types'

function withoutKey<T>(source: Record<string, T>, key: string): Record<string, T> {
  if (!Object.hasOwn(source, key)) {
    return source
  }
  const next = { ...source }
  delete next[key]
  return next
}

function withoutPanePrefix<T>(source: Record<string, T>, prefix: string): Record<string, T> {
  const entries = Object.entries(source).filter(([key]) => !key.startsWith(prefix))
  return entries.length === Object.keys(source).length ? source : Object.fromEntries(entries)
}

function withoutMigrationPanePrefix(
  source: AppState['migrationUnsupportedByPtyId'],
  prefix: string
): AppState['migrationUnsupportedByPtyId'] {
  const entries = Object.entries(source).filter(([, entry]) => !entry.paneKey?.startsWith(prefix))
  return entries.length === Object.keys(source).length ? source : Object.fromEntries(entries)
}

export function buildTransferredTerminalLocalProjectionRemoval(
  state: AppState,
  tabId: string
): Partial<AppState> {
  const prefix = `${tabId}:`
  const hadLive = Object.keys(state.agentStatusByPaneKey).some((key) => key.startsWith(prefix))
  const migrationUnsupportedByPtyId = withoutMigrationPanePrefix(
    state.migrationUnsupportedByPtyId,
    prefix
  )
  const statusChanged = hadLive || migrationUnsupportedByPtyId !== state.migrationUnsupportedByPtyId
  return {
    agentStatusByPaneKey: withoutPanePrefix(state.agentStatusByPaneKey, prefix),
    runtimeAgentOrchestrationByPaneKey: withoutPanePrefix(
      state.runtimeAgentOrchestrationByPaneKey,
      prefix
    ),
    retainedAgentsByPaneKey: withoutPanePrefix(state.retainedAgentsByPaneKey, prefix),
    sleepingAgentSessionsByPaneKey: withoutPanePrefix(state.sleepingAgentSessionsByPaneKey, prefix),
    agentLaunchConfigByPaneKey: withoutPanePrefix(state.agentLaunchConfigByPaneKey, prefix),
    acknowledgedAgentsByPaneKey: withoutPanePrefix(state.acknowledgedAgentsByPaneKey, prefix),
    paneForegroundAgentByPaneKey: withoutPanePrefix(state.paneForegroundAgentByPaneKey, prefix),
    unreadTerminalPanes: withoutPanePrefix(state.unreadTerminalPanes, prefix),
    unreadAgentCompletionPanes: withoutPanePrefix(state.unreadAgentCompletionPanes, prefix),
    lastTerminalInputAtByPaneKey: withoutPanePrefix(state.lastTerminalInputAtByPaneKey, prefix),
    cacheTimerByKey: withoutPanePrefix(state.cacheTimerByKey, prefix),
    retentionSuppressedPaneKeys: withoutPanePrefix(state.retentionSuppressedPaneKeys, prefix),
    recentlyRetiredAgentStatusPaneKeys: withoutPanePrefix(
      state.recentlyRetiredAgentStatusPaneKeys,
      prefix
    ),
    recentlyClosedAgentStatusTabIds: withoutKey(state.recentlyClosedAgentStatusTabIds, tabId),
    migrationUnsupportedByPtyId,
    agentStatusEpoch: statusChanged ? state.agentStatusEpoch + 1 : state.agentStatusEpoch,
    sortEpoch: statusChanged ? state.sortEpoch + 1 : state.sortEpoch
  }
}
