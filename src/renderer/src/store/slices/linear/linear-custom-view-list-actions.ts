import type {
  LinearCustomViewModel,
  LinearCustomViewSummary
} from '../../../../../shared/linear/project-types'
import type {
  LinearFetchOptions,
  LinearSlice,
  LinearSliceGet,
  LinearSliceSet
} from './linear-slice-contract'
import { isIntegrationCredentialDecryptionError } from '../../../../../shared/integration-credential-errors'
import { linearListCustomViews } from '@/runtime/runtime-linear-project-client'
import {
  collectionWithWorkspaceError,
  emptyLinearCollection,
  evictStaleEntries,
  getSelectedWorkspaceId,
  isFresh,
  linearCollectionCacheKey,
  looksLikeAuthError,
  shouldRefreshStatusAfterRead
} from './linear-cache'
import {
  getLinearCacheGeneration,
  getLinearMutationGeneration,
  inflightCustomViewRequests,
  type InflightLinearCollectionRequest
} from './linear-slice-request-state'
import {
  canWriteLinearReadResult,
  getLinearReadScope,
  scopedLinearCacheKey
} from './linear-slice-scope'

export function createLinearCustomViewListActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<LinearSlice, 'getCachedLinearCustomViews' | 'listLinearCustomViews'> {
  return {
    getCachedLinearCustomViews: (model, limit = 20, workspaceId, options) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const resolvedWorkspaceId = workspaceId ?? getSelectedWorkspaceId(get().linearStatus)
      const cacheKey = linearCollectionCacheKey(resolvedWorkspaceId, 'custom-views', model, limit)
      return get().linearCustomViewCache[scopedLinearCacheKey(scope, cacheKey)]?.data ?? null
    },

    listLinearCustomViews: async (
      model: LinearCustomViewModel,
      limit = 20,
      workspaceId,
      options?: LinearFetchOptions
    ) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const { contextKey } = scope
      const resolvedWorkspaceId = workspaceId ?? getSelectedWorkspaceId(get().linearStatus)
      const cacheKey = scopedLinearCacheKey(
        scope,
        linearCollectionCacheKey(resolvedWorkspaceId, 'custom-views', model, limit)
      )
      const cached = get().linearCustomViewCache[cacheKey]
      if (!options?.force && isFresh(cached)) {
        return cached.data ?? emptyLinearCollection<LinearCustomViewSummary>()
      }

      const inflight = inflightCustomViewRequests.get(cacheKey)
      if (
        inflight &&
        inflight.contextKey === contextKey &&
        inflight.mutationGeneration === getLinearMutationGeneration() &&
        (!options?.force || inflight.force)
      ) {
        return inflight.promise
      }

      let entry: InflightLinearCollectionRequest<LinearCustomViewSummary>
      const requestCacheGeneration = getLinearCacheGeneration()
      const requestMutationGeneration = getLinearMutationGeneration()
      const promise = linearListCustomViews(scope.settings, model, limit, resolvedWorkspaceId, {
        force: options?.force
      })
        .then((result) => {
          if (
            inflightCustomViewRequests.get(cacheKey) === entry &&
            canWriteLinearReadResult(
              contextKey,
              requestCacheGeneration,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            set((s) => ({
              linearCustomViewCache: evictStaleEntries({
                ...s.linearCustomViewCache,
                [cacheKey]: { data: result, fetchedAt: Date.now() }
              })
            }))
          }
          return result
        })
        .catch((error) => {
          console.warn('[linear] listLinearCustomViews failed:', error)
          if (
            (isIntegrationCredentialDecryptionError(error) || looksLikeAuthError(error)) &&
            canWriteLinearReadResult(
              contextKey,
              requestCacheGeneration,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            void get().checkLinearConnection(true)
          }
          const fallback =
            get().linearCustomViewCache[cacheKey]?.data ??
            emptyLinearCollection<LinearCustomViewSummary>()
          return collectionWithWorkspaceError(fallback, resolvedWorkspaceId ?? 'default', error)
        })
        .finally(() => {
          if (inflightCustomViewRequests.get(cacheKey) === entry) {
            inflightCustomViewRequests.delete(cacheKey)
          }
          if (
            shouldRefreshStatusAfterRead(resolvedWorkspaceId, get().linearStatus) &&
            canWriteLinearReadResult(
              contextKey,
              requestCacheGeneration,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            void get().checkLinearConnection(true)
          }
        })

      entry = {
        promise,
        force: Boolean(options?.force),
        generation: requestCacheGeneration,
        contextKey,
        mutationGeneration: requestMutationGeneration
      }
      inflightCustomViewRequests.set(cacheKey, entry)
      return promise
    }
  }
}
