import type { CacheEntry } from '@/store/slices/github'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { JiraIssue } from '../../../shared/types'

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
  const matchesLookup = (cacheKey: string, issue: JiraIssue | null | undefined): boolean => {
    if (!issue || issue.key !== jiraIssueKey) {
      return false
    }
    if (options.siteId && issue.siteId !== options.siteId) {
      return false
    }
    // Why: Jira issue keys are only unique within a site/source, so drawer lookup
    // must not borrow a same-key issue cached for another host/account.
    return sourceScope === null || cacheKey.startsWith(`${sourceScope}::`)
  }

  for (const [cacheKey, entry] of Object.entries(jiraIssueCache)) {
    if (matchesLookup(cacheKey, entry?.data)) {
      return entry.data
    }
  }

  for (const [cacheKey, entry] of Object.entries(jiraSearchCache)) {
    const found = entry?.data?.find((issue) => matchesLookup(cacheKey, issue))
    if (found) {
      return found
    }
  }

  return null
}
