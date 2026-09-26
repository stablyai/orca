import type {
  AgentTurnLifecycleEvent,
  AgentTurnLifecycleReduction,
  AgentTurnLifecycleState
} from './agent-turn-lifecycle-contract'
import {
  addTurn,
  addWork,
  eventEvidence,
  findTurn,
  issue,
  turnFromInventory,
  unresolvedTurn
} from './agent-turn-lifecycle-reducer-operations'
import { applyInventoryWork } from './agent-turn-lifecycle-reducer-inventory'
import {
  applyDispatch,
  applyInterruptAcknowledgement,
  applyOutcome
} from './agent-turn-lifecycle-reducer-transitions'
import {
  recoveryAbandoned,
  recoveryExpired,
  recoveryStarted
} from './agent-turn-lifecycle-reducer-recovery'
import { markJoinedChildKnowledgeUnknown } from './agent-turn-lifecycle-reducer-knowledge'
import { observeExecutionVerdict } from './agent-turn-lifecycle-reducer-execution'

type Reason = AgentTurnLifecycleReduction['reason'] | undefined

function turnStarted(
  state: AgentTurnLifecycleState,
  event: Extract<AgentTurnLifecycleEvent, { kind: 'turn-started' }>
): Reason {
  const existing = findTurn(state, event.turnId)
  if (existing) {
    if (existing.phase === 'active' || existing.phase === 'recovering') {
      existing.startedAt = existing.startedAt ?? event.startedAt ?? event.evidence.observedAt
      existing.lastEvidence = eventEvidence(event)
      state.currentTurnId = event.turnId
      state.recoveries = state.recoveries.filter((entry) => entry.turnId !== event.turnId)
    }
    return undefined
  }
  if (
    !addTurn(state, {
      turnId: event.turnId,
      phase: 'active',
      outcome: null,
      joinedChildrenKnowledge: 'unknown',
      integrityBreached: false,
      interrupt: 'none',
      interruptInputWrittenAt: null,
      startedAt: event.startedAt ?? event.evidence.observedAt,
      settledAt: null,
      lastEvidence: eventEvidence(event)
    })
  ) {
    issue(state, {
      kind: 'capacity-overflow',
      turnId: event.turnId,
      observedAt: event.evidence.observedAt
    })
    return 'capacity'
  }
  if (state.currentTurnId && state.currentTurnId !== event.turnId) {
    unresolvedTurn(state, state.currentTurnId, eventEvidence(event))
  }
  state.currentTurnId = event.turnId
  return undefined
}

function inventory(
  state: AgentTurnLifecycleState,
  event: Extract<AgentTurnLifecycleEvent, { kind: 'current-turn-inventory' }>
): Reason {
  const priorCurrent = state.currentTurnId
  if (priorCurrent && (!event.currentTurn || priorCurrent !== event.currentTurn.turnId)) {
    unresolvedTurn(state, priorCurrent, eventEvidence(event))
  }
  if (event.currentTurn && !turnFromInventory(state, event.currentTurn, event)) {
    issue(state, {
      kind: 'capacity-overflow',
      turnId: event.currentTurn.turnId,
      observedAt: event.evidence.observedAt
    })
    return 'capacity'
  }
  if (!event.currentTurn) {
    state.currentTurnId = null
    return undefined
  }
  const turn = findTurn(state, event.currentTurn.turnId)
  if (!turn || turn.phase !== 'active') {
    state.currentTurnId = null
    return undefined
  }
  if (
    !applyInventoryWork(
      state,
      event.currentTurn.turnId,
      event.currentTurn.joinedChildren,
      'joined-child',
      event
    ) ||
    !applyInventoryWork(
      state,
      event.currentTurn.turnId,
      event.currentTurn.residentBackground,
      'resident-background',
      event
    )
  ) {
    return 'capacity'
  }
  turn.joinedChildrenKnowledge = 'complete'
  return undefined
}

function workStarted(
  state: AgentTurnLifecycleState,
  event: Extract<AgentTurnLifecycleEvent, { kind: 'work-started' }>
): Reason {
  const existing = state.work.find(
    (item) => item.turnId === event.turnId && item.workId === event.workId
  )
  if (existing) {
    if (existing.kind !== event.workKind) {
      issue(state, {
        kind: 'conflicting-outcome',
        turnId: event.turnId,
        workId: event.workId,
        observedAt: event.evidence.observedAt
      })
      return 'conflict'
    }
    if (existing.phase === 'active') {
      existing.lastEvidence = eventEvidence(event)
    }
    return undefined
  }
  if (
    !addWork(state, {
      turnId: event.turnId,
      workId: event.workId,
      kind: event.workKind,
      phase: 'active',
      outcome: null,
      startedAt: event.startedAt ?? event.evidence.observedAt,
      settledAt: null,
      lastEvidence: eventEvidence(event)
    })
  ) {
    issue(state, {
      kind: 'capacity-overflow',
      turnId: event.turnId,
      workId: event.workId,
      observedAt: event.evidence.observedAt
    })
    return 'capacity'
  }
  if (event.workKind === 'joined-child') {
    markJoinedChildKnowledgeUnknown(state, event.turnId)
  }
  return undefined
}

