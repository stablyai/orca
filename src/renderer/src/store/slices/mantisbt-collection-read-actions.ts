import { getMantisBTRuntimeTarget } from '@/runtime/runtime-mantisbt-target'
import { mantisBTListIssues } from '@/runtime/runtime-mantisbt-client'
import { isIntegrationCredentialDecryptionError } from '../../../../shared/integration-credential-errors'
import type { MantisBTIssue, MantisBTSiteSelection } from '../../../../shared/mantisbt-types'
import type { MantisBTSlice, MantisBTSliceGet, MantisBTSliceSet } from './mantisbt-slice-contract'
import {
  canWriteMantisBTReadResult,
  currentMantisBTMutationGeneration,
  evictStaleMantisBTCacheEntries,
  getMantisBTReadScope,
  getSelectedMantisBTSiteId,
  inflightMantisBTListRequests,
  isFreshMantisBTCacheEntry,
  looksLikeMantisBTAuthError,
  markMantisBTConnectionLost,
  scopedMantisBTCacheKey,
  shouldRefreshMantisBTStatusAfterRead,
  type InflightMantisBTReadRequest,
  type MantisBTReadScope
} from './mantisbt-read-coordination'

type MantisBTCollectionReadActions = Pick<MantisBTSlice, 'listMantisBTIssues'>

function canWriteCollectionResult(
  scope: MantisBTReadScope,
  mutationGeneration: number,
  get: MantisBTSliceGet
): boolean {
  return canWriteMantisBTReadResult(
    scope.contextKey,
    mutationGeneration,
    get().settings,
    scope.explicitSource
  )
}

function handleMantisBTCollectionReadError(
  error: unknown,
  scope: MantisBTReadScope,
  siteId: MantisBTSiteSelection | null | undefined,
  mutationGeneration: number,
  set: MantisBTSliceSet,
  get: MantisBTSliceGet
): MantisBTIssue[] {
  if (
    isIntegrationCredentialDecryptionError(error) &&
    canWriteCollectionResult(scope, mutationGeneration, get)
  ) {
    if (!shouldRefreshMantisBTStatusAfterRead(siteId, get().mantisBTStatus)) {
      void get().checkMantisBTConnection()
    }
  } else if (
    looksLikeMantisBTAuthError(error) &&
    canWriteCollectionResult(scope, mutationGeneration, get)
  ) {
    markMantisBTConnectionLost(set, scope)
  }
  if (isIntegrationCredentialDecryptionError(error) || looksLikeMantisBTAuthError(error)) {
    return []
  }
  throw error
}

export function createMantisBTCollectionReadActions(
  set: MantisBTSliceSet,
  get: MantisBTSliceGet
): MantisBTCollectionReadActions {
  return {
    listMantisBTIssues: async (filter = 'assigned', limit = 30, options) => {
      const scope = getMantisBTReadScope(get().settings, options?.sourceContext)
      // Why: a project filter is only unambiguous scoped to its own site (project
      // ids are unique per-site, not globally) — the caller passes the project's
      // owning siteId as an explicit override when a project is selected under an
      // 'all sites' view; otherwise fall back to the store's selected site.
      const siteId = options?.siteId ?? getSelectedMantisBTSiteId(get().mantisBTStatus)
      const projectId = options?.projectId ?? null
      const cacheKey = scopedMantisBTCacheKey(
        scope,
        `${siteId ?? 'default'}::list::${filter}::${limit}::${projectId ?? 'all'}`
      )
      const cached = get().mantisBTSearchCache[cacheKey]
      if (isFreshMantisBTCacheEntry(cached)) {
        return cached.data ?? []
      }
      const inflight = inflightMantisBTListRequests.get(cacheKey)
      const requestMutationGeneration = currentMantisBTMutationGeneration()
      if (
        inflight &&
        inflight.contextKey === scope.contextKey &&
        inflight.mutationGeneration === requestMutationGeneration
      ) {
        return inflight.promise
      }
      let entry: InflightMantisBTReadRequest<MantisBTIssue[]>
      const target = getMantisBTRuntimeTarget(scope.settings)
      const onProgress = options?.onProgress
      const requestId =
        target.kind !== 'environment' && onProgress ? crypto.randomUUID() : undefined
      const unsubscribeProgress = requestId
        ? window.api.mantisBT.onListIssuesProgress(({ requestId: rid, issues }) => {
            if (rid === requestId) {
              onProgress?.(issues)
            }
          })
        : undefined
      const promise = mantisBTListIssues(
        scope.settings,
        filter,
        limit,
        siteId,
        projectId,
        requestId
      )
        .then((issues) => {
          if (
            inflightMantisBTListRequests.get(cacheKey) === entry &&
            canWriteCollectionResult(scope, requestMutationGeneration, get)
          ) {
            set((state) => ({
              mantisBTSearchCache: evictStaleMantisBTCacheEntries({
                ...state.mantisBTSearchCache,
                [cacheKey]: { data: issues, fetchedAt: Date.now() }
              })
            }))
          }
          return issues
        })
        .catch((error) => {
          console.warn('[mantisbt] listMantisBTIssues failed:', error)
          return handleMantisBTCollectionReadError(
            error,
            scope,
            siteId,
            requestMutationGeneration,
            set,
            get
          )
        })
        .finally(() => {
          unsubscribeProgress?.()
          if (inflightMantisBTListRequests.get(cacheKey) === entry) {
            inflightMantisBTListRequests.delete(cacheKey)
          }
          if (
            shouldRefreshMantisBTStatusAfterRead(siteId, get().mantisBTStatus) &&
            canWriteCollectionResult(scope, requestMutationGeneration, get)
          ) {
            void get().checkMantisBTConnection()
          }
        })
      entry = {
        promise,
        contextKey: scope.contextKey,
        mutationGeneration: requestMutationGeneration
      }
      inflightMantisBTListRequests.set(cacheKey, entry)
      return promise
    }
  }
}
