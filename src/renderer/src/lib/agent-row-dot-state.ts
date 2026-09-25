import type { AgentDotState } from '@/components/AgentStateDot'
import { resolveAgentPaneDisplayState } from '../../../shared/agent-status-display-state'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { AgentRowState } from './agent-row-decay-state'

type AgentRowDotInput = {
  /** The row's state after the reader's staleness decay. */
  state: AgentRowState
  entry: Pick<AgentStatusEntry, 'state' | 'workingMode' | 'interrupted' | 'mainAgent'>
}

/**
 * Map an agent row onto the shared state-indicator vocabulary. One copy so the sidebar card, the
 * dashboard row and the notes send menu cannot drift on a new member.
 */
export function agentRowDotState({ state, entry }: AgentRowDotInput): AgentDotState {
  return resolveAgentPaneDisplayState(
    entry,
    state === 'idle' || state === 'unverifiable' ? state : undefined
  )
}
