const METADATA_TTL = 300_000 // 5 min

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

export function getFreshMetadata<T>(
  store: MetadataRequestStore<T>,
  key: string,
  now = Date.now()
): CachedMetadata<T> | null {
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
        store.cache.set(key, { data, fetchedAt: now() })
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
