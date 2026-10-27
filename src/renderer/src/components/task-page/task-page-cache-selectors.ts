import { workItemsCacheKey } from '@/store/github/cache-identity'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type {
  CacheEntry,
  WorkItemsCacheError,
  WorkItemsCacheSources
} from '@/store/github/cache-model'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import {
  taskPageWorkItemKey,
  taskPageWorkItemStatusSignature,
  taskPageWorkItemKeyOrderSignature,
  taskPageWorkItemPaginationBoundary
} from './task-page-work-item-signatures'

export type TaskPageRepoCacheInput = {
  id: string
  path: string
  executionHostId?: string | null
  connectionId?: string | null
  sourceCacheScope?: string | null
}

export type TaskPageDialogWorkItemKey = {
  id: string
  repoId: string
  url: string
  repoHostId?: GitHubWorkItem['repoHostId']
} | null

export type TaskPageRepoSourceState = {
  repoId: string
  repoPath: string
  /** The row's host: a twin's two rows share repoId and can share repoPath. */
  hostId: ExecutionHostId
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

// Why canonical: the fetch keys by the row's execution host, and an SSH row may carry only connectionId.
function taskPageRepoCacheScope(repo: TaskPageRepoCacheInput): string {
  return repo.sourceCacheScope ?? getRepoExecutionHostId(repo)
}

export function selectTaskPageWorkItemsCacheEntries(
  workItemsCache: WorkItemsCache,
  repos: readonly TaskPageRepoCacheInput[],
  limit: number,
  query: string
): (CacheEntry<readonly GitHubWorkItem[]> | undefined)[] {
  return repos.map(
    (repo) => workItemsCache[workItemsCacheKey(repo.id, limit, query, taskPageRepoCacheScope(repo))]
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
      hostId: getRepoExecutionHostId(repo),
      sourceKey: `${repo.id}::${taskPageRepoCacheScope(repo)}`,
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

/** Surface fetched both-null sources as unresolved; null means unfetched, and a non-null source can have genuine zero results. */
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

export function reconcileTaskPagePagesWithWorkItemsCache(
  pages: TaskPageWorkItemPages,
  entries: readonly (CacheEntry<readonly GitHubWorkItem[]> | undefined)[]
): (GitHubWorkItem[] | null)[] {
  const cachedItems = new Map<string, GitHubWorkItem>()
  for (const entry of entries) {
    for (const item of entry?.data ?? []) {
      cachedItems.set(taskPageWorkItemKey(item), item)
    }
  }

  let changed = false
  const nextPages = pages.map((page) => {
    if (!page) {
      return null
    }
    let pageChanged = false
    const nextPage = page.map((item) => {
      const cached = cachedItems.get(taskPageWorkItemKey(item))
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
      (wi) =>
        wi.id === dialogWorkItemKey.id &&
        wi.repoId === dialogWorkItemKey.repoId &&
        wi.url === dialogWorkItemKey.url &&
        // Why: a twin's other host caches the same PR; its copy routes edits to that host.
        (!dialogWorkItemKey.repoHostId || wi.repoHostId === dialogWorkItemKey.repoHostId)
    )
    if (found) {
      return found
    }
  }
  return null
}
