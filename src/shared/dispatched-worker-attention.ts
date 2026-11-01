import type { AgentSessionAttentionEdge } from './agent-session/agent-session-attention'
import { detectAgentStatusFromTitle } from './agent-detection'
import type { AgentStatusOrchestrationContext, AgentStatusState } from './agent-status-types'

type ReadOrchestration = () => AgentStatusOrchestrationContext | undefined

/** A dispatched worker's finished turn is news for the agent it reports to; only a stop that needs the person (a prompt) reaches them. A context with no parent (a coordinator's self-dispatch) is the person's own agent. */
export function isCoordinatorOnlyNews(
  agentState: AgentStatusState | undefined,
  readOrchestration: ReadOrchestration
): boolean {
  if (agentState !== 'done') {
    return false
  }
  const orchestration = readOrchestration()
  return Boolean(orchestration?.parentPaneKey || orchestration?.parentTerminalHandle)
}

/** The same rule for a chat edge: a failed turn that leaves a prompt waiting still needs the person. */
export function isCoordinatorOnlyChatNews(
  edge: AgentSessionAttentionEdge,
  agentState: AgentStatusState,
  readOrchestration: ReadOrchestration
): boolean {
  const leavesPrompt = edge.type === 'completion' && edge.completion.awaitingUser === true
  return !leavesPrompt && isCoordinatorOnlyNews(agentState, readOrchestration)
}

/** A title waiting for approval outranks the hook row's state, whatever the hooks last said. */
export function withApprovalTitle<State extends AgentStatusState | undefined>(
  agentState: State,
  title: string | null | undefined
): State | 'blocked' {
  return title && detectAgentStatusFromTitle(title) === 'permission' ? 'blocked' : agentState
}
