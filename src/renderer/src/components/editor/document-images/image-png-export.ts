import {
  CLIPBOARD_IMAGE_MAX_PIXELS,
  CLIPBOARD_IMAGE_TOO_LARGE_ERROR,
  assertClipboardImageDimensionsWithinLimit
} from '../../../../../shared/clipboard-image'
import type { PanZoomSize } from '../../../../../shared/pan-zoom-view'
import { svgMarkupDataUri } from '../../../../../shared/file-preview/svg-document'
import { blobToBase64, convertImageBlobToPng } from '../../../lib/clipboard/images/image-blob-png'

const PREFERRED_PIXEL_RATIO = 2
// Chromium returns a blank canvas when a side exceeds this.
const MAX_CANVAS_SIDE = 16384

export type ImagePngLayout = { width: number; height: number; pixelRatio: number }

/** Vectors render at 2x for crisp text, scaled down to fit the clipboard pixel budget and Chromium's canvas limit. */
export function imagePngLayout(
  size: PanZoomSize,
  maxPixels = CLIPBOARD_IMAGE_MAX_PIXELS
): ImagePngLayout | null {
  if (!(size.width > 0 && size.height > 0)) {
    return null
  }
  const pixelRatio = Math.min(
    PREFERRED_PIXEL_RATIO,
    Math.sqrt(maxPixels / (size.width * size.height)),
    MAX_CANVAS_SIDE / Math.max(size.width, size.height)
  )
  return {
    width: Math.max(1, Math.floor(size.width * pixelRatio)),
    height: Math.max(1, Math.floor(size.height * pixelRatio)),
    pixelRatio
  }
}

// Copies keep full size or fail, never silently shrink.
function rasterPngLayout(size: PanZoomSize): ImagePngLayout | null {
  if (!(size.width > 0 && size.height > 0)) {
    return null
  }
  assertClipboardImageDimensionsWithinLimit(size)
  if (Math.max(size.width, size.height) > MAX_CANVAS_SIDE) {
    throw new Error(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
  }
  return { width: size.width, height: size.height, pixelRatio: 1 }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Could not load image'))
    // A web image drawn without CORS taints the canvas; servers that allow CORS can then be copied.
    if (/^https?:/i.test(src)) {
      image.crossOrigin = 'anonymous'
    }
    image.src = src
  })
}

async function fetchImageBlob(src: string): Promise<Blob | null> {
  try {
    const response = await fetch(src)
    return response.ok ? await response.blob() : null
  } catch {
    return null
  }
}

/** A raster keeps its own size like a file copy; a vector renders at 2x. */
export async function imageClipboardPngDataUrl(
  src: string,
  size: PanZoomSize,
  background: string | null
): Promise<string> {
  // Sources fetch can't read (e.g. orca-media://) still draw through an <img> at natural size.
  const blob = await fetchImageBlob(src)
  const type = blob?.type.split(';', 1)[0] ?? ''
  if (blob && type.startsWith('image/') && type !== 'image/svg+xml') {
    return `data:image/png;base64,${await blobToBase64(await convertImageBlobToPng(blob))}`
  }
  return renderImagePngDataUrl(src, size, background, type === 'image/svg+xml')
}

// Chromium taints a canvas drawn from a blob-URL SVG with HTML (foreignObject) labels; a data URL does not.
async function drawableSrc(src: string): Promise<string> {
  if (!src.startsWith('blob:')) {
    return src
  }
  const blob = await (await fetch(src)).blob()
  return blob.type === 'image/svg+xml' ? svgMarkupDataUri(await blob.text()) : src
}

/** Rasterizes an image, vectors included, to a PNG data URL; `background` keeps light-on-dark diagrams readable when pasted. */
export async function renderImagePngDataUrl(
  src: string,
  size: PanZoomSize,
  background: string | null,
  vector: boolean
): Promise<string> {
  const layout = vector ? imagePngLayout(size) : rasterPngLayout(size)
  if (!layout) {
    throw new Error('Image has no size')
  }
  const image = await loadImage(await drawableSrc(src))
  const canvas = document.createElement('canvas')
  canvas.width = layout.width
  canvas.height = layout.height
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Canvas is unavailable')
  }
  if (background) {
    context.fillStyle = background
    context.fillRect(0, 0, canvas.width, canvas.height)
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}
