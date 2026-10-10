// Composites the frozen base screenshot + markup shapes into a single PNG under
// the delivery byte and pixel budgets (PNG only — see MarkupComposeResult).
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
  // Why: PNG only — the clipboard:writeImage handler accepts a PNG data URL and
  // silently drops anything else, so a JPEG fallback would "succeed" with an
  // empty clipboard.
  mimeType: 'image/png'
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
  /** Hard pixel (width×height) ceiling — the clipboard handler silently drops
   *  images over its own dimension limit, so the composite must fit it too. */
  maxPixels: number
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

// The single uniform scale actually applied to the base image and every shape:
// the clamped output scale, reduced further if needed so the composite's pixel
// area stays within `maxPixels`. Reducing one uniform factor keeps strokes aligned.
export function effectiveMarkupScale(
  displayCssWidth: number,
  displayCssHeight: number,
  outputScale: number,
  maxPixels: number = Number.POSITIVE_INFINITY
): number {
  const scale = clampMarkupScale(outputScale)
  const area = displayCssWidth * displayCssHeight
  if (area <= 0 || !Number.isFinite(maxPixels) || maxPixels <= 0) {
    return scale
  }
  return Math.min(scale, Math.sqrt(maxPixels / area))
}

export function markupCanvasSize(
  displayCssWidth: number,
  displayCssHeight: number,
  outputScale: number,
  maxPixels: number = Number.POSITIVE_INFINITY
): { width: number; height: number } {
  const scale = effectiveMarkupScale(displayCssWidth, displayCssHeight, outputScale, maxPixels)
  // Why: floor (not round) so a rounded-up dimension can't nudge the area back
  // over maxPixels at the budget boundary.
  return {
    width: Math.max(1, Math.floor(displayCssWidth * scale)),
    height: Math.max(1, Math.floor(displayCssHeight * scale))
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

// Progressive raster sizes (full, then shrink) tried to fit the byte budget.
// PNG at every step — never JPEG (see MarkupComposeResult).
export const MARKUP_DOWNSCALE_STEPS = [1, 0.85, 0.7, 0.55, 0.4, 0.3] as const

// ─── Canvas raster (thin) ───────────────────────────────────────────────────

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return canvas
}

function renderComposite(input: MarkupComposeInput): HTMLCanvasElement {
  const scale = effectiveMarkupScale(
    input.displayCssWidth,
    input.displayCssHeight,
    input.outputScale,
    input.maxPixels
  )
  const size = markupCanvasSize(
    input.displayCssWidth,
    input.displayCssHeight,
    input.outputScale,
    input.maxPixels
  )
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

// Encodes a canvas to a PNG data URL. Prefers toBlob because Chromium encodes it
// off the main thread — a multi-megapixel toData('image/png') is synchronous and
// freezes the renderer. Falls back to the sync encode if toBlob yields no blob.
function canvasToPngDataUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        try {
          resolve(canvas.toDataURL('image/png'))
        } catch (error) {
          reject(error instanceof Error ? error : new Error('markup compose: toDataURL failed'))
        }
        return
      }
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error ?? new Error('markup compose: blob read failed'))
      reader.readAsDataURL(blob)
    }, 'image/png')
  })
}

// Encodes a PNG within budget: full size, then progressively smaller. Always
// returns a PNG (best effort at the smallest step) so the clipboard handler
// accepts it and delivery never silently drops. Async so the per-step PNG encode
// runs off the main thread instead of blocking the renderer.
export async function composeMarkupDataUrl(
  input: MarkupComposeInput
): Promise<MarkupComposeResult> {
  const composite = renderComposite(input)

  let smallest: MarkupComposeResult | null = null
  for (const step of MARKUP_DOWNSCALE_STEPS) {
    const canvas = downscaleCanvas(composite, step)
    const dataUrl = await canvasToPngDataUrl(canvas)
    const byteLength = dataUrlByteLength(dataUrl)
    const result: MarkupComposeResult = {
      dataUrl,
      mimeType: 'image/png',
      width: canvas.width,
      height: canvas.height,
      byteLength
    }
    if (byteLength <= input.maxBytes) {
      return result
    }
    smallest = result
  }

  // Why: still over the byte budget at the smallest step — return it anyway. It's
  // a PNG within the pixel budget (every step is), so the clipboard handler
  // accepts it; a slightly large attachment beats dropping the user's markup.
  if (!smallest) {
    // Unreachable: MARKUP_DOWNSCALE_STEPS is non-empty, so the loop always sets it.
    throw new Error('markup compose: no downscale step produced output')
  }
  return smallest
}
