// Pure document edits for the select/edit tools. Each returns a new document as a
// single undoable step (via setShapes), keeping the editor hook's handlers to
// one-liners and making the transforms unit-testable.

import {
  restyleShape,
  setShapes,
  translateShape,
  type MarkupDocument,
  type MarkupStylePatch
} from './markup-drawing-model'

export function moveShapeInDocument(
  doc: MarkupDocument,
  id: string,
  dx: number,
  dy: number
): MarkupDocument {
  return setShapes(
    doc,
    doc.shapes.map((shape) => (shape.id === id ? translateShape(shape, dx, dy) : shape))
  )
}

export function deleteShapeFromDocument(doc: MarkupDocument, id: string): MarkupDocument {
  return setShapes(
    doc,
    doc.shapes.filter((shape) => shape.id !== id)
  )
}

export function restyleShapeInDocument(
  doc: MarkupDocument,
  id: string,
  patch: MarkupStylePatch
): MarkupDocument {
  return setShapes(
    doc,
    doc.shapes.map((shape) => (shape.id === id ? restyleShape(shape, patch) : shape))
  )
}

// Replace a text shape's content/style, or remove it when the text is cleared.
export function setTextInDocument(
  doc: MarkupDocument,
  id: string,
  text: string,
  color: string,
  fontSize: number
): MarkupDocument {
  if (text.length === 0) {
    return deleteShapeFromDocument(doc, id)
  }
  return setShapes(
    doc,
    doc.shapes.map((shape) =>
      shape.id === id && shape.kind === 'text' ? { ...shape, text, color, fontSize } : shape
    )
  )
}
