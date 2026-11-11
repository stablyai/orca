// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { editor, Range } from 'monaco-editor/esm/vs/editor/editor.api.js'

describe('combined native nonvisual reading marker', () => {
  it('retargets one native marker without decoration events, tracks edits and retires permanently on flush/disposal', async () => {
    const model = editor.createModel('first\nanchor\nlast', 'plaintext')
    // Initialize the lazy bracket provider before observing marker-only events.
    model.getAllDecorations()
    let decorations = 0
    const listener = model.onDidChangeDecorations(() => decorations++)
    const point = model.createTrackedRange(
      new Range(2, 1, 2, 1),
      editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
    )
    try {
      expect(decorations).toBe(0)
      const markerIds = model.getAllDecorations().map((decoration) => decoration.id)
      point.setRange(new Range(3, 2, 3, 4))
      expect(point.getRange()).toEqual(new Range(3, 2, 3, 4))
      expect(model.getAllDecorations().map((decoration) => decoration.id)).toEqual(markerIds)
      point.setRange(new Range(2, 1, 2, 1))
      expect(point.getRange()).toEqual(new Range(2, 1, 2, 1))
      expect(decorations).toBe(0)
      model.pushEditOperations(
        null,
        [{ range: new Range(1, 1, 1, 1), text: 'inserted\n' }],
        () => null
      )
      expect(point.getRange()).toEqual(new Range(3, 1, 3, 1))
      await model.undo()
      expect(point.getRange()).toEqual(new Range(2, 1, 2, 1))
      decorations = 0
      point.setRange(new Range(3, 1, 3, 5))
      expect(point.getRange()).toEqual(new Range(3, 1, 3, 5))
      expect(decorations).toBe(0)
      point.dispose()
      point.dispose()
      point.setRange(new Range(1, 1, 1, 1))
      expect(point.getRange()).toBeNull()
      expect(model.getAllDecorations()).toEqual([])
      expect(decorations).toBe(0)
      const replaced = model.createTrackedRange(new Range(2, 1, 2, 1))
      model.setValue('replacement')
      expect(replaced.getRange()).toBeNull()
      decorations = 0
      replaced.setRange(new Range(1, 1, 1, 2))
      expect(replaced.getRange()).toBeNull()
      expect(model.getAllDecorations()).toEqual([])
      expect(decorations).toBe(0)
      const successor = model.createTrackedRange(new Range(1, 2, 1, 2))
      replaced.setRange(new Range(1, 3, 1, 3))
      expect(replaced.getRange()).toBeNull()
      expect(successor.getRange()).toEqual(new Range(1, 2, 1, 2))
      replaced.dispose()
      expect(decorations).toBe(0)
      model.dispose()
      successor.setRange(new Range(1, 1, 1, 1))
      expect(successor.getRange()).toBeNull()
      successor.dispose()
    } finally {
      point.dispose()
      listener.dispose()
      if (!model.isDisposed()) {
        model.dispose()
      }
    }
  })
})
