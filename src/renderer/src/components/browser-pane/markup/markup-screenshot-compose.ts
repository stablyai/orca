// Composites the frozen base screenshot + markup shapes into a single PNG (or
// JPEG fallback) under the delivery byte budget.
//
// WYSIWYG: the output canvas matches the on-screen content box (its CSS width ×
// height) times an output scale for crispness. The base image is stretched to
// fill that box exactly as the user saw it (so a distorted objectFit:fill remote
// frame composites correctly), and shapes — authored in CSS coordinates — are
// scaled by the same single factor. One uniform scale keeps strokes aligned.

import { scaleShape, type MarkupShape } from './markup-drawing-model'
import { drawShapes } from './markup-shape-render'

export type MarkupComposeResult = {
  dataUrl: string
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
  byteLength: number
}

export type MarkupComposeInput = {
  image: CanvasImageSource
  /** On-screen size of the content box the canvas overlaid (CSS pixels). */
  displayCssWidth: number
  displayCssHeight: number
  /** Output resolution multiplier (typically devicePixelRatio). */
  outputScale: number
  shapes: readonly MarkupShape[]
  /** Hard byte ceiling for the encoded data URL payload. */
  maxBytes: number
}

// ─── Pure helpers (unit-tested) ─────────────────────────────────────────────

// Keep the output scale sane so a huge DPR or bogus value can't allocate an
// absurd canvas.
export function clampMarkupScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) {
    return 1
  }
  return Math.min(Math.max(scale, 1), 4)
}

export function markupCanvasSize(
  displayCssWidth: number,
  displayCssHeight: number,
  outputScale: number
): { width: number; height: number } {
  const scale = clampMarkupScale(outputScale)
  return {
    width: Math.max(1, Math.round(displayCssWidth * scale)),
    height: Math.max(1, Math.round(displayCssHeight * scale))
  }
}

// Bytes represented by a `data:...;base64,<payload>` URL's payload.
export function dataUrlByteLength(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex === -1) {
    return 0
  }
  const payload = dataUrl.slice(commaIndex + 1)
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

// Progressive raster sizes (full, then shrink) tried before falling back to JPEG.
export const MARKUP_DOWNSCALE_STEPS = [1, 0.8, 0.65, 0.5] as const
export const MARKUP_JPEG_QUALITIES = [0.85, 0.65, 0.45] as const

// ─── Canvas raster (thin) ───────────────────────────────────────────────────

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return canvas
}

function renderComposite(input: MarkupComposeInput): HTMLCanvasElement {
  const scale = clampMarkupScale(input.outputScale)
  const size = markupCanvasSize(input.displayCssWidth, input.displayCssHeight, scale)
  const canvas = createCanvas(size.width, size.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('markup compose: 2d context unavailable')
  }
  ctx.drawImage(input.image, 0, 0, size.width, size.height)
  for (const shape of input.shapes) {
    drawShapes(ctx, [scaleShape(shape, scale)])
  }
  return canvas
}

function downscaleCanvas(source: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  if (factor >= 1) {
    return source
  }
  const next = createCanvas(source.width * factor, source.height * factor)
  const ctx = next.getContext('2d')
  if (!ctx) {
    return source
  }
  ctx.drawImage(source, 0, 0, next.width, next.height)
  return next
}

// Encodes within budget: full PNG, then progressively smaller PNGs, then JPEG.
// Always returns something (best effort) so delivery never silently drops.
export function composeMarkupDataUrl(input: MarkupComposeInput): MarkupComposeResult {
  const composite = renderComposite(input)

  for (const step of MARKUP_DOWNSCALE_STEPS) {
    const canvas = downscaleCanvas(composite, step)
    const dataUrl = canvas.toDataURL('image/png')
    const byteLength = dataUrlByteLength(dataUrl)
    if (byteLength <= input.maxBytes) {
      return {
        dataUrl,
        mimeType: 'image/png',
        width: canvas.width,
        height: canvas.height,
        byteLength
      }
    }
  }

  let last: MarkupComposeResult | null = null
  for (const quality of MARKUP_JPEG_QUALITIES) {
    const dataUrl = composite.toDataURL('image/jpeg', quality)
    const byteLength = dataUrlByteLength(dataUrl)
    last = {
      dataUrl,
      mimeType: 'image/jpeg',
      width: composite.width,
      height: composite.height,
      byteLength
    }
    if (byteLength <= input.maxBytes) {
      return last
    }
  }

  // Why: even if still over budget, return the smallest JPEG — a slightly large
  // attachment is better than dropping the user's markup entirely.
  return (
    last ?? {
      dataUrl: composite.toDataURL('image/png'),
      mimeType: 'image/png',
      width: composite.width,
      height: composite.height,
      byteLength: 0
    }
  )
}
