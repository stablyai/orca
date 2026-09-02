import type { AppState } from '../types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type {
  SleepingAgentLaunchConfig,
  SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import { agentEntryCompletionAt } from '../../../../shared/agent-completion-time'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { recordHibernationBoundaryResolved } from '@/lib/agent-hibernation-pane-age'
import {
  findAgentPaneWorktreeId,
  isAgentCompletionState
} from './agent-status-pane-key-tab-binding'
import { pruneMigrationUnsupportedEntries } from './agent-status-migration-unsupported-entries'
import { sleepingRecordFromEntry } from './agent-status-sleeping-records'

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
  const wasFresh =
    !!existing && isExplicitAgentStatusFresh(existing, updatedAt, AGENT_STATUS_STALE_AFTER_MS)
  const attributionChanged =
    existing?.worktreeId !== entry.worktreeId || existing?.tabId !== entry.tabId
  const sameStateStateStartedAtChanged =
    !!existing && existing.state === entry.state && entry.stateStartedAt !== existing.stateStartedAt
  const sameStateDoneAttentionChanged =
    existing?.state === 'done' &&
    entry.state === 'done' &&
    agentEntryCompletionAt(existing) !== agentEntryCompletionAt(entry)
  const sortRelevantChange =
    !existing ||
    existing.state !== entry.state ||
    !wasFresh ||
    attributionChanged ||
    commandCodeNewTurn ||
    sameStateStateStartedAtChanged ||
    sameStateDoneAttentionChanged
  const doneRetentionFieldsChanged =
    existing?.state === 'done' &&
    entry.state === 'done' &&
    (entry.prompt !== existing.prompt ||
      entry.updatedAt !== existing.updatedAt ||
      entry.stateStartedAt !== existing.stateStartedAt ||
      entry.agentType !== existing.agentType ||
      entry.model !== existing.model ||
      entry.terminalTitle !== existing.terminalTitle ||
      entry.toolName !== existing.toolName ||
      entry.toolInput !== existing.toolInput ||
      entry.lastAssistantMessage !== existing.lastAssistantMessage ||
      entry.lastAssistantMessageIsToolOutput !== existing.lastAssistantMessageIsToolOutput ||
      entry.orchestration !== existing.orchestration ||
      entry.subagents !== existing.subagents ||
      entry.providerSession !== existing.providerSession ||
      entry.interrupted !== existing.interrupted)
  const retentionRelevantChange =
    sortRelevantChange ||
    attributionChanged ||
    existing?.workingMode !== entry.workingMode ||
    doneRetentionFieldsChanged
  const existingSleepingRecord = state.sleepingAgentSessionsByPaneKey[paneKey]
  const liveRecoveryWorktreeId =
    entry.state === 'done' && !retainsResumableRecoveryIdentity
      ? null
      : (entry.worktreeId ?? findAgentPaneWorktreeId(state, paneKey))
  const liveRecoveryRecord = liveRecoveryWorktreeId
    ? sleepingRecordFromEntry({
        state,
        entry: retainsResumableRecoveryIdentity
          ? { ...entry, prompt: '', lastAssistantMessage: undefined }
          : entry,
        worktreeId: liveRecoveryWorktreeId,
        capturedAt: updatedAt,
        launchConfig: launchConfigSource,
        origin: 'live'
      })
    : null
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
