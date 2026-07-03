/* eslint-disable max-lines -- Why: TaskPage cache reconciliation helpers are
   kept together so list refresh and drawer lookup behavior stay consistent. */
import {
  workItemsCacheKey,
  type CacheEntry,
  type WorkItemsCacheError,
  type WorkItemsCacheSources
} from '@/store/slices/github'
import type { GitHubWorkItem, LinearCollectionResult, LinearIssue } from '../../../shared/types'

export type TaskPageRepoCacheInput = {
  id: string
  path: string
  executionHostId?: string | null
  sourceCacheScope?: string | null
}

export type TaskPageDialogWorkItemKey = {
  id: string
  repoId: string
} | null

export type TaskPageRepoSourceState = {
  repoId: string
  repoPath: string
  sourceKey: string
  sources: WorkItemsCacheSources | null
  error: WorkItemsCacheError | null
}

export type TaskPageWorkItemsFetchOptions = {
  force: boolean
  noCache: boolean
}

type WorkItemsCache = Record<string, CacheEntry<GitHubWorkItem[]>>
type LinearIssueCache = Record<string, CacheEntry<LinearIssue>>
type LinearSearchCache = Record<string, CacheEntry<LinearIssue[]>>
type LinearListCache = Record<string, CacheEntry<LinearCollectionResult<LinearIssue>>>

export function deriveTaskPageGitHubWorkItemsFetchOptions(
  forcedFetch: boolean,
  shouldProbeOnLanding: boolean
): TaskPageWorkItemsFetchOptions {
  return {
    force: forcedFetch || shouldProbeOnLanding,
    noCache: forcedFetch
  }
}

export function selectTaskPageWorkItemsCacheEntries(
  workItemsCache: WorkItemsCache,
  repos: readonly TaskPageRepoCacheInput[],
  limit: number,
  query: string
): (CacheEntry<GitHubWorkItem[]> | undefined)[] {
  return repos.map(
    (repo) =>
      workItemsCache[
        workItemsCacheKey(repo.id, limit, query, repo.sourceCacheScope ?? repo.executionHostId)
      ]
  )
}

export function buildTaskPageRepoSourceState(
  repos: readonly TaskPageRepoCacheInput[],
  entries: readonly (CacheEntry<GitHubWorkItem[]> | undefined)[]
): TaskPageRepoSourceState[] {
  return repos.map((repo, index) => {
    const entry = entries[index]
    return {
      repoId: repo.id,
      repoPath: repo.path,
      sourceKey: `${repo.id}::${repo.sourceCacheScope ?? repo.executionHostId ?? 'local'}`,
      sources: entry?.sources ?? null,
      error: entry?.error ?? null
    }
  })
}

function taskPageWorkItemCacheKey(item: GitHubWorkItem): string {
  return `${item.repoId}\u0000${item.id}`
}

export function reconcileTaskPagePagesWithWorkItemsCache(
  pages: readonly GitHubWorkItem[][],
  entries: readonly (CacheEntry<GitHubWorkItem[]> | undefined)[]
): GitHubWorkItem[][] {
  const cachedItems = new Map<string, GitHubWorkItem>()
  for (const entry of entries) {
    for (const item of entry?.data ?? []) {
      cachedItems.set(taskPageWorkItemCacheKey(item), item)
    }
  }

  let changed = false
  const nextPages = pages.map((page) => {
    let pageChanged = false
    const nextPage = page.map((item) => {
      const cached = cachedItems.get(taskPageWorkItemCacheKey(item))
      if (!cached || cached === item) {
        return item
      }
      pageChanged = true
      changed = true
      return cached
    })
    return pageChanged ? nextPage : page
  })

  return changed ? nextPages : (pages as GitHubWorkItem[][])
}

function taskPageWorkItemKey(item: GitHubWorkItem): string {
  return `${item.repoId}\u0000${item.id}`
}

function sortedStrings(values: readonly string[] | undefined): string {
  return [...(values ?? [])].sort().join('\u0000')
}

function sortedLogins(users: readonly { login: string | null | undefined }[] | undefined): string {
  return [...(users ?? [])]
    .map((user) => user.login ?? '')
    .sort()
    .join('\u0000')
}

function taskPageWorkItemStatusSignature(item: GitHubWorkItem): string {
  return JSON.stringify([
    item.type,
    item.number,
    item.title,
    item.state,
    item.url,
    item.author,
    item.branchName ?? null,
    item.baseRefName ?? null,
    sortedStrings(item.labels),
    sortedLogins(item.assignees),
    sortedLogins(item.reviewRequests),
    item.reviewDecision ?? null,
    item.checksSummary?.state ?? null,
    item.checksSummary?.total ?? null,
    item.checksSummary?.failed ?? null,
    item.checksSummary?.pending ?? null,
    item.mergeable ?? null,
    item.autoMergeEnabled ?? null,
    item.autoMergeAllowed ?? null,
    item.mergeQueueRequired ?? null,
    item.mergeStateStatus ?? null,
    item.updatedAt
  ])
}

