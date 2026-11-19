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

function visitTaskPageJiraIssues(
  jiraIssueCache: JiraIssueCache,
  jiraSearchCache: JiraSearchCache,
  options: TaskPageJiraIssueLookupOptions,
  visit: (issue: JiraIssue) => void
): void {
  const sourceScope =
    options.sourceContext?.provider === 'jira'
      ? `${getTaskSourceCacheScope(options.sourceContext)}::`
      : null
  const matchesScope = (cacheKey: string): boolean =>
    sourceScope === null || cacheKey.startsWith(sourceScope)
  const consider = (issue: JiraIssue | null | undefined): void => {
    if (issue && (!options.siteId || issue.siteId === options.siteId)) {
      visit(issue)
    }
  }
  for (const [cacheKey, entry] of Object.entries(jiraIssueCache)) {
    if (matchesScope(cacheKey)) {
      consider(entry?.data)
    }
  }
  for (const [cacheKey, entry] of Object.entries(jiraSearchCache)) {
    if (matchesScope(cacheKey)) {
      entry?.data?.forEach(consider)
    }
  }
}

function newestJiraIssue(current: JiraIssue | null, candidate: JiraIssue): JiraIssue {
  const timestamp = (issue: JiraIssue): number => {
    const time = Date.parse(issue.updatedAt)
    return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time
  }
  return current === null || timestamp(candidate) > timestamp(current) ? candidate : current
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
  let newest: JiraIssue | null = null
  visitTaskPageJiraIssues(jiraIssueCache, jiraSearchCache, options, (issue) => {
    if (issue.key === jiraIssueKey) {
      newest = newestJiraIssue(newest, issue)
    }
  })
  return newest
}

export function resolveTaskPageJiraIssues(
  issues: JiraIssue[],
  jiraIssueCache: JiraIssueCache,
  jiraSearchCache: JiraSearchCache,
  options: Pick<TaskPageJiraIssueLookupOptions, 'sourceContext'> = {}
): JiraIssue[] {
  if (issues.length === 0) {
    return issues
  }
  const identity = (key: string, siteId?: string): string => JSON.stringify([siteId ?? null, key])
  const newest = new Map<string, JiraIssue | null>(
    issues.map((issue) => [identity(issue.key, issue.siteId), null])
  )
  const consider = (key: string, issue: JiraIssue): void => {
    if (newest.has(key)) {
      newest.set(key, newestJiraIssue(newest.get(key) ?? null, issue))
    }
  }
  visitTaskPageJiraIssues(jiraIssueCache, jiraSearchCache, options, (issue) => {
    consider(identity(issue.key, issue.siteId), issue)
    if (issue.siteId) {
      consider(identity(issue.key), issue)
    }
  })
  return issues.map((issue) =>
    newestJiraIssue(newest.get(identity(issue.key, issue.siteId)) ?? null, issue)
  )
}
