import { describe, expect, it, vi } from 'vitest'
import {
  buildSelectionTextDigest,
  exportCollabSelectionFromEditor,
  type CollabSelectionEditor
} from './export-selection'

function mockEditor(overrides: Partial<CollabSelectionEditor> = {}): CollabSelectionEditor {
  return {
    getSelectedShapes: () =>
      [
        { id: 'shape:1', type: 'geo', x: 0, y: 0 },
        { id: 'shape:2', type: 'draw', x: 10, y: 10 }
      ] as never,
    getSelectedShapeIds: () => ['shape:1', 'shape:2'] as never,
    getSelectionPageBounds: () => ({ x: 0, y: 0, w: 100, h: 50 }) as never,
    toImageDataUrl: vi.fn(async () => ({ url: 'data:image/png;base64,abc', width: 10, height: 10 })),
    getShapeUtil: () => ({ getText: () => undefined }),
    ...overrides
  }
}

describe('buildSelectionTextDigest', () => {
  it('lists shape types when no text', () => {
    const editor = mockEditor()
    const digest = buildSelectionTextDigest(editor, editor.getSelectedShapes())
    expect(digest).toContain('geo:shape:1')
    expect(digest).toContain('draw:shape:2')
  })
})

describe('exportCollabSelectionFromEditor', () => {
  it('exports selection with atlas', async () => {
    const editor = mockEditor()
    const selection = await exportCollabSelectionFromEditor(editor, {
      boardId: 'b1',
      worktreeId: 'wt-1'
    })
    expect(selection.boardId).toBe('b1')
    expect(selection.worktreeId).toBe('wt-1')
    expect(selection.selectedShapeIds).toEqual(['shape:1', 'shape:2'])
    expect(selection.atlasDataUri).toBe('data:image/png;base64,abc')
    expect(selection.bounds).toEqual({ x: 0, y: 0, w: 100, h: 50 })
  })

  it('skips atlas when includeAtlas false', async () => {
    const editor = mockEditor()
    const selection = await exportCollabSelectionFromEditor(editor, {
      boardId: 'b1',
      worktreeId: 'wt-1',
      includeAtlas: false
    })
    expect(selection.atlasDataUri).toBeNull()
    expect(editor.toImageDataUrl).not.toHaveBeenCalled()
  })
})
