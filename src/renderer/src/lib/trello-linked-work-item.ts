import type { TrelloCard } from '../../../shared/trello-types'
import type { LinkedWorkItemContext } from './linked-work-item-context'
import type { LinkedWorkItemSummary } from './new-workspace'

export function buildTrelloCardLinkedWorkItem(
  card: TrelloCard,
  renderedContext?: string
): LinkedWorkItemSummary {
  const context: LinkedWorkItemContext | undefined = renderedContext
    ? {
        provider: 'trello',
        version: 1 as const,
        renderedText: renderedContext
      }
    : undefined

  return {
    type: 'issue',
    provider: 'trello',
    number: 0,
    title: card.name,
    url: card.url,
    trelloCardId: card.shortLink || card.id,
    linkedContext: context
  }
}
