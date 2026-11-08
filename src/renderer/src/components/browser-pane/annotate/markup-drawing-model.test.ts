import { describe, expect, it } from 'vitest'
import {
  canRedo,
  commitShape,
  createMarkupDocument,
  redoShape,
  setShapes,
  undoShape,
  type MarkupShape,
  type PenShape
} from './markup-drawing-model'

function pen(id: string): PenShape {
  return { id, kind: 'pen', color: '#ef4444', width: 4, points: [{ x: 0, y: 0 }] }
}

describe('markup document undo/redo', () => {
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

  it('undoes an edit (not just an add) via whole-list snapshots', () => {
    let doc = commitShape(createMarkupDocument(), pen('a'))
    doc = setShapes(doc, [])
    expect(doc.shapes).toHaveLength(0)
    doc = undoShape(doc)
    expect(doc.shapes.map((s) => s.id)).toEqual(['a'])
  })
})

const _exhaustive: MarkupShape['kind'][] = ['pen', 'highlight', 'arrow', 'rect', 'ellipse', 'text']
void _exhaustive
