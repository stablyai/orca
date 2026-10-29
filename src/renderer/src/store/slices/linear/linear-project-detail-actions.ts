import type { LinearProjectDetail } from '../../../../../shared/linear/project-types'
import type {
  LinearFetchOptions,
  LinearSlice,
  LinearSliceGet,
  LinearSliceSet
} from './linear-slice-contract'
import { isIntegrationCredentialDecryptionError } from '../../../../../shared/integration-credential-errors'
import { linearGetProject } from '@/runtime/runtime-linear-project-client'
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
  inflightProjectDetailRequests,
  type InflightLinearDetailRequest
} from './linear-slice-request-state'
import {
  canWriteLinearReadResult,
  getLinearReadScope,
  scopedLinearCacheKey
} from './linear-slice-scope'

export function createLinearProjectDetailActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<LinearSlice, 'fetchLinearProject'> {
  return {
    fetchLinearProject: async (id, workspaceId, options?: LinearFetchOptions) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const { contextKey } = scope
      const cacheKey = scopedLinearCacheKey(
        scope,
        linearCollectionCacheKey(workspaceId, 'project-detail', id)
      )
      const cached = get().linearProjectDetailCache[cacheKey]
      if (!options?.force && isFresh(cached)) {
        return cached.data
      }

      const inflight = inflightProjectDetailRequests.get(cacheKey)
      if (
        inflight &&
        inflight.contextKey === contextKey &&
        inflight.mutationGeneration === getLinearMutationGeneration() &&
        (!options?.force || inflight.force)
      ) {
        return inflight.promise
      }

      let entry: InflightLinearDetailRequest<LinearProjectDetail | null>
      const requestCacheGeneration = getLinearCacheGeneration()
      const requestMutationGeneration = getLinearMutationGeneration()
      const promise = linearGetProject(scope.settings, id, workspaceId, {
        force: options?.force
      })
        .then((project) => {
          if (
            inflightProjectDetailRequests.get(cacheKey) === entry &&
            canWriteLinearReadResult(
              contextKey,
              requestCacheGeneration,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            set((s) => ({
              linearProjectDetailCache: evictStaleEntries({
                ...s.linearProjectDetailCache,
                [cacheKey]: { data: project, fetchedAt: Date.now() }
              })
            }))
          }
          return project
        })
        .catch((error) => {
          console.warn('[linear] fetchLinearProject failed:', error)
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
          const cachedResult = get().linearProjectDetailCache[cacheKey]
          if (cachedResult) {
            return cachedResult.data
          }
          throw error
        })
        .finally(() => {
          if (inflightProjectDetailRequests.get(cacheKey) === entry) {
            inflightProjectDetailRequests.delete(cacheKey)
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
      inflightProjectDetailRequests.set(cacheKey, entry)
      return promise
    }
  }
}
