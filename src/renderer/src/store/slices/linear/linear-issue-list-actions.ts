import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { LinearCollectionResult } from '../../../../../shared/linear/workspace-types'
import type {
  LinearIssueListReadArgs,
  LinearFetchOptions,
  LinearSlice,
  LinearSliceGet,
  LinearSliceSet
} from './linear-slice-contract'
import { clampLinearIssueListLimit } from '../../../../../shared/linear/issue-read-limits'
import { isIntegrationCredentialDecryptionError } from '../../../../../shared/integration-credential-errors'
import {
  isLinearIssueAttributeFilterUnsupportedError,
  linearListIssues,
  linearSearchIssues
} from '@/runtime/runtime-linear-client'
import {
  evictStaleEntries,
  emptyLinearCollection,
  getSelectedWorkspaceId,
  isFresh,
  linearListCacheKey,
  linearSearchCacheKey,
  looksLikeAuthError,
  shouldRefreshStatusAfterRead
} from './linear-cache'
import {
  getLinearCacheGeneration,
  getLinearMutationGeneration,
  inflightListRequests,
  inflightSearchRequests,
  type InflightLinearListRequest,
  type InflightLinearPlainListRequest
} from './linear-slice-request-state'
import {
  canWriteLinearReadResult,
  getLinearReadScope,
  normalizeListAttributeFilter,
  scopedLinearCacheKey
} from './linear-slice-scope'

export function createLinearIssueListActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<LinearSlice, 'searchLinearIssues' | 'listLinearIssues'> {
  return {
    searchLinearIssues: async (query: string, limit = 20, options?: LinearFetchOptions) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const { contextKey } = scope
      const workspaceId = getSelectedWorkspaceId(get().linearStatus)
      const cacheKey = scopedLinearCacheKey(scope, linearSearchCacheKey(workspaceId, query, limit))
      const cached = get().linearSearchCache[cacheKey]
      if (!options?.force && isFresh(cached)) {
        return cached.data ?? []
      }

      const inflight = inflightSearchRequests.get(cacheKey)
      if (
        inflight &&
        inflight.contextKey === contextKey &&
        inflight.mutationGeneration === getLinearMutationGeneration() &&
        (!options?.force || inflight.force)
      ) {
        return inflight.promise
      }

      let entry: InflightLinearListRequest
      const requestCacheGeneration = getLinearCacheGeneration()
      const requestMutationGeneration = getLinearMutationGeneration()
      const promise = linearSearchIssues(scope.settings, query, limit, workspaceId)
        .then((issues) => {
          const data = issues as LinearIssue[]
          if (
            inflightSearchRequests.get(cacheKey) === entry &&
            canWriteLinearReadResult(
              contextKey,
              requestCacheGeneration,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            set((s) => ({
              linearSearchCache: evictStaleEntries({
                ...s.linearSearchCache,
                [cacheKey]: { data, fetchedAt: Date.now() }
              })
            }))
          }
          return data
        })
        .catch((error) => {
          console.warn('[linear] searchLinearIssues failed:', error)
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
            if (!shouldRefreshStatusAfterRead(workspaceId, get().linearStatus)) {
              void get().checkLinearConnection(true)
            }
            return []
          }
          return get().linearSearchCache[cacheKey]?.data ?? []
        })
        .finally(() => {
          if (inflightSearchRequests.get(cacheKey) === entry) {
            inflightSearchRequests.delete(cacheKey)
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
      inflightSearchRequests.set(cacheKey, entry)
      return promise
    },

    listLinearIssues: async (args: LinearIssueListReadArgs, options?: LinearFetchOptions) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const { contextKey } = scope
      const workspaceId = getSelectedWorkspaceId(get().linearStatus)
      const filter = args.filter ?? 'assigned'
      const effectiveLimit = clampLinearIssueListLimit(args.limit)
      const attributeFilter = normalizeListAttributeFilter(args.attributeFilter)
      const cacheKey = scopedLinearCacheKey(
        scope,
        linearListCacheKey(workspaceId, filter, effectiveLimit, attributeFilter)
      )
      const cached = get().linearListCache[cacheKey]
      if (!options?.force && isFresh(cached)) {
        return cached.data ?? emptyLinearCollection<LinearIssue>()
      }

      const inflight = inflightListRequests.get(cacheKey)
      if (
        inflight &&
        inflight.contextKey === contextKey &&
        inflight.mutationGeneration === getLinearMutationGeneration() &&
        (!options?.force || inflight.force)
      ) {
        return inflight.promise
      }

      let entry: InflightLinearPlainListRequest
      const requestCacheGeneration = getLinearCacheGeneration()
      const requestMutationGeneration = getLinearMutationGeneration()
      const promise: Promise<LinearCollectionResult<LinearIssue>> = linearListIssues(
        scope.settings,
        filter,
        effectiveLimit,
        workspaceId,
        attributeFilter
      )
        .then((result) => {
          const data = result as LinearCollectionResult<LinearIssue>
          if (
            inflightListRequests.get(cacheKey) === entry &&
            canWriteLinearReadResult(
              contextKey,
              requestCacheGeneration,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            set((s) => ({
              linearListCache: evictStaleEntries({
                ...s.linearListCache,
                [cacheKey]: { data, fetchedAt: Date.now() }
              })
            }))
          }
          return data
        })
        .catch((error) => {
          console.warn('[linear] listLinearIssues failed:', error)
          // Why: capability mismatch is actionable (update remote runtime). Swallowing
          // it as [] would look like "no issues match filters" and hide the fix.
          if (isLinearIssueAttributeFilterUnsupportedError(error)) {
            throw error
          }
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
            if (!shouldRefreshStatusAfterRead(workspaceId, get().linearStatus)) {
              void get().checkLinearConnection(true)
            }
            return emptyLinearCollection<LinearIssue>()
          }
          return get().linearListCache[cacheKey]?.data ?? emptyLinearCollection<LinearIssue>()
        })
        .finally(() => {
          if (inflightListRequests.get(cacheKey) === entry) {
            inflightListRequests.delete(cacheKey)
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
      inflightListRequests.set(cacheKey, entry)
      return promise
    }
  }
}
