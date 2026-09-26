import type {
  AgentCurrentTurnInventory,
  AgentTurnEvidence,
  AgentTurnIntegrityIssue,
  AgentTurnLifecycleEvent,
  AgentTurnDispatchRecord,
  AgentTurnLifecycleState,
  AgentTurnRecord,
  AgentTurnWorkRecord
} from './agent-turn-lifecycle-contract'
import {
  AGENT_TURN_MAX_APPLIED_EVENTS,
  AGENT_TURN_MAX_DISPATCHES,
  AGENT_TURN_MAX_INTEGRITY_ISSUES,
  AGENT_TURN_MAX_TURNS,
  AGENT_TURN_MAX_WORK_ITEMS
} from './agent-turn-lifecycle-state'

export const eventEvidence = (event: AgentTurnLifecycleEvent): AgentTurnEvidence => ({
  ...event.evidence
})

export function copyLifecycleState(state: AgentTurnLifecycleState): AgentTurnLifecycleState {
  return {
    ...state,
    owner: { ...state.owner, attachment: { ...state.owner.attachment } },
    turns: state.turns.map((turn) => ({ ...turn, lastEvidence: { ...turn.lastEvidence } })),
    work: state.work.map((item) => ({ ...item, lastEvidence: { ...item.lastEvidence } })),
    dispatches: state.dispatches.map((dispatch) => ({
      ...dispatch,
      lastEvidence: { ...dispatch.lastEvidence }
    })),
    recoveries: state.recoveries.map((recovery) => ({
      ...recovery,
      lastEvidence: { ...recovery.lastEvidence }
    })),
    integrityIssues: state.integrityIssues.map((entry) => ({ ...entry })),
    appliedEvents: state.appliedEvents.map((entry) => ({ ...entry }))
  }
}

export function findTurn(
  state: AgentTurnLifecycleState,
  turnId: string
): AgentTurnRecord | undefined {
  return state.turns.find((turn) => turn.turnId === turnId)
}

export function findWork(
  state: AgentTurnLifecycleState,
  turnId: string,
  workId: string
): AgentTurnWorkRecord | undefined {
  return state.work.find((item) => item.turnId === turnId && item.workId === workId)
}

export function findDispatch(
  state: AgentTurnLifecycleState,
  dispatchId: string
): AgentTurnDispatchRecord | undefined {
  return state.dispatches.find((dispatch) => dispatch.dispatchId === dispatchId)
}

export function issue(state: AgentTurnLifecycleState, entry: AgentTurnIntegrityIssue): void {
  // Latch the breach on the turn itself; the ring below can evict this entry.
  if (entry.turnId !== undefined) {
    const turn = findTurn(state, entry.turnId)
    if (turn) {
      turn.integrityBreached = true
    }
  }
  if (
    state.integrityIssues.some(
      (existing) =>
        existing.kind === entry.kind &&
        existing.turnId === entry.turnId &&
        existing.workId === entry.workId &&
        existing.dispatchId === entry.dispatchId
    )
  ) {
    return
  }
  state.integrityIssues.push(entry)
  if (state.integrityIssues.length > AGENT_TURN_MAX_INTEGRITY_ISSUES) {
    state.integrityIssues.splice(0, state.integrityIssues.length - AGENT_TURN_MAX_INTEGRITY_ISSUES)
  }
}

export function rememberEvent(
  state: AgentTurnLifecycleState,
  event: AgentTurnLifecycleEvent
): void {
  state.appliedEvents.push({
    producerId: event.evidence.producerId,
    eventId: event.evidence.eventId
  })
  if (state.appliedEvents.length > AGENT_TURN_MAX_APPLIED_EVENTS) {
    state.appliedEvents.splice(0, state.appliedEvents.length - AGENT_TURN_MAX_APPLIED_EVENTS)
  }
}

export function wasApplied(
  state: AgentTurnLifecycleState,
  event: AgentTurnLifecycleEvent
): boolean {
  return state.appliedEvents.some(
    (applied) =>
      applied.producerId === event.evidence.producerId && applied.eventId === event.evidence.eventId
  )
}

