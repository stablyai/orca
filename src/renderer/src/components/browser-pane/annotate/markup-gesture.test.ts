import { describe, expect, it } from 'vitest'
import {
  commitShape,
  createMarkupDocument,
  redoShape,
  undoShape,
  type MarkupPoint,
  type PenShape,
  type TextShape
} from './markup-drawing-model'
import {
  beginDrawGesture,
  beginEraseGesture,
  endGesture,
  moveGesture,
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
  it('removes only the clicked mark, leaving the ones drawn after it', () => {
    const state = endGesture(
      erase(editorWith(line('a', 0), line('b', 100), line('c', 200)), [{ x: 50, y: 0 }]),
      1
    )

    expect(ids(state)).toEqual(['b', 'c'])
    expect(state.gesture).toBeNull()
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

  it('leaves the document and its history untouched when nothing was hit', () => {
    const before = editorWith(line('a', 0))
    const after = endGesture(erase(before, [{ x: 50, y: 300 }]), 1)

    expect(after.doc).toBe(before.doc)
  })

  it('does not erase a mark the pointer curved around between events', () => {
    // Down left of the stroke, around its end, to its far side: the chord from the
    // first to the last point crosses it, but no swept segment does.
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

  it('keeps the same erased set while a drag hits nothing new', () => {
    const begun = beginEraseGesture(editorWith(line('a', 0)), 1, { x: 50, y: 0 }, noText)
    const moved = moveGesture(begun, 1, { x: 50, y: 300 }, noText)

    expect(erasedIds(begun)).toEqual(new Set(['a']))
    expect(erasedIds(moved)).toBe(erasedIds(begun))
  })

  it('erases a text label the drag passes through', () => {
    const label: TextShape = {
      id: 'label',
      kind: 'text',
      color: '#111827',
      at: { x: 200, y: 200 },
      text: 'note',
      fontSize: 18
    }
    const inkBox = () => ({ x: 200, y: 200, width: 60, height: 20 })
    const before: MarkupEditorState = {
      doc: commitShape(createMarkupDocument(), label),
      gesture: null
    }
    const begun = beginEraseGesture(before, 1, { x: 100, y: 210 }, inkBox)
    const after = endGesture(moveGesture(begun, 1, { x: 230, y: 210 }, inkBox), 1)

    expect(erasedIds(begun)).toEqual(new Set())
    expect(ids(after)).toEqual([])
  })

  it('ignores a second pointer while a gesture is in flight', () => {
    const first = erase(editorWith(line('a', 0), line('b', 100)), [{ x: 50, y: 0 }], 1)

    const secondDown = beginEraseGesture(first, 2, { x: 50, y: 100 }, noText)
    expect(secondDown).toBe(first)
    expect(moveGesture(first, 2, { x: 50, y: 100 }, noText)).toBe(first)
    expect(endGesture(first, 2)).toBe(first)

    expect(ids(endGesture(first, 1))).toEqual(['b'])
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
  it('keeps every point of a freehand stroke', () => {
    const begun = beginDrawGesture(editorWith(), 1, {
      id: 'pen',
      kind: 'highlight',
      color: '#eab308',
      width: 4,
      points: [{ x: 0, y: 0 }]
    })
    const moved = [
      { x: 10, y: 5 },
      { x: 20, y: 0 }
    ].reduce((state, point) => moveGesture(state, 1, point, noText), begun)

    expect(endGesture(moved, 1).doc.shapes).toMatchObject([
      {
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 5 },
          { x: 20, y: 0 }
        ]
      }
    ])
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
})
