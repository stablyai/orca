import { readRasterImageDimensions, type RasterImageDimensions } from './raster-image-dimensions'

export const MAX_RASTER_IMAGE_PREVIEW_DIMENSION_PX = 32_768
export const MAX_RASTER_IMAGE_PREVIEW_PIXELS = 32 * 1024 * 1024
export const RASTER_IMAGE_PREVIEW_HEADER_MAX_BYTES = 1024 * 1024
export const INVALID_RASTER_IMAGE_PREVIEW_ERROR =
  'Image preview has invalid or unsupported raster dimensions'
export const RASTER_IMAGE_PREVIEW_TOO_LARGE_ERROR =
  'Image dimensions exceed the preview safety limit'

const RASTER_IMAGE_MIME_TYPES = new Set([
  'image/apng',
  'image/bmp',
  'image/gif',
  'image/ico',
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/png',
  'image/vnd.microsoft.icon',
  'image/webp',
  'image/x-bmp',
  'image/x-icon',
  'image/x-ms-bmp'
])

function normalizeMimeType(mimeType: string | undefined): string | null {
  const normalized = mimeType?.split(';', 1)[0]?.trim().toLowerCase()
  return normalized || null
}

export function isKnownRasterImageMimeType(mimeType: string | undefined): boolean {
  const normalized = normalizeMimeType(mimeType)
  return normalized !== null && RASTER_IMAGE_MIME_TYPES.has(normalized)
}

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
  if (!isKnownRasterImageMimeType(mimeType)) {
    return undefined
  }
  const dimensions = readRasterImageDimensions(bytes)
  if (!dimensions) {
    throw new Error(INVALID_RASTER_IMAGE_PREVIEW_ERROR)
  }
  if (!isRasterImagePreviewDimensions(dimensions)) {
    throw new Error(RASTER_IMAGE_PREVIEW_TOO_LARGE_ERROR)
  }
  return dimensions
}