export function addTurn(state: AgentTurnLifecycleState, turn: AgentTurnRecord): boolean {
  if (state.turns.some((existing) => existing.turnId === turn.turnId)) {
    return true
  }
  const removable = state.turns.findIndex(
    (existing) => existing.phase === 'settled' || existing.phase === 'abandoned'
  )
  if (state.turns.length >= AGENT_TURN_MAX_TURNS && removable === -1) {
    return false
  }
  if (removable !== -1 && state.turns.length >= AGENT_TURN_MAX_TURNS) {
    const removed = state.turns[removable]
    issue(state, {
      kind: 'capacity-overflow',
      turnId: removed.turnId,
      observedAt: turn.lastEvidence.observedAt
    })
    state.turns.splice(removable, 1)
  }
  state.turns.push(turn)
  return true
}

export function addWork(state: AgentTurnLifecycleState, work: AgentTurnWorkRecord): boolean {
  if (
    state.work.some(
      (existing) => existing.turnId === work.turnId && existing.workId === work.workId
    )
  ) {
    return true
  }
  const removable = state.work.findIndex(
    (existing) => existing.phase === 'settled' || existing.phase === 'abandoned'
  )
  if (state.work.length >= AGENT_TURN_MAX_WORK_ITEMS && removable === -1) {
    return false
  }
  if (removable !== -1 && state.work.length >= AGENT_TURN_MAX_WORK_ITEMS) {
    const removed = state.work[removable]
    issue(state, {
      kind: 'capacity-overflow',
      turnId: removed.turnId,
      observedAt: work.lastEvidence.observedAt
    })
    state.work.splice(removable, 1)
  }
  state.work.push(work)
  return true
}

export function addDispatch(
  state: AgentTurnLifecycleState,
  dispatch: AgentTurnDispatchRecord
): boolean {
  if (state.dispatches.some((existing) => existing.dispatchId === dispatch.dispatchId)) {
    return true
  }
  const removable = state.dispatches.findIndex((existing) => existing.outcome !== null)
  if (state.dispatches.length >= AGENT_TURN_MAX_DISPATCHES && removable === -1) {
    return false
  }
  if (removable !== -1 && state.dispatches.length >= AGENT_TURN_MAX_DISPATCHES) {
    state.dispatches.splice(removable, 1)
  }
  state.dispatches.push(dispatch)
  return true
}

export function unresolvedTurn(
  state: AgentTurnLifecycleState,
  turnId: string,
  evidence: AgentTurnEvidence,
  options: { includeResidentBackground?: boolean } = {}
): void {
  const at = evidence.observedAt
  const turn = findTurn(state, turnId)
  if (turn && (turn.phase === 'active' || turn.phase === 'recovering')) {
    turn.phase = 'unresolved'
    turn.settledAt = at
    turn.lastEvidence = evidence
  }
  for (const item of state.work) {
    if (
      item.turnId === turnId &&
      item.phase === 'active' &&
      (options.includeResidentBackground === true || item.kind === 'joined-child')
    ) {
      item.phase = 'unresolved'
      item.settledAt = at
      item.lastEvidence = evidence
    }
  }
  if (state.currentTurnId === turnId) {
    state.currentTurnId = null
  }
}

export function turnFromInventory(
  state: AgentTurnLifecycleState,
  inventory: AgentCurrentTurnInventory,
  event: AgentTurnLifecycleEvent
): boolean {
  const existing = findTurn(state, inventory.turnId)
  if (existing?.phase === 'settled' || existing?.phase === 'abandoned') {
    return true
  }
  if (existing) {
    existing.phase = 'active'
    existing.outcome = null
    existing.interrupt = 'none'
    existing.interruptInputWrittenAt = null
    existing.settledAt = null
    existing.startedAt = existing.startedAt ?? inventory.startedAt ?? event.evidence.observedAt
    existing.lastEvidence = eventEvidence(event)
  } else if (
    !addTurn(state, {
      turnId: inventory.turnId,
      phase: 'active',
      outcome: null,
      joinedChildrenKnowledge: 'unknown',
      integrityBreached: false,
      interrupt: 'none',
      interruptInputWrittenAt: null,
      startedAt: inventory.startedAt ?? event.evidence.observedAt,
      settledAt: null,
      lastEvidence: eventEvidence(event)
    })
  ) {
    return false
  }
  state.currentTurnId = inventory.turnId
  state.recoveries = state.recoveries.filter((entry) => entry.turnId !== inventory.turnId)
  return true
}
