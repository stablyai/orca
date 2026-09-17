import { normalizeProviderTurnIdentity } from './provider-turn-identity'
import type {
  ProviderCurrentTurnInventory,
  ProviderTurnInventoryWork,
  ProviderWorkKind
} from './provider-turn-evidence-types'

const MAX_WORK_IDS = 128

type ProviderTurnInventoryFields = {
  providerTurnInventory?: ProviderCurrentTurnInventory | null
  providerTurnInventoryComplete?: true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalTimestamp(value: unknown): number | undefined | null {
  if (value === undefined) {
    return undefined
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function providerCurrentTurnInventory(
  value: unknown,
  complete: unknown
): ProviderCurrentTurnInventory | null {
  if (complete !== true || typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  if (!isRecord(value)) {
    return null
  }
  const record = value
  const turnId = normalizeProviderTurnIdentity(record.turnId ?? record.turn_id ?? record.id)
  if (!turnId) {
    return null
  }
  const readWork = (
    candidate: unknown,
    kind: ProviderWorkKind
  ): ProviderTurnInventoryWork[] | null => {
    if (!Array.isArray(candidate) || candidate.length > MAX_WORK_IDS) {
      return null
    }
    const result: ProviderTurnInventoryWork[] = []
    for (const item of candidate) {
      if (!isRecord(item)) {
        return null
      }
      const workId = normalizeProviderTurnIdentity(item.workId ?? item.work_id ?? item.id)
      const phase =
        item.phase === 'active' || item.phase === 'settled' || item.phase === 'unresolved'
          ? item.phase
          : null
      if (!workId || !phase) {
        return null
      }
      const outcome =
        item.outcome === 'completed' || item.outcome === 'failed' || item.outcome === 'interrupted'
          ? item.outcome
          : undefined
      if ((phase === 'active' || phase === 'unresolved') && outcome !== undefined) {
        return null
      }
      const startedAt = optionalTimestamp(item.startedAt)
      const settledAt = optionalTimestamp(item.settledAt)
      if (startedAt === null || settledAt === null) {
        return null
      }
      result.push({
        workId,
        kind,
        phase,
        ...(outcome ? { outcome } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(settledAt !== undefined ? { settledAt } : {})
      })
    }
    result.sort((left, right) =>
      left.workId < right.workId ? -1 : left.workId > right.workId ? 1 : 0
    )
    return result
  }
  const joinedChildren = readWork(record.joinedChildren ?? record.joined_children, 'joined-child')
  const residentBackground = readWork(
    record.residentBackground ?? record.resident_background,
    'resident-background'
  )
  if (joinedChildren === null || residentBackground === null) {
    return null
  }
  const workIds = new Set([...joinedChildren, ...residentBackground].map((item) => item.workId))
  if (workIds.size !== joinedChildren.length + residentBackground.length) {
    return null
  }
  const startedAt = optionalTimestamp(record.startedAt)
  if (startedAt === null) {
    return null
  }
  return {
    turnId,
    ...(startedAt !== undefined ? { startedAt } : {}),
    joinedChildren,
    residentBackground
  }
}

export function normalizeProviderTurnInventoryFields(
  inventoryValue: unknown,
  completeValue: unknown
): ProviderTurnInventoryFields | null {
  if (completeValue !== true) {
    return inventoryValue === undefined ? {} : null
  }
  if (inventoryValue === null) {
    return { providerTurnInventory: null, providerTurnInventoryComplete: true }
  }
  const inventory = providerCurrentTurnInventory(inventoryValue, true)
  return inventory
    ? { providerTurnInventory: inventory, providerTurnInventoryComplete: true }
    : null
}
