// Why: isolated module so the store slice can call revokeCustomPetBlobUrl
// without importing usePetUrl (which itself imports the store). Keeps
// the dependency graph acyclic.

import {
  CustomPetLoadQueue,
  MAX_CONCURRENT_CUSTOM_PET_LOADS,
  MAX_PENDING_CUSTOM_PET_LOADS
} from './custom-pet-load-queue'
import { processCustomPetBundleSheet } from './custom-pet-bundle-processing'
import type { DetectedSpriteCacheEntry } from './custom-pet-media-types'

export { MAX_CONCURRENT_CUSTOM_PET_LOADS, MAX_PENDING_CUSTOM_PET_LOADS }
export type { DetectedSpriteCacheEntry } from './custom-pet-media-types'

// Why: sandbox=true + webSecurity=true block the renderer from reading user
// files directly. For custom pet images we fetch the bytes over IPC and
// turn them into a `blob:` URL that an <img> tag can load. A small in-memory
// cache means switching back and forth between images in the same session
// doesn't re-fetch from main.
export const blobUrlCache = new Map<string, string>()
export const CUSTOM_PET_BLOB_CACHE_MAX = 16
export const CUSTOM_PET_MEDIA_CACHE_MAX_BYTES = 128 * 1024 * 1024

export const detectedSpriteCache = new Map<string, DetectedSpriteCacheEntry>()
const customPetBlobUrlLoads = new Map<string, Promise<string | null>>()
const customPetBlobCacheEpoch = new Map<string, number>()
const customPetBlobActiveLoadCounts = new Map<string, number>()
const customPetBlobRetainCounts = new Map<string, number>()
const customPetMediaBytes = new Map<string, number>()
const customPetLoadQueue = new CustomPetLoadQueue()
let retainedCustomPetMediaBytes = 0

export function inspectCustomPetMediaCache(): {
  activeLoads: number
  cachedEntries: number
  pendingLoads: number
  retainedBytes: number
} {
  const loads = customPetLoadQueue.inspect()
  return {
    activeLoads: loads.active,
    cachedEntries: blobUrlCache.size,
    pendingLoads: loads.pending,
    retainedBytes: retainedCustomPetMediaBytes
  }
}

export function retainCustomPetBlobCacheEntry(id: string): () => void {
  customPetBlobRetainCounts.set(id, (customPetBlobRetainCounts.get(id) ?? 0) + 1)
  let retained = true
  return () => {
    if (!retained) {
      return
    }
    retained = false
    const nextCount = (customPetBlobRetainCounts.get(id) ?? 1) - 1
    if (nextCount > 0) {
      customPetBlobRetainCounts.set(id, nextCount)
      return
    }
    customPetBlobRetainCounts.delete(id)
    evictInactiveCustomPetBlobUrls()
  }
}

export function peekCustomPetBlobUrl(id: string): string | null {
  return blobUrlCache.get(id) ?? null
}

export function readCustomPetBlobUrl(id: string): string | null {
  const cached = peekCustomPetBlobUrl(id)
  if (!cached) {
    return null
  }
  blobUrlCache.delete(id)
  blobUrlCache.set(id, cached)
  return cached
}

export async function loadCustomBlobUrl(
  id: string,
  fileName: string,
  mimeType: string,
  kind?: 'image' | 'bundle',
  spriteFps?: number,
  hasManifestSprite?: boolean
): Promise<string | null> {
  const cached = readCustomPetBlobUrl(id)
  if (cached) {
    return cached
  }
  const pending = customPetBlobUrlLoads.get(id)
  if (pending) {
    return pending
  }
  // Why: reject before allocating tracking Maps/promises for overflow IDs;
  // the queue's own guard remains the race-proof backstop.
  if (customPetLoadQueue.inspect().pending >= MAX_PENDING_CUSTOM_PET_LOADS) {
    return null
  }
  const loadEpoch = customPetBlobCacheEpoch.get(id) ?? 0
  incrementCustomPetBlobActiveLoadCount(id)
  const load = customPetLoadQueue
    .run(() =>
      loadCustomBlobUrlUncached(
        id,
        fileName,
        mimeType,
        kind,
        spriteFps,
        hasManifestSprite,
        loadEpoch
      )
    )
    .catch(() => null)
    .finally(() => {
      if (customPetBlobUrlLoads.get(id) === load) {
        customPetBlobUrlLoads.delete(id)
      }
      decrementCustomPetBlobActiveLoadCount(id)
    })
  customPetBlobUrlLoads.set(id, load)
  return load
}

function incrementCustomPetBlobActiveLoadCount(id: string): void {
  customPetBlobActiveLoadCounts.set(id, (customPetBlobActiveLoadCounts.get(id) ?? 0) + 1)
}

function decrementCustomPetBlobActiveLoadCount(id: string): void {
  const nextCount = (customPetBlobActiveLoadCounts.get(id) ?? 1) - 1
  if (nextCount > 0) {
    customPetBlobActiveLoadCounts.set(id, nextCount)
    return
  }
  customPetBlobActiveLoadCounts.delete(id)
  customPetBlobCacheEpoch.delete(id)
}

