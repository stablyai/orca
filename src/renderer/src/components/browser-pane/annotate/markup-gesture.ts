// The markup editor's document plus its in-flight pointer gesture, advanced by
// pure transitions. Keeping both in one value lets a release commit from the
// latest state, and keeps the transitions safe to run twice under StrictMode.

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

// Why pointerId: a second pointer (another finger) must not restart or steer a
// gesture the first one owns.
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
  // Why: a click takes only the mark on top. Leaving the slop makes it a drag,
  // and that sweep starts at the press point, so it takes the rest under it too.
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

// Why: a pointer cannot press twice without releasing, so a press from the
// gesture's own pointer means its release was lost; settle it as that release
// would have, instead of letting it block the new press and steer from a stale point.
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

// Commits the gesture as one undoable step. A gesture with no visible result
// leaves history untouched so Undo never has a step with no visible effect.
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

// Why: a cancelled pointer (an OS gesture or palm rejection took it) was not a
// deliberate release, so its gesture is discarded rather than committed.
export function cancelGesture(state: MarkupEditorState, pointerId: number): MarkupEditorState {
  return state.gesture?.pointerId === pointerId ? { ...state, gesture: null } : state
}

// Why: Undo mid-gesture takes back only that gesture, as the newest step, so the
// next Undo takes back the last committed mark rather than both at once. A gesture
// that shows nothing yet (an erase hiding nothing, an unmoved shape press) is no
// step, so Undo goes to the document. Either way the gesture is dropped, so the
// rest of that drag does nothing until the next press.
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

// Why: a rectangle, ellipse or arrow pressed without dragging paints nothing; saved,
// it would be an invisible topmost mark that soaks up the next eraser click there.
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
  // Why: keep the same Set when nothing new was hit so the cached canvas layer
  // is not re-rasterized on every pointermove.
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
