export const CLIPBOARD_IMAGE_MAX_BASE64_CHARS = 24 * 1024 * 1024
export const CLIPBOARD_IMAGE_MAX_SOURCE_BYTES = Math.floor(
  (CLIPBOARD_IMAGE_MAX_BASE64_CHARS / 4) * 3
)
export const CLIPBOARD_IMAGE_MAX_PIXELS = 32 * 1024 * 1024
export const CLIPBOARD_IMAGE_TOO_LARGE_ERROR = 'Clipboard image is too large'

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

/** Bound previews for fast IPC while full clipboard images finish writing. */
export const CLIPBOARD_IMAGE_THUMBNAIL_MAX_EDGE = 320

export type ClipboardImageThumbnail = ClipboardImageDimensions & {
  /** `data:image/png;base64,...` preview of the clipboard image. */
  dataUrl: string
}

/** Fit the thumbnail budget; preserve already-small dimensions so callers skip resizing. */
export function clipboardImageThumbnailSize({
  height,
  width
}: ClipboardImageDimensions): ClipboardImageDimensions {
  const longestEdge = Math.max(width, height)
  if (longestEdge <= CLIPBOARD_IMAGE_THUMBNAIL_MAX_EDGE) {
    return { height, width }
  }
  const scale = CLIPBOARD_IMAGE_THUMBNAIL_MAX_EDGE / longestEdge
  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale))
  }
}

/** Clipboard formats are MIME types, so image presence needs no decode. */
export function clipboardFormatsIncludeImage(formats: readonly string[]): boolean {
  return formats.some((format) => format.startsWith('image/'))
}
