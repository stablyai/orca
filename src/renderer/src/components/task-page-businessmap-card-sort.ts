import type { BusinessmapCard } from '../../../shared/businessmap-types'
import { compareNumericLocaleText } from '@/lib/locale-text-collators'

export type BusinessmapCardSortColumn = 'id' | 'title' | 'column' | 'assignee' | 'updated'

export type BusinessmapCardSortDirection = 'asc' | 'desc'

export function sortBusinessmapCards(
  cards: readonly BusinessmapCard[],
  orderBy: BusinessmapCardSortColumn,
  orderDirection: BusinessmapCardSortDirection
): BusinessmapCard[] {
  const updatedKeys = new Map<BusinessmapCard, number>()
  if (cards.length > 1 && orderBy === 'updated') {
    for (const card of cards) {
      updatedKeys.set(card, new Date(card.updatedAt).getTime())
    }
  }
  return [...cards].sort((a, b) => {
    let comparison = 0
    if (orderBy === 'id') {
      comparison = a.id - b.id
    } else if (orderBy === 'title') {
      comparison = a.title.localeCompare(b.title)
    } else if (orderBy === 'column') {
      comparison = compareNumericLocaleText(a.column.name, b.column.name)
    } else if (orderBy === 'assignee') {
      comparison = (a.assignee?.displayName ?? '').localeCompare(b.assignee?.displayName ?? '')
    } else if (orderBy === 'updated') {
      comparison = updatedKeys.get(a)! - updatedKeys.get(b)!
    }
    return orderDirection === 'asc' ? comparison : -comparison
  })
}