async function loadCustomBlobUrlUncached(
  id: string,
  fileName: string,
  mimeType: string,
  kind: 'image' | 'bundle' | undefined,
  spriteFps: number | undefined,
  hasManifestSprite: boolean | undefined,
  loadEpoch: number
): Promise<string | null> {
  if ((customPetBlobCacheEpoch.get(id) ?? 0) !== loadEpoch) {
    return null
  }
  // Why: defensively clear any stale entry so we don't leak a prior blob URL
  // or ImageBitmap[] when re-populating after a cache miss.
  clearCustomPetBlobCacheEntry(id)
  const buffer = await window.api.pet.read(id, fileName, kind)
  if (!buffer || (customPetBlobCacheEpoch.get(id) ?? 0) !== loadEpoch) {
    return null
  }
  // Why: MIME comes from CustomPet.mimeType — required especially for
  // SVG, which browsers refuse to render from a blob URL with the wrong
  // Content-Type.
  const blob = new Blob([buffer], { type: mimeType })
  let url = URL.createObjectURL(blob)
  let detected: DetectedSpriteCacheEntry | null = null
  let retainedBytes = blob.size
  // Why: pet bundles often ship spritesheets with a magenta chroma-key as
  // the background instead of true alpha (common in pixel-art tooling).
  // Strip it once at load and replace the cached URL with a transparent PNG
  // so the overlay just sees a normal blob URL.
  if (kind === 'bundle' && mimeType !== 'image/svg+xml') {
    // Why: when the manifest already provides a valid sprite layout, the
    // renderer reads the `sprite` branch of usePetUrl and never touches
    // detectedSpriteCache — so skipping detection (and the per-frame
    // ImageBitmap allocations) avoids a per-bundle memory leak.
    const processed = await processCustomPetBundleSheet(url, spriteFps, hasManifestSprite === true)
    if (processed?.kind === 'rejected') {
      URL.revokeObjectURL(url)
      return null
    }
    if (processed?.kind === 'processed') {
      URL.revokeObjectURL(url)
      url = processed.url
      detected = processed.detected
      retainedBytes = processed.retainedBytes
    }
  }
  if ((customPetBlobCacheEpoch.get(id) ?? 0) !== loadEpoch) {
    URL.revokeObjectURL(url)
    closeDetectedSpriteCacheEntry(detected)
    return null
  }
  if (!cacheCustomPetBlobUrl(id, url, detected, retainedBytes)) {
    URL.revokeObjectURL(url)
    closeDetectedSpriteCacheEntry(detected)
    return null
  }
  return url
}

function cacheCustomPetBlobUrl(
  id: string,
  url: string,
  detected: DetectedSpriteCacheEntry | null,
  retainedBytes: number
): boolean {
  clearCustomPetBlobCacheEntry(id)
  if (!Number.isSafeInteger(retainedBytes) || retainedBytes < 0) {
    return false
  }
  evictInactiveCustomPetBlobUrls(retainedBytes, 1)
  if (
    blobUrlCache.size >= CUSTOM_PET_BLOB_CACHE_MAX ||
    retainedCustomPetMediaBytes + retainedBytes > CUSTOM_PET_MEDIA_CACHE_MAX_BYTES
  ) {
    return false
  }
  blobUrlCache.set(id, url)
  customPetMediaBytes.set(id, retainedBytes)
  retainedCustomPetMediaBytes += retainedBytes
  if (detected) {
    detectedSpriteCache.set(id, detected)
  }
  return true
}

function evictInactiveCustomPetBlobUrls(incomingBytes = 0, incomingEntries = 0): void {
  // Why: users can import many custom pets; inactive blob URLs and sprite
  // bitmaps should not stay resident for the whole renderer session.
  while (
    blobUrlCache.size + incomingEntries > CUSTOM_PET_BLOB_CACHE_MAX ||
    retainedCustomPetMediaBytes + incomingBytes > CUSTOM_PET_MEDIA_CACHE_MAX_BYTES
  ) {
    let evicted = false
    for (const id of blobUrlCache.keys()) {
      if (customPetBlobRetainCounts.has(id)) {
        continue
      }
      clearCustomPetBlobCacheEntry(id)
      evicted = true
      break
    }
    if (!evicted) {
      return
    }
  }
}

// Why: the store invokes this on removeCustomPet so the underlying Blob
// is released; otherwise the blob: URL keeps it alive for the rest of the
// session, wasting memory per imported image.
export function revokeCustomPetBlobUrl(id: string): void {
  customPetBlobCacheEpoch.set(id, (customPetBlobCacheEpoch.get(id) ?? 0) + 1)
  customPetBlobUrlLoads.delete(id)
  clearCustomPetBlobCacheEntry(id)
  if (!customPetBlobActiveLoadCounts.has(id)) {
    customPetBlobCacheEpoch.delete(id)
  }
}

function clearCustomPetBlobCacheEntry(id: string): void {
  const retainedBytes = customPetMediaBytes.get(id) ?? 0
  customPetMediaBytes.delete(id)
  retainedCustomPetMediaBytes = Math.max(0, retainedCustomPetMediaBytes - retainedBytes)
  const url = blobUrlCache.get(id)
  if (url) {
    URL.revokeObjectURL(url)
    blobUrlCache.delete(id)
  }
  const detected = detectedSpriteCache.get(id)
  if (detected) {
    closeDetectedSpriteCacheEntry(detected)
    detectedSpriteCache.delete(id)
  }
}

function closeDetectedSpriteCacheEntry(entry: DetectedSpriteCacheEntry | null): void {
  if (!entry) {
    return
  }
  for (const bmp of entry.bitmaps) {
    bmp.close()
  }
}
