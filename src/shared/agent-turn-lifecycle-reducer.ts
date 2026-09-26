import type {
  AgentTurnLifecycleEvent,
  AgentTurnLifecycleReduction,
  AgentTurnLifecycleState
} from './agent-turn-lifecycle-contract'
import {
  agentTurnOwnersEqual,
  isAgentTurnEvidence,
  isAgentTurnLifecycleEvent,
  isAgentTurnOwner
} from './agent-turn-lifecycle-state'
import {
  copyLifecycleState,
  rememberEvent,
  wasApplied
} from './agent-turn-lifecycle-reducer-operations'
import {
  committedDispatches,
  committedOutcomes,
  reconcileDispatches
} from './agent-turn-lifecycle-reducer-transitions'
import { reduceAgentTurnEvent } from './agent-turn-lifecycle-reducer-events'
import { expireRecoveries } from './agent-turn-lifecycle-reducer-recovery'

function ignored(
  state: AgentTurnLifecycleState,
  reason: AgentTurnLifecycleReduction['reason']
): AgentTurnLifecycleReduction {
  return { state, disposition: 'ignored', reason, committedOutcomes: [], committedDispatches: [] }
}

/** Applies one host-attributed fact; provider adapters must not reduce status themselves. */
export function reduceAgentTurnLifecycle(
  state: AgentTurnLifecycleState,
  event: AgentTurnLifecycleEvent
): AgentTurnLifecycleReduction {
  if (!isAgentTurnLifecycleEvent(event) || !isAgentTurnEvidence(event.evidence)) {
    return ignored(state, 'invalid-event')
  }
  if (!isAgentTurnOwner(state.owner) || !agentTurnOwnersEqual(state.owner, event.owner)) {
    return ignored(state, 'owner-mismatch')
  }
  if (wasApplied(state, event)) {
    return { state, disposition: 'duplicate', committedOutcomes: [], committedDispatches: [] }
  }
  const next = copyLifecycleState(state)
  // Retain rejected evidence too: replaying the same stale fact forever must not
  // turn a provider delivery race into an unbounded host workload.
  rememberEvent(next, event)
  const reason = reduceAgentTurnEvent(next, event)
  // Expire first: a lapsed custody must release its turn before dispatches settle.
  expireRecoveries(next, event.evidence.observedAt)
  reconcileDispatches(next, event.evidence.observedAt)
  return {
    state: next,
    disposition: reason ? 'ignored' : 'accepted',
    ...(reason ? { reason } : {}),
    committedOutcomes: committedOutcomes(state, next),
    committedDispatches: committedDispatches(state, next)
  }
}
