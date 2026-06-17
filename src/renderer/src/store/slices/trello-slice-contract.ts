import type {
  TrelloBoard,
  TrelloCard,
  TrelloCardFilter,
  TrelloComment,
  TrelloConnectionStatus,
  TrelloLabel,
  TrelloList,
  TrelloMember,
  TrelloViewer
} from '../../../../shared/trello-types'
import type { CacheEntry } from './github'

export type TrelloSlice = {
  trelloCacheGeneration: number
  trelloStatus: TrelloConnectionStatus
  trelloStatusChecked: boolean
  trelloCardCache: Record<string, CacheEntry<TrelloCard>>
  trelloSearchCache: Record<string, CacheEntry<TrelloCard[]>>
  trelloBoardsCache: TrelloBoard[] | null
  trelloListsCache: Record<string, TrelloList[]>
  trelloCommentsCache: Record<string, CacheEntry<TrelloComment[]>>
  trelloBoardMembersCache: Record<string, TrelloMember[]>
  trelloBoardLabelsCache: Record<string, TrelloLabel[]>

  checkTrelloConnection: () => Promise<void>
  connectTrello: (args: {
    apiKey: string
    token: string
  }) => Promise<{ ok: true; viewer: TrelloViewer } | { ok: false; error: string }>
  testTrelloConnection: () => Promise<
    { ok: true; viewer: TrelloViewer } | { ok: false; error: string }
  >
  disconnectTrello: () => Promise<void>
  fetchTrelloCard: (cardId: string, options?: { force?: boolean }) => Promise<TrelloCard | null>
  searchTrelloCards: (
    query: string,
    limit?: number,
    boardIds?: string[],
    options?: { force?: boolean }
  ) => Promise<TrelloCard[]>
  listTrelloCards: (
    filter?: TrelloCardFilter,
    limit?: number,
    boardIds?: string[],
    options?: { force?: boolean }
  ) => Promise<TrelloCard[]>
  fetchTrelloBoards: () => Promise<TrelloBoard[]>
  fetchTrelloLists: (boardId: string) => Promise<TrelloList[]>
  fetchTrelloBoardMembers: (boardId: string) => Promise<TrelloMember[]>
  fetchTrelloBoardLabels: (boardId: string) => Promise<TrelloLabel[]>
  fetchTrelloComments: (cardId: string, options?: { force?: boolean }) => Promise<TrelloComment[]>
  addTrelloCardComment: (
    cardId: string,
    text: string
  ) => Promise<{ ok: true; id: string } | { ok: false; error: string }>
  patchTrelloCard: (cardId: string, patch: Partial<TrelloCard>) => void
}
