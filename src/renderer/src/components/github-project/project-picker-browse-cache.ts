import type { GitHubProjectSummary } from '../../../../shared/github-project-types'

export const PROJECT_PICKER_BROWSE_CACHE_TTL_MS = 5 * 60_000
export const PROJECT_PICKER_BROWSE_CACHE_MAX_ENTRIES = 32

type ProjectPickerBrowseCacheEntry = {
  fetchedAt: number
  projects: GitHubProjectSummary[]
  partialFailures?: { owner: string; message: string }[]
}

const browseCacheByRuntimeScope = new Map<string, ProjectPickerBrowseCacheEntry>()

function pruneExpiredProjectPickerBrowseCache(now: number): void {
  for (const [key, entry] of browseCacheByRuntimeScope) {
    if (now - entry.fetchedAt >= PROJECT_PICKER_BROWSE_CACHE_TTL_MS) {
      browseCacheByRuntimeScope.delete(key)
    }
  }
}

function trimProjectPickerBrowseCache(): void {
  while (browseCacheByRuntimeScope.size > PROJECT_PICKER_BROWSE_CACHE_MAX_ENTRIES) {
    const oldestKey = browseCacheByRuntimeScope.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    browseCacheByRuntimeScope.delete(oldestKey)
  }
}

export function peekProjectPickerBrowseCacheEntry(
  cacheKey: string,
  now = Date.now()
): ProjectPickerBrowseCacheEntry | null {
  const entry = browseCacheByRuntimeScope.get(cacheKey)
  if (!entry || now - entry.fetchedAt >= PROJECT_PICKER_BROWSE_CACHE_TTL_MS) {
    return null
  }
  return entry
}

export function getProjectPickerBrowseCacheEntry(
  cacheKey: string,
  now = Date.now()
): ProjectPickerBrowseCacheEntry | null {
  pruneExpiredProjectPickerBrowseCache(now)
  const entry = peekProjectPickerBrowseCacheEntry(cacheKey, now)
  if (!entry) {
    browseCacheByRuntimeScope.delete(cacheKey)
    return null
  }
  // Why: cache keys are runtime scopes; refresh recency so active runtimes do
  // not get evicted just because a user briefly tries many other runtimes.
  browseCacheByRuntimeScope.delete(cacheKey)
  browseCacheByRuntimeScope.set(cacheKey, entry)
  return entry
}

export function rememberProjectPickerBrowseCacheEntry(
  cacheKey: string,
  entry: Omit<ProjectPickerBrowseCacheEntry, 'fetchedAt'>,
  now = Date.now()
): void {
  pruneExpiredProjectPickerBrowseCache(now)
  browseCacheByRuntimeScope.delete(cacheKey)
  browseCacheByRuntimeScope.set(cacheKey, {
    ...entry,
    fetchedAt: now
  })
  trimProjectPickerBrowseCache()
}

/** @internal - exposed for leak-regression tests only */
export function _getProjectPickerBrowseCacheSizeForTest(): number {
  return browseCacheByRuntimeScope.size
}

/** @internal - exposed for leak-regression tests only */
export function _clearProjectPickerBrowseCacheForTest(): void {
  browseCacheByRuntimeScope.clear()
}
