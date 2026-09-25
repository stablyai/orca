// Renders the live markup scene into the overlay canvas at device resolution.
// Committed shapes are rasterized once into an offscreen layer; the per-frame
// paint blits that layer and draws only the in-progress shape on top, so a fast
// pointermove stream never re-strokes the whole scene. Kept separate from the
// editor hook so the draw composition stays focused.
//
// Why the caller passes dpr: the committed layer and the visible canvas are sized
// in two separate paints. Reading window.devicePixelRatio independently in each
// could size them differently if the ratio changed between them (monitor move),
// misaligning the 1:1 blit. Taking one measured dpr keeps them in lockstep.

import { clampMarkupScale } from './markup-screenshot-compose'
import { drawShapes } from './markup-shape-render'
import type { MarkupShape } from './markup-drawing-model'

function sceneDevicePixels(
  cssWidth: number,
  cssHeight: number,
  dpr: number
): { scale: number; width: number; height: number } {
  // Why: clamp identically to the compositor so the live preview and the exported
  // PNG render shapes at the same scale.
  const scale = clampMarkupScale(dpr)
  return {
    scale,
    width: Math.max(1, Math.round(cssWidth * scale)),
    height: Math.max(1, Math.round(cssHeight * scale))
  }
}

// Rasterizes the committed shapes into an offscreen layer. Called only when the
// committed shape list, the size, or the dpr changes — never on the pointermove
// path.
export function renderCommittedLayer(
  layer: HTMLCanvasElement,
  shapes: readonly MarkupShape[],
  cssWidth: number,
  cssHeight: number,
  dpr: number
): void {
  const { scale, width, height } = sceneDevicePixels(cssWidth, cssHeight, dpr)
  if (layer.width !== width || layer.height !== height) {
    layer.width = width
    layer.height = height
  }
  const ctx = layer.getContext('2d')
  if (!ctx) {
    return
  }
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.clearRect(0, 0, cssWidth, cssHeight)
  drawShapes(ctx, shapes)
}

// Blits the cached committed layer plus the in-progress shape onto the visible
// canvas. Cheap enough for every frame: one image blit + at most one shape.
export function blitMarkupScene(
  canvas: HTMLCanvasElement,
  committedLayer: HTMLCanvasElement,
  inProgress: MarkupShape | null,
  cssWidth: number,
  cssHeight: number,
  dpr: number
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return
  }
  const { scale, width, height } = sceneDevicePixels(cssWidth, cssHeight, dpr)
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  // Why: blit the committed layer under the identity transform, stretched to the
  // canvas's device box. It's 1:1 when the layer matches (the common case, since
  // both are sized from the same dpr) and degrades gracefully — never clips or
  // offsets — if a layer render briefly lags a dpr change.
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, width, height)
  if (committedLayer.width > 0 && committedLayer.height > 0) {
    ctx.drawImage(committedLayer, 0, 0, width, height)
  }
  // Then switch to the dpr transform to draw the in-progress shape in CSS coords.
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  if (inProgress) {
    drawShapes(ctx, [inProgress])
  }
}
