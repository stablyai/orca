import type {
  AgentTurnLifecycleEvent,
  AgentTurnLifecycleState
} from './agent-turn-lifecycle-contract'
import { eventEvidence, unresolvedTurn } from './agent-turn-lifecycle-reducer-operations'

export function observeExecutionVerdict(
  state: AgentTurnLifecycleState,
  event: Extract<AgentTurnLifecycleEvent, { kind: 'execution-verdict-observed' }>
): void {
  if (state.executionVerdict !== 'exited') {
    state.executionVerdict = event.verdict
  }
  if (event.verdict === 'exited') {
    for (const turn of state.turns) {
      const hasActiveWork = state.work.some(
        (item) => item.turnId === turn.turnId && item.phase === 'active'
      )
      if (turn.phase === 'active' || turn.phase === 'recovering' || hasActiveWork) {
        unresolvedTurn(state, turn.turnId, eventEvidence(event), {
          includeResidentBackground: true
        })
      }
    }
  }
}
