import {
  classifyConversationContinuity,
  normalizedConversationPrompt,
  type AgentConversationContinuity,
  type AgentConversationSource
} from './agent-conversation-continuity'
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
  continuity?: AgentConversationContinuity
}

type ConversationState = WorktreeRuntimeOwnerState &
  Pick<AppState, 'tabsByWorktree'> &
  Partial<Pick<AppState, 'agentConversationsByPaneKey'>>
type ConversationEntry = Pick<
  AgentStatusEntry,
  'paneKey' | 'agentType' | 'providerSession' | 'worktreeId' | 'connectionId'
> &
  Partial<
    Pick<
      AgentStatusEntry,
      | 'firstStateStartedAt'
      | 'prompt'
      | 'state'
      | 'stateStartedAt'
      | 'turnStartedAt'
      | 'promptInteractionKey'
      | 'observation'
    >
  >

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
  executionHostId?: ExecutionHostId,
  source?: AgentConversationSource
): AppState['agentConversationsByPaneKey'] {
  const current = state.agentConversationsByPaneKey ?? {}
  const agent = entry.agentType
  const worktreeId = entry.worktreeId ?? findAgentPaneWorktreeId(state, entry.paneKey)
  if (!agent || agent === 'unknown' || !worktreeId) {
    return current
  }
  const ownerHostId = executionHostId ?? getExecutionHostIdForWorktree(state, worktreeId)
  const previous = agentPaneConversationForEntry(state, { ...entry, worktreeId }, ownerHostId)
  const acceptance = classifyAgentPaneConversation(
    state,
    { ...entry, worktreeId },
    source ?? entry,
    ownerHostId
  )
  if (acceptance.stale) {
    return current
  }
  const sameProvider = !acceptance.reset
  const carried = sameProvider ? previous : undefined
  const providerSession =
    carried?.providerSession &&
    (!source?.providerSession ||
      providersCompatible(agent, carried.providerSession, source.providerSession))
      ? carried.providerSession
      : (source?.providerSession ?? (acceptance.reset ? undefined : entry.providerSession))
  const firstStateStartedAt =
    (sameProvider ? previous?.firstStateStartedAt : undefined) ?? entry.firstStateStartedAt
  const prompt = normalizedConversationPrompt(entry.prompt)
  let promptCandidates = providerSession ? undefined : carried?.promptCandidates
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
    previous.promptCandidates === promptCandidates &&
    previous.continuity === acceptance.continuity
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
      ...(acceptance.continuity ? { continuity: acceptance.continuity } : {}),
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

function providersCompatible(
  agent: AgentType | undefined,
  previous: AgentProviderSessionMetadata,
  incoming: AgentProviderSessionMetadata
): boolean {
  return agentProviderSessionsEqual(
    agent,
    { ...previous, transcriptPath: previous.transcriptPath ?? incoming.transcriptPath },
    { ...incoming, transcriptPath: incoming.transcriptPath ?? previous.transcriptPath }
  )
}

export function classifyAgentPaneConversation(
  state: ConversationState,
  entry: ConversationEntry,
  source: AgentConversationSource,
  executionHostId?: ExecutionHostId
) {
  const previous = agentPaneConversationForEntry(state, entry, executionHostId)
  const providerChanged = Boolean(
    previous?.providerSession &&
    source.providerSession &&
    !providersCompatible(entry.agentType, previous.providerSession, source.providerSession)
  )
  const confirmedProvider = Boolean(
    previous?.providerSession && source.providerSession && !providerChanged
  )
  const phase = classifyConversationContinuity(
    providerChanged ? undefined : previous?.continuity,
    source,
    entry.agentType,
    confirmedProvider
  )
  const reset =
    providerChanged ||
    phase.successor ||
    Boolean(state.agentConversationsByPaneKey?.[entry.paneKey] && !previous)
  return { previous, reset, continuity: phase.continuity, stale: phase.stale }
}
