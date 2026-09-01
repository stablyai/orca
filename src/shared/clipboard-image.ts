export const CLIPBOARD_IMAGE_MAX_BASE64_CHARS = 24 * 1024 * 1024
export const CLIPBOARD_IMAGE_MAX_SOURCE_BYTES = Math.floor(
  (CLIPBOARD_IMAGE_MAX_BASE64_CHARS / 4) * 3
)
export const CLIPBOARD_IMAGE_MAX_PIXELS = 32 * 1024 * 1024
export const CLIPBOARD_IMAGE_TOO_LARGE_ERROR = 'Clipboard image is too large'
// Why: PNG bytes don't scale exactly with pixel area, so undershoot and retry.
export const CLIPBOARD_IMAGE_DOWNSCALE_SAFETY = 0.85
export const CLIPBOARD_IMAGE_MAX_DOWNSCALE_ATTEMPTS = 3

export type ClipboardImageDimensions = {
  height: number
  width: number
}

export function assertClipboardImageBase64LengthWithinLimit(length: number): void {
  if (!Number.isFinite(length) || length > CLIPBOARD_IMAGE_MAX_BASE64_CHARS) {
    throw new Error(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
  }
}

export function assertClipboardImageByteLengthWithinLimit(byteLength: number): void {
  if (!Number.isFinite(byteLength) || byteLength > CLIPBOARD_IMAGE_MAX_SOURCE_BYTES) {
    throw new Error(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
  }
}

export function assertClipboardImageDimensionsWithinLimit({
  height,
  width
}: ClipboardImageDimensions): void {
  const pixelCount = width * height
  if (
    !Number.isFinite(pixelCount) ||
    width <= 0 ||
    height <= 0 ||
    pixelCount > CLIPBOARD_IMAGE_MAX_PIXELS
  ) {
    throw new Error(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
  }
}

function scaleClipboardImageDimensions(
  width: number,
  height: number,
  scale: number
): ClipboardImageDimensions | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    return null
  }
  const nextWidth = Math.max(1, Math.floor(width * scale))
  const nextHeight = Math.max(1, Math.floor(height * scale))
  // Guard against a no-op shrink (already 1px) so retry loops can't spin forever.
  if (nextWidth >= width && nextHeight >= height) {
    return null
  }
  return { width: nextWidth, height: nextHeight }
}

/** Target size so width*height fits under maxPixels, or null when already within budget. */
export function computeClipboardImagePixelDownscale(
  width: number,
  height: number,
  maxPixels: number = CLIPBOARD_IMAGE_MAX_PIXELS
): ClipboardImageDimensions | null {
  const pixelCount = width * height
  if (!Number.isFinite(pixelCount) || width <= 0 || height <= 0 || pixelCount <= maxPixels) {
    return null
  }
  if (!Number.isFinite(maxPixels) || maxPixels <= 0) {
    return null
  }
  return scaleClipboardImageDimensions(
    width,
    height,
    Math.sqrt(maxPixels / pixelCount) * CLIPBOARD_IMAGE_DOWNSCALE_SAFETY
  )
}

/**
 * Target size so an encoded payload (PNG bytes or base64 length) fits under maxEncodedSize.
 * Returns null when already within budget or dimensions cannot shrink further.
 */
export function computeClipboardImageEncodedSizeDownscale(
  encodedSize: number,
  width: number,
  height: number,
  maxEncodedSize: number
): ClipboardImageDimensions | null {
  if (
    !Number.isFinite(encodedSize) ||
    !Number.isFinite(maxEncodedSize) ||
    encodedSize <= maxEncodedSize ||
    maxEncodedSize <= 0
  ) {
    return null
  }
  return scaleClipboardImageDimensions(
    width,
    height,
    Math.sqrt(maxEncodedSize / encodedSize) * CLIPBOARD_IMAGE_DOWNSCALE_SAFETY
  )
}
