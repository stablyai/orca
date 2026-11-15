import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { translateWorkspaceBoardStatusLabel } from '@/components/sidebar/workspace-board-status-label'
import type { DashboardCard, DashboardFilterOption } from '../../../../../shared/dashboard-snapshot'
import type { DashboardReviewFilter } from './agent-board-filtering'

export type FilterOption = { id: string; label: string; count: number; color?: string }

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
      label: dashboardWorkspaceStatusLabel(card),
      color: card.workspaceStatusColor,
      count: counts.get(card.workspaceStatusId) ?? 0
    })
  }
  return [...options.values()]
}

export function dashboardWorkspaceStatusLabel(
  card: Pick<DashboardCard, 'workspaceStatusId' | 'workspaceStatusLabel'>
): string {
  const id = card.workspaceStatusId ?? ''
  return translateWorkspaceBoardStatusLabel({ id, label: card.workspaceStatusLabel ?? id })
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

export function reviewStateLabel(state: DashboardReviewFilter, t: Translate = translate): string {
  switch (state) {
    case 'open':
      return t('dashboardPopout.filters.review.open', 'Open')
    case 'draft':
      return t('dashboardPopout.filters.review.draft', 'Draft')
    case 'merged':
      return t('dashboardPopout.filters.review.merged', 'Merged')
    case 'closed':
      return t('dashboardPopout.filters.review.closed', 'Closed')
    case 'none':
      return t('dashboardPopout.filters.review.none', 'No review')
  }
}
