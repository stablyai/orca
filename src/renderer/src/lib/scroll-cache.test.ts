import { describe, expect, it, beforeEach } from 'vitest'
import {
  editorSelectionCache,
  diffViewStateCache,
  pdfViewPositionCache,
  setWithLRU,
  scrollTopCache
} from './scroll-cache'

beforeEach(() => {
  scrollTopCache.clear()
  editorSelectionCache.clear()
  diffViewStateCache.clear()
  pdfViewPositionCache.clear()
})

describe('setWithLRU', () => {
  it('inserts a new entry into the map', () => {
    const map = new Map<string, number>()
    setWithLRU(map, 'a', 1)
    expect(map.get('a')).toBe(1)
    expect(map.size).toBe(1)
  })

  it('updates an existing entry', () => {
    const map = new Map<string, number>()
    setWithLRU(map, 'a', 1)
    setWithLRU(map, 'a', 2)
    expect(map.get('a')).toBe(2)
    expect(map.size).toBe(1)
  })

  it('evicts the oldest entry when exceeding the default limit', () => {
    const map = new Map<string, number>()
    for (let i = 0; i <= 20; i++) {
      setWithLRU(map, `key-${i}`, i)
    }
    // 21 inserts with default limit of 20 → oldest (key-0) evicted
    expect(map.size).toBe(20)
    expect(map.has('key-0')).toBe(false)
    expect(map.has('key-1')).toBe(true)
    expect(map.has('key-20')).toBe(true)
  })

  it('evicts the oldest entry when exceeding a custom limit', () => {
    const map = new Map<string, number>()
    setWithLRU(map, 'a', 1, 3)
    setWithLRU(map, 'b', 2, 3)
    setWithLRU(map, 'c', 3, 3)
    setWithLRU(map, 'd', 4, 3)
    expect(map.size).toBe(3)
    expect(map.has('a')).toBe(false)
    expect(map.get('d')).toBe(4)
  })

  it('refreshes insertion order when updating an existing key', () => {
    const map = new Map<string, number>()
    setWithLRU(map, 'a', 1, 3)
    setWithLRU(map, 'b', 2, 3)
    setWithLRU(map, 'c', 3, 3)
    // Touch 'a' to move it to the end
    setWithLRU(map, 'a', 10, 3)
    // Now 'b' is the oldest — inserting 'd' should evict 'b', not 'a'
    setWithLRU(map, 'd', 4, 3)
    expect(map.has('a')).toBe(true)
    expect(map.has('b')).toBe(false)
    expect(map.has('c')).toBe(true)
    expect(map.has('d')).toBe(true)
    expect(map.get('a')).toBe(10)
  })

  it('does not evict when at exactly the limit', () => {
    const map = new Map<string, number>()
    setWithLRU(map, 'a', 1, 3)
    setWithLRU(map, 'b', 2, 3)
    setWithLRU(map, 'c', 3, 3)
    expect(map.size).toBe(3)
    expect(map.has('a')).toBe(true)
  })

  it('works with a limit of 1', () => {
    const map = new Map<string, number>()
    setWithLRU(map, 'a', 1, 1)
    expect(map.size).toBe(1)
    setWithLRU(map, 'b', 2, 1)
    expect(map.size).toBe(1)
    expect(map.has('a')).toBe(false)
    expect(map.has('b')).toBe(true)
  })

  it('evicts only one entry per insert even when far over limit', () => {
    const map = new Map<string, number>()
    // Pre-fill with 5 entries
    for (let i = 0; i < 5; i++) {
      map.set(`key-${i}`, i)
    }
    // Insert with a limit of 3 — only evicts one, leaving 5 entries
    // (LRU eviction is per-insert, not bulk)
    setWithLRU(map, 'new', 99, 3)
    expect(map.size).toBe(5)
    expect(map.has('key-0')).toBe(false)
    expect(map.has('new')).toBe(true)
  })
})

describe('scrollTopCache', () => {
  it('is an empty Map on import', () => {
    expect(scrollTopCache).toBeInstanceOf(Map)
    expect(scrollTopCache.size).toBe(0)
  })

  it('works with setWithLRU for mode-scoped keys', () => {
    setWithLRU(scrollTopCache, '/path/to/file.ts', 100)
    setWithLRU(scrollTopCache, '/path/to/file.ts:preview', 200)
    setWithLRU(scrollTopCache, '/path/to/file.ts:rich', 300)
    expect(scrollTopCache.get('/path/to/file.ts')).toBe(100)
    expect(scrollTopCache.get('/path/to/file.ts:preview')).toBe(200)
    expect(scrollTopCache.get('/path/to/file.ts:rich')).toBe(300)
    expect(scrollTopCache.size).toBe(3)
  })
})

