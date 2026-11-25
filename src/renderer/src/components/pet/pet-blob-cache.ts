// Keep cache revocation independent of the hook/store dependency cycle.

import { detectFramesFromImageData, type DetectedFrame } from './sprite-frame-detection'

// Sandboxed renderers cannot read user files; cache IPC-loaded blob URLs to avoid refetching on pet switches.
export const blobUrlCache = new Map<string, string>()
export const CUSTOM_PET_BLOB_CACHE_MAX = 16

export type DetectedSpriteCacheEntry = {
  frames: DetectedFrame[]
  /** Crop irregular sheets into per-frame bitmaps for canvas playback without requiring a manifest grid. */
  bitmaps: ImageBitmap[]
  /** Imported manifest speed; missing values use the overlay’s 8 fps fallback. */
  fps: number
}
export const detectedSpriteCache = new Map<string, DetectedSpriteCacheEntry>()
const customPetBlobUrlLoads = new Map<string, Promise<string | null>>()
const customPetBlobCacheEpoch = new Map<string, number>()
const customPetBlobActiveLoadCounts = new Map<string, number>()
const customPetBlobRetainCounts = new Map<string, number>()

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
  const loadEpoch = customPetBlobCacheEpoch.get(id) ?? 0
  incrementCustomPetBlobActiveLoadCount(id)
  const load = loadCustomBlobUrlUncached(
    id,
    fileName,
    mimeType,
    kind,
    spriteFps,
    hasManifestSprite,
    loadEpoch
  ).finally(() => {
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
  // Release stale URLs/bitmaps before repopulating a cache miss.
  clearCustomPetBlobCacheEntry(id)
  const buffer = await window.api.pet.read(id, fileName, kind)
  if (!buffer) {
    return null
  }
  // Use the stored MIME type; SVG blobs with the wrong Content-Type will not render.
  const blob = new Blob([buffer], { type: mimeType })
  let url = URL.createObjectURL(blob)
  let detected: DetectedSpriteCacheEntry | null = null
  // Remove magenta chroma keys once at load so overlays receive ordinary transparent PNG URLs.
  if (kind === 'bundle' && mimeType !== 'image/svg+xml') {
    // Manifest-layout playback never reads detected bitmaps; skip their allocation to avoid leaking them.
    const processed = await processBundleSheet(url, spriteFps, hasManifestSprite === true)
    if (processed) {
      URL.revokeObjectURL(url)
      url = processed.url
      if (processed.detected) {
        detected = processed.detected
      }
    }
  }
  if ((customPetBlobCacheEpoch.get(id) ?? 0) !== loadEpoch) {
    URL.revokeObjectURL(url)
    closeDetectedSpriteCacheEntry(detected)
    return null
  }
  cacheCustomPetBlobUrl(id, url, detected)
  return url
}

function cacheCustomPetBlobUrl(
  id: string,
  url: string,
  detected: DetectedSpriteCacheEntry | null
): void {
  clearCustomPetBlobCacheEntry(id)
  blobUrlCache.set(id, url)
  if (detected) {
    detectedSpriteCache.set(id, detected)
  }
  evictInactiveCustomPetBlobUrls()
}

function evictInactiveCustomPetBlobUrls(): void {
  // Bound inactive URLs/bitmaps so imported pets cannot occupy memory for the entire session.
  while (blobUrlCache.size > CUSTOM_PET_BLOB_CACHE_MAX) {
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

async function processBundleSheet(
  srcUrl: string,
  spriteFps?: number,
  skipDetection?: boolean
): Promise<{ url: string; detected: DetectedSpriteCacheEntry | null } | null> {
  let detected: DetectedSpriteCacheEntry | null = null
  try {
    const img = await loadImage(srcUrl)
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return null
    }
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
    keyMagenta(data.data)
    ctx.putImageData(data, 0, 0)
    // Detect after keying so transparent gutters separate frames instead of one whole-sheet frame.
    const sprite = skipDetection ? null : detectFramesFromImageData(data)
    if (sprite && sprite.frames.length >= 1) {
      // allSettled lets failed crops release successful bitmaps before falling back.
      const results = await Promise.allSettled(
        sprite.frames.map((f) => createImageBitmap(canvas, f.x, f.y, f.w, f.h))
      )
      const rejected = results.some((r) => r.status === 'rejected')
      if (rejected) {
        // Crop failure must still return the keyed PNG instead of the original magenta sheet.
        for (const r of results) {
          if (r.status === 'fulfilled') {
            r.value.close()
          }
        }
      } else {
        const bitmaps = results.map((r) => (r as PromiseFulfilledResult<ImageBitmap>).value)
        detected = { frames: sprite.frames, bitmaps, fps: spriteFps ?? 8 }
      }
    }
    const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
    if (!out) {
      closeDetectedSpriteCacheEntry(detected)
      return null
    }
    try {
      return { url: URL.createObjectURL(out), detected }
    } catch {
      closeDetectedSpriteCacheEntry(detected)
      return null
    }
  } catch {
    closeDetectedSpriteCacheEntry(detected)
    return null
  }
}

// Compressed keys leave halos beyond tight RGB distance; score magenta dominance and fade near-key edge pixels proportionally.
function magentaScore(r: number, g: number, b: number): number {
  // 0 means retained color, 1 pure key; preserve legitimate purple/pink artwork.
  const minRB = Math.min(r, b)
  if (g >= minRB) {
    return 0
  }
  const dom = (minRB - g) / 255
  // Require strong R+B dominance to preserve purple/pink while fading antialiased key edges.
  if (dom <= 0.4) {
    return 0
  }
  return Math.max(0, Math.min(1, dom * 1.4))
}

function keyMagenta(px: Uint8ClampedArray): void {
  for (let i = 0; i < px.length; i += 4) {
    const score = magentaScore(px[i], px[i + 1], px[i + 2])
    if (score <= 0) {
      continue
    }
    if (score >= 0.5) {
      px[i + 3] = 0
      px[i] = 0
      px[i + 1] = 0
      px[i + 2] = 0
    } else {
      const keep = 1 - score * 2
      px[i + 3] = Math.round(px[i + 3] * Math.max(0, keep))
    }
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
}

// Removal must revoke the URL or its blob stays alive for the renderer session.
export function revokeCustomPetBlobUrl(id: string): void {
  customPetBlobCacheEpoch.set(id, (customPetBlobCacheEpoch.get(id) ?? 0) + 1)
  customPetBlobUrlLoads.delete(id)
  clearCustomPetBlobCacheEntry(id)
  if (!customPetBlobActiveLoadCounts.has(id)) {
    customPetBlobCacheEpoch.delete(id)
  }
}

function clearCustomPetBlobCacheEntry(id: string): void {
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
