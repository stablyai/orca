import type { CacheEntry } from './github'
import { CLICKUP_DEFAULT_CACHE_SCOPE } from './clickup-task-cache-patch'

const CACHE_TTL = 60_000
const MAX_CACHE_ENTRIES = 500

export function clickUpCacheKey(cachePrefix: string | null, key: string): string {
  return `${cachePrefix ?? CLICKUP_DEFAULT_CACHE_SCOPE}::${key}`
}

export function isFreshClickUpCacheEntry<T>(
  entry: CacheEntry<T> | undefined
): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < CACHE_TTL
}

export function evictStaleClickUpCacheEntries<T>(
  cache: Record<string, CacheEntry<T>>
): Record<string, CacheEntry<T>> {
  const keys = Object.keys(cache)
  if (keys.length <= MAX_CACHE_ENTRIES) {
    return cache
  }
  const keep = keys
    .sort((a, b) => (cache[a]?.fetchedAt ?? 0) - (cache[b]?.fetchedAt ?? 0))
    .slice(-MAX_CACHE_ENTRIES)
  return Object.fromEntries(keep.map((key) => [key, cache[key]!]))
}
