import type { LinearProjectSummary } from '../../../../../shared/linear/project-types'
import type {
  LinearFetchOptions,
  LinearSlice,
  LinearSliceGet,
  LinearSliceSet
} from './linear-slice-contract'
import { isIntegrationCredentialDecryptionError } from '../../../../../shared/integration-credential-errors'
import { linearListCustomViewProjects } from '@/runtime/runtime-linear-project-client'
import {
  collectionWithWorkspaceError,
  emptyLinearCollection,
  evictStaleEntries,
  isFresh,
  linearCollectionCacheKey,
  looksLikeAuthError,
  shouldRefreshStatusAfterRead
} from './linear-cache'
import {
  getLinearCacheGeneration,
  getLinearMutationGeneration,
  inflightCustomViewProjectRequests,
  type InflightLinearCollectionRequest
} from './linear-slice-request-state'
import {
  canWriteLinearReadResult,
  getLinearReadScope,
  scopedLinearCacheKey
} from './linear-slice-scope'

export function createLinearCustomViewProjectActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<LinearSlice, 'listLinearCustomViewProjects'> {
  return {
    listLinearCustomViewProjects: async (
      viewId,
      workspaceId,
      limit = 20,
      options?: LinearFetchOptions
    ) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const { contextKey } = scope
      const cacheKey = scopedLinearCacheKey(
        scope,
        linearCollectionCacheKey(workspaceId, 'custom-view-projects', viewId, limit)
      )
      const cached = get().linearCustomViewProjectCache[cacheKey]
      if (!options?.force && isFresh(cached)) {
        return cached.data ?? emptyLinearCollection<LinearProjectSummary>()
      }

      const inflight = inflightCustomViewProjectRequests.get(cacheKey)
      if (
        inflight &&
        inflight.contextKey === contextKey &&
        inflight.mutationGeneration === getLinearMutationGeneration() &&
        (!options?.force || inflight.force)
      ) {
        return inflight.promise
      }

      let entry: InflightLinearCollectionRequest<LinearProjectSummary>
      const requestCacheGeneration = getLinearCacheGeneration()
      const requestMutationGeneration = getLinearMutationGeneration()
      const promise = linearListCustomViewProjects(scope.settings, viewId, limit, workspaceId, {
        force: options?.force
      })
        .then((result) => {
          if (
            inflightCustomViewProjectRequests.get(cacheKey) === entry &&
            canWriteLinearReadResult(
              contextKey,
              requestCacheGeneration,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            set((s) => ({
              linearCustomViewProjectCache: evictStaleEntries({
                ...s.linearCustomViewProjectCache,
                [cacheKey]: { data: result, fetchedAt: Date.now() }
              })
            }))
          }
          return result
        })
        .catch((error) => {
          console.warn('[linear] listLinearCustomViewProjects failed:', error)
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
            get().linearCustomViewProjectCache[cacheKey]?.data ??
            emptyLinearCollection<LinearProjectSummary>()
          return collectionWithWorkspaceError(fallback, workspaceId, error)
        })
        .finally(() => {
          if (inflightCustomViewProjectRequests.get(cacheKey) === entry) {
            inflightCustomViewProjectRequests.delete(cacheKey)
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
        generation: requestCacheGeneration,
        contextKey,
        mutationGeneration: requestMutationGeneration
      }
      inflightCustomViewProjectRequests.set(cacheKey, entry)
      return promise
    }
  }
}
