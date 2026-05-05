// Why: isolated module so the store slice can call revokeCustomSidekickBlobUrl
// without importing useSidekickUrl (which itself imports the store). Keeps
// the dependency graph acyclic.

import { detectFramesFromImageData, type DetectedFrame } from './sprite-frame-detection'

// Why: sandbox=true + webSecurity=true block the renderer from reading user
// files directly. For custom sidekick images we fetch the bytes over IPC and
// turn them into a `blob:` URL that an <img> tag can load. A small in-memory
// cache means switching back and forth between images in the same session
// doesn't re-fetch from main.
export const blobUrlCache = new Map<string, string>()

export type DetectedSpriteCacheEntry = {
  frames: DetectedFrame[]
  /** Per-frame image bitmaps drawn from the keyed canvas. The overlay paints
   *  these onto its own canvas one at a time, so we can crop irregular sheets
   *  without forcing the manifest to declare a uniform grid. */
  bitmaps: ImageBitmap[]
  /** Manifest-declared playback speed; the overlay falls back to 8 fps when
   *  the bundle didn't declare one. */
  fps: number
}
export const detectedSpriteCache = new Map<string, DetectedSpriteCacheEntry>()

export async function loadCustomBlobUrl(
  id: string,
  fileName: string,
  mimeType: string,
  kind?: 'image' | 'bundle',
  spriteFps?: number
): Promise<string | null> {
  const cached = blobUrlCache.get(id)
  if (cached) {
    return cached
  }
  // Why: defensively clear any stale entry so we don't leak a prior blob URL
  // or ImageBitmap[] when re-populating after a cache miss.
  revokeCustomSidekickBlobUrl(id)
  const buffer = await window.api.sidekick.read(id, fileName, kind)
  if (!buffer) {
    return null
  }
  // Why: MIME comes from CustomSidekick.mimeType — required especially for
  // SVG, which browsers refuse to render from a blob URL with the wrong
  // Content-Type.
  const blob = new Blob([buffer], { type: mimeType })
  let url = URL.createObjectURL(blob)
  // Why: pet bundles often ship spritesheets with a magenta chroma-key as
  // the background instead of true alpha (common in pixel-art tooling).
  // Strip it once at load and replace the cached URL with a transparent PNG
  // so the overlay just sees a normal blob URL.
  if (kind === 'bundle' && mimeType !== 'image/svg+xml') {
    const processed = await processBundleSheet(url, spriteFps)
    if (processed) {
      URL.revokeObjectURL(url)
      url = processed.url
      if (processed.detected) {
        detectedSpriteCache.set(id, processed.detected)
      }
    }
  }
  blobUrlCache.set(id, url)
  return url
}

async function processBundleSheet(
  srcUrl: string,
  spriteFps?: number
): Promise<{ url: string; detected: DetectedSpriteCacheEntry | null } | null> {
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
    // Why: detect frames *after* keying so transparent gutters between
    // sprites are visible to the band/column scanner. Without this the whole
    // sheet collapses into one giant frame.
    let detected: DetectedSpriteCacheEntry | null = null
    const sprite = detectFramesFromImageData(data)
    if (sprite && sprite.frames.length >= 1) {
      // Why: allSettled so a single failed crop doesn't leak the bitmaps that
      // did succeed — close fulfilled ones before bailing out.
      const results = await Promise.allSettled(
        sprite.frames.map((f) => createImageBitmap(canvas, f.x, f.y, f.w, f.h))
      )
      const rejected = results.some((r) => r.status === 'rejected')
      if (rejected) {
        for (const r of results) {
          if (r.status === 'fulfilled') {r.value.close()}
        }
        return null
      }
      const bitmaps = results.map((r) => (r as PromiseFulfilledResult<ImageBitmap>).value)
      detected = { frames: sprite.frames, bitmaps, fps: spriteFps ?? 8 }
    }
    const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
    if (!out) {
      return null
    }
    return { url: URL.createObjectURL(out), detected }
  } catch {
    return null
  }
}

// Why: WebP/JPEG-compressed magenta keys leave wide gradient halos around
// each sprite, so a tight RGB-distance check leaves ugly fringing. We use a
// hue-style test instead: the magenta family has R and B much greater than
// G. Anything matching gets fully cleared; anything close gets proportional
// alpha so antialiased edges fade smoothly.
function magentaScore(r: number, g: number, b: number): number {
  // 0 = not magenta, 1 = pure magenta key. Requires both red and blue to
  // dominate green (the signature of any magenta shade), and rejects greys
  // / dark pixels which can otherwise have low-but-equal channels.
  if (r < 100 || b < 100) {return 0}
  const minRB = Math.min(r, b)
  if (g >= minRB) {return 0}
  const dom = (minRB - g) / 255 // how much R and B dominate green
  return Math.max(0, Math.min(1, dom * 1.4))
}

function keyMagenta(px: Uint8ClampedArray): void {
  for (let i = 0; i < px.length; i += 4) {
    const score = magentaScore(px[i], px[i + 1], px[i + 2])
    if (score <= 0) {continue}
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

// Why: the store invokes this on removeCustomSidekick so the underlying Blob
// is released; otherwise the blob: URL keeps it alive for the rest of the
// session, wasting memory per imported image.
export function revokeCustomSidekickBlobUrl(id: string): void {
  const url = blobUrlCache.get(id)
  if (url) {
    URL.revokeObjectURL(url)
    blobUrlCache.delete(id)
  }
  const detected = detectedSpriteCache.get(id)
  if (detected) {
    for (const bmp of detected.bitmaps) {bmp.close()}
    detectedSpriteCache.delete(id)
  }
}
