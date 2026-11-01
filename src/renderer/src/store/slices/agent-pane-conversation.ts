import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'
import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { AppState } from '../types'
import { findAgentPaneWorktreeId } from './agent-status/agent-status-pane-key-tab-binding'

export type AgentPaneConversationIdentity = {
  paneKey: string
  worktreeId: string
  executionHostId: ExecutionHostId
  connectionId: string | null
  agent: AgentType
  providerSession: AgentProviderSessionMetadata
}

/** Conversation identity outlives turn occupancy; it never requests an automatic resume. */
export function projectAgentPaneConversation(
  state: AppState,
  entry: Pick<
    AgentStatusEntry,
    'paneKey' | 'agentType' | 'providerSession' | 'worktreeId' | 'connectionId'
  >,
  copy: (
    entries: AppState['agentConversationsByPaneKey']
  ) => AppState['agentConversationsByPaneKey'] = (entries) => ({ ...entries })
): AppState['agentConversationsByPaneKey'] {
  const current = state.agentConversationsByPaneKey
  const previous = current[entry.paneKey]
  const agent = entry.agentType
  const worktreeId = entry.worktreeId ?? findAgentPaneWorktreeId(state, entry.paneKey)
  if (!agent || agent === 'unknown' || !entry.providerSession?.id || !worktreeId) {
    if (!previous) {
      return current
    }
    const next = copy(current)
    delete next[entry.paneKey]
    return next
  }
  const executionHostId = getExecutionHostIdForWorktree(state, worktreeId)
  const connectionId = entry.connectionId ?? null
  if (
    previous?.agent === agent &&
    previous.worktreeId === worktreeId &&
    previous.executionHostId === executionHostId &&
    previous.connectionId === connectionId &&
    agentProviderSessionsEqual(agent, previous.providerSession, entry.providerSession)
  ) {
    return current
  }
  const next = copy(current)
  Object.defineProperty(next, entry.paneKey, {
    value: {
      paneKey: entry.paneKey,
      worktreeId,
      executionHostId,
      connectionId,
      agent,
      providerSession: entry.providerSession
    },
    writable: true,
    enumerable: true,
    configurable: true
  })
  return next
}
