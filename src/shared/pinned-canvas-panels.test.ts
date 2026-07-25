import { describe, expect, it } from 'vitest'
import { MAX_PINNED_CANVAS_PANELS, normalizePinnedCanvasPanels } from './pinned-canvas-panels'

describe('normalizePinnedCanvasPanels', () => {
  it('returns an empty list for non-array input', () => {
    expect(normalizePinnedCanvasPanels(undefined)).toEqual([])
    expect(normalizePinnedCanvasPanels(null)).toEqual([])
    expect(normalizePinnedCanvasPanels({ id: 'a' })).toEqual([])
  })

  it('keeps a well-formed board and its optional fields', () => {
    expect(
      normalizePinnedCanvasPanels([
        { id: 'p1', title: '  Roadmap  ', boardId: 'board-1', groupId: 'g1', order: 2.7 }
      ])
    ).toEqual([{ id: 'p1', title: 'Roadmap', boardId: 'board-1', groupId: 'g1', order: 2 }])
  })

  it('omits absent optional fields rather than writing undefined', () => {
    const [panel] = normalizePinnedCanvasPanels([{ id: 'p1', title: 'B', boardId: 'b1' }])
    expect(Object.hasOwn(panel, 'groupId')).toBe(false)
    expect(Object.hasOwn(panel, 'order')).toBe(false)
  })

  it('falls back to the board id when the title is blank', () => {
    expect(normalizePinnedCanvasPanels([{ id: 'p1', title: '   ', boardId: 'b1' }])[0].title).toBe(
      'b1'
    )
  })

  it('caps long titles', () => {
    const title = 'x'.repeat(200)
    expect(normalizePinnedCanvasPanels([{ id: 'p1', title, boardId: 'b1' }])[0].title).toHaveLength(
      60
    )
  })

  it('drops board ids that could escape the state dir', () => {
    // These key a snapshot filename and an omp --session-dir, so traversal and
    // separators must never survive normalization.
    for (const boardId of ['../escape', 'a/b', 'has space', '', 'x'.repeat(65), 42, null]) {
      expect(normalizePinnedCanvasPanels([{ id: 'p1', title: 'B', boardId }])).toEqual([])
    }
  })

  it('drops one malformed entry without failing the rest of the write', () => {
    const panels = normalizePinnedCanvasPanels([
      { id: 'p1', title: 'Good', boardId: 'b1' },
      { id: '', title: 'No id', boardId: 'b2' },
      null,
      { id: 'p3', title: 'Also good', boardId: 'b3' }
    ])
    expect(panels.map((p) => p.id)).toEqual(['p1', 'p3'])
  })

  it('drops duplicate ids and duplicate board ids', () => {
    expect(
      normalizePinnedCanvasPanels([
        { id: 'p1', title: 'First', boardId: 'b1' },
        { id: 'p1', title: 'Same id', boardId: 'b2' },
        // Two rows driving one snapshot + one omp session: the second writer
        // would clobber the first, so it never gets persisted.
        { id: 'p2', title: 'Same board', boardId: 'b1' }
      ]).map((p) => p.title)
    ).toEqual(['First'])
  })

  it('stops at the cap', () => {
    const input = Array.from({ length: MAX_PINNED_CANVAS_PANELS + 5 }, (_, i) => ({
      id: `p${i}`,
      title: `B${i}`,
      boardId: `b${i}`
    }))
    expect(normalizePinnedCanvasPanels(input)).toHaveLength(MAX_PINNED_CANVAS_PANELS)
  })
})
