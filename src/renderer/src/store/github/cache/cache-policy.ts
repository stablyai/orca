import type { CacheEntry } from './cache-model'
import { MAX_CACHE_ENTRIES } from '../../../../../shared/github/cache/bounded-cache-entries'

// Shared with main so a host without a renderer bounds its PR cache the same way.
export {
  MAX_CACHE_ENTRIES,
  evictStaleEntries,
  withBoundedCacheEntry
} from '../../../../../shared/github/cache/bounded-cache-entries'

export const CACHE_TTL = 300_000
export const WORK_ITEMS_CACHE_TTL = 60_000
export const ERROR_TOAST_DURATION = 60_000

export function isFresh<T>(
  entry: CacheEntry<T> | undefined,
  ttl = CACHE_TTL
): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < ttl
}

export function capRecordByInsertionOrder<T>(
  record: Record<string, T>,
  maxEntries = MAX_CACHE_ENTRIES
): Record<string, T> {
  const keys = Object.keys(record)
  if (keys.length <= maxEntries) {
    return record
  }
  const next = { ...record }
  for (let i = 0; i < keys.length - maxEntries; i += 1) {
    delete next[keys[i]]
  }
  return next
}
