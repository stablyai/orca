import { exceedsRasterImagePreviewLimits } from './raster-image-base64-preview'
import { isKnownRasterImageMimeType } from './raster-image-preview-limits'

// Share desktop/mobile image data URIs; remove line-wrapped base64 whitespace from Git/SSH and reject empty/non-image payloads.
export function buildImageDataUri(
  mimeType: string | undefined,
  base64Content: string
): string | null {
  if (!mimeType?.startsWith('image/')) {
    return null
  }
  const cleaned = base64Content.replace(/\s/g, '')
  if (!cleaned) {
    return null
  }
  // Suppress only proven oversized images; unreadable headers may belong to valid decoder-supported formats.
  if (exceedsRasterImagePreviewLimits(cleaned, mimeType)) {
    return null
  }
  return `data:${mimeType};base64,${cleaned}`
}

/** Preserves non-raster data URIs and rejects unsafe known-raster data URIs. */
export function validateRasterImageDataUri(dataUri: string): string | null {
  const match = /^data:([^;,]+)((?:;[^,]*)?),([\s\S]*)$/i.exec(dataUri)
  if (!match || !isKnownRasterImageMimeType(match[1])) {
    return dataUri
  }
  const parameters = match[2].split(';').filter(Boolean)
  if (!parameters.some((parameter) => parameter.toLowerCase() === 'base64')) {
    return null
  }
  return buildImageDataUri(match[1], match[3])
}
