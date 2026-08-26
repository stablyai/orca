// Pure drawing model for browser screenshot markup. No DOM access — shapes are
// vector objects in CSS-viewport coordinates so the same data drives both the
// live canvas overlay and the final composited PNG. Keeping this canvas-free
// makes the undo/redo and geometry logic unit-testable.

export type MarkupToolKind = 'pen' | 'highlight' | 'arrow' | 'rect' | 'ellipse' | 'text'

// Toolbar selection. Draw-only: markup is a throwaway scribble the user copies
// once, so there is no select/move/restyle cursor.
export type MarkupTool = MarkupToolKind

export type MarkupPoint = { x: number; y: number }

type MarkupShapeBase = { id: string; color: string }

export type PenShape = MarkupShapeBase & { kind: 'pen'; points: MarkupPoint[]; width: number }
export type HighlightShape = MarkupShapeBase & {
  kind: 'highlight'
  points: MarkupPoint[]
  width: number
}
export type ArrowShape = MarkupShapeBase & {
  kind: 'arrow'
  from: MarkupPoint
  to: MarkupPoint
  width: number
}
export type RectShape = MarkupShapeBase & {
  kind: 'rect'
  from: MarkupPoint
  to: MarkupPoint
  width: number
}
export type EllipseShape = MarkupShapeBase & {
  kind: 'ellipse'
  from: MarkupPoint
  to: MarkupPoint
  width: number
}
export type TextShape = MarkupShapeBase & {
  kind: 'text'
  at: MarkupPoint
  text: string
  fontSize: number
}

export type MarkupShape =
  | PenShape
  | HighlightShape
  | ArrowShape
  | RectShape
  | EllipseShape
  | TextShape

// Concrete ink colors (baked into the exported PNG, so these are content colors,
// not UI-chrome tokens). Ordered for a compact swatch row.
export const MARKUP_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#3b82f6',
  '#111827',
  '#ffffff'
] as const
export const DEFAULT_MARKUP_COLOR: string = MARKUP_COLORS[0]

export const MARKUP_WIDTHS = [2, 4, 8] as const
export const DEFAULT_MARKUP_WIDTH = 4
export const MARKUP_FONT_SIZES = [14, 18, 24, 32, 48] as const
export const DEFAULT_MARKUP_FONT_SIZE = 18

// Highlight strokes are intentionally fat and translucent.
export const HIGHLIGHT_WIDTH_MULTIPLIER = 4
export const HIGHLIGHT_ALPHA = 0.35

// ─── Document with undo/redo ────────────────────────────────────────────────

export type MarkupDocument = {
  shapes: MarkupShape[]
  /** Prior whole-list states (oldest first) for undo. */
  past: MarkupShape[][]
  /** Undone whole-list states (newest first) for redo. */
  future: MarkupShape[][]
}

export function createMarkupDocument(): MarkupDocument {
  return { shapes: [], past: [], future: [] }
}

// Replace the whole shape list as one undoable step. Snapshot-based so every
// edit — add, move, restyle, delete — is reversible, not just adding a shape.
export function setShapes(doc: MarkupDocument, shapes: MarkupShape[]): MarkupDocument {
  return { shapes, past: [...doc.past, doc.shapes], future: [] }
}

export function commitShape(doc: MarkupDocument, shape: MarkupShape): MarkupDocument {
  return setShapes(doc, [...doc.shapes, shape])
}

export function undoShape(doc: MarkupDocument): MarkupDocument {
  const prev = doc.past.at(-1)
  if (!prev) {
    return doc
  }
  return { shapes: prev, past: doc.past.slice(0, -1), future: [doc.shapes, ...doc.future] }
}

export function redoShape(doc: MarkupDocument): MarkupDocument {
  const next = doc.future.at(0)
  if (!next) {
    return doc
  }
  return { shapes: next, past: [...doc.past, doc.shapes], future: doc.future.slice(1) }
}

export function clearShapes(doc: MarkupDocument): MarkupDocument {
  return doc.shapes.length === 0 ? doc : setShapes(doc, [])
}

export function canUndo(doc: MarkupDocument): boolean {
  return doc.past.length > 0
}

export function canRedo(doc: MarkupDocument): boolean {
  return doc.future.length > 0
}

export function isEmptyDocument(doc: MarkupDocument): boolean {
  return doc.shapes.length === 0
}

// ─── Geometry helpers (shared by live overlay + compositor) ─────────────────

export type NormalizedRect = { x: number; y: number; width: number; height: number }

export function normalizeRect(from: MarkupPoint, to: MarkupPoint): NormalizedRect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y)
  }
}

export function scalePoint(point: MarkupPoint, scale: number): MarkupPoint {
  return { x: point.x * scale, y: point.y * scale }
}

// Why: the compositor draws into a canvas sized to the base-image's physical
// pixels, while shapes are authored in CSS-viewport pixels. Scaling every shape
// by (imagePx / cssPx) keeps strokes aligned with the underlying screenshot.
export function scaleShape(shape: MarkupShape, scale: number): MarkupShape {
  switch (shape.kind) {
    case 'pen':
    case 'highlight':
      return {
        ...shape,
        width: shape.width * scale,
        points: shape.points.map((point) => scalePoint(point, scale))
      }
    case 'arrow':
    case 'rect':
    case 'ellipse':
      return {
        ...shape,
        width: shape.width * scale,
        from: scalePoint(shape.from, scale),
        to: scalePoint(shape.to, scale)
      }
    case 'text':
      return {
        ...shape,
        fontSize: shape.fontSize * scale,
        at: scalePoint(shape.at, scale)
      }
  }
}

export type ArrowHeadGeometry = { tip: MarkupPoint; left: MarkupPoint; right: MarkupPoint }

const ARROW_HEAD_ANGLE = 0.45

export function arrowHeadLength(width: number): number {
  return Math.max(10, width * 3.5)
}

// Returns the two wing points of an arrowhead at `to`, or null when the segment
// has no direction (from === to) so callers can skip drawing a degenerate head.
export function arrowHeadGeometry(
  from: MarkupPoint,
  to: MarkupPoint,
  width: number
): ArrowHeadGeometry | null {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx === 0 && dy === 0) {
    return null
  }
  const angle = Math.atan2(dy, dx)
  const size = arrowHeadLength(width)
  const leftAngle = angle + Math.PI - ARROW_HEAD_ANGLE
  const rightAngle = angle + Math.PI + ARROW_HEAD_ANGLE
  return {
    tip: to,
    left: { x: to.x + size * Math.cos(leftAngle), y: to.y + size * Math.sin(leftAngle) },
    right: { x: to.x + size * Math.cos(rightAngle), y: to.y + size * Math.sin(rightAngle) }
  }
}

export function highlightWidth(width: number): number {
  return width * HIGHLIGHT_WIDTH_MULTIPLIER
}
