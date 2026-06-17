import type {
  TrelloBoard,
  TrelloCard,
  TrelloCardFilter,
  TrelloConnectionStatus,
  TrelloList
} from '../../../shared/trello-types'
import type { TrelloCardGroup } from '@/components/trello-task-source-card-views'
import type {
  TrelloGroupBy,
  TrelloOrderBy,
  TrelloViewMode
} from '@/components/trello-task-source-controls'

export type TrelloTaskSourceController = {
  trelloStatus: TrelloConnectionStatus
  trelloStatusChecked: boolean
  connectOpen: boolean
  setConnectOpen: (open: boolean) => void
  createOpen: boolean
  setCreateOpen: (open: boolean) => void
  filter: TrelloCardFilter
  setFilter: (filter: TrelloCardFilter) => void
  query: string
  setQuery: (query: string) => void
  boards: TrelloBoard[]
  selectedBoardId: string
  setSelectedBoardId: (boardId: string) => void
  selectedListId: string
  setSelectedListId: (listId: string) => void
  selectedBoardLabel: string
  selectedListLabel: string
  boardLists: TrelloList[]
  selectedCard: TrelloCard | null
  setSelectedCard: (card: TrelloCard | null) => void
  viewMode: TrelloViewMode
  setViewMode: (mode: TrelloViewMode) => void
  groupBy: TrelloGroupBy
  setGroupBy: (groupBy: TrelloGroupBy) => void
  orderBy: TrelloOrderBy
  setOrderBy: (orderBy: TrelloOrderBy) => void
  loading: boolean
  error: string | null
  truncated: boolean
  orderedCards: TrelloCard[]
  groupedCards: TrelloCardGroup[]
  cardsByListId: Map<string, TrelloCard[]>
  boardNameById: Map<string, string>
  listNameById: Map<string, string>
  activeBackLabel: string
  refreshCards: (options?: { force?: boolean }) => Promise<void>
  openCreateDialog: () => Promise<void>
  onSelectedCardUpdated: (card: TrelloCard) => void
  onCreatedCard: (card: TrelloCard) => void
}
