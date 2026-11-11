// Cache committed raster ink between pointer moves; pass one measured DPR to both layers so a monitor move cannot misalign them.

import { clampMarkupScale } from './markup-screenshot-compose'
import { drawShapes } from './markup-shape-render'
import type { MarkupShape } from './markup-drawing-model'

function sceneDevicePixels(
  cssWidth: number,
  cssHeight: number,
  dpr: number
): { scale: number; width: number; height: number } {
  // Use the compositor’s scale clamp so preview and export agree.
  const scale = clampMarkupScale(dpr)
  return {
    scale,
    width: Math.max(1, Math.round(cssWidth * scale)),
    height: Math.max(1, Math.round(cssHeight * scale))
  }
}

// Rebuild only when visible shapes, size or DPR change; erase drags rebuild only after hitting new ink.
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

// One cached blit plus the in-progress shape keeps per-frame cost independent of committed ink.
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
  // Blit in device coordinates, stretching if the cached layer briefly lags a DPR change to avoid clipping or offset.
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, width, height)
  if (committedLayer.width > 0 && committedLayer.height > 0) {
    ctx.drawImage(committedLayer, 0, 0, width, height)
  }
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  if (inProgress) {
    drawShapes(ctx, [inProgress])
  }
}
