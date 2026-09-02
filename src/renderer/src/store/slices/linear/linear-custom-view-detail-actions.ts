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
import { linearGetCustomView } from '@/runtime/runtime-linear-project-client'
import {
  evictStaleEntries,
  isFresh,
  linearCollectionCacheKey,
  looksLikeAuthError,
  shouldRefreshStatusAfterRead
} from './linear-cache'
import {
  getLinearCacheGeneration,
  getLinearMutationGeneration,
  inflightCustomViewDetailRequests,
  type InflightLinearDetailRequest
} from './linear-slice-request-state'
import {
  canWriteLinearReadResult,
  getLinearReadScope,
  scopedLinearCacheKey
} from './linear-slice-scope'

export function createLinearCustomViewDetailActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<LinearSlice, 'fetchLinearCustomView'> {
  return {
    fetchLinearCustomView: async (
      viewId,
      workspaceId,
      model: LinearCustomViewModel,
      options?: LinearFetchOptions
    ) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const { contextKey } = scope
      const cacheKey = scopedLinearCacheKey(
        scope,
        linearCollectionCacheKey(workspaceId, 'custom-view-detail', model, viewId)
      )
      const cached = get().linearCustomViewDetailCache[cacheKey]
      if (!options?.force && isFresh(cached)) {
        return cached.data
      }

      const inflight = inflightCustomViewDetailRequests.get(cacheKey)
      if (
        inflight &&
        inflight.contextKey === contextKey &&
        inflight.mutationGeneration === getLinearMutationGeneration() &&
        (!options?.force || inflight.force)
      ) {
        return inflight.promise
      }

      let entry: InflightLinearDetailRequest<LinearCustomViewSummary | null>
      const requestCacheGeneration = getLinearCacheGeneration()
      const requestMutationGeneration = getLinearMutationGeneration()
      const promise = linearGetCustomView(scope.settings, viewId, model, workspaceId, {
        force: options?.force
      })
        .then((view) => {
          if (
            inflightCustomViewDetailRequests.get(cacheKey) === entry &&
            canWriteLinearReadResult(
              contextKey,
              requestCacheGeneration,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            set((s) => ({
              linearCustomViewDetailCache: evictStaleEntries({
                ...s.linearCustomViewDetailCache,
                [cacheKey]: { data: view, fetchedAt: Date.now() }
              })
            }))
          }
          return view
        })
        .catch((error) => {
          console.warn('[linear] fetchLinearCustomView failed:', error)
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
          if (options?.force) {
            throw error
          }
          const cachedResult = get().linearCustomViewDetailCache[cacheKey]
          if (cachedResult) {
            return cachedResult.data
          }
          throw error
        })
        .finally(() => {
          if (inflightCustomViewDetailRequests.get(cacheKey) === entry) {
            inflightCustomViewDetailRequests.delete(cacheKey)
          }
          if (
            shouldRefreshStatusAfterRead(workspaceId, get().linearStatus) &&
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
        contextKey,
        mutationGeneration: requestMutationGeneration
      }
      inflightCustomViewDetailRequests.set(cacheKey, entry)
      return promise
    }
  }
}
