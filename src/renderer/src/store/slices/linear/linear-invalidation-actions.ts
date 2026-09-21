import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type {
  LinearFetchOptions,
  LinearSlice,
  LinearSliceGet,
  LinearSliceSet
} from './linear-slice-contract'
import {
  LINEAR_LIST_INVALIDATION_VERSION_CAP,
  linearListInvalidationToken,
  patchLinearIssueCollectionCache,
  setLinearListInvalidationToken
} from './linear-cache'
import { inflightListRequests } from './linear-slice-request-state'
import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'
import { getLinearReadScope } from './linear-slice-scope'

export function createLinearInvalidationActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<LinearSlice, 'invalidateLinearIssueLists' | 'patchLinearIssue'> {
  return {
    invalidateLinearIssueLists: (options?: Pick<LinearFetchOptions, 'sourceContext'>) => {
      const scope = getLinearReadScope(get().settings, options?.sourceContext)
      const tokenScope = scope.cachePrefix ?? 'local'
      const nextVersion =
        linearListInvalidationToken.scope === tokenScope
          ? (linearListInvalidationToken.version + 1) % LINEAR_LIST_INVALIDATION_VERSION_CAP || 1
          : 1
      const nextToken = { scope: tokenScope, version: nextVersion }
      setLinearListInvalidationToken(nextToken)

      // Why: drop only attribute-filtered plain list entries in this source scope
      // so the next TaskPage read is forced current without wiping search/unrelated
      // collections.
      set((s) => {
        const nextListCache = { ...s.linearListCache }
        let changed = false
        for (const key of Object.keys(nextListCache)) {
          const parts = key.split('::')
          // Cache keys end with the attribute signature; unfiltered entries end empty.
          const attributeSignature = parts.at(-1) ?? ''
          if (!attributeSignature) {
            continue
          }
          if (scope.cachePrefix) {
            if (!key.startsWith(`${scope.cachePrefix}::`)) {
              continue
            }
          } else if (parts[1] !== 'list') {
            // Why: unscoped invalidation must not touch other runtimes' scoped list keys.
            continue
          }
          delete nextListCache[key]
          inflightListRequests.delete(key)
          changed = true
        }
        if (!changed) {
          return { linearListInvalidationToken: nextToken }
        }
        return {
          linearListCache: nextListCache,
          linearListInvalidationToken: nextToken
        }
      })
    },

    patchLinearIssue: (issueId: string, patch: Partial<LinearIssue>, options) => {
      const sourceScope =
        options?.sourceContext?.provider === 'linear'
          ? getTaskSourceCacheScope(options.sourceContext)
          : null
      const canPatchCacheKey = (key: string): boolean =>
        sourceScope === null || key.startsWith(`${sourceScope}::`)
      set((s) => {
        let changed = false

        const nextIssueCache = { ...s.linearIssueCache }
        for (const [key, issueEntry] of Object.entries(nextIssueCache)) {
          if (!canPatchCacheKey(key) || issueEntry?.data?.id !== issueId) {
            continue
          }
          // Why: set fetchedAt to 0 so the next fetchLinearIssue call
          // actually hits IPC instead of returning the stale optimistic data.
          nextIssueCache[key] = {
            ...issueEntry,
            data: { ...issueEntry.data, ...patch },
            fetchedAt: 0
          }
          changed = true
        }

        const nextSearchCache = { ...s.linearSearchCache }
        for (const key of Object.keys(nextSearchCache)) {
          const entry = nextSearchCache[key]
          if (!canPatchCacheKey(key) || !entry?.data) {
            continue
          }
          const idx = entry.data.findIndex((item) => item.id === issueId)
          if (idx === -1) {
            continue
          }
          const updatedItems = [...entry.data]
          updatedItems[idx] = { ...updatedItems[idx], ...patch }
          nextSearchCache[key] = { ...entry, data: updatedItems }
          changed = true
        }

        const nextListCache = patchLinearIssueCollectionCache(
          s.linearListCache,
          issueId,
          patch,
          canPatchCacheKey
        )
        if (nextListCache.changed) {
          changed = true
        }

        const nextProjectIssueCache = patchLinearIssueCollectionCache(
          s.linearProjectIssueCache,
          issueId,
          patch,
          canPatchCacheKey
        )
        if (nextProjectIssueCache.changed) {
          changed = true
        }

        const nextCustomViewIssueCache = patchLinearIssueCollectionCache(
          s.linearCustomViewIssueCache,
          issueId,
          patch,
          canPatchCacheKey
        )
        if (nextCustomViewIssueCache.changed) {
          changed = true
        }

        return changed
          ? {
              linearIssueCache: nextIssueCache,
              linearSearchCache: nextSearchCache,
              linearListCache: nextListCache.changed ? nextListCache.cache : s.linearListCache,
              linearProjectIssueCache: nextProjectIssueCache.changed
                ? nextProjectIssueCache.cache
                : s.linearProjectIssueCache,
              linearCustomViewIssueCache: nextCustomViewIssueCache.changed
                ? nextCustomViewIssueCache.cache
                : s.linearCustomViewIssueCache
            }
          : {}
      })
    }
  }
}
