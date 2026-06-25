// Hit-testing so the select tool can pick an existing shape. Pure (no DOM) and
// works in CSS-viewport coordinates like the rest of the drawing model.

import {
  boundingBox,
  highlightWidth,
  normalizeRect,
  type MarkupPoint,
  type MarkupShape,
  type NormalizedRect
} from './markup-drawing-model'

export function pointToSegmentDistance(point: MarkupPoint, a: MarkupPoint, b: MarkupPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) {
    return Math.hypot(point.x - a.x, point.y - a.y)
  }
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

function withinRect(rect: NormalizedRect, point: MarkupPoint, tolerance: number): boolean {
  return (
    point.x >= rect.x - tolerance &&
    point.x <= rect.x + rect.width + tolerance &&
    point.y >= rect.y - tolerance &&
    point.y <= rect.y + rect.height + tolerance
  )
}

export function hitTestShape(shape: MarkupShape, point: MarkupPoint, tolerance: number): boolean {
  switch (shape.kind) {
    case 'pen':
    case 'highlight': {
      // Why: highlights render at highlightWidth(width) (much fatter), so hit-test
      // against the drawn thickness or large highlights miss their visible area.
      const strokeWidth = shape.kind === 'highlight' ? highlightWidth(shape.width) : shape.width
      const tol = tolerance + strokeWidth / 2
      if (shape.points.length === 1) {
        return Math.hypot(point.x - shape.points[0].x, point.y - shape.points[0].y) <= tol
      }
      for (let i = 1; i < shape.points.length; i += 1) {
        if (pointToSegmentDistance(point, shape.points[i - 1], shape.points[i]) <= tol) {
          return true
        }
      }
      return false
    }
    case 'arrow':
      return pointToSegmentDistance(point, shape.from, shape.to) <= tolerance + shape.width / 2
    case 'rect':
    case 'ellipse':
      // Forgiving: select by clicking anywhere within the bounds.
      return withinRect(normalizeRect(shape.from, shape.to), point, tolerance)
    case 'text':
      return withinRect(boundingBox(shape), point, tolerance)
  }
}

// Topmost (last-drawn) shape under the point, or null.
export function findTopShape(
  shapes: readonly MarkupShape[],
  point: MarkupPoint,
  tolerance: number
): MarkupShape | null {
  for (let i = shapes.length - 1; i >= 0; i -= 1) {
    if (hitTestShape(shapes[i], point, tolerance)) {
      return shapes[i]
    }
  }
  return null
}
