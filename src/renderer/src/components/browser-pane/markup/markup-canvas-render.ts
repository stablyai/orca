// Renders the live markup scene (committed shapes + in-progress shape + drag
// preview + selection box) into the overlay canvas at device resolution. Kept
// separate from the editor hook so the draw composition stays focused.

import { clampMarkupScale } from './markup-screenshot-compose'
import { drawShapes } from './markup-shape-render'
import {
  boundingBox,
  translateShape,
  type MarkupShape,
  type NormalizedRect
} from './markup-drawing-model'

export type MarkupScene = {
  shapes: readonly MarkupShape[]
  inProgress: MarkupShape | null
  dragId: string | null
  dragOffset: { dx: number; dy: number } | null
  selectedId: string | null
  cssWidth: number
  cssHeight: number
}

function drawSelectionBox(ctx: CanvasRenderingContext2D, rect: NormalizedRect): void {
  const pad = 6
  ctx.save()
  ctx.strokeStyle = '#3b82f6'
  ctx.lineWidth = 1.5
  ctx.setLineDash([5, 4])
  ctx.strokeRect(rect.x - pad, rect.y - pad, rect.width + pad * 2, rect.height + pad * 2)
  ctx.restore()
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

  const offset = scene.dragOffset
  const displayShapes =
    scene.dragId && offset
      ? scene.shapes.map((shape) =>
          shape.id === scene.dragId ? translateShape(shape, offset.dx, offset.dy) : shape
        )
      : scene.shapes
  drawShapes(ctx, displayShapes)
  if (scene.inProgress) {
    drawShapes(ctx, [scene.inProgress])
  }
  if (scene.selectedId) {
    const selected = displayShapes.find((shape) => shape.id === scene.selectedId)
    if (selected) {
      drawSelectionBox(ctx, boundingBox(selected))
    }
  }
}
