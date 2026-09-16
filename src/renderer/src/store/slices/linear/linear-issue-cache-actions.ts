import { clampLinearIssueListLimit } from '../../../../../shared/linear/issue-read-limits'
import type {
  LinearIssueListReadArgs,
  LinearIssueReadArgs,
  LinearSlice,
  LinearSliceGet,
  LinearSliceSet,
  LinearFetchOptions
} from './linear-slice-contract'
import {
  getSelectedWorkspaceId,
  isFresh,
  linearListCacheKey,
  linearSearchCacheKey
} from './linear-cache'
import {
  getLinearMutationGeneration,
  inflightListRequests,
  inflightSearchRequests
} from './linear-slice-request-state'
import {
  getLinearReadScope,
  normalizeListAttributeFilter,
  scopedLinearCacheKey
} from './linear-slice-scope'

export function createLinearIssueCacheActions(
  _set: LinearSliceSet,
  get: LinearSliceGet
): Pick<LinearSlice, 'getCachedLinearIssues' | 'prefetchLinearIssues'> {
  return {
    getCachedLinearIssues: (args: LinearIssueReadArgs, options) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const workspaceId = getSelectedWorkspaceId(get().linearStatus)
      if (args.kind === 'search') {
        const cacheKey = scopedLinearCacheKey(
          scope,
          linearSearchCacheKey(workspaceId, args.query, args.limit ?? 20)
        )
        return get().linearSearchCache[cacheKey]?.data ?? null
      }
      const limit = clampLinearIssueListLimit(args.limit)
      const attributeFilter = normalizeListAttributeFilter(args.attributeFilter)
      const cacheKey = scopedLinearCacheKey(
        scope,
        linearListCacheKey(workspaceId, args.filter ?? 'assigned', limit, attributeFilter)
      )
      return get().linearListCache[cacheKey]?.data ?? null
    },

    prefetchLinearIssues: (args: LinearIssueReadArgs, options?: LinearFetchOptions) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const { contextKey } = scope
      const workspaceId = getSelectedWorkspaceId(get().linearStatus)
      if (args.kind === 'search') {
        const limit = args.limit ?? 20
        const cacheKey = scopedLinearCacheKey(
          scope,
          linearSearchCacheKey(workspaceId, args.query, limit)
        )
        const inflight = inflightSearchRequests.get(cacheKey)
        if (
          isFresh(get().linearSearchCache[cacheKey]) ||
          (inflight &&
            inflight.contextKey === contextKey &&
            inflight.mutationGeneration === getLinearMutationGeneration())
        ) {
          return
        }
        void get()
          .searchLinearIssues(args.query, limit, options)
          .catch(() => {})
        return
      }
      const limit = clampLinearIssueListLimit(args.limit)
      const attributeFilter = normalizeListAttributeFilter(args.attributeFilter)
      const listArgs: LinearIssueListReadArgs = {
        kind: 'list',
        filter: args.filter,
        limit,
        attributeFilter
      }
      const cacheKey = scopedLinearCacheKey(
        scope,
        linearListCacheKey(workspaceId, args.filter ?? 'assigned', limit, attributeFilter)
      )
      const inflight = inflightListRequests.get(cacheKey)
      if (
        isFresh(get().linearListCache[cacheKey]) ||
        (inflight &&
          inflight.contextKey === contextKey &&
          inflight.mutationGeneration === getLinearMutationGeneration())
      ) {
        return
      }
      void get()
        .listLinearIssues(listArgs, options)
        .catch(() => {})
    }
  }
}