function taskPageWorkItemKeyOrderSignature(items: readonly GitHubWorkItem[]): string {
  return items.map(taskPageWorkItemKey).join('\u0000')
}

function taskPageWorkItemPaginationBoundary(items: readonly GitHubWorkItem[]): string | null {
  return items.at(-1)?.updatedAt ?? null
}

export function shouldReplaceTaskPageItemsAfterRefresh(
  currentItems: readonly GitHubWorkItem[],
  refreshedItems: readonly GitHubWorkItem[]
): boolean {
  if (currentItems.length !== refreshedItems.length) {
    return true
  }
  const currentKeys = new Set(currentItems.map(taskPageWorkItemKey))
  for (const item of refreshedItems) {
    if (!currentKeys.has(taskPageWorkItemKey(item))) {
      return true
    }
  }
  return false
}

export function reconcileTaskPageItemsAfterLandingRefresh(
  currentItems: readonly GitHubWorkItem[],
  refreshedItems: readonly GitHubWorkItem[]
): GitHubWorkItem[] {
  if (shouldReplaceTaskPageItemsAfterRefresh(currentItems, refreshedItems)) {
    return [...refreshedItems]
  }

  const refreshedByKey = new Map(refreshedItems.map((item) => [taskPageWorkItemKey(item), item]))
  let changed = false
  const next = currentItems.map((item) => {
    const refreshed = refreshedByKey.get(taskPageWorkItemKey(item))
    if (
      !refreshed ||
      taskPageWorkItemStatusSignature(item) === taskPageWorkItemStatusSignature(refreshed)
    ) {
      return item
    }
    changed = true
    return refreshed
  })
  return changed ? next : (currentItems as GitHubWorkItem[])
}

export function shouldResetTaskPagePaginationAfterLandingRefresh(
  currentFirstPage: readonly GitHubWorkItem[],
  refreshedItems: readonly GitHubWorkItem[]
): boolean {
  if (shouldReplaceTaskPageItemsAfterRefresh(currentFirstPage, refreshedItems)) {
    return true
  }
  if (
    taskPageWorkItemKeyOrderSignature(currentFirstPage) !==
    taskPageWorkItemKeyOrderSignature(refreshedItems)
  ) {
    return true
  }
  return (
    taskPageWorkItemPaginationBoundary(currentFirstPage) !==
    taskPageWorkItemPaginationBoundary(refreshedItems)
  )
}

export function reconcileTaskPagePagesAfterLandingRefresh(
  pages: readonly GitHubWorkItem[][],
  refreshedItems: readonly GitHubWorkItem[]
): GitHubWorkItem[][] {
  const firstPage = pages[0] ?? []
  if (shouldResetTaskPagePaginationAfterLandingRefresh(firstPage, refreshedItems)) {
    return [[...refreshedItems]]
  }
  const nextFirstPage = reconcileTaskPageItemsAfterLandingRefresh(firstPage, refreshedItems)
  if (nextFirstPage === firstPage) {
    return pages as GitHubWorkItem[][]
  }
  return [nextFirstPage, ...pages.slice(1)]
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
  for (const issue of refreshedIssues) {
    if (!currentKeys.has(linearIssueKey(issue))) {
      return true
    }
  }
  return false
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

export function findTaskPageDialogWorkItem(
  workItemsCache: WorkItemsCache,
  dialogWorkItemKey: TaskPageDialogWorkItemKey
): GitHubWorkItem | null {
  if (!dialogWorkItemKey) {
    return null
  }

  for (const entry of Object.values(workItemsCache)) {
    const found = entry?.data?.find(
      (wi) => wi.id === dialogWorkItemKey.id && wi.repoId === dialogWorkItemKey.repoId
    )
    if (found) {
      return found
    }
  }
  return null
}

export function findTaskPageLinearIssue(
  linearIssueCache: LinearIssueCache,
  linearSearchCache: LinearSearchCache,
  linearListCache: LinearListCache,
  linearIssueId: string | null
): LinearIssue | null {
  if (!linearIssueId) {
    return null
  }
  for (const entry of Object.values(linearIssueCache)) {
    if (entry?.data?.id === linearIssueId) {
      return entry.data
    }
  }
  for (const entry of Object.values(linearSearchCache)) {
    const found = entry?.data?.find((issue) => issue.id === linearIssueId)
    if (found) {
      return found
    }
  }
  for (const entry of Object.values(linearListCache)) {
    const found = entry?.data?.items.find((issue) => issue.id === linearIssueId)
    if (found) {
      return found
    }
  }
  return null
}

export const findTaskPageLinearDrawerIssue = findTaskPageLinearIssue
