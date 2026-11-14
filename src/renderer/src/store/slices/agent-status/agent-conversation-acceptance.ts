import type { AppState } from '../../types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { resolveAgentSessionStartedAt } from '../../../../../shared/agent-session/lifecycle/agent-session-start-time'
import { classifyAgentPaneConversation } from './agent-pane-conversation'
import type { AgentConversationSource } from './agent-conversation-continuity'
import { findAgentPaneWorktreeId } from './agent-status-pane-key-tab-binding'
import type {
  AgentStatusMetadata,
  AgentStatusPayload,
  AgentStatusRouting,
  AgentStatusTiming
} from './agent-status-contract'

export function localAgentConversationAcceptance(
  args: {
    state: AppState
    paneKey: string
    payload: AgentStatusPayload
    routing?: AgentStatusRouting
    timing?: AgentStatusTiming
    metadata?: AgentStatusMetadata
  },
  agentType: AgentStatusEntry['agentType']
) {
  const { state, paneKey, payload, routing, timing, metadata } = args
  const existing = state.agentStatusByPaneKey.get(paneKey)
  const source: AgentConversationSource = {
    ...payload,
    stateStartedAt: timing?.stateStartedAt,
    turnStartedAt: timing?.turnStartedAt,
    isReplay: timing?.isReplay,
    providerSession: metadata?.providerSession
  }
  const owner = {
    paneKey,
    agentType,
    worktreeId:
      routing?.worktreeId ??
      existing?.worktreeId ??
      findAgentPaneWorktreeId(state, paneKey) ??
      undefined,
    connectionId:
      routing?.connectionId === undefined
        ? (existing?.connectionId ?? state.sleepingAgentSessionsByPaneKey[paneKey]?.connectionId)
        : routing.connectionId
  }
  return { ...classifyAgentPaneConversation(state, owner, source), source }
}

export function conversationSessionStartedAt(
  entry: AgentStatusEntry,
  existing: AgentStatusEntry | undefined,
  acceptance: ReturnType<typeof classifyAgentPaneConversation>,
  source: AgentConversationSource
): number {
  if (acceptance.reset) {
    return (
      source.firstStateStartedAt ??
      acceptance.newTurnStartedAt ??
      entry.evidenceObservedAt ??
      entry.updatedAt
    )
  }
  const previous = acceptance.previous
  return resolveAgentSessionStartedAt({
    entry,
    previous: existing ?? (previous ? { ...previous, agentType: previous.agent } : undefined),
    identity: { ...entry, providerSession: source.providerSession }
  })
}
