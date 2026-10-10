import type { GitHubWorkItem } from '../../../shared/github/work-item-types'

export const TASK_PAGE_GITHUB_RESUME_CACHE_LIMIT = 5
export const TASK_PAGE_GITHUB_RESUME_CACHE_TTL_MS = 10 * 60_000
export const TASK_PAGE_GITHUB_RESUME_FRESH_MS = 30_000

type CachedPage<T> = {
  items: readonly T[]
  cachedAt: number
  lastAccessedAt: number
}

export type TaskPageResumeCachedPage<T> = {
  items: T[]
  cachedAt: number
}

type TaskPageResumePageCacheOptions = {
  maxEntries?: number
  ttlMs?: number
}

export function buildTaskPageGitHubResumeContextKey(args: {
  selectedReposKey: string
  query: string
  pageSize: number
}): string {
  return JSON.stringify(['github', 'items', args.selectedReposKey, args.query, args.pageSize])
}

export function createTaskPageResumePageCache<T>(options: TaskPageResumePageCacheOptions = {}): {
  read: (contextKey: string, page: number, now?: number) => TaskPageResumeCachedPage<T> | null
  write: (contextKey: string, page: number, items: readonly T[], now?: number) => void
  clear: () => void
  size: () => number
} {
  const maxEntries = options.maxEntries ?? TASK_PAGE_GITHUB_RESUME_CACHE_LIMIT
  const ttlMs = options.ttlMs ?? TASK_PAGE_GITHUB_RESUME_CACHE_TTL_MS
  const entries = new Map<string, CachedPage<T>>()
  const keyFor = (contextKey: string, page: number): string => `${contextKey}\u0000${page}`

  const pruneExpired = (now: number): void => {
    for (const [key, entry] of entries) {
      if (now - entry.lastAccessedAt >= ttlMs) {
        entries.delete(key)
      }
    }
  }

  return {
    read(contextKey, page, now = Date.now()) {
      pruneExpired(now)
      const key = keyFor(contextKey, page)
      const entry = entries.get(key)
      if (!entry) {
        return null
      }
      entries.delete(key)
      entries.set(key, { ...entry, lastAccessedAt: now })
      return { items: [...entry.items], cachedAt: entry.cachedAt }
    },
    write(contextKey, page, items, now = Date.now()) {
      pruneExpired(now)
      const key = keyFor(contextKey, page)
      entries.delete(key)
      entries.set(key, { items: [...items], cachedAt: now, lastAccessedAt: now })
      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value
        if (oldestKey === undefined) {
          break
        }
        entries.delete(oldestKey)
      }
    },
    clear() {
      entries.clear()
    },
    size() {
      return entries.size
    }
  }
}

export const taskPageGitHubResumeCache = createTaskPageResumePageCache<GitHubWorkItem>()
