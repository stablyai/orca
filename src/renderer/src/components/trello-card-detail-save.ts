import type { TrelloCard } from '../../../shared/trello-types'
import type { GlobalSettings } from '../../../shared/types'
import { trelloUpdateCard } from '@/runtime/runtime-trello-client'
import { prepareTrelloDescriptionForSave } from '@/lib/trello-description-images'

type SaveTrelloCardChangesArgs = {
  settings: GlobalSettings | null | undefined
  cardId: string
  title: string
  description: string
  listId: string
  fetchTrelloCard: (cardId: string, options?: { force?: boolean }) => Promise<TrelloCard | null>
}

export async function saveTrelloCardChanges({
  settings,
  cardId,
  title,
  description,
  listId,
  fetchTrelloCard
}: SaveTrelloCardChangesArgs): Promise<TrelloCard | null> {
  const preparedDescription = await prepareTrelloDescriptionForSave({
    cardId,
    description,
    settings
  })
  const updated = await trelloUpdateCard(settings, cardId, {
    name: title.trim(),
    desc: preparedDescription,
    idList: listId
  })
  if (!updated.ok) {
    throw new Error(updated.error)
  }
  return fetchTrelloCard(cardId, { force: true })
}
