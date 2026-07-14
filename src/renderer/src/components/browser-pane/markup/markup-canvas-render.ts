// Renders the live markup scene (committed shapes + the in-progress shape) into
// the overlay canvas at device resolution. Kept separate from the editor hook so
// the draw composition stays focused.

import { clampMarkupScale } from './markup-screenshot-compose'
import { drawShapes } from './markup-shape-render'
import type { MarkupShape } from './markup-drawing-model'

export type MarkupScene = {
  shapes: readonly MarkupShape[]
  inProgress: MarkupShape | null
  cssWidth: number
  cssHeight: number
}

export function renderMarkupScene(canvas: HTMLCanvasElement, scene: MarkupScene): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return
  }
  // Why: clamp identically to the compositor so the live preview and the exported
  // PNG render shapes at the same scale.
  const dpr = clampMarkupScale(window.devicePixelRatio || 1)
  const pixelWidth = Math.max(1, Math.round(scene.cssWidth * dpr))
  const pixelHeight = Math.max(1, Math.round(scene.cssHeight * dpr))
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, scene.cssWidth, scene.cssHeight)

  drawShapes(ctx, scene.shapes)
  if (scene.inProgress) {
    drawShapes(ctx, [scene.inProgress])
  }
}
