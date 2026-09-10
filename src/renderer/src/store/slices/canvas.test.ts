import { describe, it, expect } from 'vitest'
import { classifyCanvasFile, CANVAS_MIN_CARD_WIDTH } from './canvas'
import { createTestStore, seedStore, makeWorktree } from './store-test-helpers'

const WT = 'repo1::/path/wt1'

function makeSeededStore(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })]
    },
    activeWorktreeId: WT
  })
  return store
}

describe('classifyCanvasFile', () => {
  it('classifies markdown and html extensions case-insensitively', () => {
    expect(classifyCanvasFile('/a/b/notes.md')).toBe('markdown')
    expect(classifyCanvasFile('/a/b/NOTES.MDX')).toBe('markdown')
    expect(classifyCanvasFile('C:\\proto\\index.html')).toBe('html')
    expect(classifyCanvasFile('/a/b/page.htm')).toBe('html')
  })

  it('rejects unsupported files', () => {
    expect(classifyCanvasFile('/a/b/app.ts')).toBeNull()
    expect(classifyCanvasFile('/a/b/image.png')).toBeNull()
    expect(classifyCanvasFile('/a/b/no-extension')).toBeNull()
  })
})

describe('canvas slice', () => {
  it('adds a card and derives its kind from the path', () => {
    const store = makeSeededStore()
    const card = store.getState().addCanvasCard(WT, {
      filePath: '/path/wt1/README.md',
      x: 10,
      y: 20,
      width: 520,
      height: 420
    })
    expect(card).not.toBeNull()
    expect(card?.kind).toBe('markdown')
    expect(store.getState().canvasCardsByWorktree[WT]).toHaveLength(1)
  })

  it('refuses unsupported file types', () => {
    const store = makeSeededStore()
    const card = store.getState().addCanvasCard(WT, {
      filePath: '/path/wt1/main.ts',
      x: 0,
      y: 0,
      width: 520,
      height: 420
    })
    expect(card).toBeNull()
    expect(store.getState().canvasCardsByWorktree[WT]).toBeUndefined()
  })

  it('returns the existing card when the same file is added twice', () => {
    const store = makeSeededStore()
    const first = store.getState().addCanvasCard(WT, {
      filePath: '/path/wt1/README.md',
      x: 0,
      y: 0,
      width: 520,
      height: 420
    })
    const second = store.getState().addCanvasCard(WT, {
      filePath: '/path/wt1/README.md',
      x: 100,
      y: 100,
      width: 520,
      height: 420
    })
    expect(second?.id).toBe(first?.id)
    expect(store.getState().canvasCardsByWorktree[WT]).toHaveLength(1)
  })

  it('updates geometry with minimum size clamping', () => {
    const store = makeSeededStore()
    const card = store
      .getState()
      .addCanvasCard(WT, { filePath: '/path/wt1/p.html', x: 0, y: 0, width: 520, height: 420 })
    store.getState().updateCanvasCardGeometry(WT, card!.id, { x: 50, y: 60, width: 10 })
    const updated = store.getState().canvasCardsByWorktree[WT][0]
    expect(updated.x).toBe(50)
    expect(updated.y).toBe(60)
    expect(updated.width).toBe(CANVAS_MIN_CARD_WIDTH)
  })

  it('removes cards and keeps other worktrees untouched', () => {
    const store = makeSeededStore()
    const kept = store
      .getState()
      .addCanvasCard('other::/wt2', { filePath: '/wt2/a.md', x: 0, y: 0, width: 520, height: 420 })
    const removed = store
      .getState()
      .addCanvasCard(WT, { filePath: '/path/wt1/b.md', x: 0, y: 0, width: 520, height: 420 })
    store.getState().removeCanvasCard(WT, removed!.id)
    expect(store.getState().canvasCardsByWorktree[WT]).toEqual([])
    expect(store.getState().canvasCardsByWorktree['other::/wt2']?.[0]?.id).toBe(kept?.id)
  })

  it('stores the viewport per worktree', () => {
    const store = makeSeededStore()
    store.getState().setCanvasViewport(WT, { offsetX: 5, offsetY: 6, zoom: 1.5 })
    expect(store.getState().canvasViewportByWorktree[WT]).toEqual({
      offsetX: 5,
      offsetY: 6,
      zoom: 1.5
    })
  })
})
