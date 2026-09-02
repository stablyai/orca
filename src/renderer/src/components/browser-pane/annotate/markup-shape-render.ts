// Canvas rendering for markup shapes. Shared by the live overlay (draws into the
// visible canvas) and the compositor (draws into the offscreen export canvas), so
// on-screen preview and the delivered PNG are pixel-identical.

import {
  arrowHeadGeometry,
  highlightWidth,
  normalizeRect,
  HIGHLIGHT_ALPHA,
  type ArrowShape,
  type EllipseShape,
  type MarkupShape,
  type PenShape,
  type HighlightShape,
  type RectShape,
  type TextShape
} from './markup-drawing-model'

export const TEXT_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

export function drawShape(ctx: CanvasRenderingContext2D, shape: MarkupShape): void {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = shape.color
  ctx.fillStyle = shape.color
  switch (shape.kind) {
    case 'pen':
      drawStroke(ctx, shape)
      break
    case 'highlight':
      drawHighlight(ctx, shape)
      break
    case 'arrow':
      drawArrow(ctx, shape)
      break
    case 'rect':
      drawRect(ctx, shape)
      break
    case 'ellipse':
      drawEllipse(ctx, shape)
      break
    case 'text':
      drawText(ctx, shape)
      break
  }
  ctx.restore()
}

export function drawShapes(ctx: CanvasRenderingContext2D, shapes: readonly MarkupShape[]): void {
  for (const shape of shapes) {
    drawShape(ctx, shape)
  }
}

function drawStroke(ctx: CanvasRenderingContext2D, shape: PenShape): void {
  ctx.lineWidth = shape.width
  strokePolyline(ctx, shape.points, shape.width)
}

function drawHighlight(ctx: CanvasRenderingContext2D, shape: HighlightShape): void {
  // Why: translucent + fat so it reads as a marker pass over the screenshot
  // without hiding the pixels beneath.
  ctx.globalAlpha = HIGHLIGHT_ALPHA
  const width = highlightWidth(shape.width)
  ctx.lineWidth = width
  strokePolyline(ctx, shape.points, width)
}

function strokePolyline(
  ctx: CanvasRenderingContext2D,
  points: readonly { x: number; y: number }[],
  width: number
): void {
  if (points.length === 0) {
    return
  }
  if (points.length === 1) {
    // Why: a tap (single point) still leaves a visible dot.
    const point = points[0]
    ctx.beginPath()
    ctx.arc(point.x, point.y, Math.max(width / 2, 1), 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length; i += 1) {
    ctx.lineTo(points[i].x, points[i].y)
  }
  ctx.stroke()
}

function drawArrow(ctx: CanvasRenderingContext2D, shape: ArrowShape): void {
  ctx.lineWidth = shape.width
  ctx.beginPath()
  ctx.moveTo(shape.from.x, shape.from.y)
  ctx.lineTo(shape.to.x, shape.to.y)
  ctx.stroke()
  const head = arrowHeadGeometry(shape.from, shape.to, shape.width)
  if (!head) {
    return
  }
  ctx.beginPath()
  ctx.moveTo(head.left.x, head.left.y)
  ctx.lineTo(head.tip.x, head.tip.y)
  ctx.lineTo(head.right.x, head.right.y)
  ctx.stroke()
}

function drawRect(ctx: CanvasRenderingContext2D, shape: RectShape): void {
  ctx.lineWidth = shape.width
  const rect = normalizeRect(shape.from, shape.to)
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height)
}

function drawEllipse(ctx: CanvasRenderingContext2D, shape: EllipseShape): void {
  ctx.lineWidth = shape.width
  const rect = normalizeRect(shape.from, shape.to)
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  ctx.beginPath()
  ctx.ellipse(cx, cy, rect.width / 2, rect.height / 2, 0, 0, Math.PI * 2)
  ctx.stroke()
}

function drawText(ctx: CanvasRenderingContext2D, shape: TextShape): void {
  ctx.font = `600 ${shape.fontSize}px ${TEXT_FONT_FAMILY}`
  ctx.textBaseline = 'top'
  // Why: a thin contrasting halo keeps text legible over busy screenshots
  // regardless of the underlying pixels.
  ctx.lineWidth = Math.max(shape.fontSize / 6, 2)
  ctx.strokeStyle = haloColor(shape.color)
  ctx.lineJoin = 'round'
  // Text comes from a single-line input, so there are no newlines to lay out.
  ctx.strokeText(shape.text, shape.at.x, shape.at.y)
  ctx.fillText(shape.text, shape.at.x, shape.at.y)
}

// White text gets a dark halo, everything else a light halo.
function haloColor(color: string): string {
  return color.toLowerCase() === '#ffffff' ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.85)'
}