describe('editorSelectionCache', () => {
  it('keeps each pane selection independent', () => {
    const firstSelection = {
      selectionStartLineNumber: 2,
      selectionStartColumn: 3,
      positionLineNumber: 4,
      positionColumn: 5
    }
    const secondSelection = {
      selectionStartLineNumber: 8,
      selectionStartColumn: 2,
      positionLineNumber: 6,
      positionColumn: 1
    }

    setWithLRU(editorSelectionCache, '/path/to/file.ts', [firstSelection])
    setWithLRU(editorSelectionCache, '/path/to/file.ts::tab-2', [secondSelection])

    expect(editorSelectionCache.get('/path/to/file.ts')).toEqual([firstSelection])
    expect(editorSelectionCache.get('/path/to/file.ts::tab-2')).toEqual([secondSelection])
  })
})

describe('pdfViewPositionCache', () => {
  it('is an empty Map on import', () => {
    expect(pdfViewPositionCache).toBeInstanceOf(Map)
    expect(pdfViewPositionCache.size).toBe(0)
  })

  it('round-trips pageNumber, top, and left intact', () => {
    setWithLRU(pdfViewPositionCache, '/doc.pdf:pdf', { pageNumber: 12, top: 431.5, left: 62 })
    expect(pdfViewPositionCache.get('/doc.pdf:pdf')).toEqual({
      pageNumber: 12,
      top: 431.5,
      left: 62
    })
  })

  it('keeps pane-scoped keys for the same file independent', () => {
    setWithLRU(pdfViewPositionCache, '/doc.pdf:pdf', { pageNumber: 3, top: 700, left: 0 })
    setWithLRU(pdfViewPositionCache, '/doc.pdf::tab-2:pdf', { pageNumber: 40, top: 120, left: 0 })
    expect(pdfViewPositionCache.get('/doc.pdf:pdf')?.pageNumber).toBe(3)
    expect(pdfViewPositionCache.get('/doc.pdf::tab-2:pdf')?.pageNumber).toBe(40)
  })

  it('evicts the oldest entry at the default cap of 20', () => {
    for (let i = 0; i <= 20; i++) {
      setWithLRU(pdfViewPositionCache, `/doc-${i}.pdf:pdf`, { pageNumber: i, top: 0, left: 0 })
    }
    expect(pdfViewPositionCache.size).toBe(20)
    expect(pdfViewPositionCache.has('/doc-0.pdf:pdf')).toBe(false)
    expect(pdfViewPositionCache.has('/doc-20.pdf:pdf')).toBe(true)
  })

  it('refreshes recency when an existing PDF key is re-set', () => {
    for (let i = 0; i < 20; i++) {
      setWithLRU(pdfViewPositionCache, `/doc-${i}.pdf:pdf`, { pageNumber: i, top: 0, left: 0 })
    }
    setWithLRU(pdfViewPositionCache, '/doc-0.pdf:pdf', { pageNumber: 99, top: 0, left: 0 })
    setWithLRU(pdfViewPositionCache, '/doc-new.pdf:pdf', { pageNumber: 1, top: 0, left: 0 })
    expect(pdfViewPositionCache.get('/doc-0.pdf:pdf')?.pageNumber).toBe(99)
    expect(pdfViewPositionCache.has('/doc-1.pdf:pdf')).toBe(false)
  })
})

describe('diffViewStateCache', () => {
  it('is an empty Map on import', () => {
    expect(diffViewStateCache).toBeInstanceOf(Map)
    expect(diffViewStateCache.size).toBe(0)
  })

  it('works with setWithLRU for diff-tab keys', () => {
    const diffState = {
      original: {
        cursorState: [],
        viewState: { scrollTop: 10, scrollTopWithoutViewZones: 10, scrollLeft: 0 }
      },
      modified: {
        cursorState: [],
        viewState: { scrollTop: 20, scrollTopWithoutViewZones: 20, scrollLeft: 0 }
      },
      modelState: { unchangedRegions: [] }
    } as unknown as typeof diffViewStateCache extends Map<string, infer T> ? T : never

    setWithLRU(diffViewStateCache, 'diff-tab', diffState)

    expect(diffViewStateCache.get('diff-tab')).toBe(diffState)
    expect(diffViewStateCache.size).toBe(1)
  })
})
