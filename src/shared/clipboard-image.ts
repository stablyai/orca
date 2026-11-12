export const CLIPBOARD_IMAGE_MAX_BASE64_CHARS = 24 * 1024 * 1024
export const CLIPBOARD_IMAGE_MAX_SOURCE_BYTES = Math.floor(
  (CLIPBOARD_IMAGE_MAX_BASE64_CHARS / 4) * 3
)
export const CLIPBOARD_IMAGE_MAX_PIXELS = 32 * 1024 * 1024
export const CLIPBOARD_IMAGE_TOO_LARGE_ERROR = 'Clipboard image is too large'
// Agents downscale to about this edge anyway, and Anthropic refuses images over 5 MiB of base64.
export const AGENT_IMAGE_MAX_LONG_EDGE = 2000
export const AGENT_IMAGE_MAX_BYTES = Math.floor(((5 * 1024 * 1024) / 4) * 3)

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

// Each retry shrinks the edge by at least 10%, so a few encodes reach the cap.
const CLIPBOARD_IMAGE_FIT_ATTEMPTS = 6
const CLIPBOARD_IMAGE_FIT_MARGIN = 0.9

function scaleClipboardImageDimensions(
  { height, width }: ClipboardImageDimensions,
  scale: number
): ClipboardImageDimensions {
  return {
    height: Math.max(1, Math.floor(height * scale)),
    width: Math.max(1, Math.floor(width * scale))
  }
}

/** Re-encoded pastes can outgrow the caps their source met, so shrink instead of rejecting. */
export async function encodeClipboardImageWithinLimit<T>(
  source: ClipboardImageDimensions,
  encode: (size: ClipboardImageDimensions) => T | Promise<T>,
  byteLength: (encoded: T) => number,
  maxBytes: number = CLIPBOARD_IMAGE_MAX_SOURCE_BYTES
): Promise<T> {
  const { height, width } = source
  if (!Number.isFinite(width * height) || width <= 0 || height <= 0) {
    throw new Error(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
  }
  let size =
    width * height > CLIPBOARD_IMAGE_MAX_PIXELS
      ? scaleClipboardImageDimensions(
          source,
          Math.sqrt(CLIPBOARD_IMAGE_MAX_PIXELS / (width * height))
        )
      : source
  for (let attempt = 0; attempt < CLIPBOARD_IMAGE_FIT_ATTEMPTS; attempt += 1) {
    const encoded = await encode(size)
    const bytes = byteLength(encoded)
    if (bytes <= maxBytes) {
      return encoded
    }
    const next = scaleClipboardImageDimensions(
      size,
      CLIPBOARD_IMAGE_FIT_MARGIN * Math.min(1, Math.sqrt(maxBytes / bytes))
    )
    if (next.width === size.width && next.height === size.height) {
      break
    }
    size = next
  }
  throw new Error(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
}

/** Bound previews for fast IPC while full clipboard images finish writing. */
export const CLIPBOARD_IMAGE_THUMBNAIL_MAX_EDGE = 320

export type ClipboardImageThumbnail = ClipboardImageDimensions & {
  /** `data:image/png;base64,...` preview of the clipboard image. */
  dataUrl: string
}

/** Fit the thumbnail budget; preserve already-small dimensions so callers skip resizing. */
export function clipboardImageThumbnailSize(
  size: ClipboardImageDimensions
): ClipboardImageDimensions {
  return clipboardImageSizeWithinEdge(size, CLIPBOARD_IMAGE_THUMBNAIL_MAX_EDGE)
}

/** Preserve already-small dimensions so callers can skip resizing. */
export function clipboardImageSizeWithinEdge(
  { height, width }: ClipboardImageDimensions,
  maxEdge: number
): ClipboardImageDimensions {
  const longestEdge = Math.max(width, height)
  if (longestEdge <= maxEdge) {
    return { height, width }
  }
  const scale = maxEdge / longestEdge
  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale))
  }
}

/** Clipboard formats are MIME types, so image presence needs no decode. */
export function clipboardFormatsIncludeImage(formats: readonly string[]): boolean {
  return formats.some((format) => format.startsWith('image/'))
}
