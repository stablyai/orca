import type { AgentStatusState } from './agent-status-types'

/** A snapshot of a previous agent state, used to render activity blocks.
 *  Why: intentionally narrower than AgentStatusEntry — tool/assistant context is
 *  per-turn, not meaningful on a historical snapshot, and would bloat memory.
 *  Coalesced-turn output lives in AgentStatusEntry.lastCompletedAssistantMessage,
 *  one copy per pane, so it can't multiply by AGENT_STATE_HISTORY_MAX. */
export type AgentStateHistoryEntry = {
  state: AgentStatusState
  prompt: string
  /** When this state was first reported. */
  startedAt: number
  /** `updatedAt` of the write that switched into this state. `startedAt` can predate an earlier
   *  entry (an answered ask returns to its turn's end), so this orders and identifies the switch. */
  observedAt?: number
  /** True when this `done` was a cancellation (agent hook like Claude `is_interrupt`,
   *  or Orca's guarded fallback). Always falsy for non-`done` states so retention logic can preserve it. */
  interrupted?: boolean
}

/** Maximum number of history entries kept per agent to bound memory. */
export const AGENT_STATE_HISTORY_MAX = 20
