import {
  workItemsCacheKey,
  type CacheEntry,
  type WorkItemsCacheError,
  type WorkItemsCacheSources
} from '@/store/slices/github'
import type { GitHubWorkItem, LinearIssue } from '../../../shared/types'

export type TaskPageRepoCacheInput = {
  id: string
  path: string
}

export type TaskPageDialogWorkItemKey = {
  id: string
  repoId: string
} | null

export type TaskPageRepoSourceState = {
  repoId: string
  repoPath: string
  sources: WorkItemsCacheSources | null
  error: WorkItemsCacheError | null
}

type WorkItemsCache = Record<string, CacheEntry<GitHubWorkItem[]>>
type LinearIssueCache = Record<string, CacheEntry<LinearIssue>>
type LinearSearchCache = Record<string, CacheEntry<LinearIssue[]>>

export function selectTaskPageWorkItemsCacheEntries(
  workItemsCache: WorkItemsCache,
  repos: readonly TaskPageRepoCacheInput[],
  limit: number,
  query: string
): (CacheEntry<GitHubWorkItem[]> | undefined)[] {
  return repos.map((repo) => workItemsCache[workItemsCacheKey(repo.path, limit, query)])
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
      sources: entry?.sources ?? null,
      error: entry?.error ?? null
    }
  })
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

  return null
}

export const findTaskPageLinearDrawerIssue = findTaskPageLinearIssue
