import {
  businessmapAddCardComment,
  businessmapCreateCard,
  businessmapListBoards,
  businessmapListCards,
  businessmapUpdateCard
} from '@/runtime/runtime-businessmap-client'
import type {
  BusinessmapBoard,
  BusinessmapCard,
  BusinessmapCardFilter
} from '../../../../shared/businessmap-types'
import type {
  BusinessmapSlice,
  BusinessmapSliceGet,
  BusinessmapSliceSet
} from './businessmap-slice-contract'
import {
  peekBusinessmapMutationGeneration,
  currentBusinessmapReadInvalidationGeneration,
  evictStaleBusinessmapCacheEntries,
  getBusinessmapReadScope,
  inflightBusinessmapBoardRequests,
  inflightBusinessmapListRequests,
  invalidateBusinessmapReads,
  isFreshBusinessmapCacheEntry,
  scopedBusinessmapCacheKey,
  type InflightBusinessmapReadRequest
} from './businessmap-read-coordination'
import { createBusinessmapCardReadActions } from './businessmap-card-read-actions'
import {
  canWriteCollectionResult,
  handleBusinessmapCollectionReadError,
  resolveReadSiteId
} from './businessmap-read-result-guards'

type BusinessmapCollectionReadActions = Pick<
  BusinessmapSlice,
  | 'fetchBusinessmapCard'
  | 'searchBusinessmapCards'
  | 'listBusinessmapCards'
  | 'createBusinessmapCard'
  | 'updateBusinessmapCard'
  | 'addBusinessmapCardComment'
  | 'listBusinessmapBoards'
>

