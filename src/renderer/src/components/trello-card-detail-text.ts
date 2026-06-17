import type { TrelloCard } from '../../../shared/trello-types'

export function formatShortDate(value: string | null | undefined): string {
  if (!value) {
    return '—'
  }
  return new Date(value).toLocaleDateString()
}

export function renderCardContext(card: TrelloCard): string {
  return [
    `Trello card: ${card.name}`,
    `URL: ${card.url}`,
    card.boardName ? `Board: ${card.boardName}` : null,
    card.listName ? `List: ${card.listName}` : null,
    card.desc ? `\nDescription:\n${card.desc}` : null
  ]
    .filter(Boolean)
    .join('\n')
}

export function formatRelativeTime(value: string | null | undefined): string {
  if (!value) {
    return 'recently'
  }
  const diffMs = Date.now() - Date.parse(value)
  const diffMinutes = Math.max(1, Math.round(diffMs / 60_000))
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`
  }
  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) {
    return `${diffHours}h ago`
  }
  const diffDays = Math.round(diffHours / 24)
  return `${diffDays}d ago`
}
