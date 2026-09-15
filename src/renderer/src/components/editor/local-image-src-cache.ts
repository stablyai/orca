import {
  clearLocalImageCachePins,
  isLocalImageCacheKeyPinned,
  pinLocalImageCacheKey,
  prunePinnedLocalImageCache,
  unpinLocalImageCacheKey
} from './local-image-cache-pinning'

const BLOB_URL_CACHE_MAX_SIZE = 100
// Keep retained decoded image data bounded as well as entry count.
const BLOB_URL_CACHE_MAX_BYTES = 128 * 1024 * 1024

export const blobUrlCache = new Map<string, string>()
const blobUrlCacheBytes = new Map<string, number>()
export const inFlightBlobUrlLoads = new Map<string, Promise<string | null>>()
// Incremented on release so a read resolving after its last consumer left
// cannot repopulate the cache.
const cacheKeyVersions = new Map<string, number>()

export function getLocalImageCacheKeyVersion(key: string): number {
  return cacheKeyVersions.get(key) ?? 0
}

export function cleanupLocalImageCacheKeyVersion(key: string): void {
  if (
    !blobUrlCache.has(key) &&
    !inFlightBlobUrlLoads.has(key) &&
    !isLocalImageCacheKeyPinned(key)
  ) {
    cacheKeyVersions.delete(key)
  }
}

let cacheGeneration = 0
const cacheListeners = new Set<() => void>()
const pendingBlobUrlRevocations = new Set<string>()
let pendingBlobUrlRevocationTimer: ReturnType<typeof setTimeout> | null = null

function pruneImageCache(): void {
  prunePinnedLocalImageCache(blobUrlCache, BLOB_URL_CACHE_MAX_SIZE, (url) => {
    URL.revokeObjectURL(url)
  })
  for (const key of blobUrlCacheBytes.keys()) {
    if (!blobUrlCache.has(key)) {
      blobUrlCacheBytes.delete(key)
      cleanupLocalImageCacheKeyVersion(key)
    }
  }
  let retainedBytes = 0
  for (const byteLength of blobUrlCacheBytes.values()) {
    retainedBytes += byteLength
  }
  while (retainedBytes > BLOB_URL_CACHE_MAX_BYTES) {
    const key = Array.from(blobUrlCache.keys()).find(
      (candidate) => !isLocalImageCacheKeyPinned(candidate)
    )
    if (key === undefined) {
      return
    }
    const url = blobUrlCache.get(key)
    blobUrlCache.delete(key)
    retainedBytes -= blobUrlCacheBytes.get(key) ?? 0
    blobUrlCacheBytes.delete(key)
    if (url) {
      URL.revokeObjectURL(url)
    }
    cleanupLocalImageCacheKeyVersion(key)
  }
}

export function cacheLocalImageBlob(
  key: string,
  url: string,
  byteLength: number,
  expectedVersion?: number
): boolean {
  if (
    (expectedVersion !== undefined && getLocalImageCacheKeyVersion(key) !== expectedVersion) ||
    byteLength > BLOB_URL_CACHE_MAX_BYTES
  ) {
    URL.revokeObjectURL(url)
    cleanupLocalImageCacheKeyVersion(key)
    return false
  }
  const previousUrl = blobUrlCache.get(key)
  const previousBytes = blobUrlCacheBytes.get(key) ?? 0
  let retainedBytes = 0
  for (const bytes of blobUrlCacheBytes.values()) {
    retainedBytes += bytes
  }
  let projectedEntries = blobUrlCache.size + (previousUrl === undefined ? 1 : 0)
  let projectedBytes = retainedBytes - previousBytes + byteLength

  // Evict only unpinned entries. If visible leases consume the budget, fail
  // closed so a late/non-visible decode cannot make retention unbounded.
  while (projectedEntries > BLOB_URL_CACHE_MAX_SIZE || projectedBytes > BLOB_URL_CACHE_MAX_BYTES) {
    const candidate = Array.from(blobUrlCache.keys()).find(
      (candidateKey) => candidateKey !== key && !isLocalImageCacheKeyPinned(candidateKey)
    )
    if (candidate === undefined) {
      URL.revokeObjectURL(url)
      cleanupLocalImageCacheKeyVersion(key)
      return false
    }
    const candidateUrl = blobUrlCache.get(candidate)
    const candidateBytes = blobUrlCacheBytes.get(candidate) ?? 0
    blobUrlCache.delete(candidate)
    blobUrlCacheBytes.delete(candidate)
    projectedEntries -= 1
    projectedBytes -= candidateBytes
    if (candidateUrl) {
      URL.revokeObjectURL(candidateUrl)
    }
    cleanupLocalImageCacheKeyVersion(candidate)
  }
  if (previousUrl !== undefined && previousUrl !== url) {
    URL.revokeObjectURL(previousUrl)
  }
  blobUrlCacheBytes.delete(key)
  blobUrlCacheBytes.set(key, byteLength)
  blobUrlCache.set(key, url)
  return true
}

