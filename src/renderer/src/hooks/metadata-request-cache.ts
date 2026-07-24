import { measureUtf8ByteLength } from '../../../shared/utf8-byte-limits'
import { boundedMetadataFailure, measureMetadataValueBytes } from './metadata-retention-measurement'

const METADATA_TTL = 300_000 // 5 min
const MAX_METADATA_CACHE_ENTRIES = 500
// Why: an unreachable provider/runtime fails every consumer render; without a
// negative cache each settlement re-issues the fetch, which storms a dead
// remote. Failures are remembered briefly so retries are paced, not disabled —
// short enough that a recovered provider is picked up within seconds.
const METADATA_FAILURE_TTL = 10_000
const MAX_METADATA_FAILURE_ENTRIES = 200
export const MAX_METADATA_INFLIGHT_ENTRIES = 100
export const MAX_METADATA_KEY_BYTES = 4 * 1024
export const MAX_METADATA_VALUE_BYTES = 512 * 1024
export const MAX_METADATA_ERROR_SUMMARY_BYTES = 4 * 1024
export const MAX_METADATA_RETAINED_BYTES = 16 * 1024 * 1024

type CachedMetadata<T> = { data: T; fetchedAt: number; retainedBytes: number }
type CachedMetadataFailure = { error: Error; failedAt: number; retainedBytes: number }

type MetadataRequestStoreOptions = {
  maxRetainedBytes?: number
}

export type MetadataRequestStore<T> = {
  cache: Map<string, CachedMetadata<T>>
  inflight: Map<string, Promise<T>>
  inflightEntryBytes: Map<string, number>
  failures: Map<string, CachedMetadataFailure>
  generation: number
  retainedBytes: number
  maxRetainedBytes: number
}

export function createMetadataRequestStore<T>(
  options: MetadataRequestStoreOptions = {}
): MetadataRequestStore<T> {
  return {
    cache: new Map(),
    inflight: new Map(),
    inflightEntryBytes: new Map(),
    failures: new Map(),
    generation: 0,
    retainedBytes: 0,
    maxRetainedBytes: clampRetainedByteLimit(options.maxRetainedBytes)
  }
}

export function clearMetadataRequestStore<T>(store: MetadataRequestStore<T>): void {
  store.generation += 1
  store.cache.clear()
  store.inflight.clear()
  store.inflightEntryBytes.clear()
  store.failures.clear()
  store.retainedBytes = 0
}

function clampRetainedByteLimit(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    return MAX_METADATA_RETAINED_BYTES
  }
  return Math.min(value, MAX_METADATA_RETAINED_BYTES)
}

function metadataKeyBytes(key: string): number | null {
  const measured = measureUtf8ByteLength(key, { stopAfterBytes: MAX_METADATA_KEY_BYTES })
  return measured.exceededLimit ? null : measured.byteLength
}

function deleteCachedMetadata<T>(store: MetadataRequestStore<T>, key: string): void {
  const entry = store.cache.get(key)
  if (entry && store.cache.delete(key)) {
    store.retainedBytes -= entry.retainedBytes
  }
}

function deleteMetadataFailure<T>(store: MetadataRequestStore<T>, key: string): void {
  const entry = store.failures.get(key)
  if (entry && store.failures.delete(key)) {
    store.retainedBytes -= entry.retainedBytes
  }
}

function releaseMetadataInflight<T>(
  store: MetadataRequestStore<T>,
  key: string,
  promise: Promise<T>
): void {
  if (store.inflight.get(key) !== promise) {
    return
  }
  store.inflight.delete(key)
  const retainedBytes = store.inflightEntryBytes.get(key) ?? 0
  store.inflightEntryBytes.delete(key)
  store.retainedBytes -= retainedBytes
}

function pruneMetadataCache<T>(
  store: MetadataRequestStore<T>,
  now: number,
  maxEntries = MAX_METADATA_CACHE_ENTRIES
): void {
  for (const [key, entry] of store.cache) {
    if (now - entry.fetchedAt >= METADATA_TTL) {
      deleteCachedMetadata(store, key)
    }
  }
  if (store.cache.size <= maxEntries) {
    return
  }
  const sorted = [...store.cache.entries()].sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
  for (const [key] of sorted.slice(maxEntries)) {
    deleteCachedMetadata(store, key)
  }
}

export function getFreshMetadata<T>(
  store: MetadataRequestStore<T>,
  key: string,
  now = Date.now()
): CachedMetadata<T> | null {
  if (metadataKeyBytes(key) === null) {
    deleteCachedMetadata(store, key)
    return null
  }
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
      deleteMetadataFailure(store, key)
    }
  }
  if (store.failures.size <= maxEntries) {
    return
  }
  const sorted = [...store.failures.entries()].sort((a, b) => b[1].failedAt - a[1].failedAt)
  for (const [key] of sorted.slice(maxEntries)) {
    deleteMetadataFailure(store, key)
  }
}

