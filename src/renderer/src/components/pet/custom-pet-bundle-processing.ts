import { isCustomPetSheetSizeSafe } from '../../../../shared/custom-pet-media-limits'
import { detectFramesFromImageData } from './sprite-frame-detection'
import type { DetectedSpriteCacheEntry } from './custom-pet-media-types'

export type ProcessedCustomPetBundle =
  | { kind: 'rejected' }
  | {
      kind: 'processed'
      url: string
      detected: DetectedSpriteCacheEntry | null
      retainedBytes: number
    }

function closeDetectedSprite(entry: DetectedSpriteCacheEntry | null): void {
  for (const bitmap of entry?.bitmaps ?? []) {
    bitmap.close()
  }
}

function estimateDetectedSpriteBytes(entry: DetectedSpriteCacheEntry | null): number {
  if (!entry) {
    return 0
  }
  return entry.frames.reduce((bytes, frame) => bytes + frame.w * frame.h * 4, 0)
}

export async function processCustomPetBundleSheet(
  srcUrl: string,
  spriteFps?: number,
  skipDetection?: boolean
): Promise<ProcessedCustomPetBundle | null> {
  let detected: DetectedSpriteCacheEntry | null = null
  try {
    const img = await loadImage(srcUrl)
    if (!isCustomPetSheetSizeSafe(img.naturalWidth, img.naturalHeight)) {
      return { kind: 'rejected' }
    }
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
    // Why: detection needs keyed transparent gutters; manifest-backed sheets
    // skip bitmap crops because CSS reads the declared grid directly.
    const sprite = skipDetection ? null : detectFramesFromImageData(data)
    if (sprite && sprite.frames.length >= 1) {
      const results = await Promise.allSettled(
        sprite.frames.map((frame) => createImageBitmap(canvas, frame.x, frame.y, frame.w, frame.h))
      )
      const rejected = results.some((result) => result.status === 'rejected')
      if (rejected) {
        // Why: a partial crop failure still permits the keyed static sheet,
        // but every successful orphan bitmap must be closed first.
        for (const result of results) {
          if (result.status === 'fulfilled') {
            result.value.close()
          }
        }
      } else {
        const bitmaps = results.map(
          (result) => (result as PromiseFulfilledResult<ImageBitmap>).value
        )
        detected = { frames: sprite.frames, bitmaps, fps: spriteFps ?? 8 }
      }
    }
    const output = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!output) {
      closeDetectedSprite(detected)
      return null
    }
    try {
      return {
        kind: 'processed',
        url: URL.createObjectURL(output),
        detected,
        retainedBytes: output.size + estimateDetectedSpriteBytes(detected)
      }
    } catch {
      closeDetectedSprite(detected)
      return null
    }
  } catch {
    closeDetectedSprite(detected)
    return null
  }
}

// Why: compressed magenta keys leave gradient halos, so clear strongly
// magenta pixels and proportionally fade the antialiased edge family.
function magentaScore(red: number, green: number, blue: number): number {
  const minimumRedBlue = Math.min(red, blue)
  if (green >= minimumRedBlue) {
    return 0
  }
  const dominance = (minimumRedBlue - green) / 255
  return dominance <= 0.4 ? 0 : Math.max(0, Math.min(1, dominance * 1.4))
}

function keyMagenta(pixels: Uint8ClampedArray): void {
  for (let index = 0; index < pixels.length; index += 4) {
    const score = magentaScore(pixels[index], pixels[index + 1], pixels[index + 2])
    if (score <= 0) {
      continue
    }
    if (score >= 0.5) {
      pixels[index] = 0
      pixels[index + 1] = 0
      pixels[index + 2] = 0
      pixels[index + 3] = 0
      continue
    }
    pixels[index + 3] = Math.round(pixels[index + 3] * Math.max(0, 1 - score * 2))
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('image load failed'))
    image.src = url
  })
}
