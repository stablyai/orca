const METADATA_TTL = 300_000 // 5 min
const MAX_METADATA_CACHE_ENTRIES = 500
// Why: an unreachable provider/runtime fails every consumer render; without a
// negative cache each settlement re-issues the fetch, which storms a dead
// remote. Failures are remembered briefly so retries are paced, not disabled —
// short enough that a recovered provider is picked up within seconds.
const METADATA_FAILURE_TTL = 10_000
const MAX_METADATA_FAILURE_ENTRIES = 200

type CachedMetadata<T> = { data: T; fetchedAt: number }
type CachedMetadataFailure = { error: unknown; failedAt: number }

export type MetadataRequestStore<T> = {
  cache: Map<string, CachedMetadata<T>>
  inflight: Map<string, Promise<T>>
  failures: Map<string, CachedMetadataFailure>
  generation: number
}

export function createMetadataRequestStore<T>(): MetadataRequestStore<T> {
  return {
    cache: new Map(),
    inflight: new Map(),
    failures: new Map(),
    generation: 0
  }
}

export function clearMetadataRequestStore<T>(store: MetadataRequestStore<T>): void {
  store.generation += 1
  store.cache.clear()
  store.inflight.clear()
  store.failures.clear()
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

function pruneMetadataFailures<T>(
  store: MetadataRequestStore<T>,
  now: number,
  maxEntries = MAX_METADATA_FAILURE_ENTRIES
): void {
  for (const [key, entry] of store.failures) {
    if (now - entry.failedAt >= METADATA_FAILURE_TTL) {
      store.failures.delete(key)
    }
  }
  if (store.failures.size <= maxEntries) {
    return
  }
  const sorted = [...store.failures.entries()].sort((a, b) => b[1].failedAt - a[1].failedAt)
  for (const [key] of sorted.slice(maxEntries)) {
    store.failures.delete(key)
  }
}

export function getRecentMetadataFailure<T>(
  store: MetadataRequestStore<T>,
  key: string,
  now = Date.now()
): CachedMetadataFailure | null {
  const entry = store.failures.get(key)
  if (!entry || now - entry.failedAt >= METADATA_FAILURE_TTL) {
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

  const recentFailure = getRecentMetadataFailure(store, key, now())
  if (recentFailure) {
    return Promise.reject(recentFailure.error)
  }

  // Why: clearMetadataRequestStore invalidates auth/repo boundaries; late
  // responses from the previous generation must not repopulate the cache.
  const generation = store.generation
  const promise = fetcher()
    .then((data) => {
      if (store.generation === generation) {
        const fetchedAt = now()
        store.cache.set(key, { data, fetchedAt })
        store.failures.delete(key)
        // Why: these module-level stores are reused across dialogs and
        // repo/runtime keys; TTL controls freshness but also needs pruning so
        // long sessions do not retain stale metadata indefinitely.
        pruneMetadataCache(store, fetchedAt)
      }
      return data
    })
    .catch((error: unknown) => {
      if (store.generation === generation) {
        const failedAt = now()
        store.failures.set(key, { error, failedAt })
        pruneMetadataFailures(store, failedAt)
      }
      throw error
    })
    .finally(() => {
      if (store.inflight.get(key) === promise) {
        store.inflight.delete(key)
      }
    })

  store.inflight.set(key, promise)
  return promise
}
