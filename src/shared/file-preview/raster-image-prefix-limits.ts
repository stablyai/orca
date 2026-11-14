import {
  RASTER_IMAGE_HEADER_PROBE_BYTES,
  RASTER_IMAGE_HEADER_PROBE_GROWTH
} from './raster-image-base64-preview'
import { readRasterImageDimensions } from './raster-image-dimensions'
import {
  isKnownRasterImageMimeType,
  isRasterImagePreviewDimensions,
  RASTER_IMAGE_PREVIEW_HEADER_MAX_BYTES
} from './raster-image-preview-limits'

/**
 * The base64 preview rule for an image read by URL: only a header proving it oversized refuses it.
 * `readPrefix(n)` returns the file's first n bytes, or fewer at EOF.
 */
export async function rasterImageExceedsPreviewLimits(
  readPrefix: (bytes: number) => Promise<Uint8Array>,
  mimeType: string | undefined
): Promise<boolean> {
  if (!isKnownRasterImageMimeType(mimeType)) {
    return false
  }
  let probeBytes = RASTER_IMAGE_HEADER_PROBE_BYTES
  for (;;) {
    const prefix = await readPrefix(probeBytes)
    const dimensions = readRasterImageDimensions(prefix)
    if (dimensions !== null) {
      return !isRasterImagePreviewDimensions(dimensions)
    }
    if (prefix.byteLength < probeBytes || probeBytes >= RASTER_IMAGE_PREVIEW_HEADER_MAX_BYTES) {
      return false
    }
    probeBytes = Math.min(
      probeBytes * RASTER_IMAGE_HEADER_PROBE_GROWTH,
      RASTER_IMAGE_PREVIEW_HEADER_MAX_BYTES
    )
  }
}
