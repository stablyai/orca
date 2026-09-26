import type {
  AgentTurnCommittedDispatch,
  AgentTurnCommittedOutcome,
  AgentTurnDispatchRecord,
  AgentTurnLifecycleEvent,
  AgentTurnLifecycleState,
  AgentTurnOutcome
} from './agent-turn-lifecycle-contract'
import {
  agentTurnCompletionId,
  agentTurnDispatchSettlementId,
  AGENT_TURN_MAX_RECOVERIES
} from './agent-turn-lifecycle-state'
import {
  addDispatch,
  addTurn,
  eventEvidence,
  findDispatch,
  findTurn,
  issue
} from './agent-turn-lifecycle-reducer-operations'

export function applyOutcome(
  state: AgentTurnLifecycleState,
  turnId: string,
  outcome: Exclude<AgentTurnOutcome, 'interrupted'>,
  settledAt: number,
  event: AgentTurnLifecycleEvent,
  allowMissedStart: boolean
): boolean {
  const existing = findTurn(state, turnId)
  if (existing?.outcome !== null && existing?.outcome !== undefined) {
    if (existing.outcome !== outcome) {
      issue(state, { kind: 'conflicting-outcome', turnId, observedAt: event.evidence.observedAt })
      return false
    }
    return true
  }
  if (existing?.phase === 'abandoned') {
    return false
  }
  if (!existing && !allowMissedStart) {
    return false
  }
  if (existing) {
    existing.phase = 'settled'
    existing.outcome = outcome
    existing.settledAt = settledAt
    existing.lastEvidence = eventEvidence(event)
  } else if (
    !addTurn(state, {
      turnId,
      phase: 'settled',
      outcome,
      joinedChildrenKnowledge: 'unknown',
      integrityBreached: false,
      interrupt: 'none',
      interruptInputWrittenAt: null,
      startedAt: null,
      settledAt,
      lastEvidence: eventEvidence(event)
    })
  ) {
    return false
  }
  state.recoveries = state.recoveries.filter((entry) => entry.turnId !== turnId)
  if (state.currentTurnId === turnId) {
    state.currentTurnId = null
  }
  return true
}

export function applyInterruptAcknowledgement(
  state: AgentTurnLifecycleState,
  turnId: string,
  settledAt: number,
  event: AgentTurnLifecycleEvent
): boolean {
  const existing = findTurn(state, turnId)
  if (existing?.outcome !== null && existing?.outcome !== undefined) {
    return existing.outcome === 'interrupted'
  }
  if (existing?.phase === 'abandoned') {
    return false
  }
  if (existing) {
    existing.phase = 'settled'
    existing.outcome = 'interrupted'
    existing.interrupt = 'acknowledged'
    existing.settledAt = settledAt
    existing.lastEvidence = eventEvidence(event)
  } else {
    return false
  }
  state.recoveries = state.recoveries.filter((entry) => entry.turnId !== turnId)
  if (state.currentTurnId === turnId) {
    state.currentTurnId = null
  }
  return true
}

export function applyDispatch(
  state: AgentTurnLifecycleState,
  dispatchId: string,
  turnId: string,
  receipt: AgentTurnDispatchRecord['receipt'],
  outcome: AgentTurnDispatchRecord['outcome'],
  event: AgentTurnLifecycleEvent
): boolean {
  const existing = findDispatch(state, dispatchId)
  if (existing && existing.turnId !== turnId) {
    issue(state, {
      kind: 'conflicting-dispatch-turn',
      dispatchId,
      observedAt: event.evidence.observedAt
    })
    return false
  }
  if (existing) {
    if (existing.outcome !== null) {
      return existing.outcome === outcome || outcome === null
    }
    if (
      (existing.receipt === 'rejected' && receipt === 'received') ||
      (existing.receipt === 'received' && receipt === 'rejected')
    ) {
      return false
    }
    if (existing.receipt === 'unobserved') {
      existing.receipt = receipt
    }
    if (outcome !== null) {
      existing.outcome = outcome
      existing.settledAt = event.evidence.observedAt
    }
    existing.lastEvidence = eventEvidence(event)
    return true
  }
  return addDispatch(state, {
    dispatchId,
    turnId,
    receipt,
    outcome,
    settledAt: outcome === null ? null : event.evidence.observedAt,
    lastEvidence: eventEvidence(event)
  })
}

