import {
  dashboardCardDisplayState,
  type DashboardCard,
  type DashboardCardDotState
} from '../../../../shared/dashboard-snapshot'

/** Map-only refinement of the shared dot state. `dashboardCardDisplayState` folds an
 *  acknowledged finish into `idle`, which is right for bucket counts but loses the one
 *  distinction the map exists to show: finished-and-unread vs finished-and-still-yours.
 *  Kept local so `DashboardCardDotState` — which crosses the pop-out bridge — is unchanged. */
export type AgentMapNodeStatus = DashboardCardDotState | 'done-seen'

export function agentMapDurationMinutes(card: DashboardCard, now: number): number {
  if (!Number.isFinite(card.startedAt) || card.startedAt <= 0) {
    return 0
  }
  const end = card.finishedAt && card.finishedAt >= card.startedAt ? card.finishedAt : now
  return Math.max(0, (end - card.startedAt) / 60_000)
}

export function agentMapNodeStatus(card: DashboardCard): AgentMapNodeStatus {
  if (card.dotState === 'done') {
    return card.unseen ? 'done' : 'done-seen'
  }
  return dashboardCardDisplayState(card)
}

export type AgentMapFlareStatus = Extract<DashboardCardDotState, 'waiting' | 'done'>

/** How long a fresh question or finish keeps its one-shot flare. Long enough to catch
 *  the eye from across the map, short enough that a busy fleet is never permanently
 *  animating. Must stay in step with the `agent-map-status-flare` duration in
 *  `agent-map.css`, or the element unmounts mid-ripple. */
export const AGENT_MAP_STATUS_FLARE_MS = 1_400
// Static status emphasis remains uncapped; this bounds animated SVG paint only.
export const AGENT_MAP_MAX_CONCURRENT_STATUS_FLARES = 4

function agentMapFlareChangedAt(card: DashboardCard): number {
  return card.stateChangedAt || (card.dotState === 'done' ? card.finishedAt : 0) || 0
}

/** Uses wall time because the map's relative-timestamp clock advances only every 30s. */
export function agentMapRecentFlareStatus(
  card: DashboardCard,
  currentTime = Date.now()
): AgentMapFlareStatus | null {
  if (card.dotState !== 'waiting' && (card.dotState !== 'done' || !card.unseen)) {
    return null
  }
  const changedAt = agentMapFlareChangedAt(card)
  if (changedAt <= 0) {
    return null
  }
  const elapsed = currentTime - changedAt
  // A fleet that loads with old status changes must not flare all at once.
  return elapsed >= 0 && elapsed < AGENT_MAP_STATUS_FLARE_MS ? card.dotState : null
}

/** Selects only the freshest question/finish changes so bursts cannot animate the fleet. */
export function selectAgentMapRecentFlareStatuses(
  cards: readonly DashboardCard[]
): ReadonlyMap<string, AgentMapFlareStatus> {
  const currentTime = Date.now()
  const recent: { paneKey: string; changedAt: number; status: AgentMapFlareStatus }[] = []
  for (const card of cards) {
    const status = agentMapRecentFlareStatus(card, currentTime)
    if (!status) {
      continue
    }
    const changedAt = agentMapFlareChangedAt(card)
    const index = recent.findIndex(
      (item) =>
        changedAt > item.changedAt || (changedAt === item.changedAt && card.paneKey < item.paneKey)
    )
    if (index === -1) {
      if (recent.length < AGENT_MAP_MAX_CONCURRENT_STATUS_FLARES) {
        recent.push({ paneKey: card.paneKey, changedAt, status })
      }
      continue
    }
    recent.splice(index, 0, { paneKey: card.paneKey, changedAt, status })
    if (recent.length > AGENT_MAP_MAX_CONCURRENT_STATUS_FLARES) {
      recent.pop()
    }
  }
  return new Map(recent.map((item) => [item.paneKey, item.status]))
}

export type AgentMapStatusCounts = Record<AgentMapNodeStatus, number>

export function emptyAgentMapStatusCounts(): AgentMapStatusCounts {
  return { working: 0, blocked: 0, waiting: 0, done: 0, 'done-seen': 0, idle: 0 }
}

/** Finished work you have already opened is still yours to land, but it is not asking for
 *  attention. Counting it as quiet keeps ring aggregation and label declutter behaving
 *  exactly as they did when an acknowledged finish rendered as plain idle. */
export function agentMapQuietCount(counts: AgentMapStatusCounts): number {
  return counts.idle + counts['done-seen']
}
