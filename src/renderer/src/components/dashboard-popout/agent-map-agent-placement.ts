import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { agentMapDurationMinutes, agentMapNodeStatus } from './agent-map-node-metadata'

const GOLDEN_ANGLE = 2.399963229728653

function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function placeAgentMapAgents({
  worktreeId,
  cards,
  radius,
  agentRadius,
  now
}: {
  worktreeId: string
  cards: DashboardCard[]
  radius: number
  agentRadius: number
  now: number
}): {
  card: DashboardCard
  x: number
  y: number
  radius: number
  durationMinutes: number
  status: DashboardCard['dotState']
}[] {
  const availableRadius = Math.max(0, radius - agentRadius - 6)
  const sorted = [...cards].sort((a, b) =>
    a.paneKey < b.paneKey ? -1 : a.paneKey > b.paneKey ? 1 : 0
  )
  const capacity = Math.ceil(Math.sqrt(Math.max(1, sorted.length))) ** 2
  const angleOffset = (stableHash(worktreeId) / 0xffffffff) * Math.PI * 2

  return sorted.map((card, index) => {
    const orbit = sorted.length === 1 ? 0 : Math.sqrt((index + 0.5) / capacity) * availableRadius
    const angle = angleOffset + index * GOLDEN_ANGLE
    return {
      card,
      x: Math.cos(angle) * orbit,
      y: Math.sin(angle) * orbit,
      radius: agentRadius,
      durationMinutes: agentMapDurationMinutes(card, now),
      status: agentMapNodeStatus(card)
    }
  })
}