export function getLocalImageCacheGeneration(): number {
  return cacheGeneration
}

export function pinLocalImageCache(key: string): void {
  pinLocalImageCacheKey(key)
}

export function unpinLocalImageCache(key: string): void {
  unpinLocalImageCacheKey(key)
  pruneImageCache()
  cleanupLocalImageCacheKeyVersion(key)
}

export function subscribeToLocalImageCacheInvalidation(listener: () => void): () => void {
  cacheListeners.add(listener)
  return () => cacheListeners.delete(listener)
}

function revokePendingBlobUrls(): void {
  pendingBlobUrlRevocationTimer = null
  for (const url of pendingBlobUrlRevocations) {
    URL.revokeObjectURL(url)
  }
  pendingBlobUrlRevocations.clear()
}

function scheduleBlobUrlRevocation(urls: string[]): void {
  for (const url of urls) {
    pendingBlobUrlRevocations.add(url)
  }
  if (pendingBlobUrlRevocationTimer !== null || pendingBlobUrlRevocations.size === 0) {
    return
  }
  pendingBlobUrlRevocationTimer = setTimeout(revokePendingBlobUrls, 30_000)
}

export function invalidateLocalImageCache(): void {
  const staleUrls = Array.from(blobUrlCache.values())
  blobUrlCache.clear()
  blobUrlCacheBytes.clear()
  inFlightBlobUrlLoads.clear()
  cacheKeyVersions.clear()
  cacheGeneration += 1
  for (const listener of cacheListeners) {
    listener()
  }
  if (staleUrls.length > 0) {
    scheduleBlobUrlRevocation(staleUrls)
  }
}

export function releaseLocalImageBlob(key: string): void {
  if (isLocalImageCacheKeyPinned(key)) {
    return
  }
  cacheKeyVersions.set(key, getLocalImageCacheKeyVersion(key) + 1)
  const inFlight = inFlightBlobUrlLoads.get(key)
  if (inFlight) {
    // A released lease must not be reused by a later visible lease: the
    // released read may resolve null or be stale for the next owner.
    inFlightBlobUrlLoads.delete(key)
  }
  const url = blobUrlCache.get(key)
  if (url) {
    blobUrlCache.delete(key)
    blobUrlCacheBytes.delete(key)
    URL.revokeObjectURL(url)
  }
  if (!inFlight) {
    cleanupLocalImageCacheKeyVersion(key)
  }
}

export function resetLocalImageCacheState(): void {
  if (pendingBlobUrlRevocationTimer !== null) {
    clearTimeout(pendingBlobUrlRevocationTimer)
    pendingBlobUrlRevocationTimer = null
  }
  revokePendingBlobUrls()
  for (const url of blobUrlCache.values()) {
    URL.revokeObjectURL(url)
  }
  blobUrlCache.clear()
  blobUrlCacheBytes.clear()
  clearLocalImageCachePins()
  inFlightBlobUrlLoads.clear()
  cacheKeyVersions.clear()
  cacheGeneration = 0
  pendingBlobUrlRevocations.clear()
  cacheListeners.clear()
}

export function disposeLocalImageCacheState(): void {
  if (typeof window !== 'undefined') {
    window.removeEventListener('focus', invalidateLocalImageCache)
  }
  resetLocalImageCacheState()
}

if (typeof window !== 'undefined') {
  window.addEventListener('focus', invalidateLocalImageCache)
}

if (import.meta !== undefined && import.meta.hot) {
  import.meta.hot.dispose(disposeLocalImageCacheState)
}
