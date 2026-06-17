import type {
  TrelloCard,
  TrelloLabel,
  TrelloList,
  TrelloMember
} from '../../../shared/trello-types'

type LoadTrelloCardDetailDataArgs = {
  card: TrelloCard
  fetchTrelloCard: (cardId: string, options?: { force?: boolean }) => Promise<TrelloCard | null>
  fetchTrelloLists: (boardId: string) => Promise<TrelloList[]>
  fetchTrelloBoardMembers: (boardId: string) => Promise<TrelloMember[]>
  fetchTrelloBoardLabels: (boardId: string) => Promise<TrelloLabel[]>
}

export async function loadTrelloCardDetailData({
  card,
  fetchTrelloCard,
  fetchTrelloLists,
  fetchTrelloBoardMembers,
  fetchTrelloBoardLabels
}: LoadTrelloCardDetailDataArgs): Promise<{
  card: TrelloCard
  lists: TrelloList[]
  boardMembers: TrelloMember[]
  boardLabels: TrelloLabel[]
}> {
  const [fullCard, lists, boardMembers, boardLabels] = await Promise.all([
    fetchTrelloCard(card.id, { force: true }),
    fetchTrelloLists(card.idBoard),
    fetchTrelloBoardMembers(card.idBoard),
    fetchTrelloBoardLabels(card.idBoard)
  ])
  const nextCard = fullCard ?? card

  return {
    card: nextCard,
    lists: lists.filter((list) => !list.closed || list.id === nextCard.idList),
    boardMembers,
    boardLabels
  }
}
