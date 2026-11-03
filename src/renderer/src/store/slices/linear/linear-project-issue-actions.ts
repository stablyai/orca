import type { LinearSlice, LinearSliceGet, LinearSliceSet } from './linear-slice-contract'
import { clampLinearIssueListLimit } from '../../../../../shared/linear/issue-read-limits'
import { linearListProjectIssues } from '@/runtime/runtime-linear-project-client'
import {
  collectionWithWorkspaceError,
  emptyLinearCollection,
  evictStaleEntries,
  largestCachedCollectionBelowLimit,
  linearCollectionCacheKey
} from './linear-cache'
import { inflightProjectIssueRequests } from './linear-slice-request-state'
import { getLinearReadScope, scopedLinearCacheKey } from './linear-slice-scope'
import { openStoreLinearIssueRead } from './linear-issue-read-actions'

export function createLinearProjectIssueActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<LinearSlice, 'listLinearProjectIssues'> {
  return {
    listLinearProjectIssues: (projectId, workspaceId, limit = 20, options) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const effectiveLimit = clampLinearIssueListLimit(limit)
      const key = scopedLinearCacheKey(
        scope,
        linearCollectionCacheKey(workspaceId, 'project-issues', projectId, effectiveLimit)
      )
      return openStoreLinearIssueRead({
        set,
        scope,
        key,
        workspaceId,
        get,
        force: options?.force,
        requests: inflightProjectIssueRequests,
        cached: get().linearProjectIssueCache[key],
        dispatch: (force) =>
          linearListProjectIssues(scope.settings, projectId, effectiveLimit, workspaceId, {
            force: force || options?.force
          }).catch((error: unknown) => {
            console.warn('[linear] listLinearProjectIssues failed:', error)
            const fallback =
              get().linearProjectIssueCache[key]?.data ??
              largestCachedCollectionBelowLimit(
                get().linearProjectIssueCache,
                workspaceId,
                'project-issues',
                projectId,
                effectiveLimit,
                scope.cachePrefix
              ) ??
              emptyLinearCollection()
            return collectionWithWorkspaceError(fallback, workspaceId, error)
          }),
        publish: (data) =>
          set((state) => ({
            linearProjectIssueCache: evictStaleEntries({
              ...state.linearProjectIssueCache,
              [key]: { data, fetchedAt: data.errors?.length ? 0 : Date.now() }
            })
          }))
      })
    }
  }
}
