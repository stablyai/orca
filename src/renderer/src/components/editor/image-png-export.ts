import { CLIPBOARD_IMAGE_MAX_PIXELS } from '../../../../shared/clipboard-image'
import type { PanZoomSize } from '../../../../shared/pan-zoom-view'
import { svgMarkupDataUri } from '../../../../shared/svg-document'

const PREFERRED_PIXEL_RATIO = 2
// Chromium returns a blank canvas when a side exceeds this.
const MAX_CANVAS_SIDE = 16384

export type ImagePngLayout = { width: number; height: number; pixelRatio: number }

/** 2x for crisp text, scaled down to fit the clipboard pixel budget and Chromium's canvas limit. */
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
  background: string | null
): Promise<string> {
  const layout = imagePngLayout(size)
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
