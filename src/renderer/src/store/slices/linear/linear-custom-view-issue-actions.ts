import type { LinearSlice, LinearSliceGet, LinearSliceSet } from './linear-slice-contract'
import { clampLinearIssueListLimit } from '../../../../../shared/linear/issue-read-limits'
import { linearListCustomViewIssues } from '@/runtime/runtime-linear-project-client'
import {
  collectionWithWorkspaceError,
  emptyLinearCollection,
  evictStaleEntries,
  largestCachedCollectionBelowLimit,
  linearCollectionCacheKey
} from './linear-cache'
import { inflightCustomViewIssueRequests } from './linear-slice-request-state'
import { getLinearReadScope, scopedLinearCacheKey } from './linear-slice-scope'
import { openStoreLinearIssueRead } from './linear-issue-read-actions'

export function createLinearCustomViewIssueActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<LinearSlice, 'listLinearCustomViewIssues'> {
  return {
    listLinearCustomViewIssues: (viewId, workspaceId, limit = 20, options) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const effectiveLimit = clampLinearIssueListLimit(limit)
      const key = scopedLinearCacheKey(
        scope,
        linearCollectionCacheKey(workspaceId, 'custom-view-issues', viewId, effectiveLimit)
      )
      return openStoreLinearIssueRead({
        set,
        scope,
        key,
        workspaceId,
        get,
        force: options?.force,
        requests: inflightCustomViewIssueRequests,
        cached: get().linearCustomViewIssueCache[key],
        dispatch: (force) =>
          linearListCustomViewIssues(scope.settings, viewId, effectiveLimit, workspaceId, {
            force: force || options?.force
          }).catch((error: unknown) => {
            console.warn('[linear] listLinearCustomViewIssues failed:', error)
            const fallback =
              get().linearCustomViewIssueCache[key]?.data ??
              largestCachedCollectionBelowLimit(
                get().linearCustomViewIssueCache,
                workspaceId,
                'custom-view-issues',
                viewId,
                effectiveLimit,
                scope.cachePrefix
              ) ??
              emptyLinearCollection()
            return collectionWithWorkspaceError(fallback, workspaceId, error)
          }),
        publish: (data) =>
          set((state) => ({
            linearCustomViewIssueCache: evictStaleEntries({
              ...state.linearCustomViewIssueCache,
              [key]: { data, fetchedAt: data.errors?.length ? 0 : Date.now() }
            })
          }))
      })
    }
  }
}
