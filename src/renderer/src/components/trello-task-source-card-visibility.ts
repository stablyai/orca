import type { TrelloCard, TrelloCardFilter } from '../../../shared/trello-types'

type TrelloCardVisibleScope = {
  filter: TrelloCardFilter
  viewerId?: string
  selectedBoardId: string
  selectedListId: string
  query: string
}

export function trelloCardMatchesFilter(
  card: TrelloCard,
  filter: TrelloCardFilter,
  viewerId?: string
): boolean {
  if (filter === 'archived') {
    return card.closed
  }
  if (filter === 'allOpen') {
    return !card.closed
  }
  return viewerId ? card.members.some((member) => member.id === viewerId) : true
}

export function trelloCardMatchesVisibleScope(
  card: TrelloCard,
  { filter, viewerId, selectedBoardId, selectedListId, query }: TrelloCardVisibleScope
): boolean {
  if (!trelloCardMatchesFilter(card, filter, viewerId)) {
    return false
  }
  if (selectedBoardId !== 'all' && card.idBoard !== selectedBoardId) {
    return false
  }
  if (selectedListId !== 'all' && card.idList !== selectedListId) {
    return false
  }
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return true
  }
  return (
    card.name.toLowerCase().includes(normalizedQuery) ||
    card.desc.toLowerCase().includes(normalizedQuery) ||
    card.shortId.toLowerCase().includes(normalizedQuery) ||
    card.shortLink.toLowerCase().includes(normalizedQuery) ||
    card.url.toLowerCase().includes(normalizedQuery) ||
    (card.boardName?.toLowerCase().includes(normalizedQuery) ?? false) ||
    (card.listName?.toLowerCase().includes(normalizedQuery) ?? false) ||
    card.labels.some((label) => label.name.toLowerCase().includes(normalizedQuery))
  )
}
