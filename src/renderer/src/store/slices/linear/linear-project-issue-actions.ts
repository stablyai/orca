import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type {
  LinearFetchOptions,
  LinearSlice,
  LinearSliceGet,
  LinearSliceSet
} from './linear-slice-contract'
import { clampLinearIssueListLimit } from '../../../../../shared/linear/issue-read-limits'
import { isIntegrationCredentialDecryptionError } from '../../../../../shared/integration-credential-errors'
import { linearListProjectIssues } from '@/runtime/runtime-linear-project-client'
import {
  collectionWithWorkspaceError,
  emptyLinearCollection,
  evictStaleEntries,
  largestCachedCollectionBelowLimit,
  isFresh,
  linearCollectionCacheKey,
  looksLikeAuthError,
  shouldRefreshStatusAfterRead
} from './linear-cache'
import {
  getLinearCacheGeneration,
  getLinearMutationGeneration,
  inflightProjectIssueRequests,
  type InflightLinearCollectionRequest
} from './linear-slice-request-state'
import {
  canWriteLinearReadResult,
  getLinearReadScope,
  scopedLinearCacheKey
} from './linear-slice-scope'

export function createLinearProjectIssueActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<LinearSlice, 'listLinearProjectIssues'> {
  return {
    listLinearProjectIssues: async (
      projectId,
      workspaceId,
      limit = 20,
      options?: LinearFetchOptions
    ) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const { contextKey } = scope
      const effectiveLimit = clampLinearIssueListLimit(limit)
      const cacheKey = scopedLinearCacheKey(
        scope,
        linearCollectionCacheKey(workspaceId, 'project-issues', projectId, effectiveLimit)
      )
      const cached = get().linearProjectIssueCache[cacheKey]
      if (!options?.force && isFresh(cached)) {
        return cached.data ?? emptyLinearCollection<LinearIssue>()
      }

      const inflight = inflightProjectIssueRequests.get(cacheKey)
      if (
        inflight &&
        inflight.contextKey === contextKey &&
        inflight.mutationGeneration === getLinearMutationGeneration() &&
        (!options?.force || inflight.force)
      ) {
        return inflight.promise
      }

      let entry: InflightLinearCollectionRequest<LinearIssue>
      const requestCacheGeneration = getLinearCacheGeneration()
      const requestMutationGeneration = getLinearMutationGeneration()
      const promise = linearListProjectIssues(
        scope.settings,
        projectId,
        effectiveLimit,
        workspaceId,
        {
          force: options?.force
        }
      )
        .then((result) => {
          if (
            inflightProjectIssueRequests.get(cacheKey) === entry &&
            canWriteLinearReadResult(
              contextKey,
              requestCacheGeneration,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            set((s) => ({
              linearProjectIssueCache: evictStaleEntries({
                ...s.linearProjectIssueCache,
                [cacheKey]: { data: result, fetchedAt: Date.now() }
              })
            }))
          }
          return result
        })
        .catch((error) => {
          console.warn('[linear] listLinearProjectIssues failed:', error)
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
            get().linearProjectIssueCache[cacheKey]?.data ??
            largestCachedCollectionBelowLimit(
              get().linearProjectIssueCache,
              workspaceId,
              'project-issues',
              projectId,
              effectiveLimit
            ) ??
            emptyLinearCollection<LinearIssue>()
          return collectionWithWorkspaceError(fallback, workspaceId, error)
        })
        .finally(() => {
          if (inflightProjectIssueRequests.get(cacheKey) === entry) {
            inflightProjectIssueRequests.delete(cacheKey)
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
      inflightProjectIssueRequests.set(cacheKey, entry)
      return promise
    }
  }
}