function deriveDispatchOutcome(
  state: AgentTurnLifecycleState,
  dispatch: AgentTurnDispatchRecord
): AgentTurnDispatchRecord['outcome'] {
  if (dispatch.receipt !== 'received' || dispatch.outcome !== null) {
    return dispatch.outcome
  }
  const turn = findTurn(state, dispatch.turnId)
  if (!turn) {
    return null
  }
  if (turn.phase === 'abandoned') {
    return 'abandoned'
  }
  if (turn.phase === 'unresolved' || turn.phase === 'recovering') {
    return 'unresolved'
  }
  if (turn.phase !== 'settled' || turn.outcome === null) {
    return null
  }
  if (turn.outcome !== 'completed') {
    return turn.outcome
  }
  if (turn.joinedChildrenKnowledge !== 'complete') {
    return 'unresolved'
  }
  if (turn.integrityBreached) {
    return 'unresolved'
  }
  const joined = state.work.filter(
    (item) => item.turnId === dispatch.turnId && item.kind === 'joined-child'
  )
  if (joined.some((item) => item.phase === 'active')) {
    return null
  }
  if (joined.some((item) => item.phase === 'unresolved' || item.phase === 'abandoned')) {
    return 'unresolved'
  }
  const childFailure = joined.find(
    (item) => item.outcome === 'failed' || item.outcome === 'interrupted'
  )
  return childFailure?.outcome ?? 'completed'
}

export function reconcileDispatches(state: AgentTurnLifecycleState, observedAt: number): void {
  for (const dispatch of state.dispatches) {
    const outcome = deriveDispatchOutcome(state, dispatch)
    if (outcome !== null && dispatch.outcome === null) {
      dispatch.outcome = outcome
      dispatch.settledAt = observedAt
    }
  }
}

export function committedOutcomes(
  before: AgentTurnLifecycleState,
  after: AgentTurnLifecycleState
): AgentTurnCommittedOutcome[] {
  const committed: AgentTurnCommittedOutcome[] = []
  for (const turn of after.turns) {
    if (turn.phase !== 'settled' || turn.outcome === null) {
      continue
    }
    const prior = findTurn(before, turn.turnId)
    if (prior?.phase === 'settled' && prior.outcome === turn.outcome) {
      continue
    }
    committed.push({
      completionId: agentTurnCompletionId(after.owner, turn.turnId, turn.outcome),
      turnId: turn.turnId,
      outcome: turn.outcome
    })
  }
  return committed
}

export function committedDispatches(
  before: AgentTurnLifecycleState,
  after: AgentTurnLifecycleState
): AgentTurnCommittedDispatch[] {
  const committed: AgentTurnCommittedDispatch[] = []
  for (const dispatch of after.dispatches) {
    if (dispatch.outcome === null) {
      continue
    }
    const prior = findDispatch(before, dispatch.dispatchId)
    if (prior?.outcome === dispatch.outcome) {
      continue
    }
    committed.push({
      settlementId: agentTurnDispatchSettlementId(
        after.owner,
        dispatch.dispatchId,
        dispatch.turnId
      ),
      dispatchId: dispatch.dispatchId,
      turnId: dispatch.turnId,
      outcome: dispatch.outcome
    })
  }
  return committed
}

export function markRecovery(
  state: AgentTurnLifecycleState,
  turnId: string,
  custodyId: string,
  deadlineAt: number,
  event: AgentTurnLifecycleEvent
): boolean {
  if (state.recoveries.some((entry) => entry.custodyId === custodyId)) {
    return true
  }
  if (state.recoveries.length >= AGENT_TURN_MAX_RECOVERIES) {
    return false
  }
  state.recoveries.push({
    custodyId,
    turnId,
    deadlineAt,
    lastEvidence: eventEvidence(event)
  })
  return true
}
