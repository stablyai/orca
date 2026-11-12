import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { replaceRecordEntries } from '../../keyed-record-transitions'
import { projectAgentPaneConversation } from './agent-pane-conversation'
import type { AppState } from '../../types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { MAX_LIVE_AGENT_STATUSES } from './agent-status-capacity-eviction'
import { removePaneKeys } from './agent-status-pane-keyed-records'
import type { AgentStatusLiveEntryBuild } from './agent-status-live-entry-builder'
import { agentProviderSessionsEqual } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { liveResumeRecordChange } from '../../../../../shared/agent-session/lifecycle/agent-resume-record-from-status'
import { retiresLaunch } from './agent-status-launch-config'

export type AgentStatusLiveUpdateReduction = {
  patch: Partial<AppState>
  /** Rows the cap dropped, so freshness can move its cached minimum without a full rescan. */
  evictedEntries: AgentStatusEntry[]
}

export function reduceAgentStatusLiveUpdate(
  state: AppState,
  build: AgentStatusLiveEntryBuild,
  updatedAt: number,
  projectConversation = projectAgentPaneConversation
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
    aggregateRelevantChange,
    sortRelevantChange
  } = build
  const paneKey = entry.paneKey
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
  // A completed turn, changed provider id or the owner retiring the launch consumes its token.
  if (
    (providerSessionChanged ||
      (entry.state === 'done' && entry.sessionBoundary !== true) ||
      retiresLaunch(state.agentStatusByPaneKey.get(paneKey), entry)) &&
    paneKey in state.agentLaunchConfigByPaneKey
  ) {
    nextLaunchConfigs = { ...state.agentLaunchConfigByPaneKey }
    delete nextLaunchConfigs[paneKey]
  }
  const recordChange = liveResumeRecordChange(existingSleepingRecord, liveRecoveryRecord)
  if (recordChange === 'clear') {
    nextSleepingAgentSessions = replaceRecordEntries<SleepingAgentSessionRecord>(
      state.sleepingAgentSessionsByPaneKey,
      [[paneKey, null]]
    )
  } else if (recordChange) {
    nextSleepingAgentSessions = replaceRecordEntries<SleepingAgentSessionRecord>(
      state.sleepingAgentSessionsByPaneKey,
      [[paneKey, recordChange.set]]
    )
  }
  const previousLive = state.agentStatusByPaneKey
  const nextLive = previousLive.replace([[paneKey, entry]])
  const evictedPaneKeys = nextLive.projection.evictionKeys(
    nextLive,
    state.terminalLayoutsByTabId,
    paneKey,
    updatedAt,
    MAX_LIVE_AGENT_STATUSES
  )
  const evictedOrphans = evictedPaneKeys.length > 0
  const evictedEntries = evictedPaneKeys.flatMap((key) => {
    const row = nextLive.get(key)
    return row ? [row] : []
  })
  if (evictedOrphans) {
    const evicted = new Set(evictedPaneKeys)
    nextSleepingAgentSessions = removePaneKeys(nextSleepingAgentSessions, evicted)
    nextLaunchConfigs = removePaneKeys(nextLaunchConfigs, evicted)
  }
  nextLive.replace(evictedPaneKeys.map((key) => [key, null] as const))
  const nextConversations = projectConversation(
    state,
    entry,
    undefined,
    undefined,
    build.conversationSource
  )
  const patch: Partial<AppState> = {
    agentStatusByPaneKey: nextLive,
    ...(nextConversations !== state.agentConversationsByPaneKey
      ? { agentConversationsByPaneKey: nextConversations }
      : {}),
    sleepingAgentSessionsByPaneKey: nextSleepingAgentSessions,
    agentLaunchConfigByPaneKey: nextLaunchConfigs,
    migrationUnsupportedByPtyId: migrationUnsupported.next,
    agentStatusEpoch:
      aggregateRelevantChange || migrationUnsupported.changed || evictedOrphans
        ? state.agentStatusEpoch + 1
        : state.agentStatusEpoch,
    sortEpoch:
      sortRelevantChange || migrationUnsupported.changed || evictedOrphans
        ? state.sortEpoch + 1
        : state.sortEpoch
  }
  return { patch, evictedEntries }
}
