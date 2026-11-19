import type { CacheEntry } from '@/store/github/cache/cache-model'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../../shared/work-items/task-source-context'
import type { JiraIssue } from '../../../../../../shared/jira/jira-types'

type JiraIssueCache = Record<string, CacheEntry<JiraIssue>>
type JiraSearchCache = Record<string, CacheEntry<JiraIssue[]>>

export type TaskPageJiraIssueLookupOptions = {
  sourceContext?: TaskSourceContext | null
  siteId?: string | null
}

export function findTaskPageJiraIssue(
  jiraIssueCache: JiraIssueCache,
  jiraSearchCache: JiraSearchCache,
  jiraIssueKey: string | null,
  options: TaskPageJiraIssueLookupOptions = {}
): JiraIssue | null {
  if (!jiraIssueKey) {
    return null
  }
  const sourceScope =
    options.sourceContext?.provider === 'jira'
      ? getTaskSourceCacheScope(options.sourceContext)
      : null
  const matchesLookup = (
    cacheKey: string,
    issue: JiraIssue | null | undefined
  ): issue is JiraIssue => {
    if (!issue || issue.key !== jiraIssueKey) {
      return false
    }
    if (options.siteId && issue.siteId !== options.siteId) {
      return false
    }
    // Scope drawer lookup by site/source so identical issue keys cannot borrow another host/account’s cache.
    return sourceScope === null || cacheKey.startsWith(`${sourceScope}::`)
  }

  // Why: entries for older searches outlive their TTL, so the first match can be a stale copy.
  // Keep the most recently updated copy; ties keep the issue cache first, which carries optimistic edits.
  let newest: JiraIssue | null = null
  let newestTime = Number.NEGATIVE_INFINITY
  const consider = (issue: JiraIssue): void => {
    const time = Date.parse(issue.updatedAt)
    const comparable = Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time
    if (newest === null || comparable > newestTime) {
      newest = issue
      newestTime = comparable
    }
  }

  for (const [cacheKey, entry] of Object.entries(jiraIssueCache)) {
    const cached = entry?.data
    if (matchesLookup(cacheKey, cached)) {
      consider(cached)
    }
  }

  for (const [cacheKey, entry] of Object.entries(jiraSearchCache)) {
    const found = entry?.data?.find((issue) => matchesLookup(cacheKey, issue))
    if (found) {
      consider(found)
    }
  }

  return newest
}
