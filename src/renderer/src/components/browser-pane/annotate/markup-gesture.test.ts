import { describe, expect, it } from 'vitest'
import {
  commitShape,
  createMarkupDocument,
  redoShape,
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
  type DraggedShape,
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

// A rectangle, ellipse or arrow as pressed: no drag yet, so from === to.
function pressedShape(kind: 'rect' | 'ellipse' | 'arrow', at: MarkupPoint): DraggedShape {
  return { id: kind, kind, color: '#ef4444', width: 4, from: at, to: at }
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

  it('keeps a click a click when the pointer wanders inside the slop and back', () => {
    const before = editorWith(line('older', 0), line('newer', 0), line('near', 12))
    // `near` is out of reach of the press point but within reach 3.5px below it.
    const wandered = erase(before, [
      { x: 50, y: 0 },
      { x: 50, y: 3.5 },
      { x: 50, y: 0 }
    ])

    expect(erasedIds(wandered)).toEqual(new Set(['newer']))
    expect(ids(endGesture(wandered, 1))).toEqual(['older', 'near'])
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

  it('records a whole drag as one undo step that redo replays', () => {
    const before = editorWith(line('a', 0), line('b', 100), line('c', 200))
    const after = endGesture(
      erase(before, [
        { x: 50, y: -50 },
        { x: 50, y: 150 }
      ]),
      1
    )

    expect(ids(after)).toEqual(['c'])
    const undone = undoShape(after.doc)
    expect(undone.shapes.map((shape) => shape.id)).toEqual(['a', 'b', 'c'])
    expect(redoShape(undone).shapes.map((shape) => shape.id)).toEqual(['c'])
  })

  it('does not erase a mark the pointer curved around between events', () => {
    // The endpoint chord crosses the stroke, but the actual curved sweep goes around it.
    const after = endGesture(
      erase(editorWith(line('a', 0)), [
        { x: 50, y: -40 },
        { x: 160, y: -40 },
        { x: 160, y: 40 },
        { x: 50, y: 40 }
      ]),
      1
    )

    expect(ids(after)).toEqual(['a'])
  })

  it('ignores a second pointer while a gesture is in flight', () => {
    const first = erase(editorWith(line('a', 0), line('b', 100)), [{ x: 50, y: 0 }], 1)

    const secondDown = beginEraseGesture(first, 2, { x: 50, y: 100 }, noText)
    expect(secondDown).toBe(first)
    expect(moveGesture(first, 2, { x: 50, y: 100 }, noText)).toBe(first)
    expect(endGesture(first, 2)).toBe(first)

    expect(ids(endGesture(first, 1))).toEqual(['b'])
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

  it('commits against the document as it is on release', () => {
    const swept = erase(editorWith(line('a', 0)), [{ x: 50, y: 0 }])
    // The document moved under the gesture and no longer holds the mark.
    const without = { ...swept, doc: undoShape(swept.doc) }
    const after = endGesture(without, 1)

    expect(after.doc).toBe(without.doc)
    expect(after.gesture).toBeNull()
  })
})

describe('draw gesture', () => {
  it('commits a stroke whose release was lost and starts afresh on the next press', () => {
    const stale = moveGesture(
      beginDrawGesture(editorWith(), 1, line('old', 0)),
      1,
      { x: 120, y: 0 },
      noText
    )

    const next = beginDrawGesture(stale, 1, {
      id: 'new',
      kind: 'pen',
      color: '#ef4444',
      width: 2,
      points: [{ x: 0, y: 300 }]
    })
    const ended = endGesture(moveGesture(next, 1, { x: 50, y: 300 }, noText), 1)

    expect(ended.doc.shapes.map((shape) => shape.id)).toEqual(['old', 'new'])
    expect(ended.doc.shapes[1]).toMatchObject({
      points: [
        { x: 0, y: 300 },
        { x: 50, y: 300 }
      ]
    })
  })

  it('extends the shape on move and commits it once on release', () => {
    const begun = beginDrawGesture(editorWith(), 1, {
      id: 'new',
      kind: 'rect',
      color: '#ef4444',
      width: 4,
      from: { x: 10, y: 10 },
      to: { x: 10, y: 10 }
    })
    // A second pointer landing mid-stroke must not replace it.
    expect(beginDrawGesture(begun, 2, line('other', 0))).toBe(begun)
    const moved = moveGesture(begun, 1, { x: 60, y: 40 }, noText)
    const ended = endGesture(moved, 1)

    expect(ended.doc.shapes).toEqual([
      {
        id: 'new',
        kind: 'rect',
        color: '#ef4444',
        width: 4,
        from: { x: 10, y: 10 },
        to: { x: 60, y: 40 }
      }
    ])
    // A stray second release has no gesture left to commit.
    expect(endGesture(ended, 1)).toBe(ended)
  })

  it.each(['rect'] as const)(
    'saves no %s released without being dragged, so it adds no undo step',
    (kind) => {
      const before = editorWith(line('a', 0))
      const pressed = beginDrawGesture(before, 1, pressedShape(kind, { x: 50, y: 0 }))
      // Undo with only the unmoved press held goes straight to the last mark.
      expect(ids(undoMarkup(pressed))).toEqual([])

      expect(endGesture(pressed, 1).doc).toBe(before.doc)
    }
  )

  it('still saves a pen tap, which leaves a visible dot', () => {
    const tapped = endGesture(
      beginDrawGesture(editorWith(), 1, { ...line('dot', 0), points: [{ x: 50, y: 0 }] }),
      1
    )

    expect(ids(tapped)).toEqual(['dot'])
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

  it('undo mid-erase restores the hidden marks and leaves the document alone', () => {
    const before = editorWith(line('a', 0), line('b', 100))
    const held = erase(before, [{ x: 50, y: 0 }])
    expect(erasedIds(held)).toEqual(new Set(['a']))

    const released = finishDrag(undoMarkup(held))
    expect(released.doc).toBe(before.doc)
    expect(ids(undoMarkup(released))).toEqual(['a'])
  })

  it('undo during an erase that hides nothing undoes the last mark and ends the erase', () => {
    const before = editorWith(line('a', 0), line('b', 100))
    const held = erase(before, [{ x: 50, y: 300 }])
    expect(erasedIds(held)).toEqual(new Set())
    expect(canUndoMarkup(held)).toBe(true)

    const undone = undoMarkup(held)
    expect(ids(undone)).toEqual(['a'])
    expect(undone.gesture).toBeNull()
    // The rest of the drag crosses the restored `b`, but must not erase it.
    expect(ids(finishDrag(undone))).toEqual(['a'])
  })

  it('an unmoved shape press on an empty canvas leaves undo disabled and is kept', () => {
    const held = beginDrawGesture(editorWith(), 1, pressedShape('ellipse', { x: 50, y: 0 }))
    expect(canUndoMarkup(held)).toBe(false)
    expect(undoMarkup(held)).toBe(held)

    // Dragging it out still draws the ellipse.
    const ended = endGesture(moveGesture(held, 1, { x: 90, y: 40 }, noText), 1)
    expect(ids(ended)).toEqual(['ellipse'])
  })

  it('redo mid-gesture cancels the gesture, then redoes', () => {
    const undone = undoMarkup(editorWith(line('a', 0), line('b', 100)))

    const redone = redoMarkup(drawing(undone))
    expect(ids(redone)).toEqual(['a', 'b'])
    expect(ids(finishDrag(redone))).toEqual(['a', 'b'])
  })

  it('redo with nothing to redo keeps the held gesture', () => {
    const held = erase(editorWith(line('a', 0), line('b', 100)), [{ x: 50, y: 0 }])

    expect(redoMarkup(held)).toBe(held)
    expect(ids(endGesture(held, 1))).toEqual(['b'])
  })
})
