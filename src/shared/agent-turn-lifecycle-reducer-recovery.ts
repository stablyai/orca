import type {
  AgentTurnLifecycleEvent,
  AgentTurnLifecycleReduction,
  AgentTurnLifecycleState
} from './agent-turn-lifecycle-contract'
import {
  addTurn,
  eventEvidence,
  findTurn,
  issue,
  unresolvedTurn
} from './agent-turn-lifecycle-reducer-operations'
import { markRecovery } from './agent-turn-lifecycle-reducer-transitions'

type Reason = AgentTurnLifecycleReduction['reason'] | undefined

export function recoveryStarted(
  state: AgentTurnLifecycleState,
  event: Extract<AgentTurnLifecycleEvent, { kind: 'turn-recovery-started' }>
): Reason {
  const current = findTurn(state, event.turnId)
  if (current?.phase === 'settled' || current?.phase === 'abandoned') {
    return undefined
  }
  if (!markRecovery(state, event.turnId, event.custodyId, event.deadlineAt, event)) {
    issue(state, {
      kind: 'capacity-overflow',
      turnId: event.turnId,
      observedAt: event.evidence.observedAt
    })
    return 'capacity'
  }
  const turn = findTurn(state, event.turnId)
  if (turn) {
    turn.phase = 'recovering'
    turn.lastEvidence = eventEvidence(event)
    return undefined
  }
  if (
    !addTurn(state, {
      turnId: event.turnId,
      phase: 'recovering',
      outcome: null,
      joinedChildrenKnowledge: 'unknown',
      integrityBreached: false,
      interrupt: 'none',
      interruptInputWrittenAt: null,
      startedAt: null,
      settledAt: null,
      lastEvidence: eventEvidence(event)
    })
  ) {
    // The custody marker and the turn are one bounded obligation. If the turn
    // cannot be admitted, do not leave a recovery entry that can never settle.
    state.recoveries = state.recoveries.filter((entry) => entry.custodyId !== event.custodyId)
    issue(state, {
      kind: 'capacity-overflow',
      turnId: event.turnId,
      observedAt: event.evidence.observedAt
    })
    return 'capacity'
  }
  return undefined
}

export function recoveryExpired(
  state: AgentTurnLifecycleState,
  event: Extract<AgentTurnLifecycleEvent, { kind: 'turn-recovery-expired' }>
): Reason {
  const recovery = state.recoveries.find(
    (entry) => entry.custodyId === event.custodyId && entry.turnId === event.turnId
  )
  if (!recovery || event.evidence.observedAt < recovery.deadlineAt) {
    return 'stale'
  }
  state.recoveries = state.recoveries.filter((entry) => entry.custodyId !== event.custodyId)
  unresolvedTurn(state, event.turnId, eventEvidence(event))
  return undefined
}

export function recoveryAbandoned(
  state: AgentTurnLifecycleState,
  event: Extract<AgentTurnLifecycleEvent, { kind: 'turn-recovery-abandoned' }>
): Reason {
  const recovery = state.recoveries.find(
    (entry) => entry.custodyId === event.custodyId && entry.turnId === event.turnId
  )
  if (!recovery) {
    return 'stale'
  }
  state.recoveries = state.recoveries.filter((entry) => entry.custodyId !== event.custodyId)
  const turn = findTurn(state, event.turnId)
  if (turn && turn.phase !== 'settled') {
    turn.phase = 'abandoned'
    turn.outcome = null
    turn.settledAt = event.evidence.observedAt
    turn.lastEvidence = eventEvidence(event)
  }
  if (state.currentTurnId === event.turnId) {
    state.currentTurnId = null
  }
  return undefined
}

/** The host re-derives this expiry itself, so it is not attributable to any provider. */
const HOST_RECOVERY_EXPIRY_PRODUCER = 'host:turn-recovery-expiry'

/**
 * TTL re-derivation. A custody whose producer dies before sending its expiry event
 * must still die here, or the turn stays `recovering` and every dispatch on it stays
 * `unresolved` for the life of the process.
 */
export function expireRecoveries(state: AgentTurnLifecycleState, observedAt: number): void {
  const lapsed = state.recoveries.filter((entry) => entry.deadlineAt <= observedAt)
  if (lapsed.length === 0) {
    return
  }
  state.recoveries = state.recoveries.filter((entry) => entry.deadlineAt > observedAt)
  for (const recovery of lapsed) {
    unresolvedTurn(state, recovery.turnId, {
      eventId: `recovery-expiry:${recovery.custodyId}`,
      producerId: HOST_RECOVERY_EXPIRY_PRODUCER,
      observedAt
    })
  }
}
