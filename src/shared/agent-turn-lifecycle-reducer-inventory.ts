import type {
  AgentCurrentTurnInventory,
  AgentTurnLifecycleEvent,
  AgentTurnLifecycleState,
  AgentTurnWorkKind,
  AgentTurnWorkRecord
} from './agent-turn-lifecycle-contract'
import { addWork, eventEvidence, findWork, issue } from './agent-turn-lifecycle-reducer-operations'

function normaliseInventoryWork(
  item: AgentCurrentTurnInventory['joinedChildren'][number]
): Pick<AgentTurnWorkRecord, 'phase' | 'outcome'> {
  if (item.phase === 'settled' && item.outcome === undefined) {
    // A complete inventory without an outcome proves settlement, not success.
    return { phase: 'unresolved', outcome: null }
  }
  return {
    phase: item.phase,
    outcome: item.phase === 'settled' ? (item.outcome ?? null) : null
  }
}

export function applyInventoryWork(
  state: AgentTurnLifecycleState,
  turnId: string,
  items: AgentCurrentTurnInventory['joinedChildren'],
  kind: AgentTurnWorkKind,
  event: AgentTurnLifecycleEvent
): boolean {
  const ids = new Set<string>()
  for (const item of items) {
    ids.add(item.workId)
    const existing = findWork(state, turnId, item.workId)
    const normalised = normaliseInventoryWork(item)
    if (existing) {
      if (existing.kind !== kind) {
        issue(state, {
          kind: 'conflicting-outcome',
          turnId,
          workId: item.workId,
          observedAt: event.evidence.observedAt
        })
        continue
      }
      if (
        existing.phase === 'settled' &&
        normalised.phase === 'settled' &&
        existing.outcome !== normalised.outcome
      ) {
        issue(state, {
          kind: 'conflicting-outcome',
          turnId,
          workId: item.workId,
          observedAt: event.evidence.observedAt
        })
        continue
      }
      if (existing.phase !== 'settled' && existing.phase !== 'abandoned') {
        existing.phase = normalised.phase
        existing.outcome = normalised.outcome
        existing.startedAt = existing.startedAt ?? item.startedAt ?? null
        existing.settledAt =
          normalised.phase === 'active' ? null : (item.settledAt ?? event.evidence.observedAt)
        existing.lastEvidence = eventEvidence(event)
      }
      continue
    }
    if (
      !addWork(state, {
        turnId,
        workId: item.workId,
        kind,
        phase: normalised.phase,
        outcome: normalised.outcome,
        startedAt: item.startedAt ?? null,
        settledAt:
          normalised.phase === 'active' ? null : (item.settledAt ?? event.evidence.observedAt),
        lastEvidence: eventEvidence(event)
      })
    ) {
      issue(state, {
        kind: 'capacity-overflow',
        turnId,
        workId: item.workId,
        observedAt: event.evidence.observedAt
      })
      return false
    }
  }
  for (const existing of state.work) {
    if (
      existing.turnId === turnId &&
      existing.kind === kind &&
      existing.phase === 'active' &&
      !ids.has(existing.workId)
    ) {
      existing.phase = 'unresolved'
      existing.outcome = null
      existing.settledAt = event.evidence.observedAt
      existing.lastEvidence = eventEvidence(event)
    }
  }
  return true
}
