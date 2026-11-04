// Keep document and gesture in one pure state so releases see current ink and transitions tolerate StrictMode replay.

import {
  canRedo,
  canUndo,
  commitShape,
  redoShape,
  setShapes,
  undoShape,
  type MarkupDocument,
  type MarkupPoint,
  type MarkupShape,
  type TextShape
} from './markup-drawing-model'
import {
  shapesTouchedBySweep,
  topmostShapeAt,
  type TextInkBoxMeasurer
} from './markup-shape-hit-test'

export type DraggedShape = Exclude<MarkupShape, TextShape>

// A second pointer must not restart or steer the first pointer’s gesture.
export type MarkupGesture =
  | { kind: 'draw'; pointerId: number; shape: DraggedShape }
  | {
      kind: 'erase'
      pointerId: number
      origin: MarkupPoint
      // A 'pressed' erase is still a click; it becomes 'dragging' past ERASER_CLICK_SLOP.
      phase: 'pressed' | 'dragging'
      last: MarkupPoint
      erasedIds: ReadonlySet<string>
    }

export type MarkupEditorState = { doc: MarkupDocument; gesture: MarkupGesture | null }

// How far (CSS px) an erase press may travel and stay a click: touch and pen taps jitter.
const ERASER_CLICK_SLOP = 4

export function beginDrawGesture(
  state: MarkupEditorState,
  pointerId: number,
  shape: DraggedShape
): MarkupEditorState {
  const settled = settleMissedRelease(state, pointerId)
  return settled.gesture ? settled : { ...settled, gesture: { kind: 'draw', pointerId, shape } }
}

export function beginEraseGesture(
  state: MarkupEditorState,
  pointerId: number,
  point: MarkupPoint,
  measureTextInkBox: TextInkBoxMeasurer
): MarkupEditorState {
  const settled = settleMissedRelease(state, pointerId)
  if (settled.gesture) {
    return settled
  }
  // Clicks erase only topmost ink; crossing the slop starts a sweep from the original press, erasing underlying marks too.
  const topmost = topmostShapeAt(settled.doc.shapes, point, measureTextInkBox)
  return {
    ...settled,
    gesture: {
      kind: 'erase',
      pointerId,
      origin: point,
      phase: 'pressed',
      last: point,
      erasedIds: new Set(topmost ? [topmost.id] : [])
    }
  }
}

// A repeated press from the owning pointer implies a lost release; settle it before starting the new gesture.
function settleMissedRelease(state: MarkupEditorState, pointerId: number): MarkupEditorState {
  return state.gesture?.pointerId === pointerId ? endGesture(state, pointerId) : state
}

export function moveGesture(
  state: MarkupEditorState,
  pointerId: number,
  point: MarkupPoint,
  measureTextInkBox: TextInkBoxMeasurer
): MarkupEditorState {
  const { gesture } = state
  if (gesture?.pointerId !== pointerId) {
    return state
  }
  if (gesture.kind === 'erase') {
    if (gesture.phase === 'pressed') {
      const { origin } = gesture
      if (Math.hypot(point.x - origin.x, point.y - origin.y) < ERASER_CLICK_SLOP) {
        return state
      }
      // `last` is still the origin here, so the first sweep starts at the press point.
      const dragging: EraseGesture = { ...gesture, phase: 'dragging' }
      return {
        ...state,
        gesture: sweepEraser(dragging, state.doc.shapes, point, measureTextInkBox)
      }
    }
    return { ...state, gesture: sweepEraser(gesture, state.doc.shapes, point, measureTextInkBox) }
  }
  return { ...state, gesture: { ...gesture, shape: dragShapeTo(gesture.shape, point) } }
}

// Commit as one undo step; invisible gestures leave history untouched.
export function endGesture(state: MarkupEditorState, pointerId: number): MarkupEditorState {
  const { doc, gesture } = state
  if (gesture?.pointerId !== pointerId) {
    return state
  }
  if (gesture.kind === 'draw') {
    return { doc: hasNoSize(gesture.shape) ? doc : commitShape(doc, gesture.shape), gesture: null }
  }
  const remaining = doc.shapes.filter((shape) => !gesture.erasedIds.has(shape.id))
  return {
    doc: remaining.length === doc.shapes.length ? doc : setShapes(doc, remaining),
    gesture: null
  }
}

// OS cancellation or palm rejection is not a deliberate release; discard the gesture.
export function cancelGesture(state: MarkupEditorState, pointerId: number): MarkupEditorState {
  return state.gesture?.pointerId === pointerId ? { ...state, gesture: null } : state
}

// Undo visible held ink before committed history; drop the gesture either way so the remaining drag cannot change the result.
export function undoMarkup(state: MarkupEditorState): MarkupEditorState {
  if (gestureHasEffect(state.gesture)) {
    return { ...state, gesture: null }
  }
  return canUndo(state.doc) ? { doc: undoShape(state.doc), gesture: null } : state
}

export function canUndoMarkup(state: MarkupEditorState): boolean {
  return gestureHasEffect(state.gesture) || canUndo(state.doc)
}

// Whether releasing the gesture would change the document.
function gestureHasEffect(gesture: MarkupGesture | null): boolean {
  if (gesture === null) {
    return false
  }
  return gesture.kind === 'draw' ? !hasNoSize(gesture.shape) : gesture.erasedIds.size > 0
}

// Unmoved non-pen shapes paint nothing and would invisibly intercept the next eraser click.
function hasNoSize(shape: DraggedShape): boolean {
  return (
    shape.kind !== 'pen' &&
    shape.kind !== 'highlight' &&
    shape.from.x === shape.to.x &&
    shape.from.y === shape.to.y
  )
}

// Why: with nothing to redo the document stays put, so a held gesture is kept.
export function redoMarkup(state: MarkupEditorState): MarkupEditorState {
  return canRedo(state.doc) ? applyDocumentCommand(state, redoShape) : state
}

// Redo and Clear replace the document, so the gesture made against it is dropped.
export function applyDocumentCommand(
  state: MarkupEditorState,
  command: (doc: MarkupDocument) => MarkupDocument
): MarkupEditorState {
  return { doc: command(state.doc), gesture: null }
}

type EraseGesture = Extract<MarkupGesture, { kind: 'erase' }>

function sweepEraser(
  gesture: EraseGesture,
  shapes: readonly MarkupShape[],
  point: MarkupPoint,
  measureTextInkBox: TextInkBoxMeasurer
): EraseGesture {
  const touched = shapesTouchedBySweep(
    shapes.filter((shape) => !gesture.erasedIds.has(shape.id)),
    gesture.last,
    point,
    measureTextInkBox
  )
  // Preserve Set identity when no new ink is hit to avoid re-rasterizing on every pointermove.
  const erasedIds =
    touched.length === 0
      ? gesture.erasedIds
      : new Set([...gesture.erasedIds, ...touched.map((shape) => shape.id)])
  return { ...gesture, last: point, erasedIds }
}

function dragShapeTo(shape: DraggedShape, point: MarkupPoint): DraggedShape {
  if (shape.kind === 'pen' || shape.kind === 'highlight') {
    return { ...shape, points: [...shape.points, point] }
  }
  return { ...shape, to: point }
}
