import type { AgentStatusState } from './agent-status-types'
import type { AgentMainAgentStatus } from './main-agent-status'

/** Keep per-turn tool/assistant context out of history to bound memory; completed output lives once per pane in lastCompletedAssistantMessage, not once per history entry. */
export type AgentStateHistoryEntry = {
  state: AgentStatusState
  prompt: string
  /** When this state was first reported. */
  startedAt: number
  /** The switching write's updatedAt orders/identifies this entry; startedAt may move backwards when an answered ask returns to its turn end. */
  observedAt?: number
  /** True when this `done` was a cancellation (agent hook like Claude `is_interrupt`,
   *  or Orca's guarded fallback). Always falsy for non-`done` states so retention logic can preserve it. */
  interrupted?: boolean
  /** The main agent's own status when this state was left, copied with `interrupted` by
   *  `agentVerdictFields`; read the verdict through `agentMainAgentVerdict`. */
  mainAgent?: AgentMainAgentStatus
}

/** Maximum number of history entries kept per agent to bound memory. */
export const AGENT_STATE_HISTORY_MAX = 20
