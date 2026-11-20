import type { CacheEntry } from '@/store/github/cache/cache-model'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../../shared/work-items/task-source-context'
import type { JiraIssue } from '../../../../../../shared/jira/jira-types'

type JiraIssueCache = Record<string, CacheEntry<JiraIssue>>
type JiraSearchCache = Record<string, CacheEntry<JiraIssue[]>>
type CachedJiraIssueCopy = { cacheKey: string; issue: JiraIssue }

export type TaskPageJiraIssueLookupOptions = {
  sourceContext?: TaskSourceContext | null
  siteId?: string | null
}

const copiesBySnapshot = new WeakMap<
  JiraIssueCache,
  WeakMap<JiraSearchCache, Map<string, CachedJiraIssueCopy[]>>
>()

// Why: the list looks up every row per cache change; one pass per snapshot keeps that linear.
function cachedJiraIssueCopies(
  jiraIssueCache: JiraIssueCache,
  jiraSearchCache: JiraSearchCache
): Map<string, CachedJiraIssueCopy[]> {
  let bySearchCache = copiesBySnapshot.get(jiraIssueCache)
  if (!bySearchCache) {
    bySearchCache = new WeakMap()
    copiesBySnapshot.set(jiraIssueCache, bySearchCache)
  }
  const cached = bySearchCache.get(jiraSearchCache)
  if (cached) {
    return cached
  }
  const copies = new Map<string, CachedJiraIssueCopy[]>()
  const add = (cacheKey: string, issue: JiraIssue | null | undefined): void => {
    if (!issue) {
      return
    }
    const forKey = copies.get(issue.key)
    if (forKey) {
      forKey.push({ cacheKey, issue })
    } else {
      copies.set(issue.key, [{ cacheKey, issue }])
    }
  }
  for (const [cacheKey, entry] of Object.entries(jiraIssueCache)) {
    add(cacheKey, entry?.data)
  }
  for (const [cacheKey, entry] of Object.entries(jiraSearchCache)) {
    for (const issue of entry?.data ?? []) {
      add(cacheKey, issue)
    }
  }
  bySearchCache.set(jiraSearchCache, copies)
  return copies
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

  // Why: entries for older searches outlive their TTL, so the first match can be a stale copy.
  // Keep the most recently updated copy; optimistic edits are patched into every copy.
  let newest: JiraIssue | null = null
  let newestTime = Number.NEGATIVE_INFINITY
  for (const { cacheKey, issue } of cachedJiraIssueCopies(jiraIssueCache, jiraSearchCache).get(
    jiraIssueKey
  ) ?? []) {
    if (options.siteId && issue.siteId !== options.siteId) {
      continue
    }
    // Scope drawer lookup by site/source so identical issue keys cannot borrow another host/account’s cache.
    if (sourceScope !== null && !cacheKey.startsWith(`${sourceScope}::`)) {
      continue
    }
    const time = Date.parse(issue.updatedAt)
    const comparable = Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time
    if (newest === null || comparable > newestTime) {
      newest = issue
      newestTime = comparable
    }
  }
  return newest
}

export function resolveTaskPageJiraIssues(
  issues: JiraIssue[],
  jiraIssueCache: JiraIssueCache,
  jiraSearchCache: JiraSearchCache,
  options: Pick<TaskPageJiraIssueLookupOptions, 'sourceContext'> = {}
): JiraIssue[] {
  return issues.map((issue) => {
    const cached = findTaskPageJiraIssue(jiraIssueCache, jiraSearchCache, issue.key, {
      ...options,
      siteId: issue.siteId
    })
    if (!cached) {
      return issue
    }
    const fetchedTime = Date.parse(issue.updatedAt)
    const cachedTime = Date.parse(cached.updatedAt)
    return !Number.isNaN(fetchedTime) && (Number.isNaN(cachedTime) || fetchedTime > cachedTime)
      ? issue
      : cached
  })
}
