import { describe, expect, it } from 'vitest'
import {
  MAX_PANEL_LAYOUTS,
  MAX_PANEL_LAYOUT_LEAVES,
  countPanelLayoutLeaves,
  normalizePanelLayouts
} from './panel-layouts'
import type { PanelLayoutNode } from './types'

const leaf = (panelId: string): PanelLayoutNode => ({ kind: 'terminal', panelId })

describe('normalizePanelLayouts', () => {
  it('returns empty for non-array input', () => {
    expect(normalizePanelLayouts(undefined)).toEqual([])
    expect(normalizePanelLayouts(null)).toEqual([])
    expect(normalizePanelLayouts('nope')).toEqual([])
  })

  it('keeps a valid layout intact', () => {
    const layouts = normalizePanelLayouts([
      {
        id: 'l1',
        title: 'all nodes btop',
        root: {
          direction: 'row',
          children: [leaf('a'), { kind: 'web', panelId: 'b' }],
          sizes: [2, 1]
        }
      }
    ])
    expect(layouts).toEqual([
      {
        id: 'l1',
        title: 'all nodes btop',
        root: {
          direction: 'row',
          children: [
            { kind: 'terminal', panelId: 'a' },
            { kind: 'web', panelId: 'b' }
          ],
          sizes: [2, 1]
        }
      }
    ])
  })

  it('drops malformed entries without failing the rest', () => {
    const layouts = normalizePanelLayouts([
      { id: 'bad-root', title: 'x', root: { direction: 'diagonal', children: [] } },
      { id: '', title: 'x', root: leaf('a') },
      { id: 'no-title', title: '   ', root: leaf('a') },
      { id: 'ok', title: 'ok', root: leaf('a') }
    ])
    expect(layouts.map((layout) => layout.id)).toEqual(['ok'])
  })

  it('drops duplicate ids, keeping the first', () => {
    const layouts = normalizePanelLayouts([
      { id: 'dup', title: 'first', root: leaf('a') },
      { id: 'dup', title: 'second', root: leaf('b') }
    ])
    expect(layouts).toHaveLength(1)
    expect(layouts[0].title).toBe('first')
  })

  it('collapses single-child splits into the child', () => {
    const layouts = normalizePanelLayouts([
      {
        id: 'l1',
        title: 't',
        root: { direction: 'row', children: [leaf('only')] }
      }
    ])
    expect(layouts[0].root).toEqual({ kind: 'terminal', panelId: 'only' })
  })

  it('drops mismatched or non-positive sizes but keeps the split', () => {
    const layouts = normalizePanelLayouts([
      {
        id: 'l1',
        title: 't',
        root: { direction: 'column', children: [leaf('a'), leaf('b')], sizes: [1, 0] }
      },
      {
        id: 'l2',
        title: 't2',
        root: { direction: 'column', children: [leaf('a'), leaf('b')], sizes: [1, 2, 3] }
      }
    ])
    expect(layouts[0].root).toEqual({ direction: 'column', children: [leaf('a'), leaf('b')] })
    expect(layouts[1].root).toEqual({ direction: 'column', children: [leaf('a'), leaf('b')] })
  })

  it('caps the layout count and the leaf budget per layout', () => {
    const many = Array.from({ length: MAX_PANEL_LAYOUTS + 4 }, (_, i) => ({
      id: `l${i}`,
      title: `t${i}`,
      root: leaf('a')
    }))
    expect(normalizePanelLayouts(many)).toHaveLength(MAX_PANEL_LAYOUTS)

    const wide = normalizePanelLayouts([
      {
        id: 'wide',
        title: 'wide',
        root: {
          direction: 'row',
          children: Array.from({ length: MAX_PANEL_LAYOUT_LEAVES + 5 }, (_, i) => leaf(`p${i}`))
        }
      }
    ])
    expect(countPanelLayoutLeaves(wide[0].root)).toBe(MAX_PANEL_LAYOUT_LEAVES)
  })

  it('prunes subtrees nested past the depth cap instead of dropping the layout', () => {
    let root: PanelLayoutNode = leaf('deep')
    for (let i = 0; i < 8; i++) {
      root = { direction: 'row', children: [root, leaf(`p${i}`)] }
    }
    const layouts = normalizePanelLayouts([{ id: 'deep', title: 'deep', root }])
    expect(layouts).toHaveLength(1)
    // Why: 9 leaves went in; everything below the depth cap is pruned and
    // orphaned single-child splits collapse upward.
    expect(countPanelLayoutLeaves(layouts[0].root)).toBeLessThan(9)
  })
})
