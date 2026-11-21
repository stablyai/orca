import type {
  DashboardBucket,
  DashboardCard
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { dashboardCardChangesSince } from '../snapshot/dashboard-card-changes'
import { matchesDashboardCard, type DashboardFilters } from './agent-board-filtering'

export type DashboardLane = { indexes: number[]; paneKeys: string[]; subagentCounts: number[] }
const hasTimestamp = (card: DashboardCard) => (card.finishedAt ?? card.startedAt) > 0
const countInputsChanged = (a: DashboardCard, b: DashboardCard) =>
  a.repoId !== b.repoId ||
  a.repoName !== b.repoName ||
  a.review?.state !== b.review?.state ||
  a.hasReview !== b.hasReview ||
  a.workspaceStatusId !== b.workspaceStatusId ||
  a.workspaceStatusLabel !== b.workspaceStatusLabel ||
  a.workspaceStatusColor !== b.workspaceStatusColor

export function createDashboardBoardProjection() {
  let previous:
    | { cards: DashboardCard[]; showIdle: boolean; query: string; filters: DashboardFilters }
    | undefined
  let visibleCards: DashboardCard[] = []
  let lanes: Record<DashboardBucket, DashboardLane>
  let timestampCount = 0
  return (cards: DashboardCard[], showIdle: boolean, search: string, filters: DashboardFilters) => {
    const query = search.trim().toLowerCase()
    const before = previous
    const changed = before ? dashboardCardChangesSince(cards, before.cards) : null
    const visible = (card: DashboardCard) => showIdle || card.bucket !== 'idle'
    const matches = (card: DashboardCard) =>
      visible(card) && matchesDashboardCard(card, query, filters)
    if (!before || !changed) {
      timestampCount = cards.reduce((count, card) => count + Number(hasTimestamp(card)), 0)
    } else {
      for (const index of changed) {
        timestampCount +=
          Number(hasTimestamp(cards[index])) - Number(hasTimestamp(before.cards[index]))
      }
    }
    if (
      !before ||
      !changed ||
      before.showIdle !== showIdle ||
      changed.some((index) => {
        const a = cards[index],
          b = before.cards[index]
        return visible(a) !== visible(b) || (visible(a) && countInputsChanged(a, b))
      })
    ) {
      visibleCards = cards.filter(visible)
    }
    if (
      !before ||
      !changed ||
      before.showIdle !== showIdle ||
      before.query !== query ||
      before.filters !== filters ||
      changed.some((index) => {
        const a = cards[index],
          b = before.cards[index]
        return matches(a)
          ? !matches(b) ||
              a.bucket !== b.bucket ||
              a.stateChangedAt !== b.stateChangedAt ||
              a.subagents?.length !== b.subagents?.length
          : matches(b)
      })
    ) {
      const indexes: Record<DashboardBucket, number[]> = {
        attention: [],
        working: [],
        done: [],
        idle: []
      }
      cards.forEach((card, index) => {
        if (matches(card)) {
          indexes[card.bucket].push(index)
        }
      })
      const lane = (bucket: DashboardBucket): DashboardLane => {
        const positions = indexes[bucket].sort(
          (a, b) => cards[b].stateChangedAt - cards[a].stateChangedAt
        )
        return {
          indexes: positions,
          paneKeys: positions.map((i) => cards[i].paneKey),
          subagentCounts: positions.map((i) => cards[i].subagents?.length ?? 0)
        }
      }
      lanes = {
        attention: lane('attention'),
        working: lane('working'),
        done: lane('done'),
        idle: lane('idle')
      }
    }
    previous = { cards, showIdle, query, filters }
    return { lanes: lanes!, visibleCards, hasRelativeTimestamps: timestampCount > 0 }
  }
}
