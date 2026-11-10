import {
  type AgentProviderSessionMetadata,
  agentProviderSessionsEqual
} from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type {
  AgentStatusEntry,
  AgentType
} from '../../../../../shared/agent-status/contracts/agent-status-types'
import { AGENT_STATE_HISTORY_MAX } from '../../../../../shared/agent-status/lifecycle/agent-state-history'
import { sameAgentStatusTerminalOwner } from '../../../../../shared/agent-status/identity/agent-status-terminal-owner'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from '@/lib/workspace/ownership/worktree-runtime-owner-state'
import type { AppState } from '../../types'
import { findAgentPaneWorktreeId } from './agent-status-pane-key-tab-binding'

export type AgentPaneConversationIdentity = {
  paneKey: string
  worktreeId: string
  executionHostId: ExecutionHostId
  connectionId: string | null
  agent: AgentType
  providerSession?: AgentProviderSessionMetadata
  firstStateStartedAt?: number
  promptCandidates?: readonly string[]
}

type ConversationState = WorktreeRuntimeOwnerState &
  Pick<AppState, 'tabsByWorktree'> &
  Partial<Pick<AppState, 'agentConversationsByPaneKey'>>
type ConversationEntry = Pick<
  AgentStatusEntry,
  'paneKey' | 'agentType' | 'providerSession' | 'worktreeId' | 'connectionId'
> &
  Partial<Pick<AgentStatusEntry, 'firstStateStartedAt' | 'prompt'>>

export function agentPaneConversationForEntry(
  state: ConversationState,
  entry: ConversationEntry,
  executionHostId = getExecutionHostIdForWorktree(state, entry.worktreeId)
): AgentPaneConversationIdentity | undefined {
  const previous = state.agentConversationsByPaneKey?.[entry.paneKey]
  return previous &&
    previous.agent === entry.agentType &&
    previous.executionHostId === executionHostId &&
    sameAgentStatusTerminalOwner(previous, {
      worktreeId: entry.worktreeId,
      connectionId: entry.connectionId ?? null
    })
    ? previous
    : undefined
}

/** Accepted conversation identity/first clock survives transient occupancy loss, never renders a row or requests resume; explicit pane retirement deletes it. */
export function projectAgentPaneConversation(
  state: ConversationState,
  entry: ConversationEntry,
  copy: (
    entries: AppState['agentConversationsByPaneKey']
  ) => AppState['agentConversationsByPaneKey'] = (entries) => ({ ...entries }),
  executionHostId?: ExecutionHostId
): AppState['agentConversationsByPaneKey'] {
  const current = state.agentConversationsByPaneKey ?? {}
  const agent = entry.agentType
  const worktreeId = entry.worktreeId ?? findAgentPaneWorktreeId(state, entry.paneKey)
  if (!agent || agent === 'unknown' || !worktreeId) {
    return current
  }
  const ownerHostId = executionHostId ?? getExecutionHostIdForWorktree(state, worktreeId)
  const previous = agentPaneConversationForEntry(state, { ...entry, worktreeId }, ownerHostId)
  const sameProvider =
    !previous?.providerSession ||
    !entry.providerSession ||
    agentProviderSessionsEqual(
      agent,
      {
        ...previous.providerSession,
        transcriptPath:
          previous.providerSession.transcriptPath ?? entry.providerSession.transcriptPath
      },
      {
        ...entry.providerSession,
        transcriptPath:
          entry.providerSession.transcriptPath ?? previous.providerSession.transcriptPath
      }
    )
  const providerSession =
    previous?.providerSession &&
    (!entry.providerSession ||
      agentProviderSessionsEqual(agent, previous.providerSession, entry.providerSession))
      ? previous.providerSession
      : entry.providerSession
  const firstStateStartedAt =
    (sameProvider ? previous?.firstStateStartedAt : undefined) ?? entry.firstStateStartedAt
  const prompt = entry.prompt?.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 1024)
  let promptCandidates = providerSession ? undefined : previous?.promptCandidates
  if (prompt && !providerSession && promptCandidates?.at(-1) !== prompt) {
    promptCandidates = [
      ...(promptCandidates ?? []).filter((value) => value !== prompt),
      prompt
    ].slice(-(AGENT_STATE_HISTORY_MAX + 1))
  }
  if (
    previous &&
    sameProvider &&
    previous.providerSession === providerSession &&
    previous.firstStateStartedAt === firstStateStartedAt &&
    previous.promptCandidates === promptCandidates
  ) {
    return current
  }
  const next = copy(current)
  Object.defineProperty(next, entry.paneKey, {
    value: {
      paneKey: entry.paneKey,
      worktreeId,
      executionHostId: ownerHostId,
      connectionId: entry.connectionId ?? null,
      agent,
      ...(providerSession ? { providerSession } : {}),
      ...(firstStateStartedAt !== undefined ? { firstStateStartedAt } : {}),
      ...(promptCandidates ? { promptCandidates } : {})
    },
    writable: true,
    enumerable: true,
    configurable: true
  })
  return next
}
