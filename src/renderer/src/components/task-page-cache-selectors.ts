import {
  workItemsCacheKey,
  type CacheEntry,
  type WorkItemsCacheError,
  type WorkItemsCacheSources
} from '@/store/slices/github'
import type { GitHubWorkItem } from '../../../shared/types'
import {
  taskPageWorkItemKey,
  taskPageWorkItemStatusSignature,
  taskPageWorkItemKeyOrderSignature,
  taskPageWorkItemPaginationBoundary
} from './task-page-work-item-signatures'
export {
  findTaskPageLinearDrawerIssue,
  findTaskPageLinearIssue,
  reconcileTaskPageLinearIssuesAfterLandingRefresh,
  shouldReplaceTaskPageLinearIssuesAfterRefresh
} from './task-page-linear-cache-selectors'

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

type WorkItemsCache = Record<string, CacheEntry<readonly GitHubWorkItem[]>>
export type TaskPageWorkItemPages = readonly (GitHubWorkItem[] | null)[]

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
): (CacheEntry<readonly GitHubWorkItem[]> | undefined)[] {
  return repos.map(
    (repo) =>
      workItemsCache[
        workItemsCacheKey(repo.id, limit, query, repo.sourceCacheScope ?? repo.executionHostId)
      ]
  )
}

export function buildTaskPageRepoSourceState(
  repos: readonly TaskPageRepoCacheInput[],
  entries: readonly (CacheEntry<readonly GitHubWorkItem[]> | undefined)[]
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

export type TaskPageUnresolvedSourceRepo = {
  repoId: string
  sourceKey: string
  label: string
}

/**
 * Select the fetched repos that resolved neither an issue nor a PR GitHub source.
 *
 * Why: since #9660 an unresolvable source returns an empty null-source envelope
 * instead of an unscoped search. That empty is otherwise indistinguishable from a
 * genuine zero-result query, so surface these repos to the user. The three states
 * are told apart purely by `sources`: present-but-both-null = unresolved (this
 * function), a non-null side = resolved (genuine zero), `null` = not yet fetched.
 */
export function selectTaskPageUnresolvedSourceRepos(
  repos: readonly { id: string; displayName?: string; path: string }[],
  sourceState: readonly TaskPageRepoSourceState[]
): TaskPageUnresolvedSourceRepo[] {
  const stateByRepoId = new Map(sourceState.map((state) => [state.repoId, state]))
  const unresolved: TaskPageUnresolvedSourceRepo[] = []
  for (const repo of repos) {
    const state = stateByRepoId.get(repo.id)
    if (state?.sources && !state.sources.issues && !state.sources.prs && !state.error) {
      unresolved.push({
        repoId: repo.id,
        sourceKey: state.sourceKey,
        label: repo.displayName ?? repo.path
      })
    }
  }
  return unresolved
}

function taskPageWorkItemCacheKey(item: GitHubWorkItem): string {
  return `${item.repoId}\u0000${item.id}`
}

export function reconcileTaskPagePagesWithWorkItemsCache(
  pages: TaskPageWorkItemPages,
  entries: readonly (CacheEntry<readonly GitHubWorkItem[]> | undefined)[]
): (GitHubWorkItem[] | null)[] {
  const cachedItems = new Map<string, GitHubWorkItem>()
  for (const entry of entries) {
    for (const item of entry?.data ?? []) {
      cachedItems.set(taskPageWorkItemCacheKey(item), item)
    }
  }

  let changed = false
  const nextPages = pages.map((page) => {
    if (!page) {
      return null
    }
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

  return changed ? nextPages : (pages as (GitHubWorkItem[] | null)[])
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
  pages: TaskPageWorkItemPages,
  refreshedItems: readonly GitHubWorkItem[]
): (GitHubWorkItem[] | null)[] {
  const firstPage = pages[0] ?? []
  if (shouldResetTaskPagePaginationAfterLandingRefresh(firstPage, refreshedItems)) {
    return [[...refreshedItems]]
  }
  const nextFirstPage = reconcileTaskPageItemsAfterLandingRefresh(firstPage, refreshedItems)
  if (nextFirstPage === firstPage) {
    return pages as (GitHubWorkItem[] | null)[]
  }
  return [nextFirstPage, ...pages.slice(1)]
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
