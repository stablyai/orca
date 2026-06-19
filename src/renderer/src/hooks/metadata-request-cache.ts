const METADATA_TTL = 300_000 // 5 min
const MAX_METADATA_CACHE_ENTRIES = 500

type CachedMetadata<T> = { data: T; fetchedAt: number }

export type MetadataRequestStore<T> = {
  cache: Map<string, CachedMetadata<T>>
  inflight: Map<string, Promise<T>>
  generation: number
}

export function createMetadataRequestStore<T>(): MetadataRequestStore<T> {
  return {
    cache: new Map(),
    inflight: new Map(),
    generation: 0
  }
}

export function clearMetadataRequestStore<T>(store: MetadataRequestStore<T>): void {
  store.generation += 1
  store.cache.clear()
  store.inflight.clear()
}

function pruneMetadataCache<T>(
  store: MetadataRequestStore<T>,
  now: number,
  maxEntries = MAX_METADATA_CACHE_ENTRIES
): void {
  for (const [key, entry] of store.cache) {
    if (now - entry.fetchedAt >= METADATA_TTL) {
      store.cache.delete(key)
    }
  }
  if (store.cache.size <= maxEntries) {
    return
  }
  const sorted = [...store.cache.entries()].sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
  for (const [key] of sorted.slice(maxEntries)) {
    store.cache.delete(key)
  }
}

export function getFreshMetadata<T>(
  store: MetadataRequestStore<T>,
  key: string,
  now = Date.now()
): CachedMetadata<T> | null {
  pruneMetadataCache(store, now)
  const entry = store.cache.get(key)
  if (!entry || now - entry.fetchedAt >= METADATA_TTL) {
    return null
  }
  return entry
}

export function loadMetadata<T>(
  store: MetadataRequestStore<T>,
  key: string,
  fetcher: () => Promise<T>,
  now = Date.now
): Promise<T> {
  const cached = getFreshMetadata(store, key, now())
  if (cached) {
    return Promise.resolve(cached.data)
  }

  const inflight = store.inflight.get(key)
  if (inflight) {
    return inflight
  }

  // Why: clearMetadataRequestStore invalidates auth/repo boundaries; late
  // responses from the previous generation must not repopulate the cache.
  const generation = store.generation
  const promise = fetcher()
    .then((data) => {
      if (store.generation === generation) {
        const fetchedAt = now()
        store.cache.set(key, { data, fetchedAt })
        // Why: these module-level stores are reused across dialogs and
        // repo/runtime keys; TTL controls freshness but also needs pruning so
        // long sessions do not retain stale metadata indefinitely.
        pruneMetadataCache(store, fetchedAt)
      }
      return data
    })
    .finally(() => {
      if (store.inflight.get(key) === promise) {
        store.inflight.delete(key)
      }
    })

  store.inflight.set(key, promise)
  return promise
}
