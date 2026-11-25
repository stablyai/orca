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

type DataUriParts = { mimeType: string; base64: boolean; payload: string }

function readDataUri(dataUri: string): DataUriParts | null {
  const match = /^data:([^;,]+)((?:;[^,]*)?),([\s\S]*)$/i.exec(dataUri)
  if (!match) {
    return null
  }
  const parameters = match[2].split(';').filter(Boolean)
  return {
    mimeType: match[1],
    base64: parameters.some((parameter) => parameter.toLowerCase() === 'base64'),
    payload: match[3]
  }
}

/** Preserves non-raster data URIs and rejects unsafe known-raster data URIs. */
export function validateRasterImageDataUri(dataUri: string): string | null {
  const parts = readDataUri(dataUri)
  if (!parts || !isKnownRasterImageMimeType(parts.mimeType)) {
    return dataUri
  }
  return parts.base64 ? buildImageDataUri(parts.mimeType, parts.payload) : null
}

/** The type and whitespace-free base64 of a known-raster base64 data URI, or null for anything else. */
export function readRasterImageDataUri(
  dataUri: string
): { mimeType: string; base64: string } | null {
  const parts = readDataUri(dataUri)
  if (!parts?.base64 || !isKnownRasterImageMimeType(parts.mimeType)) {
    return null
  }
  const base64 = parts.payload.replace(/\s/g, '')
  return base64 ? { mimeType: parts.mimeType, base64 } : null
}
