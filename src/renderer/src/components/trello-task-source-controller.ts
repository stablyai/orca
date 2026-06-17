import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  TrelloBoard,
  TrelloCard,
  TrelloCardFilter,
  TrelloList
} from '../../../shared/trello-types'
import { useAppStore } from '@/store'
import type {
  TrelloGroupBy,
  TrelloOrderBy,
  TrelloViewMode
} from '@/components/trello-task-source-controls'
import type { TrelloTaskSourceController } from '@/components/trello-task-source-controller-types'
import { useTrelloTaskSourceCardDerivations } from '@/components/trello-task-source-card-derivations'
import {
  trelloCardMatchesFilter,
  trelloCardMatchesVisibleScope
} from '@/components/trello-task-source-card-visibility'

type TrelloSelectedListSelection = {
  boardId: string
  listId: string
}

export function useTrelloTaskSourceController(): TrelloTaskSourceController {
  const trelloStatus = useAppStore((s) => s.trelloStatus)
  const trelloStatusChecked = useAppStore((s) => s.trelloStatusChecked)
  const checkTrelloConnection = useAppStore((s) => s.checkTrelloConnection)
  const listTrelloCards = useAppStore((s) => s.listTrelloCards)
  const searchTrelloCards = useAppStore((s) => s.searchTrelloCards)
  const fetchTrelloBoards = useAppStore((s) => s.fetchTrelloBoards)
  const fetchTrelloLists = useAppStore((s) => s.fetchTrelloLists)

  const [connectOpen, setConnectOpen] = useState(false)
  const [filter, setFilter] = useState<TrelloCardFilter>('allOpen')
  const [query, setQuery] = useState('')
  const [boards, setBoards] = useState<TrelloBoard[]>([])
  const [selectedBoardId, setSelectedBoardId] = useState('all')
  const [selectedListSelection, setSelectedListSelection] = useState<TrelloSelectedListSelection>({
    boardId: 'all',
    listId: 'all'
  })
  const [cards, setCards] = useState<TrelloCard[]>([])
  const [selectedCard, setSelectedCard] = useState<TrelloCard | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [boardLists, setBoardLists] = useState<TrelloList[]>([])
  const [knownLists, setKnownLists] = useState<TrelloList[]>([])
  const [viewMode, setViewMode] = useState<TrelloViewMode>('list')
  const [groupBy, setGroupBy] = useState<TrelloGroupBy>('board')
  const [orderBy, setOrderBy] = useState<TrelloOrderBy>('activity')
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)

  const selectedListId =
    selectedListSelection.boardId === selectedBoardId ? selectedListSelection.listId : 'all'
  const cardRequestIdRef = useRef(0)
  const boardListsRequestIdRef = useRef(0)

  const cardMatchesVisibleScope = useCallback(
    (card: TrelloCard): boolean =>
      trelloCardMatchesVisibleScope(card, {
        filter,
        viewerId: trelloStatus.viewer?.id,
        selectedBoardId,
        selectedListId,
        query
      }),
    [filter, query, selectedBoardId, selectedListId, trelloStatus.viewer?.id]
  )

  const setSelectedListId = useCallback(
    (listId: string): void => {
      setSelectedListSelection({ boardId: selectedBoardId, listId })
    },
    [selectedBoardId]
  )

  const {
    selectedBoardLabel,
    selectedListLabel,
    orderedCards,
    groupedCards,
    cardsByListId,
    boardNameById,
    listNameById,
    activeBackLabel
  } = useTrelloTaskSourceCardDerivations({
    boards,
    knownLists,
    boardLists,
    cards,
    selectedBoardId,
    selectedListId,
    viewMode,
    groupBy,
    orderBy
  })

  const refreshCards = useCallback(
    async (options?: { force?: boolean }): Promise<void> => {
      if (!trelloStatus.connected) {
        return
      }
      const requestId = ++cardRequestIdRef.current
      setLoading(true)
      setError(null)
      try {
        const loadedBoards = await fetchTrelloBoards()
        if (requestId !== cardRequestIdRef.current) {
          return
        }
        setBoards(loadedBoards)
        const boardIds =
          selectedBoardId === 'all' ? loadedBoards.map((board) => board.id) : [selectedBoardId]
        const listGroups = await Promise.all(
          boardIds.map((boardId) => fetchTrelloLists(boardId).catch(() => [] as TrelloList[]))
        )
        if (requestId !== cardRequestIdRef.current) {
          return
        }
        setKnownLists(listGroups.flat())
        const trimmedQuery = query.trim()
        let nextCards: TrelloCard[]
        let isTruncated = false
        if (trimmedQuery) {
          const searchResults = await searchTrelloCards(
            trimmedQuery,
            50,
            boardIds.length > 0 ? boardIds : undefined,
            options
          )
          if (requestId !== cardRequestIdRef.current) {
            return
          }
          // Trello search caps at 50 results; treat a full page as potentially truncated.
          isTruncated = searchResults.length >= 50
          // Reconcile search with filter: apply the same filter semantics as browsing
          // when Trello search cannot combine the list filter server-side.
          nextCards = searchResults.filter((card) =>
            trelloCardMatchesFilter(card, filter, trelloStatus.viewer?.id)
          )
        } else {
          nextCards = await listTrelloCards(
            filter,
            50,
            filter === 'assigned' && selectedBoardId === 'all' ? undefined : boardIds,
            options
          )
          if (requestId !== cardRequestIdRef.current) {
            return
          }
          isTruncated = nextCards.length >= 50
        }
        const filteredCards =
          selectedBoardId === 'all'
            ? nextCards
            : nextCards.filter((card) => card.idBoard === selectedBoardId)
        setCards(filteredCards)
        setTruncated(isTruncated)
      } catch (err) {
        if (requestId !== cardRequestIdRef.current) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to load Trello cards.')
      } finally {
        if (requestId === cardRequestIdRef.current) {
          setLoading(false)
        }
      }
    },
    [
      fetchTrelloBoards,
      fetchTrelloLists,
      filter,
      listTrelloCards,
      query,
      searchTrelloCards,
      selectedBoardId,
      trelloStatus.connected,
      trelloStatus.viewer?.id
    ]
  )

  const openCreateDialog = useCallback(async (): Promise<void> => {
    if (boards.length === 0) {
      setLoading(true)
      setError(null)
      try {
        const loadedBoards = await fetchTrelloBoards()
        setBoards(loadedBoards)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load Trello boards.')
        return
      } finally {
        setLoading(false)
      }
    }
    setCreateOpen(true)
  }, [boards.length, fetchTrelloBoards])

  useEffect(() => {
    if (!trelloStatusChecked) {
      void checkTrelloConnection()
    }
  }, [checkTrelloConnection, trelloStatusChecked])

  useEffect(() => {
    void refreshCards()
  }, [refreshCards])

  useEffect(() => {
    const requestId = ++boardListsRequestIdRef.current
    if (!trelloStatus.connected || selectedBoardId === 'all') {
      setBoardLists([])
      return
    }
    void fetchTrelloLists(selectedBoardId)
      .then((lists) => {
        if (requestId !== boardListsRequestIdRef.current) {
          return
        }
        setBoardLists(lists.filter((list) => !list.closed))
      })
      .catch((err) => {
        if (requestId !== boardListsRequestIdRef.current) {
          return
        }
        setBoardLists([])
        setError(err instanceof Error ? err.message : 'Failed to load Trello lists.')
      })
  }, [fetchTrelloLists, selectedBoardId, trelloStatus.connected])

  const handleSelectedCardUpdated = useCallback(
    (updated: TrelloCard): void => {
      setSelectedCard(updated)
      setCards((prev) => {
        if (!cardMatchesVisibleScope(updated)) {
          return prev.filter((card) => card.id !== updated.id)
        }
        const hasExisting = prev.some((card) => card.id === updated.id)
        if (!hasExisting) {
          return [updated, ...prev]
        }
        return prev.map((card) => (card.id === updated.id ? updated : card))
      })
    },
    [cardMatchesVisibleScope]
  )

  const handleCreatedCard = useCallback(
    (card: TrelloCard): void => {
      if (cardMatchesVisibleScope(card)) {
        setCards((prev) => [card, ...prev])
      }
      setSelectedCard(card)
    },
    [cardMatchesVisibleScope]
  )

  return {
    trelloStatus,
    trelloStatusChecked,
    connectOpen,
    setConnectOpen,
    createOpen,
    setCreateOpen,
    filter,
    setFilter,
    query,
    setQuery,
    boards,
    selectedBoardId,
    setSelectedBoardId,
    selectedListId,
    setSelectedListId,
    selectedBoardLabel,
    selectedListLabel,
    boardLists,
    selectedCard,
    setSelectedCard,
    viewMode,
    setViewMode,
    groupBy,
    setGroupBy,
    orderBy,
    setOrderBy,
    loading,
    error,
    truncated,
    orderedCards,
    groupedCards,
    cardsByListId,
    boardNameById,
    listNameById,
    activeBackLabel,
    refreshCards,
    openCreateDialog,
    onSelectedCardUpdated: handleSelectedCardUpdated,
    onCreatedCard: handleCreatedCard
  }
}
