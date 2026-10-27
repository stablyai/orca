// Stretch the base to the displayed CSS box, including distorted remote frames, then scale it and the shapes uniformly for aligned PNG output.

import { scaleShape, type MarkupShape } from './markup-drawing-model'
import { drawShapes } from './markup-shape-render'

export type MarkupComposeResult = {
  dataUrl: string
  // The clipboard handler silently rejects non-PNG data URLs; a JPEG fallback would leave it empty.
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
  /** Hard pixel ceiling; the clipboard handler silently rejects images exceeding its dimension limit. */
  maxPixels: number
}

// Clamp extreme or invalid DPR before allocating a canvas.
export function clampMarkupScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) {
    return 1
  }
  return Math.min(Math.max(scale, 1), 4)
}

// Reduce one uniform scale to meet the pixel budget without misaligning strokes.
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
  // Floor dimensions so rounding cannot push area back above maxPixels.
  return {
    width: Math.max(1, Math.floor(displayCssWidth * scale)),
    height: Math.max(1, Math.floor(displayCssHeight * scale))
  }
}

export function dataUrlByteLength(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex === -1) {
    return 0
  }
  const payload = dataUrl.slice(commaIndex + 1)
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

// Try progressively smaller PNGs; never fall back to JPEG because clipboard delivery requires PNG.
export const MARKUP_DOWNSCALE_STEPS = [1, 0.85, 0.7, 0.55, 0.4, 0.3] as const

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

// Prefer off-thread toBlob encoding to avoid freezing on large PNGs; use synchronous encoding only when it yields no blob.
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

// Try smaller PNGs asynchronously, returning the smallest as best effort if none meets the byte budget.
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

  // Keep the smallest PNG even above the byte target; its dimensions still meet the clipboard pixel limit.
  if (!smallest) {
    throw new Error('markup compose: no downscale step produced output')
  }
  return smallest
}
