import { describe, expect, it } from 'vitest'
import {
  commitShape,
  createMarkupDocument,
  undoShape,
  type MarkupPoint,
  type PenShape
} from './markup-drawing-model'
import {
  beginDrawGesture,
  beginEraseGesture,
  cancelGesture,
  canUndoMarkup,
  endGesture,
  moveGesture,
  redoMarkup,
  undoMarkup,
  type MarkupEditorState
} from './markup-gesture'

const noText = () => null

// A short horizontal pen stroke at height `y`, 100px wide.
function line(id: string, y: number): PenShape {
  return {
    id,
    kind: 'pen',
    color: '#ef4444',
    width: 2,
    points: [
      { x: 0, y },
      { x: 100, y }
    ]
  }
}

function editorWith(...shapes: PenShape[]): MarkupEditorState {
  return { doc: shapes.reduce(commitShape, createMarkupDocument()), gesture: null }
}

function erase(state: MarkupEditorState, path: MarkupPoint[], pointerId = 1): MarkupEditorState {
  const [first, ...rest] = path
  const begun = beginEraseGesture(state, pointerId, first, noText)
  return rest.reduce((current, point) => moveGesture(current, pointerId, point, noText), begun)
}

const ids = (state: MarkupEditorState) => state.doc.shapes.map((shape) => shape.id)
const erasedIds = (state: MarkupEditorState) =>
  state.gesture?.kind === 'erase' ? state.gesture.erasedIds : undefined

describe('erase gesture', () => {
  it('erases only the newest of two overlapping marks on a click', () => {
    const before = editorWith(line('older', 0), line('newer', 0))
    const pressed = erase(before, [{ x: 50, y: 0 }])
    // The pointer is still down at the press point: only what a release commits is hidden.
    expect(erasedIds(pressed)).toEqual(new Set(['newer']))

    const after = endGesture(pressed, 1)
    expect(ids(after)).toEqual(['older'])
    expect(undoShape(after.doc).shapes.map((shape) => shape.id)).toEqual(['older', 'newer'])
  })

  it('erases every mark under the press point once the click becomes a drag', () => {
    const before = editorWith(line('older', 0), line('newer', 0), line('away', 200))
    // The drag leaves the marks behind straight away, so only the press point touched them.
    const dragged = erase(before, [
      { x: 50, y: 0 },
      { x: 50, y: 60 }
    ])
    expect(erasedIds(dragged)).toEqual(new Set(['older', 'newer']))

    const after = endGesture(dragged, 1)
    expect(ids(after)).toEqual(['away'])
    expect(undoShape(after.doc).shapes.map((shape) => shape.id)).toEqual(['older', 'newer', 'away'])
  })

  it('settles an erase whose release was lost when the same pointer presses again', () => {
    const swept = erase(editorWith(line('a', 0), line('b', 100), line('c', 200)), [{ x: 50, y: 0 }])

    // No release for pointer 1; it presses again below every mark and drags a little.
    const after = endGesture(
      erase(swept, [
        { x: 50, y: 300 },
        { x: 60, y: 300 }
      ]),
      1
    )

    // The new press must not sweep from the stale point, which would cross b and c.
    expect(ids(after)).toEqual(['b', 'c'])
    expect(undoShape(after.doc).shapes.map((shape) => shape.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('cancelled pointer', () => {
  it('discards an erase, so the marks it hid stay, and a later lost capture does nothing', () => {
    const before = editorWith(line('a', 0), line('b', 100))
    const held = erase(before, [
      { x: 50, y: -50 },
      { x: 50, y: 150 }
    ])
    expect(erasedIds(held)).toEqual(new Set(['a', 'b']))

    const cancelled = cancelGesture(held, 1)
    expect(cancelled.doc).toBe(before.doc)
    // lostpointercapture follows pointercancel and ends the same pointer's gesture.
    expect(endGesture(cancelled, 1)).toBe(cancelled)
  })
})

describe('history commands mid-gesture', () => {
  // A stroke from (0, 300) to (50, 300), still held down.
  function drawing(state: MarkupEditorState): MarkupEditorState {
    return moveGesture(beginDrawGesture(state, 1, line('held', 300)), 1, { x: 50, y: 300 }, noText)
  }

  // The rest of the held drag, which must neither draw nor erase.
  function finishDrag(state: MarkupEditorState): MarkupEditorState {
    return endGesture(moveGesture(state, 1, { x: 50, y: 100 }, noText), 1)
  }

  it('undo mid-stroke drops only the stroke, and the next undo takes the last mark', () => {
    const before = editorWith(line('a', 0), line('b', 100))
    const held = drawing(before)
    expect(canUndoMarkup(held)).toBe(true)

    const undone = undoMarkup(held)
    expect(undone.doc).toBe(before.doc)
    expect(undone.gesture).toBeNull()

    const released = finishDrag(undone)
    expect(released.doc).toBe(before.doc)
    expect(released.gesture).toBeNull()
    expect(ids(undoMarkup(released))).toEqual(['a'])
  })

  it('redo mid-gesture cancels the gesture, then redoes', () => {
    const undone = undoMarkup(editorWith(line('a', 0), line('b', 100)))

    const redone = redoMarkup(drawing(undone))
    expect(ids(redone)).toEqual(['a', 'b'])
    expect(ids(finishDrag(redone))).toEqual(['a', 'b'])
  })
})
