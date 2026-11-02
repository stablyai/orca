import { clampLinearIssueListLimit } from '../../../../../shared/linear/issue-read-limits'
import type {
  LinearIssueReadArgs,
  LinearSlice,
  LinearSliceGet,
  LinearSliceSet,
  LinearFetchOptions
} from './linear-slice-contract'
import { getSelectedWorkspaceId, linearListCacheKey, linearSearchCacheKey } from './linear-cache'
import { consumeLinearIssueRead } from './linear-issue-publication'
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
      const workspaceId = getSelectedWorkspaceId(get().linearStatus, options)
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
      const complete =
        args.kind === 'search'
          ? consumeLinearIssueRead(get().searchLinearIssues(args.query, args.limit, options))
          : consumeLinearIssueRead(get().listLinearIssues(args, options))
      void complete.catch(() => {})
    }
  }
}
