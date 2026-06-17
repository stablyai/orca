import { useMemo } from 'react'
import type { TrelloBoard, TrelloCard, TrelloList } from '../../../shared/trello-types'
import type { TrelloCardGroup } from '@/components/trello-task-source-card-views'
import type {
  TrelloGroupBy,
  TrelloOrderBy,
  TrelloViewMode
} from '@/components/trello-task-source-controls'

type TrelloTaskSourceCardDerivationsArgs = {
  boards: TrelloBoard[]
  knownLists: TrelloList[]
  boardLists: TrelloList[]
  cards: TrelloCard[]
  selectedBoardId: string
  selectedListId: string
  viewMode: TrelloViewMode
  groupBy: TrelloGroupBy
  orderBy: TrelloOrderBy
}

type TrelloTaskSourceCardDerivations = {
  selectedBoardLabel: string
  selectedListLabel: string
  orderedCards: TrelloCard[]
  groupedCards: TrelloCardGroup[]
  cardsByListId: Map<string, TrelloCard[]>
  boardNameById: Map<string, string>
  listNameById: Map<string, string>
  activeBackLabel: string
}

export function useTrelloTaskSourceCardDerivations({
  boards,
  knownLists,
  boardLists,
  cards,
  selectedBoardId,
  selectedListId,
  viewMode,
  groupBy,
  orderBy
}: TrelloTaskSourceCardDerivationsArgs): TrelloTaskSourceCardDerivations {
  const boardNameById = useMemo(() => {
    const names = new Map<string, string>()
    for (const board of boards) {
      names.set(board.id, board.name)
    }
    return names
  }, [boards])

  const listNameById = useMemo(() => {
    const names = new Map<string, string>()
    for (const list of knownLists) {
      names.set(list.id, list.name)
    }
    for (const list of boardLists) {
      names.set(list.id, list.name)
    }
    for (const card of cards) {
      if (card.listName) {
        names.set(card.idList, card.listName)
      }
    }
    return names
  }, [boardLists, cards, knownLists])

  const selectedBoardLabel =
    selectedBoardId === 'all' ? 'All boards' : (boardNameById.get(selectedBoardId) ?? 'Board')
  const selectedListLabel =
    selectedListId === 'all' ? 'All lists' : (listNameById.get(selectedListId) ?? 'List')

  const visibleCards = useMemo(() => {
    if (selectedListId === 'all') {
      return cards
    }
    return cards.filter((card) => card.idList === selectedListId)
  }, [cards, selectedListId])

  const orderedCards = useMemo(() => {
    const sorted = [...visibleCards]
    sorted.sort((a, b) => {
      if (orderBy === 'title') {
        return a.name.localeCompare(b.name)
      }
      if (orderBy === 'due') {
        const aDue = a.due ? Date.parse(a.due) : Number.POSITIVE_INFINITY
        const bDue = b.due ? Date.parse(b.due) : Number.POSITIVE_INFINITY
        return aDue - bDue
      }
      return Date.parse(b.dateLastActivity || '') - Date.parse(a.dateLastActivity || '')
    })
    return sorted
  }, [orderBy, visibleCards])

  const activeBackLabel = useMemo(() => {
    if (selectedBoardId !== 'all') {
      return boardNameById.get(selectedBoardId) ?? 'Trello board'
    }
    return viewMode === 'board' ? 'Trello board' : 'Trello list'
  }, [boardNameById, selectedBoardId, viewMode])

  const groupedCards = useMemo<TrelloCardGroup[]>(() => {
    const groups: TrelloCardGroup[] = []
    const groupIndex = new Map<string, number>()
    for (const card of orderedCards) {
      const key =
        groupBy === 'none'
          ? 'all'
          : groupBy === 'list'
            ? card.idList || 'unknown-list'
            : card.idBoard || 'unknown-board'
      let index = groupIndex.get(key)
      if (index === undefined) {
        index = groups.length
        groupIndex.set(key, index)
        groups.push({
          key,
          label:
            groupBy === 'none'
              ? 'Cards'
              : groupBy === 'list'
                ? card.listName || listNameById.get(card.idList) || 'Unknown list'
                : card.boardName || boardNameById.get(card.idBoard) || 'Unknown board',
          cards: []
        })
      }
      groups[index]?.cards.push(card)
    }
    return groups
  }, [boardNameById, groupBy, listNameById, orderedCards])

  const cardsByListId = useMemo(() => {
    const grouped = new Map<string, TrelloCard[]>()
    for (const card of orderedCards) {
      const listCards = grouped.get(card.idList)
      if (listCards) {
        listCards.push(card)
      } else {
        grouped.set(card.idList, [card])
      }
    }
    return grouped
  }, [orderedCards])

  return {
    selectedBoardLabel,
    selectedListLabel,
    orderedCards,
    groupedCards,
    cardsByListId,
    boardNameById,
    listNameById,
    activeBackLabel
  }
}
