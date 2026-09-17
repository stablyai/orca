import type {
  AgentCurrentTurnInventory,
  AgentTurnEvidence,
  AgentTurnLifecycleEvent,
  AgentTurnOwner
} from '../agent-turn-lifecycle'
import type { ProviderTurnEvidence } from './provider-turn-evidence'

function lifecycleEvidence(evidence: ProviderTurnEvidence): AgentTurnEvidence {
  return {
    eventId: evidence.eventId,
    producerId: evidence.producerId,
    observedAt: evidence.observedAt
  }
}

function inventoryFor(evidence: ProviderTurnEvidence): AgentCurrentTurnInventory | null {
  const inventory = evidence.inventory
  if (!inventory) {
    return null
  }
  return {
    turnId: inventory.turnId,
    ...(inventory.startedAt !== undefined ? { startedAt: inventory.startedAt } : {}),
    joinedChildren: inventory.joinedChildren.map((work) => ({
      workId: work.workId,
      phase: work.phase,
      ...(work.outcome ? { outcome: work.outcome } : {}),
      ...(work.startedAt !== undefined ? { startedAt: work.startedAt } : {}),
      ...(work.settledAt !== undefined ? { settledAt: work.settledAt } : {})
    })),
    residentBackground: inventory.residentBackground.map((work) => ({
      workId: work.workId,
      phase: work.phase,
      ...(work.outcome ? { outcome: work.outcome } : {}),
      ...(work.startedAt !== undefined ? { startedAt: work.startedAt } : {}),
      ...(work.settledAt !== undefined ? { settledAt: work.settledAt } : {})
    }))
  }
}

/**
 * Converts provider facts into C1 lifecycle events. This adapter deliberately has no state and
 * never chooses a row status; the host supplies the committed owner and invokes the reducer.
 */
export function providerEvidenceToLifecycleEvents(
  owner: AgentTurnOwner,
  evidence: ProviderTurnEvidence
): AgentTurnLifecycleEvent[] {
  const base = { owner, evidence: lifecycleEvidence(evidence) }
  switch (evidence.kind) {
    case 'turn-started':
      return evidence.turnId
        ? [
            {
              ...base,
              kind: 'turn-started',
              turnId: evidence.turnId,
              startedAt: evidence.observedAt
            }
          ]
        : []
    case 'turn-outcome-observed':
      return evidence.turnId && evidence.outcome !== undefined && evidence.outcome !== 'interrupted'
        ? [
            {
              ...base,
              kind: 'turn-outcome-observed',
              turnId: evidence.turnId,
              outcome: evidence.outcome,
              settledAt: evidence.observedAt,
              recordKind: evidence.recordKind ?? 'event'
            }
          ]
        : []
    case 'turn-interrupt-acknowledged':
      return evidence.turnId
        ? [
            {
              ...base,
              kind: 'turn-interrupt-acknowledged',
              turnId: evidence.turnId,
              settledAt: evidence.observedAt
            }
          ]
        : []
    case 'work-started':
      return evidence.turnId && evidence.workId && evidence.workKind
        ? [
            {
              ...base,
              kind: 'work-started',
              turnId: evidence.turnId,
              workId: evidence.workId,
              workKind: evidence.workKind,
              startedAt: evidence.observedAt
            }
          ]
        : []
    case 'work-outcome-observed':
      return evidence.turnId && evidence.workId && evidence.workKind && evidence.outcome
        ? [
            {
              ...base,
              kind: 'work-outcome-observed',
              turnId: evidence.turnId,
              workId: evidence.workId,
              workKind: evidence.workKind,
              outcome: evidence.outcome,
              settledAt: evidence.observedAt
            }
          ]
        : []
    case 'current-turn-inventory':
      return [
        {
          ...base,
          kind: 'current-turn-inventory',
          complete: true,
          currentTurn: inventoryFor(evidence)
        }
      ]
  }
}
