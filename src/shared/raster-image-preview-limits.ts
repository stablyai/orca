import {
  isRasterImageDimensionMimeType,
  readRasterImageDimensionsForMimeType,
  type RasterImageDimensions
} from './raster-image-dimensions'

export const MAX_RASTER_IMAGE_PREVIEW_DIMENSION_PX = 32_768
export const MAX_RASTER_IMAGE_PREVIEW_PIXELS = 32 * 1024 * 1024
// Bounds the transient decode buffer, not the image. 1 MiB cut off valid photos whose SOF sits past
// a large ICC/MPF block; 8 MiB clears every real-world metadata layout while staying a fraction of
// the base64 string the caller already holds.
export const RASTER_IMAGE_PREVIEW_HEADER_MAX_BYTES = 8 * 1024 * 1024
export const INVALID_RASTER_IMAGE_PREVIEW_ERROR =
  'Image preview has invalid or unsupported raster dimensions'
export const RASTER_IMAGE_PREVIEW_TOO_LARGE_ERROR =
  'Image dimensions exceed the preview safety limit'

/** Bare lowercase media type with parameters such as `; charset=` stripped, or null when empty. */
function normalizeMimeType(mimeType: string | undefined): string | null {
  const normalized = mimeType?.split(';', 1)[0]?.trim().toLowerCase()
  return normalized || null
}

/** True when the declared type is a raster family this module can measure without decoding. */
export function isKnownRasterImageMimeType(mimeType: string | undefined): boolean {
  const normalized = normalizeMimeType(mimeType)
  return normalized !== null && isRasterImageDimensionMimeType(normalized)
}

/** Checks unknown input against the per-side and total-pixel preview caps without overflowing. */
export function isRasterImagePreviewDimensions(value: unknown): value is RasterImageDimensions {
  if (!value || typeof value !== 'object') {
    return false
  }
  const dimensions = value as Partial<RasterImageDimensions>
  return (
    Number.isSafeInteger(dimensions.width) &&
    Number.isSafeInteger(dimensions.height) &&
    dimensions.width! > 0 &&
    dimensions.height! > 0 &&
    dimensions.width! <= MAX_RASTER_IMAGE_PREVIEW_DIMENSION_PX &&
    dimensions.height! <= MAX_RASTER_IMAGE_PREVIEW_DIMENSION_PX &&
    dimensions.width! <= Math.floor(MAX_RASTER_IMAGE_PREVIEW_PIXELS / dimensions.height!)
  )
}

/** Validates encoded raster dimensions without invoking a native image decoder. */
export function assertRasterImagePreviewWithinLimits(
  bytes: Uint8Array,
  mimeType: string | undefined
): RasterImageDimensions | undefined {
  const normalized = normalizeMimeType(mimeType)
  if (normalized === null || !isRasterImageDimensionMimeType(normalized)) {
    return undefined
  }
  // Why: the caller forwards bytes under the declared type, so another raster family's bytes
  // (JPEG labelled image/png) must not pass as valid.
  const dimensions = readRasterImageDimensionsForMimeType(bytes, normalized)
  if (!dimensions) {
    throw new Error(INVALID_RASTER_IMAGE_PREVIEW_ERROR)
  }
  if (!isRasterImagePreviewDimensions(dimensions)) {
    throw new Error(RASTER_IMAGE_PREVIEW_TOO_LARGE_ERROR)
  }
  return dimensions
}
