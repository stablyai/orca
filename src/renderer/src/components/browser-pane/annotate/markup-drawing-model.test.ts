import { describe, expect, it } from 'vitest'
import {
  canRedo,
  commitShape,
  createMarkupDocument,
  undoShape,
  type PenShape
} from './markup-drawing-model'

function pen(id: string): PenShape {
  return { id, kind: 'pen', color: '#ef4444', width: 4, points: [{ x: 0, y: 0 }] }
}

describe('markup document undo/redo', () => {
  it('forks history: committing after undo discards the redo stack', () => {
    let doc = createMarkupDocument()
    doc = commitShape(doc, pen('a'))
    doc = commitShape(doc, pen('b'))
    doc = undoShape(doc)
    doc = commitShape(doc, pen('c'))
    expect(doc.shapes.map((s) => s.id)).toEqual(['a', 'c'])
    expect(canRedo(doc)).toBe(false)
  })
})
