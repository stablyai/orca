import type { ClickUpTask } from '../../../../shared/clickup-types'
import type { CacheEntry } from './github'

// Why: an explicit marker keeps the local runtime scope distinct from every task-source scope.
export const CLICKUP_DEFAULT_CACHE_SCOPE = '__clickup_default_scope__'

function cacheKeyMatchesScope(key: string, cachePrefix: string | null): boolean {
  return key.startsWith(`${cachePrefix ?? CLICKUP_DEFAULT_CACHE_SCOPE}::`)
}

export function patchClickUpTaskCache(
  cache: Record<string, CacheEntry<ClickUpTask>>,
  taskId: string,
  patch: Partial<ClickUpTask>,
  cachePrefix: string | null
): Record<string, CacheEntry<ClickUpTask>> {
  return Object.fromEntries(
    Object.entries(cache).map(([key, entry]) => {
      if (!cacheKeyMatchesScope(key, cachePrefix) || !entry.data || entry.data.id !== taskId) {
        return [key, entry]
      }
      return [key, { ...entry, data: { ...entry.data, ...patch } }]
    })
  )
}

export function patchClickUpTaskListCache(
  cache: Record<string, CacheEntry<ClickUpTask[]>>,
  taskId: string,
  patch: Partial<ClickUpTask>,
  cachePrefix: string | null
): Record<string, CacheEntry<ClickUpTask[]>> {
  return Object.fromEntries(
    Object.entries(cache).map(([key, entry]) => {
      if (!cacheKeyMatchesScope(key, cachePrefix) || !entry.data) {
        return [key, entry]
      }
      return [
        key,
        {
          ...entry,
          data: entry.data.map((task) => (task.id === taskId ? { ...task, ...patch } : task))
        }
      ]
    })
  )
}

export function patchClickUpCaches(
  caches: {
    clickUpTaskCache: Record<string, CacheEntry<ClickUpTask>>
    clickUpSearchCache: Record<string, CacheEntry<ClickUpTask[]>>
    clickUpListCache: Record<string, CacheEntry<ClickUpTask[]>>
  },
  taskId: string,
  patch: Partial<ClickUpTask>,
  cachePrefix: string | null
): typeof caches {
  return {
    clickUpTaskCache: patchClickUpTaskCache(caches.clickUpTaskCache, taskId, patch, cachePrefix),
    clickUpSearchCache: patchClickUpTaskListCache(
      caches.clickUpSearchCache,
      taskId,
      patch,
      cachePrefix
    ),
    clickUpListCache: patchClickUpTaskListCache(caches.clickUpListCache, taskId, patch, cachePrefix)
  }
}
