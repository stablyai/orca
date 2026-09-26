import type { AgentTurnLifecycleState } from './agent-turn-lifecycle-contract'
import { findTurn } from './agent-turn-lifecycle-reducer-operations'

export function markJoinedChildKnowledgeUnknown(
  state: AgentTurnLifecycleState,
  turnId: string
): void {
  const turn = findTurn(state, turnId)
  if (turn && turn.phase !== 'abandoned') {
    turn.joinedChildrenKnowledge = 'unknown'
  }
}
