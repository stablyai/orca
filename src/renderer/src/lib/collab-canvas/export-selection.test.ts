import { describe, expect, it, vi } from 'vitest'
import {
  buildSelectionTextDigest,
  exportCollabBoardFromEditor,
  exportCollabSelectionFromEditor,
  type CollabSelectionEditor
} from './export-selection'

const pageShapes = [
  { id: 'shape:1', type: 'geo', x: 0, y: 0 },
  { id: 'shape:2', type: 'draw', x: 10, y: 10 },
  { id: 'shape:3', type: 'draw', x: 40, y: 50 }
] as never

function mockEditor(overrides: Partial<CollabSelectionEditor> = {}): CollabSelectionEditor {
  return {
    getSelectedShapes: () =>
      [
        { id: 'shape:1', type: 'geo', x: 0, y: 0 },
        { id: 'shape:2', type: 'draw', x: 10, y: 10 }
      ] as never,
    getSelectedShapeIds: () => ['shape:1', 'shape:2'] as never,
    getSelectionPageBounds: () => ({ x: 0, y: 0, w: 100, h: 50 }) as never,
    getCurrentPageShapes: () => pageShapes,
    toImageDataUrl: vi.fn(async (shapes) => ({
      url: `data:image/png;base64,n${Array.isArray(shapes) ? shapes.length : 0}`,
      width: 10,
      height: 10
    })),
    getShapeUtil: () => ({ getText: () => undefined }),
    ...overrides
  }
}

describe('buildSelectionTextDigest', () => {
  it('lists shape types with coords', () => {
    const editor = mockEditor()
    const digest = buildSelectionTextDigest(editor, editor.getSelectedShapes())
    expect(digest).toContain('geo:shape:1')
    expect(digest).toContain('draw:shape:2')
    expect(digest).toContain('@0,0')
  })
})

describe('exportCollabBoardFromEditor', () => {
  it('always exports full-board atlas plus selection crop when focus differs', async () => {
    const editor = mockEditor()
    const snap = await exportCollabBoardFromEditor(editor, {
      boardId: 'b1',
      worktreeId: 'wt-1'
    })
    expect(snap.boardId).toBe('b1')
    expect(snap.hasSelection).toBe(true)
    expect(snap.boardShapeIds).toHaveLength(3)
    expect(snap.boardAtlasDataUri).toBe('data:image/png;base64,n3')
    expect(snap.atlasDataUri).toBe(snap.boardAtlasDataUri)
    expect(snap.selectionAtlasDataUri).toBe('data:image/png;base64,n2')
    expect(snap.bounds).toEqual({ x: 0, y: 0, w: 100, h: 50 })
    expect(editor.toImageDataUrl).toHaveBeenCalledTimes(2)
  })

  it('sends with no selection (full board only)', async () => {
    const editor = mockEditor({
      getSelectedShapes: () => [] as never,
      getSelectedShapeIds: () => [] as never,
      getSelectionPageBounds: () => null
    })
    const snap = await exportCollabBoardFromEditor(editor, {
      boardId: 'b1',
      worktreeId: 'wt-1'
    })
    expect(snap.hasSelection).toBe(false)
    expect(snap.boardAtlasDataUri).toBe('data:image/png;base64,n3')
    expect(snap.selectionAtlasDataUri).toBeNull()
    expect(editor.toImageDataUrl).toHaveBeenCalledTimes(1)
  })
})

describe('exportCollabSelectionFromEditor', () => {
  it('exports selection with atlas (legacy path)', async () => {
    const editor = mockEditor()
    const selection = await exportCollabSelectionFromEditor(editor, {
      boardId: 'b1',
      worktreeId: 'wt-1'
    })
    expect(selection.selectedShapeIds).toEqual(['shape:1', 'shape:2'])
    expect(selection.atlasDataUri).toMatch(/^data:image\/png/)
  })
})
