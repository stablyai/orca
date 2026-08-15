import type { DashboardCard, DashboardCardHostKind } from '../../../../shared/dashboard-snapshot'
import { agentMapNodeStatus } from './agent-map-node-metadata'
import { matchesAgentMapTimeRanges, type AgentMapTimeRanges } from './agent-map-time-filter'

export type AgentMapState = 'attention' | 'working' | 'done' | 'idle'
export type AgentMapCounts = Record<AgentMapState, number>

export const ALL_AGENT_MAP_HOSTS: readonly DashboardCardHostKind[] = [
  'local',
  'ssh',
  'wsl',
  'remote'
]

export function agentMapState(card: DashboardCard): AgentMapState {
  const state = agentMapNodeStatus(card)
  if (state === 'blocked' || state === 'waiting') {
    return 'attention'
  }
  // Why: an acknowledged finish still paints emerald, so it has to answer the Done
  // chip. Filtering it as idle would let "hide idle" blank out visibly green nodes.
  if (state === 'done-seen') {
    return 'done'
  }
  return state
}

/** Every agent in a dispatch relationship — each dispatched child *and* the
 *  coordinator that dispatched it. A children-only set would hide the half of
 *  the flow that explains it. */
export function agentMapOrchestrationPaneKeys(cards: DashboardCard[]): Set<string> {
  const present = new Set(cards.map((card) => card.paneKey))
  const flows = new Set<string>()
  for (const card of cards) {
    const parent = card.parentPaneKey
    if (parent && present.has(parent)) {
      flows.add(card.paneKey)
      flows.add(parent)
    }
  }
  return flows
}

export function filterAgentMapCards({
  cards,
  enabledStates,
  enabledHosts,
  enabledAgentTypes,
  timeRanges,
  orchestrationOnly = false,
  now
}: {
  cards: DashboardCard[]
  enabledStates: ReadonlySet<AgentMapState>
  enabledHosts: ReadonlySet<DashboardCardHostKind>
  enabledAgentTypes?: ReadonlySet<string>
  timeRanges?: AgentMapTimeRanges
  orchestrationOnly?: boolean
  now?: number
}): DashboardCard[] {
  const flows = orchestrationOnly ? agentMapOrchestrationPaneKeys(cards) : null
  // Project filtering lives in the shared toolbar filter, which has already
  // narrowed these cards.
  return cards.filter((card) => {
    if (!enabledHosts.has(card.hostKind ?? 'local')) {
      return false
    }
    if (!enabledStates.has(agentMapState(card))) {
      return false
    }
    if (enabledAgentTypes && !enabledAgentTypes.has(card.agentType)) {
      return false
    }
    if (flows && !flows.has(card.paneKey)) {
      return false
    }
    if (timeRanges && now !== undefined && !matchesAgentMapTimeRanges(card, timeRanges, now)) {
      return false
    }
    return true
  })
}

export function countAgentMapCards(cards: DashboardCard[]): AgentMapCounts {
  const counts: AgentMapCounts = {
    attention: 0,
    working: 0,
    done: 0,
    idle: 0
  }
  for (const card of cards) {
    counts[agentMapState(card)] += 1
  }
  return counts
}

export function countAgentMapAgentTypes(cards: DashboardCard[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const card of cards) {
    counts.set(card.agentType, (counts.get(card.agentType) ?? 0) + 1)
  }
  return new Map([...counts].sort(([a], [b]) => a.localeCompare(b)))
}
