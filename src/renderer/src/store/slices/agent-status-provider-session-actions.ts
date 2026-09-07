import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { AgentStatusRuntime } from './agent-status-runtime'
import type {
  AgentProviderSessionRecordMetadata,
  AgentProviderSessionRouting,
  AgentProviderSessionTiming
} from './agent-status-contract'
import {
  agentProviderSessionsEqual,
  getAgentResumeArgv,
  type ResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import { resolveAgentPaneAuthorityKey } from './agent-pane-authority'
import {
  findAgentPaneWorktreeId,
  getTabIdFromPaneKey,
  isRecentlyClosedAgentStatusTab
} from './agent-status-pane-key-tab-binding'
import { removePaneKeys } from './agent-status-pane-keyed-records'
import { registryEntryMatchesStatus } from './agent-status-launch-config'
import { copyLaunchConfig } from './agent-status-sleeping-records'

export function createAgentStatusProviderSessionActions(
  runtime: AgentStatusRuntime
): Pick<AgentStatusSlice, 'recordAgentProviderSession'> {
  const { get, set, requestFreshness } = runtime
  return {
    recordAgentProviderSession: (
      paneKey: string,
      agent: ResumableTuiAgent,
      providerSession: AgentProviderSessionMetadata,
      timing?: AgentProviderSessionTiming,
      routing?: AgentProviderSessionRouting,
      metadata?: AgentProviderSessionRecordMetadata
    ) => {
      paneKey = resolveAgentPaneAuthorityKey(paneKey)
      const updatedAt = timing?.updatedAt ?? Date.now()
      if (
        paneKey in get().recentlyRetiredAgentStatusPaneKeys ||
        isRecentlyClosedAgentStatusTab(
          get().recentlyClosedAgentStatusTabIds,
          getTabIdFromPaneKey(paneKey)
        ) ||
        !getAgentResumeArgv(agent, providerSession)
      ) {
        return
      }
      let removedLiveStatus = false
      set((s) => {
        const existingStatus = s.agentStatusByPaneKey[paneKey]
        const existingRecord = s.sleepingAgentSessionsByPaneKey[paneKey]
        if (
          (existingStatus && updatedAt < existingStatus.updatedAt) ||
          (existingRecord && updatedAt < existingRecord.updatedAt)
        ) {
          return s
        }
        const tabId = routing?.tabId ?? getTabIdFromPaneKey(paneKey) ?? existingRecord?.tabId
        const worktreeId =
          routing?.worktreeId ??
          existingStatus?.worktreeId ??
          existingRecord?.worktreeId ??
          findAgentPaneWorktreeId(s, paneKey)
        if (!worktreeId) {
          return s
        }
        const registryEntry = s.agentLaunchConfigByPaneKey[paneKey]
        const registryMatches = registryEntryMatchesStatus({
          entry: registryEntry,
          paneKey,
          agentType: agent,
          tabId,
          terminalHandle: undefined,
          launchToken: metadata?.launchToken,
          providerSession,
          existingProviderSession: existingRecord?.providerSession,
          providerSessionChanged: false
        })
        const existingRecordMatchesProviderSession =
          existingRecord?.agent === agent &&
          agentProviderSessionsEqual(agent, existingRecord.providerSession, providerSession)
        // Why: provider-session heartbeats can arrive after the turn is complete; preserve the
        // completed checkpoint so a late heartbeat cannot make it eligible for ghost resume.
        const preservesCompletedRecoveryRecord =
          existingRecordMatchesProviderSession && existingRecord?.state === 'done'
        // Why: an explicit quit capture must remain the resume handle until a new provider session replaces it.
        const preservesQuitOrigin =
          existingRecordMatchesProviderSession && existingRecord?.origin === 'quit'
        const launchConfig =
          (registryMatches ? registryEntry?.launchConfig : undefined) ??
          (existingRecordMatchesProviderSession ? existingRecord.launchConfig : undefined)
        const record: SleepingAgentSessionRecord = {
          paneKey,
          ...(tabId ? { tabId } : {}),
          worktreeId,
          agent,
          providerSession,
          prompt: '',
          // Why: durable process/session identity, not visible turn state; a non-done value keeps cold restore eligible.
          state: preservesCompletedRecoveryRecord ? 'done' : 'working',
          capturedAt: updatedAt,
          updatedAt,
          ...(existingStatus?.terminalTitle
            ? { terminalTitle: existingStatus.terminalTitle }
            : existingRecord?.terminalTitle
              ? { terminalTitle: existingRecord.terminalTitle }
              : {}),
          ...(routing?.connectionId !== undefined
            ? { connectionId: routing.connectionId }
            : existingRecord?.connectionId !== undefined
              ? { connectionId: existingRecord.connectionId }
              : {}),
          ...(launchConfig ? { launchConfig: copyLaunchConfig(launchConfig) } : {}),
          ...(existingRecordMatchesProviderSession &&
          existingRecord.automaticResumeBlockedBy === 'legacy-orchestration-worker'
            ? { automaticResumeBlockedBy: 'legacy-orchestration-worker' }
            : {}),
          ...(preservesCompletedRecoveryRecord && existingRecord.interrupted !== undefined
            ? { interrupted: existingRecord.interrupted }
            : {}),
          origin: preservesQuitOrigin ? 'quit' : 'live'
        }
        removedLiveStatus = existingStatus !== undefined
        const nextLive = removedLiveStatus ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        if (removedLiveStatus) {
          delete nextLive[paneKey]
        }
        const nextRetained =
          paneKey in s.retainedAgentsByPaneKey
            ? { ...s.retainedAgentsByPaneKey }
            : s.retainedAgentsByPaneKey
        if (nextRetained !== s.retainedAgentsByPaneKey) {
          delete nextRetained[paneKey]
        }
        const retiredPaneKeys = new Set([paneKey])
        // Why: on identity mismatch the sleeping record drops its launch config, so clear the stale
        // registry entry too, else a later return to the old identity reuses stale args/env.
        let nextLaunchConfigs = s.agentLaunchConfigByPaneKey
        if (registryMatches && registryEntry) {
          nextLaunchConfigs = {
            ...nextLaunchConfigs,
            [paneKey]: {
              ...registryEntry,
              identity: { ...registryEntry.identity, providerSession }
            }
          }
        } else if (registryEntry) {
          nextLaunchConfigs = { ...nextLaunchConfigs }
          delete nextLaunchConfigs[paneKey]
        }
        return {
          agentStatusByPaneKey: nextLive,
          retainedAgentsByPaneKey: nextRetained,
          sleepingAgentSessionsByPaneKey: {
            ...s.sleepingAgentSessionsByPaneKey,
            [paneKey]: record
          },
          agentLaunchConfigByPaneKey: nextLaunchConfigs,
          acknowledgedAgentsByPaneKey: removePaneKeys(
            s.acknowledgedAgentsByPaneKey,
            retiredPaneKeys
          ),
          // Why the cleared-at/manual-unread maps stay: the pane survives this transition, so a
          // repeat heartbeat would resurrect cleared history. They are swept on pane retirement.
          unreadAgentCompletionPanes: removePaneKeys(s.unreadAgentCompletionPanes, retiredPaneKeys),
          agentStatusEpoch: removedLiveStatus ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          sortEpoch: removedLiveStatus ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      if (removedLiveStatus) {
        requestFreshness(true)
      }
    }
  }
}
