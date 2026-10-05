import { mantisBTGetIssue } from '@/runtime/runtime-mantisbt-client'
import { isIntegrationCredentialDecryptionError } from '../../../../shared/integration-credential-errors'
import type { MantisBTIssue } from '../../../../shared/mantisbt-types'
import type { MantisBTSlice, MantisBTSliceGet, MantisBTSliceSet } from './mantisbt-slice-contract'
import {
  canWriteMantisBTReadResult,
  currentMantisBTMutationGeneration,
  evictStaleMantisBTCacheEntries,
  getMantisBTReadScope,
  inflightMantisBTIssueRequests,
  isFreshMantisBTCacheEntry,
  looksLikeMantisBTAuthError,
  markMantisBTConnectionLost,
  scopedMantisBTCacheKey,
  shouldRefreshMantisBTStatusAfterRead,
  type InflightMantisBTReadRequest
} from './mantisbt-read-coordination'

type MantisBTIssueReadActions = Pick<MantisBTSlice, 'fetchMantisBTIssue'>

export function createMantisBTIssueReadActions(
  set: MantisBTSliceSet,
  get: MantisBTSliceGet
): MantisBTIssueReadActions {
  return {
    fetchMantisBTIssue: async (id, siteId, options) => {
      const scope = getMantisBTReadScope(get().settings, options?.sourceContext)
      const issueCacheKey = scopedMantisBTCacheKey(scope, `${siteId ?? 'selected'}::${id}`)
      const cached = get().mantisBTIssueCache[issueCacheKey] ?? get().mantisBTIssueCache[id]
      if (isFreshMantisBTCacheEntry(cached)) {
        return cached.data
      }
      const inflight = inflightMantisBTIssueRequests.get(issueCacheKey)
      if (
        inflight &&
        inflight.contextKey === scope.contextKey &&
        inflight.mutationGeneration === currentMantisBTMutationGeneration()
      ) {
        return inflight.promise
      }
      let entry: InflightMantisBTReadRequest<MantisBTIssue | null>
      const requestMutationGeneration = currentMantisBTMutationGeneration()
      const promise = mantisBTGetIssue(scope.settings, id, siteId)
        .then((issue) => {
          if (
            inflightMantisBTIssueRequests.get(issueCacheKey) === entry &&
            canWriteMantisBTReadResult(
              scope.contextKey,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            set((state) => ({
              mantisBTIssueCache: evictStaleMantisBTCacheEntries({
                ...state.mantisBTIssueCache,
                [issueCacheKey]: { data: issue, fetchedAt: Date.now() }
              })
            }))
          }
          return issue
        })
        .catch((error) => {
          console.warn('[mantisbt] fetchMantisBTIssue failed:', error)
          if (
            isIntegrationCredentialDecryptionError(error) &&
            canWriteMantisBTReadResult(
              scope.contextKey,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            if (!shouldRefreshMantisBTStatusAfterRead(siteId, get().mantisBTStatus)) {
              void get().checkMantisBTConnection()
            }
          } else if (
            looksLikeMantisBTAuthError(error) &&
            canWriteMantisBTReadResult(
              scope.contextKey,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            markMantisBTConnectionLost(set, scope)
          }
          return null
        })
        .finally(() => {
          if (inflightMantisBTIssueRequests.get(issueCacheKey) === entry) {
            inflightMantisBTIssueRequests.delete(issueCacheKey)
          }
          if (
            shouldRefreshMantisBTStatusAfterRead(siteId, get().mantisBTStatus) &&
            canWriteMantisBTReadResult(
              scope.contextKey,
              requestMutationGeneration,
              get().settings,
              scope.explicitSource
            )
          ) {
            void get().checkMantisBTConnection()
          }
        })
      entry = {
        promise,
        contextKey: scope.contextKey,
        mutationGeneration: requestMutationGeneration
      }
      inflightMantisBTIssueRequests.set(issueCacheKey, entry)
      return promise
    }
  }
}
