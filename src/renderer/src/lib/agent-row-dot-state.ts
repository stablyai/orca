import type { AgentDotState } from '@/components/AgentStateDot'
import type { AgentWorkingMode } from '../../../shared/agent-status-types'
import type { AgentRowState } from './agent-row-decay-state'
import {
  agentMainAgentVerdict,
  type AgentMainAgentVerdictSource
} from '../../../shared/agent-main-agent-verdict'

/**
 * Map an agent row's state onto the shared state-indicator vocabulary. One copy so the
 * sidebar card, the dashboard row and the notes send menu cannot drift on a new member.
 */
export function agentRowDotState(
  state: AgentRowState,
  workingMode?: AgentWorkingMode
): AgentDotState {
  switch (state) {
    case 'working':
      return workingMode === 'monitoring' ? 'monitoring' : 'working'
    case 'blocked':
    case 'waiting':
    case 'done':
    case 'idle':
    case 'unverifiable':
      return state
  }
  return 'idle'
}

/** The mark a done row's verdict earns: a stopped turn and a failed one each keep their own, and
 *  both outrank the plain done dot. Null when the row is not done or finished cleanly. */
export function agentVerdictDotState(
  row: AgentMainAgentVerdictSource
): Extract<AgentDotState, 'interrupted' | 'failed'> | null {
  const verdict = agentMainAgentVerdict(row)
  return verdict === 'failure' ? 'failed' : verdict === 'cancellation' ? 'interrupted' : null
}
