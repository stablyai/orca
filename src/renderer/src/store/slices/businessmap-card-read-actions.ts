import { businessmapGetCard, businessmapSearchCards } from '@/runtime/runtime-businessmap-client'
import { isIntegrationCredentialDecryptionError } from '../../../../shared/integration-credential-errors'
import type { BusinessmapCard } from '../../../../shared/businessmap-types'
import type {
  BusinessmapSlice,
  BusinessmapSliceGet,
  BusinessmapSliceSet
} from './businessmap-slice-contract'
import {
  canWriteBusinessmapReadResult,
  createBusinessmapAbortError,
  peekBusinessmapMutationGeneration,
  currentBusinessmapReadInvalidationGeneration,
  currentBusinessmapSearchRequestSequence,
  evictStaleBusinessmapCacheEntries,
  getBusinessmapReadScope,
  inflightBusinessmapCardRequests,
  inflightBusinessmapSearchRequests,
  isFreshBusinessmapCacheEntry,
  looksLikeBusinessmapAuthError,
  markBusinessmapConnectionLost,
  nextBusinessmapSearchRequestSequence,
  scopedBusinessmapCacheKey,
  type InflightBusinessmapReadRequest
} from './businessmap-read-coordination'
import {
  canWriteCollectionResult,
  handleBusinessmapCollectionReadError,
  resolveReadSiteId
} from './businessmap-read-result-guards'

type BusinessmapCardReadActions = Pick<
  BusinessmapSlice,
  'fetchBusinessmapCard' | 'searchBusinessmapCards'
>

export function createBusinessmapCardReadActions(
  set: BusinessmapSliceSet,
  get: BusinessmapSliceGet
): BusinessmapCardReadActions {
  return {
    fetchBusinessmapCard: async (id, siteId, options) => {
      const scope = getBusinessmapReadScope(get().settings, options?.sourceContext)
      const effectiveSiteId = siteId ?? resolveReadSiteId(options, get)
      const cacheKey = scopedBusinessmapCacheKey(scope, `${effectiveSiteId ?? 'selected'}::${id}`)
      const cached = get().businessmapCardCache[cacheKey] ?? get().businessmapCardCache[String(id)]
      if (isFreshBusinessmapCacheEntry(cached)) {
        return cached.data
      }
      const inflight = inflightBusinessmapCardRequests.get(cacheKey)
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
      let entry: InflightBusinessmapReadRequest<BusinessmapCard | null>
      const request = businessmapGetCard(scope.settings, id, effectiveSiteId)
        .then((card) => {
          if (
            inflightBusinessmapCardRequests.get(cacheKey) === entry &&
            canWriteBusinessmapReadResult(
              scope.contextKey,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource,
              requestReadInvalidation
            )
          ) {
            set((state) => ({
              businessmapCardCache: evictStaleBusinessmapCacheEntries({
                ...state.businessmapCardCache,
                [cacheKey]: { data: card, fetchedAt: Date.now() }
              })
            }))
          }
          return card
        })
        .catch((error) => {
          console.warn('[businessmap] fetchBusinessmapCard failed:', error)
          if (
            isIntegrationCredentialDecryptionError(error) &&
            canWriteCollectionResult(scope, requestMutationGeneration, get, requestReadInvalidation)
          ) {
            void get().checkBusinessmapConnection()
          } else if (
            looksLikeBusinessmapAuthError(error) &&
            canWriteCollectionResult(scope, requestMutationGeneration, get, requestReadInvalidation)
          ) {
            markBusinessmapConnectionLost(set, scope)
          }
          if (
            isIntegrationCredentialDecryptionError(error) ||
            looksLikeBusinessmapAuthError(error)
          ) {
            return null
          }
          throw error
        })
      const promise = request.finally(() => {
        if (inflightBusinessmapCardRequests.get(cacheKey) === entry) {
          inflightBusinessmapCardRequests.delete(cacheKey)
        }
      })
      entry = {
        promise,
        contextKey: scope.contextKey,
        mutationGeneration: requestMutationGeneration,
        readInvalidationGeneration: requestReadInvalidation
      }
      inflightBusinessmapCardRequests.set(cacheKey, entry)
      return promise
    },

    searchBusinessmapCards: async (query, limit = 30, options) => {
      const scope = getBusinessmapReadScope(get().settings, options?.sourceContext)
      const siteId = resolveReadSiteId(options, get)
      const boardId = options?.boardId ?? null
      const cacheKey = scopedBusinessmapCacheKey(
        scope,
        `${siteId ?? 'default'}::${boardId ?? 'all'}::${query}::${limit}`
      )
      const cached = get().businessmapSearchCache[cacheKey]
      if (isFreshBusinessmapCacheEntry(cached)) {
        return cached.data ?? []
      }
      const inflight = inflightBusinessmapSearchRequests.get(cacheKey)
      const abortable = options?.signal !== undefined
      const requestMutationGeneration = peekBusinessmapMutationGeneration()
      const requestReadInvalidation = currentBusinessmapReadInvalidationGeneration()
      if (
        !abortable &&
        inflight &&
        inflight.contextKey === scope.contextKey &&
        inflight.mutationGeneration === requestMutationGeneration &&
        inflight.readInvalidationGeneration === requestReadInvalidation
      ) {
        return inflight.promise
      }
      const requestSequence = abortable ? nextBusinessmapSearchRequestSequence(cacheKey) : 0
      let entry: InflightBusinessmapReadRequest<BusinessmapCard[]>
      const request = businessmapSearchCards(
        scope.settings,
        query,
        limit,
        siteId,
        boardId,
        options?.signal
      )
        .then((cards) => {
          if (options?.signal?.aborted) {
            throw createBusinessmapAbortError('search')
          }
          const isLatestAbortable =
            abortable && requestSequence === currentBusinessmapSearchRequestSequence(cacheKey)
          if (
            (isLatestAbortable ||
              (!abortable && inflightBusinessmapSearchRequests.get(cacheKey) === entry)) &&
            canWriteCollectionResult(
              scope,
              requestMutationGeneration,
              get,
              requestReadInvalidation
            )
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
          if (options?.signal?.aborted) {
            throw error
          }
          console.warn('[businessmap] searchBusinessmapCards failed:', error)
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
        if (inflightBusinessmapSearchRequests.get(cacheKey) === entry) {
          inflightBusinessmapSearchRequests.delete(cacheKey)
        }
      })
      entry = {
        promise,
        contextKey: scope.contextKey,
        mutationGeneration: requestMutationGeneration,
        readInvalidationGeneration: requestReadInvalidation
      }
      if (!abortable) {
        inflightBusinessmapSearchRequests.set(cacheKey, entry)
      }
      return promise
    }
  }
}