function workOutcome(
  state: AgentTurnLifecycleState,
  event: Extract<AgentTurnLifecycleEvent, { kind: 'work-outcome-observed' }>
): Reason {
  const existing = state.work.find(
    (item) => item.turnId === event.turnId && item.workId === event.workId
  )
  if (existing?.phase === 'abandoned') {
    return undefined
  }
  if (existing && existing.kind !== event.workKind) {
    issue(state, {
      kind: 'conflicting-outcome',
      turnId: event.turnId,
      workId: event.workId,
      observedAt: event.evidence.observedAt
    })
    return 'conflict'
  }
  if (existing && existing.outcome !== null && existing.outcome !== event.outcome) {
    issue(state, {
      kind: 'conflicting-outcome',
      turnId: event.turnId,
      workId: event.workId,
      observedAt: event.evidence.observedAt
    })
    return 'conflict'
  }
  if (existing) {
    existing.phase = 'settled'
    existing.outcome = event.outcome
    existing.settledAt = event.settledAt ?? event.evidence.observedAt
    existing.lastEvidence = eventEvidence(event)
    return undefined
  }
  if (
    !addWork(state, {
      turnId: event.turnId,
      workId: event.workId,
      kind: event.workKind,
      phase: 'settled',
      outcome: event.outcome,
      startedAt: null,
      settledAt: event.settledAt ?? event.evidence.observedAt,
      lastEvidence: eventEvidence(event)
    })
  ) {
    issue(state, {
      kind: 'capacity-overflow',
      turnId: event.turnId,
      workId: event.workId,
      observedAt: event.evidence.observedAt
    })
    return 'capacity'
  }
  if (event.workKind === 'joined-child') {
    markJoinedChildKnowledgeUnknown(state, event.turnId)
  }
  return undefined
}

export function reduceAgentTurnEvent(
  state: AgentTurnLifecycleState,
  event: AgentTurnLifecycleEvent
): Reason {
  switch (event.kind) {
    case 'turn-started':
      return turnStarted(state, event)
    case 'turn-outcome-observed':
      return applyOutcome(
        state,
        event.turnId,
        event.outcome,
        event.settledAt ?? event.evidence.observedAt,
        event,
        event.recordKind === 'terminal-record'
      )
        ? undefined
        : event.recordKind === 'event' && !findTurn(state, event.turnId)
          ? 'stale'
          : 'conflict'
    case 'turn-interrupt-requested': {
      const turn = findTurn(state, event.turnId)
      if (turn && turn.phase === 'active') {
        turn.interrupt = 'requested'
        turn.lastEvidence = eventEvidence(event)
      }
      return undefined
    }
    case 'turn-interrupt-input-written': {
      const turn = findTurn(state, event.turnId)
      if (turn && (turn.phase === 'active' || turn.phase === 'recovering')) {
        turn.interruptInputWrittenAt = event.writtenAt ?? event.evidence.observedAt
        turn.lastEvidence = eventEvidence(event)
      }
      return undefined
    }
    case 'turn-interrupt-acknowledged':
      return applyInterruptAcknowledgement(
        state,
        event.turnId,
        event.settledAt ?? event.evidence.observedAt,
        event
      )
        ? undefined
        : 'stale'
    case 'work-started':
      return workStarted(state, event)
    case 'work-outcome-observed':
      return workOutcome(state, event)
    case 'current-turn-inventory':
      return inventory(state, event)
    case 'turn-recovery-started':
      return recoveryStarted(state, event)
    case 'turn-recovery-expired':
      return recoveryExpired(state, event)
    case 'turn-recovery-abandoned':
      return recoveryAbandoned(state, event)
    case 'execution-verdict-observed':
      observeExecutionVerdict(state, event)
      return undefined
    case 'dispatch-associated':
      return applyDispatch(state, event.dispatchId, event.turnId, 'unobserved', null, event)
        ? undefined
        : 'capacity'
    case 'dispatch-received':
      return applyDispatch(state, event.dispatchId, event.turnId, 'received', null, event)
        ? undefined
        : 'conflict'
    case 'dispatch-rejected':
      return applyDispatch(state, event.dispatchId, event.turnId, 'rejected', 'failed', event)
        ? undefined
        : 'conflict'
    case 'dispatch-abandoned':
      return applyDispatch(state, event.dispatchId, event.turnId, 'unobserved', 'abandoned', event)
        ? undefined
        : 'conflict'
  }
}
