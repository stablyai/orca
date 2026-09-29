import { CLIPBOARD_IMAGE_MAX_PIXELS } from '../../../../shared/clipboard-image'
import type { DiagramSize } from './mermaid-diagram-viewport'

const PREFERRED_PIXEL_RATIO = 2
// Why: Chromium refuses canvases with a side above this, returning a blank image.
const MAX_CANVAS_SIDE = 16384
export const DIAGRAM_PNG_PADDING = 16

export type DiagramPngLayout = { width: number; height: number; pixelRatio: number }

/**
 * Canvas size for exporting a diagram: 2x for crisp text, scaled down so the
 * image stays within the clipboard pixel budget (main silently drops larger
 * images) and Chromium's canvas side limit.
 */
export function diagramPngLayout(
  size: DiagramSize,
  maxPixels = CLIPBOARD_IMAGE_MAX_PIXELS
): DiagramPngLayout | null {
  const paddedWidth = size.width + DIAGRAM_PNG_PADDING * 2
  const paddedHeight = size.height + DIAGRAM_PNG_PADDING * 2
  if (!(size.width > 0 && size.height > 0)) {
    return null
  }
  const pixelRatio = Math.min(
    PREFERRED_PIXEL_RATIO,
    Math.sqrt(maxPixels / (paddedWidth * paddedHeight)),
    MAX_CANVAS_SIDE / Math.max(paddedWidth, paddedHeight)
  )
  return {
    width: Math.max(1, Math.floor(paddedWidth * pixelRatio)),
    height: Math.max(1, Math.floor(paddedHeight * pixelRatio)),
    pixelRatio
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Could not load diagram image'))
    image.src = url
  })
}

/**
 * Rasterizes a rendered mermaid SVG to a PNG data URL on an opaque background,
 * so light-on-dark diagrams stay readable when pasted into light documents.
 */
export async function renderDiagramSvgToPngDataUrl(
  svg: SVGSVGElement,
  size: DiagramSize,
  backgroundColor: string
): Promise<string> {
  const layout = diagramPngLayout(size)
  if (!layout) {
    throw new Error('Diagram has no size')
  }
  const clone = svg.cloneNode(true)
  if (!(clone instanceof SVGSVGElement)) {
    throw new Error('Diagram is not an SVG')
  }
  clone.setAttribute('width', String(size.width))
  clone.setAttribute('height', String(size.height))
  const markup = new XMLSerializer().serializeToString(clone)
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = await loadImage(url)
    const canvas = document.createElement('canvas')
    canvas.width = layout.width
    canvas.height = layout.height
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Canvas is unavailable')
    }
    context.fillStyle = backgroundColor
    context.fillRect(0, 0, canvas.width, canvas.height)
    const padding = DIAGRAM_PNG_PADDING * layout.pixelRatio
    context.drawImage(
      image,
      padding,
      padding,
      size.width * layout.pixelRatio,
      size.height * layout.pixelRatio
    )
    return canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(url)
  }
}
