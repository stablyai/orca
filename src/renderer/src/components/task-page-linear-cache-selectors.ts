import type { CacheEntry } from '@/store/slices/github'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { LinearCollectionResult } from '../../../shared/linear/workspace-types'
import { sortedStrings } from './task-page-work-item-signatures'

type LinearIssueCache = Record<string, CacheEntry<LinearIssue>>
type LinearSearchCache = Record<string, CacheEntry<LinearIssue[]>>
type LinearListCache = Record<string, CacheEntry<LinearCollectionResult<LinearIssue>>>
type LinearCacheKind = 'issue' | 'search' | 'list'

function linearCacheKeyMatchesScope(
  key: string,
  kind: LinearCacheKind,
  cacheScope: string | null | undefined
): boolean {
  if (cacheScope === undefined) {
    return true
  }
  if (cacheScope) {
    return key.startsWith(`${cacheScope}::`)
  }
  const parts = key.split('::')
  return kind === 'issue' ? parts.length <= 2 : parts[1] === kind
}

function linearIssueKey(issue: LinearIssue): string {
  return issue.id
}

function linearIssueStatusSignature(issue: LinearIssue): string {
  return JSON.stringify([
    issue.identifier,
    issue.title,
    issue.url,
    issue.state.name,
    issue.state.type,
    issue.state.color,
    issue.team.id,
    issue.team.name,
    issue.team.key,
    sortedStrings(issue.labels),
    sortedStrings(issue.labelIds),
    issue.assignee?.id ?? null,
    issue.assignee?.displayName ?? null,
    issue.priority,
    issue.updatedAt
  ])
}

export function shouldReplaceTaskPageLinearIssuesAfterRefresh(
  currentIssues: readonly LinearIssue[],
  refreshedIssues: readonly LinearIssue[]
): boolean {
  if (currentIssues.length !== refreshedIssues.length) {
    return true
  }
  const currentKeys = new Set(currentIssues.map(linearIssueKey))
  return refreshedIssues.some((issue) => !currentKeys.has(linearIssueKey(issue)))
}

export function reconcileTaskPageLinearIssuesAfterLandingRefresh(
  currentIssues: readonly LinearIssue[],
  refreshedIssues: readonly LinearIssue[]
): LinearIssue[] {
  if (shouldReplaceTaskPageLinearIssuesAfterRefresh(currentIssues, refreshedIssues)) {
    return [...refreshedIssues]
  }
  const refreshedByKey = new Map(refreshedIssues.map((issue) => [linearIssueKey(issue), issue]))
  let changed = false
  const next = currentIssues.map((issue) => {
    const refreshed = refreshedByKey.get(linearIssueKey(issue))
    if (!refreshed || linearIssueStatusSignature(issue) === linearIssueStatusSignature(refreshed)) {
      return issue
    }
    changed = true
    return refreshed
  })
  return changed ? next : (currentIssues as LinearIssue[])
}

export function findTaskPageLinearIssue(
  linearIssueCache: LinearIssueCache,
  linearSearchCache: LinearSearchCache,
  linearListCache: LinearListCache,
  linearIssueId: string | null,
  cacheScope?: string | null
): LinearIssue | null {
  if (!linearIssueId) {
    return null
  }
  for (const [key, entry] of Object.entries(linearIssueCache)) {
    if (!linearCacheKeyMatchesScope(key, 'issue', cacheScope)) {
      continue
    }
    if (entry?.data?.id === linearIssueId) {
      return entry.data
    }
  }
  for (const [key, entry] of Object.entries(linearSearchCache)) {
    if (!linearCacheKeyMatchesScope(key, 'search', cacheScope)) {
      continue
    }
    const found = entry?.data?.find((issue) => issue.id === linearIssueId)
    if (found) {
      return found
    }
  }
  for (const [key, entry] of Object.entries(linearListCache)) {
    if (!linearCacheKeyMatchesScope(key, 'list', cacheScope)) {
      continue
    }
    const found = entry?.data?.items.find((issue) => issue.id === linearIssueId)
    if (found) {
      return found
    }
  }
  return null
}

export const findTaskPageLinearDrawerIssue = findTaskPageLinearIssue
