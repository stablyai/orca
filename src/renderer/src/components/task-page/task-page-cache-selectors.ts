import { shallow } from 'zustand/shallow'
import { workItemsCacheKey } from '@/store/github/cache/cache-identity'
import { githubTaskBinding } from '@/lib/work-items/github/github-task-observation'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type {
  CacheEntry,
  WorkItemsCacheError,
  WorkItemsCacheSources
} from '@/store/github/cache/cache-model'
import type { GitHubWorkItem } from '../../../../shared/github/work-items/work-item-types'
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
  candidateOwner?: string
}

/** A store row, so its cache key binds from the row exactly as the fetch that wrote it did. */
export type TaskPageRepoCacheRowInput = Repo &
  Pick<TaskPageRepoCacheInput, 'sourceCacheScope' | 'candidateOwner'>

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

function taskPageRepoSourceKey(repo: TaskPageRepoCacheInput): string {
  return `${repo.id}::${taskPageRepoCacheScope(repo)}${repo.candidateOwner ? `::${repo.candidateOwner}` : ''}`
}

export type TaskPageRepoCacheRow = { sourceKey: string; cacheKey: string; binding?: string }

export function getTaskPageRepoCacheRows(
  repos: readonly TaskPageRepoCacheRowInput[],
  limit: number,
  query: string
): TaskPageRepoCacheRow[] {
  return repos.map((repo) => {
    const binding = githubTaskBinding(repo)
    return {
      sourceKey: taskPageRepoSourceKey(repo),
      binding,
      cacheKey: workItemsCacheKey(repo.id, limit, query, taskPageRepoCacheScope(repo), binding)
    }
  })
}

export function selectTaskPageWorkItemsCacheEntries(
  workItemsCache: WorkItemsCache,
  repos: readonly TaskPageRepoCacheRowInput[],
  limit: number,
  query: string
): (CacheEntry<readonly GitHubWorkItem[]> | undefined)[] {
  return getTaskPageRepoCacheRows(repos, limit, query).map((row) => workItemsCache[row.cacheKey])
}

type TaskPageWorkItemsCacheSelection = {
  current: (CacheEntry<readonly GitHubWorkItem[]> | undefined)[]
  /** Source displays only: rows, notices, errors and Retry read `current`. */
  display: (CacheEntry<readonly GitHubWorkItem[]> | undefined)[]
}

/**
 * Entries are keyed by query but sources are repo-level, so while a row's new query has no entry, source displays
 * keep reading (live) the row's last committed current entry. A present entry wins even when unresolved, and a
 * query the fetch rejects as too large claims nothing. Unchanged arrays are reused so subscribers skip renders.
 */
export function createTaskPageWorkItemsCacheSelector(
  rows: readonly TaskPageRepoCacheRow[],
  queryFetchable: boolean,
  getDisplayCacheKey: (sourceKey: string) => string | undefined,
  getCandidates?: (sourceKey: string) => CacheEntry<readonly GitHubWorkItem[]> | undefined
): (workItemsCache: WorkItemsCache) => TaskPageWorkItemsCacheSelection {
  let last: TaskPageWorkItemsCacheSelection = { current: [], display: [] }
  return (workItemsCache) => {
    const current: TaskPageWorkItemsCacheSelection['current'] = []
    const display: TaskPageWorkItemsCacheSelection['display'] = []
    for (const row of rows) {
      const entry = workItemsCache[row.cacheKey]
      current.push(entry)
      if (entry || !queryFetchable) {
        display.push(entry)
        continue
      }
      const displayKey = getDisplayCacheKey(row.sourceKey)
      const previous = displayKey === undefined ? undefined : workItemsCache[displayKey]
      display.push(
        previous && (!row.binding || previous.sourceBinding === row.binding)
          ? previous
          : getCandidates?.(row.sourceKey)
      )
    }
    const next = {
      current: shallow(current, last.current) ? last.current : current,
      display: shallow(display, last.display) ? last.display : display
    }
    if (next.current !== last.current || next.display !== last.display) {
      last = next
    }
    return last
  }
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
      sourceKey: taskPageRepoSourceKey(repo),
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
  repos: readonly (TaskPageRepoCacheInput & { displayName?: string })[],
  sourceState: readonly TaskPageRepoSourceState[]
): TaskPageUnresolvedSourceRepo[] {
  const stateBySourceKey = new Map(sourceState.map((state) => [state.sourceKey, state]))
  const unresolved: TaskPageUnresolvedSourceRepo[] = []
  for (const repo of repos) {
    const state = stateBySourceKey.get(taskPageRepoSourceKey(repo))
    if (
      state?.sources &&
      !state.sources.ineligible &&
      !state.sources.issues &&
      !state.sources.prs &&
      !state.error
    ) {
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
