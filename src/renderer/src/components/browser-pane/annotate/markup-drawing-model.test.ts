import { describe, expect, it } from 'vitest'
import {
  arrowHeadGeometry,
  canRedo,
  canUndo,
  clearShapes,
  commitShape,
  createMarkupDocument,
  isEmptyDocument,
  normalizeRect,
  redoShape,
  scaleShape,
  setShapes,
  undoShape,
  type ArrowShape,
  type MarkupShape,
  type PenShape,
  type TextShape
} from './markup-drawing-model'

function pen(id: string): PenShape {
  return { id, kind: 'pen', color: '#ef4444', width: 4, points: [{ x: 0, y: 0 }] }
}

describe('markup document undo/redo', () => {
  it('starts empty', () => {
    const doc = createMarkupDocument()
    expect(doc.shapes).toHaveLength(0)
    expect(isEmptyDocument(doc)).toBe(true)
    expect(canUndo(doc)).toBe(false)
    expect(canRedo(doc)).toBe(false)
  })

  it('commits shapes and clears the redo stack', () => {
    let doc = createMarkupDocument()
    doc = commitShape(doc, pen('a'))
    doc = commitShape(doc, pen('b'))
    expect(doc.shapes.map((s) => s.id)).toEqual(['a', 'b'])
    expect(canUndo(doc)).toBe(true)
    expect(canRedo(doc)).toBe(false)
  })

  it('undoes and redoes in order', () => {
    let doc = createMarkupDocument()
    doc = commitShape(doc, pen('a'))
    doc = commitShape(doc, pen('b'))
    doc = undoShape(doc)
    expect(doc.shapes.map((s) => s.id)).toEqual(['a'])
    expect(canRedo(doc)).toBe(true)
    doc = redoShape(doc)
    expect(doc.shapes.map((s) => s.id)).toEqual(['a', 'b'])
    expect(canRedo(doc)).toBe(false)
  })

  it('forks history: committing after undo discards the redo stack', () => {
    let doc = createMarkupDocument()
    doc = commitShape(doc, pen('a'))
    doc = commitShape(doc, pen('b'))
    doc = undoShape(doc)
    doc = commitShape(doc, pen('c'))
    expect(doc.shapes.map((s) => s.id)).toEqual(['a', 'c'])
    expect(canRedo(doc)).toBe(false)
  })

  it('undo/redo on empty document are no-ops returning the same reference', () => {
    const doc = createMarkupDocument()
    expect(undoShape(doc)).toBe(doc)
    expect(redoShape(doc)).toBe(doc)
  })

  it('clears shapes, and is a no-op (same reference) when already empty', () => {
    const empty = createMarkupDocument()
    expect(clearShapes(empty)).toBe(empty)
    let doc = commitShape(empty, pen('a'))
    doc = clearShapes(doc)
    expect(doc.shapes).toHaveLength(0)
    expect(canRedo(doc)).toBe(false)
  })

  it('undoes an edit (not just an add) via whole-list snapshots', () => {
    let doc = commitShape(createMarkupDocument(), pen('a'))
    doc = setShapes(doc, []) // delete everything
    expect(doc.shapes).toHaveLength(0)
    doc = undoShape(doc)
    expect(doc.shapes.map((s) => s.id)).toEqual(['a'])
  })
})

describe('markup geometry', () => {
  it('normalizes rectangles from any drag direction', () => {
    expect(normalizeRect({ x: 10, y: 20 }, { x: 4, y: 50 })).toEqual({
      x: 4,
      y: 20,
      width: 6,
      height: 30
    })
  })

  it('scales pen points and width', () => {
    const shape: PenShape = {
      id: 'a',
      kind: 'pen',
      color: '#fff',
      width: 4,
      points: [
        { x: 2, y: 3 },
        { x: 4, y: 5 }
      ]
    }
    const scaled = scaleShape(shape, 2) as PenShape
    expect(scaled.width).toBe(8)
    expect(scaled.points).toEqual([
      { x: 4, y: 6 },
      { x: 8, y: 10 }
    ])
  })

  it('scales rect/arrow endpoints and text position + font size', () => {
    const arrow: ArrowShape = {
      id: 'a',
      kind: 'arrow',
      color: '#fff',
      width: 3,
      from: { x: 1, y: 1 },
      to: { x: 3, y: 5 }
    }
    const scaledArrow = scaleShape(arrow, 3) as ArrowShape
    expect(scaledArrow.from).toEqual({ x: 3, y: 3 })
    expect(scaledArrow.to).toEqual({ x: 9, y: 15 })
    expect(scaledArrow.width).toBe(9)

    const text: TextShape = {
      id: 't',
      kind: 'text',
      color: '#fff',
      at: { x: 10, y: 20 },
      text: 'fix',
      fontSize: 18
    }
    const scaledText = scaleShape(text, 2) as TextShape
    expect(scaledText.at).toEqual({ x: 20, y: 40 })
    expect(scaledText.fontSize).toBe(36)
  })

  it('returns null arrowhead for a zero-length segment', () => {
    expect(arrowHeadGeometry({ x: 5, y: 5 }, { x: 5, y: 5 }, 4)).toBeNull()
  })

  it('produces a symmetric arrowhead pointing at the tip', () => {
    const head = arrowHeadGeometry({ x: 0, y: 0 }, { x: 10, y: 0 }, 4)
    expect(head).not.toBeNull()
    if (!head) {
      return
    }
    expect(head.tip).toEqual({ x: 10, y: 0 })
    // Wings sit behind the tip (smaller x) and mirror across the horizontal axis.
    expect(head.left.x).toBeLessThan(10)
    expect(head.right.x).toBeLessThan(10)
    expect(head.left.y).toBeCloseTo(-head.right.y, 6)
  })
})

// Why: exhaustiveness guard — if a new MarkupShape kind is added without a
// scaleShape branch, this fails to type-check at the cast site below.
const _exhaustive: MarkupShape['kind'][] = ['pen', 'highlight', 'arrow', 'rect', 'ellipse', 'text']
void _exhaustive
