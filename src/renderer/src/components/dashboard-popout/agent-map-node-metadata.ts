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

/** How long a fresh finish keeps its one-shot flare. Long enough to catch the eye from
 *  across the map, short enough that a busy fleet is never permanently animating.
 *  Must stay in step with the `agent-map-finish-flare` duration in `agent-map.css`, or
 *  the element unmounts mid-ripple; the glow performance test asserts the two match. */
export const AGENT_MAP_FINISH_FLARE_MS = 1_400
// Static completion emphasis remains uncapped; this bounds animated SVG paint only.
export const AGENT_MAP_MAX_CONCURRENT_FINISH_FLARES = 4

/** Uses wall time because the map's relative-timestamp clock advances only every 30s. */
export function isAgentMapRecentFinish(card: DashboardCard, currentTime = Date.now()): boolean {
  if (card.dotState !== 'done' || !card.unseen) {
    return false
  }
  const changedAt = card.stateChangedAt || card.finishedAt || 0
  if (changedAt <= 0) {
    return false
  }
  const elapsed = currentTime - changedAt
  // A fleet that loads with finished work already on it must not flare all at once, so a
  // finish that happened before this render window is never treated as fresh.
  return elapsed >= 0 && elapsed < AGENT_MAP_FINISH_FLARE_MS
}

/** Selects only the freshest finishes so burst updates cannot animate the whole fleet. */
export function selectAgentMapRecentFinishPaneKeys(
  cards: readonly DashboardCard[]
): ReadonlySet<string> {
  const currentTime = Date.now()
  const recent: { paneKey: string; changedAt: number }[] = []
  for (const card of cards) {
    if (!isAgentMapRecentFinish(card, currentTime)) {
      continue
    }
    const changedAt = card.stateChangedAt || card.finishedAt || 0
    const index = recent.findIndex(
      (item) =>
        changedAt > item.changedAt || (changedAt === item.changedAt && card.paneKey < item.paneKey)
    )
    if (index === -1) {
      if (recent.length < AGENT_MAP_MAX_CONCURRENT_FINISH_FLARES) {
        recent.push({ paneKey: card.paneKey, changedAt })
      }
      continue
    }
    recent.splice(index, 0, { paneKey: card.paneKey, changedAt })
    if (recent.length > AGENT_MAP_MAX_CONCURRENT_FINISH_FLARES) {
      recent.pop()
    }
  }
  return new Set(recent.map((item) => item.paneKey))
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
