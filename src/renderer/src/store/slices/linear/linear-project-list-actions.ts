import type { LinearProjectSummary } from '../../../../../shared/linear/project-types'
import type {
  LinearFetchOptions,
  LinearSlice,
  LinearSliceGet,
  LinearSliceSet
} from './linear-slice-contract'
import { isIntegrationCredentialDecryptionError } from '../../../../../shared/integration-credential-errors'
import { linearListProjects } from '@/runtime/runtime-linear-project-client'
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
  inflightProjectRequests,
  type InflightLinearCollectionRequest
} from './linear-slice-request-state'
import {
  canWriteLinearReadResult,
  getLinearReadScope,
  scopedLinearCacheKey
} from './linear-slice-scope'

export function createLinearProjectListActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<LinearSlice, 'getCachedLinearProjects' | 'listLinearProjects'> {
  return {
    getCachedLinearProjects: (query, limit = 20, workspaceId, options) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const resolvedWorkspaceId = workspaceId ?? getSelectedWorkspaceId(get().linearStatus)
      const cacheKey = linearCollectionCacheKey(
        resolvedWorkspaceId,
        'projects',
        query?.trim(),
        limit
      )
      return get().linearProjectCache[scopedLinearCacheKey(scope, cacheKey)]?.data ?? null
    },

    listLinearProjects: async (query, limit = 20, workspaceId, options?: LinearFetchOptions) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const { contextKey } = scope
      const resolvedWorkspaceId = workspaceId ?? getSelectedWorkspaceId(get().linearStatus)
      const trimmed = query?.trim() || undefined
      const cacheKey = scopedLinearCacheKey(
        scope,
        linearCollectionCacheKey(resolvedWorkspaceId, 'projects', trimmed, limit)
      )
      const cached = get().linearProjectCache[cacheKey]
      if (!options?.force && isFresh(cached)) {
        return cached.data ?? emptyLinearCollection<LinearProjectSummary>()
      }

      const inflight = inflightProjectRequests.get(cacheKey)
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
      const promise = linearListProjects(scope.settings, trimmed, limit, resolvedWorkspaceId, {
        force: options?.force
      })
        .then((result) => {
          if (
            inflightProjectRequests.get(cacheKey) === entry &&
            canWriteLinearReadResult(
              contextKey,
              requestCacheGeneration,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            set((s) => ({
              linearProjectCache: evictStaleEntries({
                ...s.linearProjectCache,
                [cacheKey]: { data: result, fetchedAt: Date.now() }
              })
            }))
          }
          return result
        })
        .catch((error) => {
          console.warn('[linear] listLinearProjects failed:', error)
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
            get().linearProjectCache[cacheKey]?.data ??
            emptyLinearCollection<LinearProjectSummary>()
          return collectionWithWorkspaceError(fallback, resolvedWorkspaceId ?? 'default', error)
        })
        .finally(() => {
          if (inflightProjectRequests.get(cacheKey) === entry) {
            inflightProjectRequests.delete(cacheKey)
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
      inflightProjectRequests.set(cacheKey, entry)
      return promise
    }
  }
}
