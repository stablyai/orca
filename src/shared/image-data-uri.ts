import { exceedsRasterImagePreviewLimits } from './raster-image-base64-preview'
import { isKnownRasterImageMimeType } from './raster-image-preview-limits'

// Builds an inline `data:` URI for base64 image bytes, shared by the desktop
// editor ImageViewer and the mobile file preview so both decode images the same
// way. Strips whitespace from the payload (base64 from git diffs and SSH streams
// can arrive line-wrapped) and returns null when there is nothing an <img>/RN
// <Image> can show — empty content or a non-image mime (PDF, octet-stream, …).
export function buildImageDataUri(
  mimeType: string | undefined,
  base64Content: string
): string | null {
  // Only image/* renders in an <img>/RN <Image>; reject every other mime
  // (application/pdf, application/octet-stream, …), not just PDF.
  if (!mimeType?.startsWith('image/')) {
    return null
  }
  const cleaned = base64Content.replace(/\s/g, '')
  if (!cleaned) {
    return null
  }
  // Only suppress when the header says the image is too large to render safely. An unreadable
  // header is not evidence of an oversized image, and the decoder handles formats we cannot parse.
  if (exceedsRasterImagePreviewLimits(cleaned, mimeType)) {
    return null
  }
  return `data:${mimeType};base64,${cleaned}`
}

/** Preserves non-raster data URIs and rejects unsafe known-raster data URIs. */
export function validateRasterImageDataUri(dataUri: string): string | null {
  const match = /^data:([^;,]+)((?:;[^,]*)*),([\s\S]*)$/i.exec(dataUri)
  if (!match || !isKnownRasterImageMimeType(match[1])) {
    return dataUri
  }
  const parameters = match[2].split(';').filter(Boolean)
  if (!parameters.some((parameter) => parameter.toLowerCase() === 'base64')) {
    return null
  }
  return buildImageDataUri(match[1], match[3])
}
