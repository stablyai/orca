import type { DecisionGate } from '../../../../shared/decision-gate-types'

export function parseDecisionGateOptions(options: string): string[] {
  try {
    const parsed: unknown = JSON.parse(options)
    return Array.isArray(parsed) && parsed.every((option) => typeof option === 'string')
      ? parsed
      : []
  } catch {
    return []
  }
}

export function mergePendingDecisionGates(
  current: DecisionGate[],
  incoming: DecisionGate[]
): DecisionGate[] {
  const byId = new Map(current.map((gate) => [gate.id, gate]))
  for (const gate of incoming) {
    if (gate.status === 'pending') {
      byId.set(gate.id, gate)
    } else {
      byId.delete(gate.id)
    }
  }
  return Array.from(byId.values()).sort((left, right) =>
    left.created_at === right.created_at
      ? left.id.localeCompare(right.id)
      : left.created_at.localeCompare(right.created_at)
  )
}
