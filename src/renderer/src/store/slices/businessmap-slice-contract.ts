import type { StateCreator } from 'zustand'
import type { CacheEntry } from '../github/cache-model'
import type { AppState } from '../types'
import type {
  BusinessmapBoard,
  BusinessmapCard,
  BusinessmapCardFilter,
  BusinessmapCardUpdate,
  BusinessmapConnectArgs,
  BusinessmapConnectionStatus,
  BusinessmapViewer
} from '../../../../shared/businessmap-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

export type BusinessmapReadOptions = {
  sourceContext?: TaskSourceContext | null
  siteId?: string | null
  boardId?: number | null
}

export type BusinessmapSearchOptions = BusinessmapReadOptions & { signal?: AbortSignal }

export type BusinessmapSlice = {
  businessmapStatus: BusinessmapConnectionStatus
  businessmapStatusChecked: boolean
  businessmapStatusContextKey: string | null
  businessmapConnectionRevisions: Record<string, number>
  businessmapCardCache: Record<string, CacheEntry<BusinessmapCard>>
  businessmapBoardCache: Record<string, CacheEntry<BusinessmapBoard[]>>
  businessmapSearchCache: Record<string, CacheEntry<BusinessmapCard[]>>

  checkBusinessmapConnection: () => Promise<void>
  readBusinessmapStatus: (sourceContext: TaskSourceContext) => Promise<BusinessmapConnectionStatus>
  connectBusinessmap: (
    args: BusinessmapConnectArgs
  ) => Promise<{ ok: true; viewer: BusinessmapViewer } | { ok: false; error: string }>
  testBusinessmapConnection: (
    siteId?: string | null
  ) => Promise<{ ok: true; viewer: BusinessmapViewer } | { ok: false; error: string }>
  selectBusinessmapSite: (siteId: string) => Promise<void>
  disconnectBusinessmap: (siteId?: string | null) => Promise<void>
  fetchBusinessmapCard: (
    id: number,
    siteId?: string | null,
    options?: BusinessmapReadOptions
  ) => Promise<BusinessmapCard | null>
  searchBusinessmapCards: (
    query: string,
    limit?: number,
    options?: BusinessmapSearchOptions
  ) => Promise<BusinessmapCard[]>
  listBusinessmapCards: (
    filter?: BusinessmapCardFilter,
    limit?: number,
    options?: BusinessmapReadOptions
  ) => Promise<BusinessmapCard[]>
  createBusinessmapCard: (
    args: {
      boardId: number
      title: string
      description?: string
      columnId?: number
      laneId?: number
    },
    options?: BusinessmapReadOptions
  ) => Promise<{ ok: true; id: number; url: string } | { ok: false; error: string }>
  updateBusinessmapCard: (
    id: number,
    updates: BusinessmapCardUpdate,
    options?: BusinessmapReadOptions
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  addBusinessmapCardComment: (
    id: number,
    body: string,
    options?: BusinessmapReadOptions
  ) => Promise<{ ok: true; id: number } | { ok: false; error: string }>
  listBusinessmapBoards: (options?: BusinessmapReadOptions) => Promise<BusinessmapBoard[]>
}

type BusinessmapStateCreator = StateCreator<AppState, [], [], BusinessmapSlice>

export type BusinessmapSliceSet = Parameters<BusinessmapStateCreator>[0]
export type BusinessmapSliceGet = Parameters<BusinessmapStateCreator>[1]
