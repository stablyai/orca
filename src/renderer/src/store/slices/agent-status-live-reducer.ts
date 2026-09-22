import type { AppState } from '../types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  capLiveAgentStatusesInPlace,
  classifyPaneKeyLiveness,
  countLiveAgentStatuses,
  noteLiveAgentStatusCount
} from './agent-status-capacity-eviction'
import { removePaneKeys } from './agent-status-pane-keyed-records'
import { recoveryRecordMatches } from './agent-status-recovery-equivalence'
import type { AgentStatusLiveEntryBuild } from './agent-status-live-entry-builder'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'

export type AgentStatusLiveUpdateReduction = {
  patch: Partial<AppState>
  /** Rows the cap dropped, so freshness can move its cached minimum without a full rescan. */
  evictedEntries: AgentStatusEntry[]
}

/** Apply the map changes associated with an accepted live status row. */
export function reduceAgentStatusLiveUpdate(
  state: AppState,
  build: AgentStatusLiveEntryBuild,
  updatedAt: number
): AgentStatusLiveUpdateReduction {
  const {
    entry,
    existingSleepingRecord,
    liveRecoveryRecord,
    registryEntry,
    registryMatched,
    providerSession,
    providerSessionChanged,
    migrationUnsupported,
    retentionRelevantChange,
    sortRelevantChange
  } = build
  const paneKey = entry.paneKey
  let nextRetentionSuppressedPaneKeys = state.retentionSuppressedPaneKeys
  if (paneKey in nextRetentionSuppressedPaneKeys) {
    nextRetentionSuppressedPaneKeys = { ...nextRetentionSuppressedPaneKeys }
    delete nextRetentionSuppressedPaneKeys[paneKey]
  }
  const nextRetainedAgents =
    paneKey in state.retainedAgentsByPaneKey
      ? { ...state.retainedAgentsByPaneKey }
      : state.retainedAgentsByPaneKey
  if (nextRetainedAgents !== state.retainedAgentsByPaneKey) {
    delete nextRetainedAgents[paneKey]
  }
  let nextSleepingAgentSessions = state.sleepingAgentSessionsByPaneKey
  let nextLaunchConfigs = state.agentLaunchConfigByPaneKey
  if (
    registryMatched &&
    registryEntry &&
    providerSession &&
    !agentProviderSessionsEqual(
      entry.agentType,
      registryEntry.identity.providerSession,
      providerSession
    )
  ) {
    nextLaunchConfigs = {
      ...nextLaunchConfigs,
      [paneKey]: { ...registryEntry, identity: { ...registryEntry.identity, providerSession } }
    }
  }
  // Launch tokens authorize only the session they started; a completed turn or changed provider id consumes them.
  if (
    (providerSessionChanged || (entry.state === 'done' && entry.sessionBoundary !== true)) &&
    paneKey in state.agentLaunchConfigByPaneKey
  ) {
    nextLaunchConfigs = { ...state.agentLaunchConfigByPaneKey }
    delete nextLaunchConfigs[paneKey]
  }
  if (liveRecoveryRecord) {
    if (!recoveryRecordMatches(existingSleepingRecord, liveRecoveryRecord)) {
      nextSleepingAgentSessions = {
        ...state.sleepingAgentSessionsByPaneKey,
        [paneKey]: liveRecoveryRecord
      }
    }
  } else if (existingSleepingRecord) {
    nextSleepingAgentSessions = { ...state.sleepingAgentSessionsByPaneKey }
    delete nextSleepingAgentSessions[paneKey]
  }
  const previousLive = state.agentStatusByPaneKey
  const nextLive = { ...previousLive, [paneKey]: entry }
  const nextLiveCount = countLiveAgentStatuses(previousLive) + (paneKey in previousLive ? 0 : 1)
  const evictedPaneKeys = capLiveAgentStatusesInPlace(
    nextLive,
    paneKey,
    () => classifyPaneKeyLiveness(state),
    updatedAt,
    undefined,
    nextLiveCount
  )
  noteLiveAgentStatusCount(nextLive, nextLiveCount - evictedPaneKeys.length)
  const evictedOrphans = evictedPaneKeys.length > 0
  const evictedEntries: AgentStatusEntry[] = []
  if (evictedOrphans) {
    const evicted = new Set(evictedPaneKeys)
    for (const evictedPaneKey of evictedPaneKeys) {
      const evictedEntry = previousLive[evictedPaneKey]
      if (evictedEntry) {
        evictedEntries.push(evictedEntry)
      }
    }
    nextSleepingAgentSessions = removePaneKeys(nextSleepingAgentSessions, evicted)
    nextLaunchConfigs = removePaneKeys(nextLaunchConfigs, evicted)
  }
  const patch: Partial<AppState> = {
    agentStatusByPaneKey: nextLive,
    retainedAgentsByPaneKey: nextRetainedAgents,
    sleepingAgentSessionsByPaneKey: nextSleepingAgentSessions,
    agentLaunchConfigByPaneKey: nextLaunchConfigs,
    migrationUnsupportedByPtyId: migrationUnsupported.next,
    retentionSuppressedPaneKeys: nextRetentionSuppressedPaneKeys,
    agentStatusEpoch:
      retentionRelevantChange || migrationUnsupported.changed || evictedOrphans
        ? state.agentStatusEpoch + 1
        : state.agentStatusEpoch,
    sortEpoch:
      sortRelevantChange || migrationUnsupported.changed || evictedOrphans
        ? state.sortEpoch + 1
        : state.sortEpoch
  }
  return { patch, evictedEntries }
}