export function createBusinessmapCollectionReadActions(
  set: BusinessmapSliceSet,
  get: BusinessmapSliceGet
): BusinessmapCollectionReadActions {
  return {
    ...createBusinessmapCardReadActions(set, get),

    listBusinessmapCards: async (
      filter: BusinessmapCardFilter = 'assigned',
      limit = 30,
      options
    ) => {
      const scope = getBusinessmapReadScope(get().settings, options?.sourceContext)
      const siteId = resolveReadSiteId(options, get)
      const boardId = options?.boardId ?? null
      const cacheKey = scopedBusinessmapCacheKey(
        scope,
        `${siteId ?? 'default'}::${boardId ?? 'all'}::list::${filter}::${limit}`
      )
      const cached = get().businessmapSearchCache[cacheKey]
      if (isFreshBusinessmapCacheEntry(cached)) {
        return cached.data ?? []
      }
      const inflight = inflightBusinessmapListRequests.get(cacheKey)
      const requestMutationGeneration = peekBusinessmapMutationGeneration()
      const requestReadInvalidation = currentBusinessmapReadInvalidationGeneration()
      if (
        inflight &&
        inflight.contextKey === scope.contextKey &&
        inflight.mutationGeneration === requestMutationGeneration &&
        inflight.readInvalidationGeneration === requestReadInvalidation
      ) {
        return inflight.promise
      }
      let entry: InflightBusinessmapReadRequest<BusinessmapCard[]>
      const request = businessmapListCards(scope.settings, filter, limit, siteId, boardId)
        .then((cards) => {
          if (
            inflightBusinessmapListRequests.get(cacheKey) === entry &&
            canWriteCollectionResult(scope, requestMutationGeneration, get, requestReadInvalidation)
          ) {
            set((state) => ({
              businessmapSearchCache: evictStaleBusinessmapCacheEntries({
                ...state.businessmapSearchCache,
                [cacheKey]: { data: cards, fetchedAt: Date.now() }
              })
            }))
          }
          return cards
        })
        .catch((error) => {
          console.warn('[businessmap] listBusinessmapCards failed:', error)
          return handleBusinessmapCollectionReadError(
            error,
            scope,
            requestMutationGeneration,
            set,
            get,
            requestReadInvalidation
          )
        })
      const promise = request.finally(() => {
        if (inflightBusinessmapListRequests.get(cacheKey) === entry) {
          inflightBusinessmapListRequests.delete(cacheKey)
        }
      })
      entry = {
        promise,
        contextKey: scope.contextKey,
        mutationGeneration: requestMutationGeneration,
        readInvalidationGeneration: requestReadInvalidation
      }
      inflightBusinessmapListRequests.set(cacheKey, entry)
      return promise
    },

    createBusinessmapCard: async (args, options) => {
      const scope = getBusinessmapReadScope(get().settings, options?.sourceContext)
      const siteId = resolveReadSiteId(options, get)
      const result = await businessmapCreateCard(scope.settings, args, siteId)
      if (result.ok) {
        invalidateBusinessmapReads()
        set((state) => ({ ...state, businessmapSearchCache: {} }))
      }
      return result
    },
    updateBusinessmapCard: async (id, updates, options) => {
      const scope = getBusinessmapReadScope(get().settings, options?.sourceContext)
      const siteId = resolveReadSiteId(options, get)
      const result = await businessmapUpdateCard(scope.settings, id, updates, siteId)
      if (result.ok) {
        invalidateBusinessmapReads()
        set(() => ({ businessmapSearchCache: {}, businessmapCardCache: {} }))
      }
      return result
    },

    addBusinessmapCardComment: async (id, body, options) => {
      const scope = getBusinessmapReadScope(get().settings, options?.sourceContext)
      const siteId = resolveReadSiteId(options, get)
      return businessmapAddCardComment(scope.settings, id, body, siteId)
    },

    listBusinessmapBoards: async (options) => {
      const scope = getBusinessmapReadScope(get().settings, options?.sourceContext)
      const siteId = resolveReadSiteId(options, get)
      const cacheKey = scopedBusinessmapCacheKey(scope, `${siteId ?? 'default'}::boards`)
      const cached = get().businessmapBoardCache[cacheKey]
      if (isFreshBusinessmapCacheEntry(cached)) {
        return cached.data ?? []
      }
      const inflight = inflightBusinessmapBoardRequests.get(cacheKey)
      const requestMutationGeneration = peekBusinessmapMutationGeneration()
      const requestReadInvalidation = currentBusinessmapReadInvalidationGeneration()
      if (
        inflight &&
        inflight.contextKey === scope.contextKey &&
        inflight.mutationGeneration === requestMutationGeneration &&
        inflight.readInvalidationGeneration === requestReadInvalidation
      ) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inflight map is typed unknown to share one registry across board/card payloads; the entry stored below always carries BusinessmapBoard[].
        return inflight.promise.then((boards) => boards as BusinessmapBoard[])
      }
      let entry: InflightBusinessmapReadRequest<unknown>
      const request = businessmapListBoards(scope.settings, siteId)
        .then((boards) => {
          if (
            inflightBusinessmapBoardRequests.get(cacheKey) === entry &&
            canWriteCollectionResult(
              scope,
              requestMutationGeneration,
              get,
              requestReadInvalidation
            )
          ) {
            set((state) => ({
              businessmapBoardCache: evictStaleBusinessmapCacheEntries({
                ...state.businessmapBoardCache,
                [cacheKey]: { data: boards, fetchedAt: Date.now() }
              })
            }))
          }
          return boards
        })
        .catch((error) => {
          console.warn('[businessmap] listBusinessmapBoards failed:', error)
          throw error
        })
      const promise = request.finally(() => {
        if (inflightBusinessmapBoardRequests.get(cacheKey) === entry) {
          inflightBusinessmapBoardRequests.delete(cacheKey)
        }
      })
      entry = {
        promise,
        contextKey: scope.contextKey,
        mutationGeneration: requestMutationGeneration,
        readInvalidationGeneration: requestReadInvalidation
      }
      inflightBusinessmapBoardRequests.set(cacheKey, entry)
      return promise
    }
  }
}
