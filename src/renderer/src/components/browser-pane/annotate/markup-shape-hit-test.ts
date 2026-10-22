// Hit testing for the markup eraser. Pure geometry over the same model helpers
// the renderer strokes with, so "the ink you touch" matches what is drawn.

import {
  arrowHeadGeometry,
  highlightWidth,
  normalizeRect,
  strokeDotRadius,
  type MarkupPoint,
  type MarkupShape,
  type NormalizedRect,
  type TextShape
} from './markup-drawing-model'

// How close (CSS px) the pointer must come to a mark's ink to erase it.
const ERASER_RADIUS = 8

// Longest chord used to approximate an ellipse; keeps the error far below ERASER_RADIUS.
const ELLIPSE_MAX_CHORD = 12
const ELLIPSE_MIN_SEGMENTS = 16

/** Ink box of a drawn text shape, or null when there is no canvas to measure with. */
export type TextInkBoxMeasurer = (shape: TextShape) => NormalizedRect | null

type StrokedShape = Exclude<MarkupShape, TextShape>
type StrokedInk = { paths: MarkupPoint[][]; halfWidth: number }

// Why a swept segment rather than a point: pointermove events are sparse, so a
// fast drag would otherwise jump over a thin stroke.
export function shapesTouchedBySweep(
  shapes: readonly MarkupShape[],
  from: MarkupPoint,
  to: MarkupPoint,
  measureTextInkBox: TextInkBoxMeasurer
): MarkupShape[] {
  return shapes.filter((shape) => sweepTouchesShape(shape, from, to, measureTextInkBox))
}

// The mark drawn last among those under `point`, i.e. the one painted on top.
export function topmostShapeAt(
  shapes: readonly MarkupShape[],
  point: MarkupPoint,
  measureTextInkBox: TextInkBoxMeasurer
): MarkupShape | undefined {
  for (let i = shapes.length - 1; i >= 0; i -= 1) {
    if (sweepTouchesShape(shapes[i], point, point, measureTextInkBox)) {
      return shapes[i]
    }
  }
  return undefined
}

function sweepTouchesShape(
  shape: MarkupShape,
  from: MarkupPoint,
  to: MarkupPoint,
  measureTextInkBox: TextInkBoxMeasurer
): boolean {
  return shape.kind === 'text'
    ? sweepTouchesBox(from, to, measureTextInkBox(shape))
    : sweepTouchesStroke(from, to, strokedInk(shape))
}

function sweepTouchesStroke(from: MarkupPoint, to: MarkupPoint, ink: StrokedInk): boolean {
  const reach = ink.halfWidth + ERASER_RADIUS
  return ink.paths.some((path) => sweepDistanceToPath(from, to, path) <= reach)
}

function sweepTouchesBox(from: MarkupPoint, to: MarkupPoint, box: NormalizedRect | null): boolean {
  if (!box) {
    return false
  }
  // A sweep that never crosses the outline is entirely inside or entirely outside.
  const inside =
    from.x >= box.x &&
    from.x <= box.x + box.width &&
    from.y >= box.y &&
    from.y <= box.y + box.height
  return inside || sweepDistanceToPath(from, to, rectOutline(box)) <= ERASER_RADIUS
}

// The polylines a shape is stroked along. Rect and ellipse are hollow, so only
// their outline is ink.
function strokedInk(shape: StrokedShape): StrokedInk {
  switch (shape.kind) {
    case 'pen':
      return { paths: [shape.points], halfWidth: strokeDotRadius(shape.width) }
    case 'highlight':
      return { paths: [shape.points], halfWidth: strokeDotRadius(highlightWidth(shape.width)) }
    case 'arrow': {
      const head = arrowHeadGeometry(shape.from, shape.to, shape.width)
      const shaft = [shape.from, shape.to]
      return {
        paths: head ? [shaft, [head.left, head.tip, head.right]] : [shaft],
        halfWidth: shape.width / 2
      }
    }
    case 'rect':
      return {
        paths: [rectOutline(normalizeRect(shape.from, shape.to))],
        halfWidth: shape.width / 2
      }
    case 'ellipse':
      return {
        paths: [ellipseOutline(normalizeRect(shape.from, shape.to))],
        halfWidth: shape.width / 2
      }
  }
}

function rectOutline(rect: NormalizedRect): MarkupPoint[] {
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height
  return [
    { x: rect.x, y: rect.y },
    { x: right, y: rect.y },
    { x: right, y: bottom },
    { x: rect.x, y: bottom },
    { x: rect.x, y: rect.y }
  ]
}

function ellipseOutline(rect: NormalizedRect): MarkupPoint[] {
  const rx = rect.width / 2
  const ry = rect.height / 2
  const segments = Math.max(
    ELLIPSE_MIN_SEGMENTS,
    Math.ceil((2 * Math.PI * Math.max(rx, ry)) / ELLIPSE_MAX_CHORD)
  )
  const outline: MarkupPoint[] = []
  for (let i = 0; i <= segments; i += 1) {
    const angle = (i / segments) * 2 * Math.PI
    outline.push({ x: rect.x + rx + rx * Math.cos(angle), y: rect.y + ry + ry * Math.sin(angle) })
  }
  return outline
}

function sweepDistanceToPath(from: MarkupPoint, to: MarkupPoint, path: MarkupPoint[]): number {
  // A single-point path is a dot, which has no segment to iterate.
  let nearest = path.length === 1 ? pointToSegmentDistance(path[0], from, to) : Infinity
  for (let i = 1; i < path.length; i += 1) {
    nearest = Math.min(nearest, segmentDistance(from, to, path[i - 1], path[i]))
  }
  return nearest
}

function segmentDistance(
  a1: MarkupPoint,
  a2: MarkupPoint,
  b1: MarkupPoint,
  b2: MarkupPoint
): number {
  if (segmentsCross(a1, a2, b1, b2)) {
    return 0
  }
  return Math.min(
    pointToSegmentDistance(a1, b1, b2),
    pointToSegmentDistance(a2, b1, b2),
    pointToSegmentDistance(b1, a1, a2),
    pointToSegmentDistance(b2, a1, a2)
  )
}

// Strict crossing only; touching and collinear cases fall out of the endpoint distances.
function segmentsCross(
  a1: MarkupPoint,
  a2: MarkupPoint,
  b1: MarkupPoint,
  b2: MarkupPoint
): boolean {
  return cross(a1, a2, b1) * cross(a1, a2, b2) < 0 && cross(b1, b2, a1) * cross(b1, b2, a2) < 0
}

function cross(origin: MarkupPoint, a: MarkupPoint, b: MarkupPoint): number {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x)
}

function pointToSegmentDistance(point: MarkupPoint, a: MarkupPoint, b: MarkupPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}
