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
  let timestampIndex = -1
  return (cards: DashboardCard[], showIdle: boolean, search: string, filters: DashboardFilters) => {
    const query = search.trim().toLowerCase()
    const before = previous
    const changed = before ? dashboardCardChangesSince(cards, before.cards) : null
    const visible = (card: DashboardCard) => showIdle || card.bucket !== 'idle'
    const matches = (card: DashboardCard) =>
      visible(card) && matchesDashboardCard(card, query, filters)
    // Keep a known timestamp across local changes until its own card loses it.
    if (
      !changed ||
      (timestampIndex !== -1 &&
        changed.includes(timestampIndex) &&
        !hasTimestamp(cards[timestampIndex]))
    ) {
      timestampIndex = cards.findIndex(hasTimestamp)
    } else if (timestampIndex === -1) {
      timestampIndex = changed.find((index) => hasTimestamp(cards[index])) ?? -1
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
        const prior = lanes?.[bucket]
        const sameLength = prior !== undefined && positions.length === prior.indexes.length
        const paneKeyAt = (index: number) => cards[index].paneKey
        const subagentCountAt = (index: number) => cards[index].subagents?.length ?? 0
        // Row indexes can shift without changing the virtualizer's ordered keys or estimates.
        const paneKeys =
          sameLength && positions.every((index, i) => paneKeyAt(index) === prior.paneKeys[i])
            ? prior.paneKeys
            : positions.map(paneKeyAt)
        const subagentCounts =
          sameLength &&
          positions.every((index, i) => subagentCountAt(index) === prior.subagentCounts[i])
            ? prior.subagentCounts
            : positions.map(subagentCountAt)
        if (
          prior &&
          paneKeys === prior.paneKeys &&
          subagentCounts === prior.subagentCounts &&
          positions.every((index, i) => index === prior.indexes[i])
        ) {
          return prior
        }
        return { indexes: positions, paneKeys, subagentCounts }
      }
      lanes = {
        attention: lane('attention'),
        working: lane('working'),
        done: lane('done'),
        idle: lane('idle')
      }
    }
    previous = { cards, showIdle, query, filters }
    return { lanes: lanes!, visibleCards, hasRelativeTimestamps: timestampIndex !== -1 }
  }
}
