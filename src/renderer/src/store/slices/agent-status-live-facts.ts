import type { AppState } from '../types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type {
  SleepingAgentLaunchConfig,
  SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import { isSmartSortRelevantAgentChange } from '../../../../shared/sidebar-list/smart-sort-agent-change'
import { recordHibernationBoundaryResolved } from '@/lib/agent-hibernation-pane-age'
import {
  findAgentPaneWorktreeId,
  findTabForAgentEntry,
  isAgentCompletionState
} from './agent-status-pane-key-tab-binding'
import { pruneMigrationUnsupportedEntries } from './agent-status-migration-unsupported-entries'
import { liveResumeRecord } from '../../../../shared/agent-resume-record-from-status'
import { agentMainAgentVerdict } from '../../../../shared/agent-main-agent-verdict'

export type AgentStatusLiveFacts = {
  existingSleepingRecord: SleepingAgentSessionRecord | undefined
  liveRecoveryRecord: SleepingAgentSessionRecord | null
  migrationUnsupported: ReturnType<typeof pruneMigrationUnsupportedEntries>
  completionRefreshWorktreeId: string | null
  sortRelevantChange: boolean
  retentionRelevantChange: boolean
  boundaryResolved: boolean
}

export type AgentStatusLiveFactsArgs = {
  state: AppState
  paneKey: string
  entry: AgentStatusEntry
  existing: AgentStatusEntry | undefined
  launchConfigSource: SleepingAgentLaunchConfig | undefined
  retainsResumableRecoveryIdentity: boolean
  commandCodeNewTurn: boolean
  updatedAt: number
}

export function deriveAgentStatusLiveFacts(args: AgentStatusLiveFactsArgs): AgentStatusLiveFacts {
  const {
    state,
    paneKey,
    entry,
    existing,
    launchConfigSource,
    retainsResumableRecoveryIdentity,
    commandCodeNewTurn,
    updatedAt
  } = args
  const boundaryResolved =
    entry.state === 'done' && entry.sessionBoundary !== true && existing?.sessionBoundary === true
  if (boundaryResolved) {
    recordHibernationBoundaryResolved(paneKey, updatedAt)
  }
  const completionRefreshWorktreeId =
    isAgentCompletionState(entry.state) &&
    entry.sessionBoundary !== true &&
    existing !== undefined &&
    !isAgentCompletionState(existing.state)
      ? (entry.worktreeId ?? findAgentPaneWorktreeId(state, paneKey))
      : null
  const attributionChanged =
    existing?.worktreeId !== entry.worktreeId || existing?.tabId !== entry.tabId
  const sortRelevantChange =
    isSmartSortRelevantAgentChange(existing, entry, updatedAt) || commandCodeNewTurn
  const doneRetentionFieldsChanged =
    existing?.state === 'done' &&
    entry.state === 'done' &&
    (entry.prompt !== existing.prompt ||
      entry.updatedAt !== existing.updatedAt ||
      entry.stateStartedAt !== existing.stateStartedAt ||
      entry.agentType !== existing.agentType ||
      entry.model !== existing.model ||
      entry.modelSwitchCommand !== existing.modelSwitchCommand ||
      entry.terminalTitle !== existing.terminalTitle ||
      entry.toolName !== existing.toolName ||
      entry.toolInput !== existing.toolInput ||
      entry.lastAssistantMessage !== existing.lastAssistantMessage ||
      entry.lastAssistantMessageIsToolOutput !== existing.lastAssistantMessageIsToolOutput ||
      entry.orchestration !== existing.orchestration ||
      entry.subagents !== existing.subagents ||
      entry.children !== existing.children ||
      entry.providerSession !== existing.providerSession)
  // Verdicts move no clocks: failures preserve done completion and working subagent state/start.
  const verdictChanged =
    !!existing && agentMainAgentVerdict(entry) !== agentMainAgentVerdict(existing)
  const retentionRelevantChange =
    sortRelevantChange ||
    attributionChanged ||
    existing?.workingMode !== entry.workingMode ||
    verdictChanged ||
    doneRetentionFieldsChanged
  const existingSleepingRecord = state.sleepingAgentSessionsByPaneKey[paneKey]
  const liveRecoveryRecord = liveResumeRecord({
    entry,
    retainsResumableIdentity: retainsResumableRecoveryIdentity,
    worktreeIdOf: () => entry.worktreeId ?? findAgentPaneWorktreeId(state, paneKey),
    tabOf: (worktreeId) => findTabForAgentEntry(state, worktreeId, entry),
    capturedAt: updatedAt,
    launchConfig: launchConfigSource
  })
  const migrationUnsupported = pruneMigrationUnsupportedEntries(
    state.migrationUnsupportedByPtyId,
    (migrationEntry) => migrationEntry.paneKey === paneKey
  )
  return {
    existingSleepingRecord,
    liveRecoveryRecord,
    migrationUnsupported,
    completionRefreshWorktreeId,
    sortRelevantChange,
    retentionRelevantChange,
    boundaryResolved
  }
}
