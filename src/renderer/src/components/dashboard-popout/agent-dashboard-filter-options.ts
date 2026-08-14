import { translate } from '@/i18n/i18n'
import type { DashboardCard, DashboardFilterOption } from '../../../../shared/dashboard-snapshot'
import type { DashboardReviewFilter } from './agent-board-filtering'
import type { AgentMapState } from './agent-map-filter'

/** Option rows and labels for the shared dashboard filter menu. */
export type FilterOption = { id: string; label: string; count: number; color?: string }

export const AGENT_STATE_ROWS: {
  state: AgentMapState
  dotState: 'waiting' | 'working' | 'done' | 'idle'
}[] = [
  { state: 'attention', dotState: 'waiting' },
  { state: 'working', dotState: 'working' },
  { state: 'done', dotState: 'done' },
  { state: 'idle', dotState: 'idle' }
]

export function agentStateLabel(state: AgentMapState): string {
  switch (state) {
    case 'attention':
      return translate('dashboardPopout.bucket.attention', 'Needs You')
    case 'working':
      return translate('dashboardPopout.bucket.working', 'Working')
    case 'done':
      return translate('dashboardPopout.bucket.done', 'Done')
    case 'idle':
      return translate('dashboardPopout.bucket.idle', 'Idle')
  }
}

function countBy(
  cards: DashboardCard[],
  value: (card: DashboardCard) => string
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const card of cards) {
    const key = value(card)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

export function workspaceStatusOptions(
  cards: DashboardCard[],
  configured: DashboardFilterOption[] | undefined
): FilterOption[] {
  const counts = countBy(cards, (card) => card.workspaceStatusId ?? '')
  if (configured) {
    return configured.map((option) => ({
      ...option,
      count: counts.get(option.id) ?? 0
    }))
  }
  const options = new Map<string, FilterOption>()
  for (const card of cards) {
    if (!card.workspaceStatusId || options.has(card.workspaceStatusId)) {
      continue
    }
    options.set(card.workspaceStatusId, {
      id: card.workspaceStatusId,
      label: card.workspaceStatusLabel ?? card.workspaceStatusId,
      color: card.workspaceStatusColor,
      count: counts.get(card.workspaceStatusId) ?? 0
    })
  }
  return [...options.values()]
}

export function projectOptions(
  cards: DashboardCard[],
  configured: DashboardFilterOption[] | undefined
): FilterOption[] {
  const counts = countBy(cards, (card) => card.repoId)
  if (configured) {
    return configured.map((option) => ({
      ...option,
      count: counts.get(option.id) ?? 0
    }))
  }
  const options = new Map<string, FilterOption>()
  for (const card of cards) {
    if (!options.has(card.repoId)) {
      options.set(card.repoId, {
        id: card.repoId,
        label: card.repoName,
        count: counts.get(card.repoId) ?? 0
      })
    }
  }
  return [...options.values()]
}

export function reviewCountsByState(cards: DashboardCard[]): Map<string, number> {
  return countBy(cards, (card) => card.review?.state ?? (card.hasReview ? 'unknown' : 'none'))
}

export const REVIEW_OPTIONS: readonly DashboardReviewFilter[] = [
  'open',
  'draft',
  'merged',
  'closed',
  'none'
]

export function reviewStateLabel(state: DashboardReviewFilter): string {
  switch (state) {
    case 'open':
      return translate('dashboardPopout.filters.review.open', 'Open')
    case 'draft':
      return translate('dashboardPopout.filters.review.draft', 'Draft')
    case 'merged':
      return translate('dashboardPopout.filters.review.merged', 'Merged')
    case 'closed':
      return translate('dashboardPopout.filters.review.closed', 'Closed')
    case 'none':
      return translate('dashboardPopout.filters.review.none', 'No review')
  }
}
