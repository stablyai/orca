// The markup editor's document plus its in-flight pointer gesture, advanced by
// pure transitions. Keeping both in one value lets a release commit from the
// latest state, and keeps the transitions safe to run twice under StrictMode.

import {
  commitShape,
  setShapes,
  type MarkupDocument,
  type MarkupPoint,
  type MarkupShape,
  type TextShape
} from './markup-drawing-model'
import { shapesTouchedBySweep, type TextInkBoxMeasurer } from './markup-shape-hit-test'

export type DraggedShape = Exclude<MarkupShape, TextShape>

// Why pointerId: a second pointer (another finger) must not restart or steer a
// gesture the first one owns.
export type MarkupGesture =
  | { kind: 'draw'; pointerId: number; shape: DraggedShape }
  | { kind: 'erase'; pointerId: number; last: MarkupPoint; erasedIds: ReadonlySet<string> }

export type MarkupEditorState = { doc: MarkupDocument; gesture: MarkupGesture | null }

export function beginDrawGesture(
  state: MarkupEditorState,
  pointerId: number,
  shape: DraggedShape
): MarkupEditorState {
  return state.gesture ? state : { ...state, gesture: { kind: 'draw', pointerId, shape } }
}

export function beginEraseGesture(
  state: MarkupEditorState,
  pointerId: number,
  point: MarkupPoint,
  measureTextInkBox: TextInkBoxMeasurer
): MarkupEditorState {
  if (state.gesture) {
    return state
  }
  // Sweeping a zero-length segment makes a plain click erase what is under it.
  const gesture = sweepEraser(
    { kind: 'erase', pointerId, last: point, erasedIds: new Set() },
    state.doc.shapes,
    point,
    measureTextInkBox
  )
  return { ...state, gesture }
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
    return { ...state, gesture: sweepEraser(gesture, state.doc.shapes, point, measureTextInkBox) }
  }
  return { ...state, gesture: { ...gesture, shape: dragShapeTo(gesture.shape, point) } }
}

// Commits the gesture as one undoable step. An erase that removed nothing
// leaves history untouched so Undo never has a step with no visible effect.
export function endGesture(state: MarkupEditorState, pointerId: number): MarkupEditorState {
  const { doc, gesture } = state
  if (gesture?.pointerId !== pointerId) {
    return state
  }
  if (gesture.kind === 'draw') {
    return { doc: commitShape(doc, gesture.shape), gesture: null }
  }
  const remaining = doc.shapes.filter((shape) => !gesture.erasedIds.has(shape.id))
  return {
    doc: remaining.length === doc.shapes.length ? doc : setShapes(doc, remaining),
    gesture: null
  }
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
