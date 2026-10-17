import {
  DASHBOARD_BUCKET_ORDER,
  type DashboardBucket,
  type DashboardCard
} from '../../../../shared/dashboard-snapshot'
import type { DashboardCustomLane } from '../../../../shared/dashboard-lanes'

export type AgentBoardColumn =
  | { kind: 'status'; key: string; bucket: DashboardBucket }
  | { kind: 'lane'; key: string; lane: DashboardCustomLane }

/** Pending drops, keyed by paneKey: the lane the user just dropped a card into
 *  (null = back to its status column) until a snapshot reflects the write. */
export type AgentBoardPendingPlacements = Readonly<Record<string, string | null>>

export function buildAgentBoardColumns(
  showIdle: boolean,
  lanes: readonly DashboardCustomLane[]
): AgentBoardColumn[] {
  return [
    ...DASHBOARD_BUCKET_ORDER.filter((bucket) => bucket !== 'idle' || showIdle).map(
      (bucket): AgentBoardColumn => ({ kind: 'status', key: `status:${bucket}`, bucket })
    ),
    ...lanes.map((lane): AgentBoardColumn => ({ kind: 'lane', key: `lane:${lane.id}`, lane }))
  ]
}

/** Lane the card renders in, honoring a drop that has not round-tripped yet.
 *  Needs You always wins, mirroring `resolveDashboardCardLaneId`. */
export function effectiveCardLaneId(
  card: DashboardCard,
  laneIds: ReadonlySet<string>,
  pending: AgentBoardPendingPlacements
): string | null {
  if (card.bucket === 'attention') {
    return null
  }
  const laneId = card.paneKey in pending ? pending[card.paneKey] : (card.laneId ?? null)
  return laneId !== null && laneIds.has(laneId) ? laneId : null
}

export function agentBoardColumnKeyForCard(
  card: DashboardCard,
  laneIds: ReadonlySet<string>,
  pending: AgentBoardPendingPlacements
): string {
  const laneId = effectiveCardLaneId(card, laneIds, pending)
  return laneId === null ? `status:${card.bucket}` : `lane:${laneId}`
}

/** Groups cards by column key. Cards whose status column is hidden (idle with
 *  "Show idle" off) are dropped — unless parked, since parking is explicit. */
export function groupCardsByColumn(
  cards: readonly DashboardCard[],
  columns: readonly AgentBoardColumn[],
  pending: AgentBoardPendingPlacements
): Map<string, DashboardCard[]> {
  const laneIds = new Set(columns.flatMap((c) => (c.kind === 'lane' ? [c.lane.id] : [])))
  const grouped = new Map<string, DashboardCard[]>(columns.map((c) => [c.key, []]))
  for (const card of cards) {
    grouped.get(agentBoardColumnKeyForCard(card, laneIds, pending))?.push(card)
  }
  // Most-recently-moved first: a card entering a column lands at the top,
  // matching the view-transition motion the user just watched.
  for (const list of grouped.values()) {
    list.sort((a, b) => b.stateChangedAt - a.stateChangedAt)
  }
  return grouped
}

/** Drops pending entries the latest snapshot already reflects (or that can no
 *  longer apply), so a stale optimistic move never outlives the real state. */
export function prunePendingPlacements(
  pending: AgentBoardPendingPlacements,
  cards: readonly DashboardCard[],
  laneIds: ReadonlySet<string>
): AgentBoardPendingPlacements {
  const keys = Object.keys(pending)
  if (keys.length === 0) {
    return pending
  }
  const byPaneKey = new Map(cards.map((card) => [card.paneKey, card]))
  const next: Record<string, string | null> = {}
  for (const paneKey of keys) {
    const card = byPaneKey.get(paneKey)
    const laneId = pending[paneKey]
    if (
      card &&
      card.bucket !== 'attention' &&
      (laneId === null || laneIds.has(laneId)) &&
      (card.laneId ?? null) !== laneId
    ) {
      next[paneKey] = laneId
    }
  }
  return Object.keys(next).length === keys.length ? pending : next
}
