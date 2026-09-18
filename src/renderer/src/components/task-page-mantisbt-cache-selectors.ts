import type { CacheEntry } from '@/store/github/cache-model'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { MantisBTIssue } from '../../../shared/mantisbt-types'

type MantisBTIssueCache = Record<string, CacheEntry<MantisBTIssue>>
type MantisBTSearchCache = Record<string, CacheEntry<MantisBTIssue[]>>

export type TaskPageMantisBTIssueLookupOptions = {
  sourceContext?: TaskSourceContext | null
  siteId?: string | null
}

export function findTaskPageMantisBTIssue(
  mantisBTIssueCache: MantisBTIssueCache,
  mantisBTSearchCache: MantisBTSearchCache,
  mantisBTIssueId: string | null,
  options: TaskPageMantisBTIssueLookupOptions = {}
): MantisBTIssue | null {
  if (!mantisBTIssueId) {
    return null
  }
  const sourceScope =
    options.sourceContext?.provider === 'mantisBT'
      ? getTaskSourceCacheScope(options.sourceContext)
      : null
  const matchesLookup = (cacheKey: string, issue: MantisBTIssue | null | undefined): boolean => {
    if (!issue || issue.id !== mantisBTIssueId) {
      return false
    }
    if (options.siteId && issue.siteId !== options.siteId) {
      return false
    }
    // Why: MantisBT issue ids are only unique within one site, so drawer lookup
    // must not borrow a same-id issue cached for another host/account.
    return sourceScope === null || cacheKey.startsWith(`${sourceScope}::`)
  }

  for (const [cacheKey, entry] of Object.entries(mantisBTIssueCache)) {
    if (matchesLookup(cacheKey, entry?.data)) {
      return entry.data
    }
  }

  for (const [cacheKey, entry] of Object.entries(mantisBTSearchCache)) {
    const found = entry?.data?.find((issue) => matchesLookup(cacheKey, issue))
    if (found) {
      return found
    }
  }

  return null
}
