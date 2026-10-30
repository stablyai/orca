import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type {
  LinearFetchOptions,
  LinearSlice,
  LinearSliceGet,
  LinearSliceSet
} from './linear-slice-contract'
import { clampLinearIssueListLimit } from '../../../../../shared/linear/issue-read-limits'
import { isIntegrationCredentialDecryptionError } from '../../../../../shared/integration-credential-errors'
import { linearListCustomViewIssues } from '@/runtime/runtime-linear-project-client'
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
  inflightCustomViewIssueRequests,
  type InflightLinearCollectionRequest
} from './linear-slice-request-state'
import {
  canWriteLinearReadResult,
  getLinearReadScope,
  scopedLinearCacheKey
} from './linear-slice-scope'

export function createLinearCustomViewIssueActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<LinearSlice, 'listLinearCustomViewIssues'> {
  return {
    listLinearCustomViewIssues: async (
      viewId,
      workspaceId,
      limit = 20,
      options?: LinearFetchOptions
    ) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const { contextKey } = scope
      const effectiveLimit = clampLinearIssueListLimit(limit)
      const cacheKey = scopedLinearCacheKey(
        scope,
        linearCollectionCacheKey(workspaceId, 'custom-view-issues', viewId, effectiveLimit)
      )
      const cached = get().linearCustomViewIssueCache[cacheKey]
      if (!options?.force && isFresh(cached)) {
        return cached.data ?? emptyLinearCollection<LinearIssue>()
      }

      const inflight = inflightCustomViewIssueRequests.get(cacheKey)
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
      const promise = linearListCustomViewIssues(
        scope.settings,
        viewId,
        effectiveLimit,
        workspaceId,
        {
          force: options?.force
        }
      )
        .then((result) => {
          if (
            inflightCustomViewIssueRequests.get(cacheKey) === entry &&
            canWriteLinearReadResult(
              contextKey,
              requestCacheGeneration,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            set((s) => ({
              linearCustomViewIssueCache: evictStaleEntries({
                ...s.linearCustomViewIssueCache,
                [cacheKey]: { data: result, fetchedAt: Date.now() }
              })
            }))
          }
          return result
        })
        .catch((error) => {
          console.warn('[linear] listLinearCustomViewIssues failed:', error)
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
            get().linearCustomViewIssueCache[cacheKey]?.data ??
            largestCachedCollectionBelowLimit(
              get().linearCustomViewIssueCache,
              workspaceId,
              'custom-view-issues',
              viewId,
              effectiveLimit
            ) ??
            emptyLinearCollection<LinearIssue>()
          return collectionWithWorkspaceError(fallback, workspaceId, error)
        })
        .finally(() => {
          if (inflightCustomViewIssueRequests.get(cacheKey) === entry) {
            inflightCustomViewIssueRequests.delete(cacheKey)
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
      inflightCustomViewIssueRequests.set(cacheKey, entry)
      return promise
    }
  }
}