export function getRecentMetadataFailure<T>(
  store: MetadataRequestStore<T>,
  key: string,
  now = Date.now()
): CachedMetadataFailure | null {
  if (metadataKeyBytes(key) === null) {
    deleteMetadataFailure(store, key)
    return null
  }
  pruneMetadataFailures(store, now)
  const entry = store.failures.get(key)
  if (!entry || now - entry.failedAt >= METADATA_FAILURE_TTL) {
    return null
  }
  return entry
}

function oldestRetainedEntry<T>(
  store: MetadataRequestStore<T>
): { key: string; kind: 'cache' | 'failure'; retainedAt: number } | null {
  let oldest: { key: string; kind: 'cache' | 'failure'; retainedAt: number } | null = null
  for (const [key, entry] of store.failures) {
    if (!oldest || entry.failedAt < oldest.retainedAt) {
      oldest = { key, kind: 'failure', retainedAt: entry.failedAt }
    }
  }
  for (const [key, entry] of store.cache) {
    if (!oldest || entry.fetchedAt < oldest.retainedAt) {
      oldest = { key, kind: 'cache', retainedAt: entry.fetchedAt }
    }
  }
  return oldest
}

function reserveMetadataRetention<T>(
  store: MetadataRequestStore<T>,
  retainedBytes: number,
  now: number
): boolean {
  pruneMetadataCache(store, now)
  pruneMetadataFailures(store, now)
  while (store.retainedBytes + retainedBytes > store.maxRetainedBytes) {
    const oldest = oldestRetainedEntry(store)
    if (!oldest) {
      return false
    }
    if (oldest.kind === 'cache') {
      deleteCachedMetadata(store, oldest.key)
    } else {
      deleteMetadataFailure(store, oldest.key)
    }
  }
  return true
}

export function loadMetadata<T>(
  store: MetadataRequestStore<T>,
  key: string,
  fetcher: () => Promise<T>,
  now = Date.now
): Promise<T> {
  const keyBytes = metadataKeyBytes(key)
  if (keyBytes === null) {
    return Promise.reject(
      new Error(`Metadata request key exceeds ${MAX_METADATA_KEY_BYTES} bytes.`)
    )
  }
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

  if (store.inflight.size >= MAX_METADATA_INFLIGHT_ENTRIES) {
    return Promise.reject(new Error('Metadata request queue is full; retry after requests finish.'))
  }
  if (!reserveMetadataRetention(store, keyBytes, now())) {
    return Promise.reject(new Error('Metadata request memory budget is full; retry later.'))
  }

  // Why: clearMetadataRequestStore invalidates auth/repo boundaries; late
  // responses from the previous generation must not repopulate the cache.
  const generation = store.generation
  let fetched: Promise<T>
  try {
    fetched = fetcher()
  } catch (error) {
    return Promise.reject(error)
  }
  let promise!: Promise<T>
  promise = fetched
    .then(
      (data) => {
        releaseMetadataInflight(store, key, promise)
        if (store.generation === generation) {
          const fetchedAt = now()
          const valueBytes = measureMetadataValueBytes(data, MAX_METADATA_VALUE_BYTES)
          deleteCachedMetadata(store, key)
          deleteMetadataFailure(store, key)
          if (
            valueBytes !== null &&
            reserveMetadataRetention(store, keyBytes + valueBytes, fetchedAt)
          ) {
            const retainedBytes = keyBytes + valueBytes
            store.cache.set(key, { data, fetchedAt, retainedBytes })
            store.retainedBytes += retainedBytes
            pruneMetadataCache(store, fetchedAt)
          }
        }
        return data
      },
      (error: unknown) => {
        releaseMetadataInflight(store, key, promise)
        if (store.generation === generation) {
          const failedAt = now()
          const bounded = boundedMetadataFailure(error, MAX_METADATA_ERROR_SUMMARY_BYTES)
          const retainedBytes = keyBytes + bounded.bytes
          deleteMetadataFailure(store, key)
          if (reserveMetadataRetention(store, retainedBytes, failedAt)) {
            store.failures.set(key, { error: bounded.error, failedAt, retainedBytes })
            store.retainedBytes += retainedBytes
            pruneMetadataFailures(store, failedAt)
          }
        }
        throw error
      }
    )
    .finally(() => {
      releaseMetadataInflight(store, key, promise)
    })

  store.inflight.set(key, promise)
  store.inflightEntryBytes.set(key, keyBytes)
  store.retainedBytes += keyBytes
  return promise
}
