import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type {
  LinearSlice,
  LinearSliceGet,
  LinearSliceSet,
  LinearFetchOptions
} from './linear-slice-contract'
import { isIntegrationCredentialDecryptionError } from '../../../../../shared/integration-credential-errors'
import { linearGetIssue } from '@/runtime/runtime-linear-issue-mutations'
import {
  clearLinearIssueCollectionRequestMaps,
  getLinearCacheGeneration,
  getLinearMutationGeneration,
  inflightIssueRequests
} from './linear-slice-request-state'
import {
  canWriteLinearReadResult,
  getLinearReadScope,
  scopedLinearCacheKey
} from './linear-slice-scope'
import {
  evictStaleEntries,
  isFresh,
  looksLikeAuthError,
  shouldRefreshStatusAfterRead
} from './linear-cache'
import type { InflightLinearIssueRequest } from './linear-slice-request-state'

export function createLinearIssueDetailActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<LinearSlice, 'fetchLinearIssue' | 'refreshLinearIssue'> {
  return {
    fetchLinearIssue: async (
      id: string,
      workspaceId?: string | null,
      options?: LinearFetchOptions
    ) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const { contextKey } = scope
      const issueCacheKey = scopedLinearCacheKey(scope, `${workspaceId ?? 'selected'}::${id}`)
      const cached = get().linearIssueCache[issueCacheKey] ?? get().linearIssueCache[id]
      if (isFresh(cached)) {
        return cached.data
      }

      const inflight = inflightIssueRequests.get(issueCacheKey)
      if (
        inflight &&
        inflight.contextKey === contextKey &&
        inflight.mutationGeneration === getLinearMutationGeneration()
      ) {
        return inflight.promise
      }

      let entry: InflightLinearIssueRequest
      const requestCacheGeneration = getLinearCacheGeneration()
      const requestMutationGeneration = getLinearMutationGeneration()
      const promise = linearGetIssue(scope.settings, id, workspaceId)
        .then((issue) => {
          const data = issue as LinearIssue | null
          if (
            inflightIssueRequests.get(issueCacheKey) === entry &&
            canWriteLinearReadResult(
              contextKey,
              requestCacheGeneration,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            set((s) => ({
              linearIssueCache: evictStaleEntries({
                ...s.linearIssueCache,
                [issueCacheKey]: { data, fetchedAt: Date.now() }
              })
            }))
          }
          return data
        })
        .catch((error) => {
          console.warn('[linear] fetchLinearIssue failed:', error)
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
          return null
        })
        .finally(() => {
          if (inflightIssueRequests.get(issueCacheKey) === entry) {
            inflightIssueRequests.delete(issueCacheKey)
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
        generation: requestCacheGeneration,
        contextKey,
        mutationGeneration: requestMutationGeneration
      }
      inflightIssueRequests.set(issueCacheKey, entry)
      return promise
    },

    refreshLinearIssue: async (
      id: string,
      workspaceId?: string | null,
      options?: LinearFetchOptions
    ) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const issueCacheKey = scopedLinearCacheKey(scope, `${workspaceId ?? 'selected'}::${id}`)
      inflightIssueRequests.delete(issueCacheKey)
      clearLinearIssueCollectionRequestMaps()
      set((s) => {
        const nextIssueCache = { ...s.linearIssueCache }
        for (const [key, entry] of Object.entries(nextIssueCache)) {
          if (
            key === issueCacheKey ||
            key === id ||
            entry?.data?.id === id ||
            entry?.data?.identifier === id
          ) {
            delete nextIssueCache[key]
          }
        }
        return {
          linearIssueCache: nextIssueCache,
          linearSearchCache: {},
          linearListCache: {},
          linearProjectIssueCache: {},
          linearCustomViewIssueCache: {}
        }
      })
      return get().fetchLinearIssue(id, workspaceId, options)
    }
  }
}
