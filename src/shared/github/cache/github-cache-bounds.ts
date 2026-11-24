// The GitHub caches' size bound and the merge every writer of the PR cache goes through.

export const MAX_CACHE_ENTRIES = 500

/** Evicts the oldest entries only when over the bound; age alone does not evict. */
export function evictStaleEntries<T extends { fetchedAt: number }>(
  cache: Record<string, T>,
  maxEntries = MAX_CACHE_ENTRIES
): Record<string, T> {
  const entries = Object.entries(cache)
  if (entries.length <= maxEntries) {
    return cache
  }
  entries.sort(([, a], [, b]) => b.fetchedAt - a.fetchedAt)
  return Object.fromEntries(entries.slice(0, maxEntries))
}

/** `incoming`, keeping each entry of `current` read later than incoming's own, under the bound: a
 *  window's save and main's own write each keep the other's newer reads. */
export function withNewerCacheEntries<T extends { fetchedAt: number }>(
  current: Record<string, T>,
  incoming: Record<string, T>
): Record<string, T> {
  let merged = incoming
  for (const [key, entry] of Object.entries(current)) {
    const kept = incoming[key]
    if (!kept || entry.fetchedAt > kept.fetchedAt) {
      merged = merged === incoming ? { ...incoming } : merged
      merged[key] = entry
    }
  }
  return evictStaleEntries(merged)
}

/** A window's save of its whole cache: main writes PR reads too (with no window open), and a
 *  window's older copy never undoes them. */
export function withNewerPRReads<C extends { pr: Record<string, { fetchedAt: number }> }>(
  current: C,
  incoming: C
): C {
  return { ...incoming, pr: withNewerCacheEntries(current.pr, incoming.pr) }
}
