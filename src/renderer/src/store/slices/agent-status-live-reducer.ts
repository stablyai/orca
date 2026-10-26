import type { AppState } from '../types'
import type { AgentStatusReadState } from '../agent-status-observers'
import type { AgentStatusTransaction } from '../agent-status-commit'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  capLiveAgentStatusesInPlace,
  classifyPaneKeyLiveness,
  countLiveAgentStatuses,
  noteLiveAgentStatusCount
} from './agent-status-capacity-eviction'
import { removePaneKeys } from './agent-status-pane-keyed-records'
import type { AgentStatusLiveEntryBuild } from './agent-status-live-entry-builder'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'
import { liveResumeRecordChange } from '../../../../shared/agent-resume-record-from-status'

export type AgentStatusLiveUpdateReduction = {
  patch: Partial<AppState>
  /** Rows the cap dropped, so freshness can move its cached minimum without a full rescan. */
  evictedEntries: AgentStatusEntry[]
}

export function reduceAgentStatusLiveUpdate(
  state: AgentStatusReadState,
  build: AgentStatusLiveEntryBuild,
  updatedAt: number,
  editEntries: AgentStatusTransaction['editEntries']
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
  const recordChange = liveResumeRecordChange(existingSleepingRecord, liveRecoveryRecord)
  if (recordChange === 'clear') {
    nextSleepingAgentSessions = { ...state.sleepingAgentSessionsByPaneKey }
    delete nextSleepingAgentSessions[paneKey]
  } else if (recordChange) {
    nextSleepingAgentSessions = {
      ...state.sleepingAgentSessionsByPaneKey,
      [paneKey]: recordChange.set
    }
  }
  const previousLive = state.agentStatusByPaneKey
  const nextLiveCount = countLiveAgentStatuses(previousLive) + (paneKey in previousLive ? 0 : 1)
  const evictedEntries: AgentStatusEntry[] = []
  let evictedPaneKeys: readonly string[] = []
  editEntries((draft) => {
    draft[paneKey] = entry
    evictedPaneKeys = capLiveAgentStatusesInPlace(
      draft,
      paneKey,
      () => classifyPaneKeyLiveness(state),
      updatedAt,
      undefined,
      nextLiveCount,
      (evicted) => evictedEntries.push(evicted)
    )
    noteLiveAgentStatusCount(draft, nextLiveCount - evictedPaneKeys.length)
    return [paneKey, ...evictedPaneKeys]
  })
  const evictedOrphans = evictedPaneKeys.length > 0
  if (evictedOrphans) {
    const evicted = new Set(evictedPaneKeys)
    nextSleepingAgentSessions = removePaneKeys(nextSleepingAgentSessions, evicted)
    nextLaunchConfigs = removePaneKeys(nextLaunchConfigs, evicted)
  }
  const patch: Partial<AppState> = {
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
