import { describe, expect, it } from 'vitest'
import {
  MAX_PANEL_LAYOUTS,
  MAX_PANEL_LAYOUT_LEAVES,
  countPanelLayoutLeaves,
  normalizePanelLayouts,
  prunePanelLayoutsForSurvivingPanels
} from './panel-layouts'
import type { PanelLayout, PanelLayoutNode } from './types'

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

  it('accepts browser leaves (about:blank and https)', () => {
    const layouts = normalizePanelLayouts([
      {
        id: 'br',
        title: 'blank',
        root: {
          direction: 'row',
          children: [
            { kind: 'browser' },
            { kind: 'browser', url: 'about:blank', label: 'scratch' },
            { kind: 'browser', url: 'https://example.com/x' }
          ]
        }
      }
    ])
    expect(layouts).toHaveLength(1)
    expect(countPanelLayoutLeaves(layouts[0].root)).toBe(3)
  })

  it('drops browser leaves with non-http schemes (except about:blank)', () => {
    const layouts = normalizePanelLayouts([
      {
        id: 'bad',
        title: 'bad',
        root: { kind: 'browser', url: 'file:///etc/passwd' }
      },
      {
        id: 'ok',
        title: 'ok',
        root: { kind: 'browser', url: 'https://ok.example/' }
      }
    ])
    expect(layouts.map((l) => l.id)).toEqual(['ok'])
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

describe('shell leaves', () => {
  it('keeps a shell leaf with host, local shell, and label', () => {
    const layouts = normalizePanelLayouts([
      {
        id: 'l1',
        title: 'shells',
        root: {
          direction: 'row',
          children: [
            { kind: 'shell', host: 'node-a', label: 'node-a' },
            { kind: 'shell', host: null }
          ]
        }
      }
    ])
    expect(layouts[0].root).toEqual({
      direction: 'row',
      children: [
        { kind: 'shell', host: 'node-a', label: 'node-a' },
        { kind: 'shell', host: null }
      ]
    })
  })

  it('rejects a shell leaf whose host is an empty string', () => {
    // Why: '' would silently mean "local"; only an explicit null does.
    expect(
      normalizePanelLayouts([{ id: 'l', title: 't', root: { kind: 'shell', host: '' } }])
    ).toEqual([])
  })

  it('drops a blank label instead of persisting it', () => {
    const layouts = normalizePanelLayouts([
      { id: 'l', title: 't', root: { kind: 'shell', host: 'h', label: '   ' } }
    ])
    expect(layouts[0].root).toEqual({ kind: 'shell', host: 'h' })
  })

  it('counts shell leaves against the leaf budget', () => {
    const wide = normalizePanelLayouts([
      {
        id: 'w',
        title: 'w',
        root: {
          direction: 'row',
          children: Array.from({ length: MAX_PANEL_LAYOUT_LEAVES + 3 }, () => ({
            kind: 'shell',
            host: 'h'
          }))
        }
      }
    ])
    expect(countPanelLayoutLeaves(wide[0].root)).toBe(MAX_PANEL_LAYOUT_LEAVES)
  })
})

describe('prunePanelLayoutsForSurvivingPanels', () => {
  const layout = (root: PanelLayoutNode): PanelLayout => ({ id: 'l1', title: 'L', root })

  it('keeps layouts untouched when every referenced panel survives', () => {
    const l = layout({ direction: 'row', children: [leaf('t1'), { kind: 'web', panelId: 'w1' }] })
    const out = prunePanelLayoutsForSurvivingPanels([l], [{ id: 't1' }], [{ id: 'w1' }])
    expect(out).toHaveLength(1)
    // identity preserved so a no-op delete elsewhere can't churn the profile
    expect(out[0]).toBe(l)
  })

  it('collapses a split to the surviving child when one panel is deleted', () => {
    const l = layout({ direction: 'row', children: [leaf('t1'), { kind: 'web', panelId: 'w1' }] })
    const out = prunePanelLayoutsForSurvivingPanels([l], [{ id: 't1' }], [])
    expect(out).toHaveLength(1)
    expect(out[0].root).toEqual({ kind: 'terminal', panelId: 't1' })
  })

  it('drops the layout entirely when nothing survives', () => {
    const l = layout({ direction: 'row', children: [leaf('t1'), leaf('t2')] })
    expect(prunePanelLayoutsForSurvivingPanels([l], [], [])).toEqual([])
  })

  it('drops stale sizes when the child count shrinks', () => {
    const l = layout({
      direction: 'row',
      children: [leaf('t1'), leaf('t2'), leaf('t3')],
      sizes: [1, 2, 3]
    })
    const out = prunePanelLayoutsForSurvivingPanels([l], [{ id: 't1' }, { id: 't3' }], [])
    const root = out[0].root as Extract<PanelLayoutNode, { direction: 'row' | 'column' }>
    expect(root.children).toHaveLength(2)
    expect(root.sizes).toBeUndefined()
  })

  it('never drops self-contained shell and browser leaves', () => {
    const l = layout({
      direction: 'column',
      children: [
        leaf('gone'),
        { kind: 'shell', host: 'node-a' },
        { kind: 'browser', url: 'about:blank' }
      ]
    })
    const out = prunePanelLayoutsForSurvivingPanels([l], [], [])
    const root = out[0].root as Extract<PanelLayoutNode, { direction: 'row' | 'column' }>
    expect(root.children).toEqual([
      { kind: 'shell', host: 'node-a' },
      { kind: 'browser', url: 'about:blank' }
    ])
  })

  it('prunes nested splits recursively', () => {
    const l = layout({
      direction: 'row',
      children: [leaf('keep'), { direction: 'column', children: [leaf('gone1'), leaf('gone2')] }]
    })
    const out = prunePanelLayoutsForSurvivingPanels([l], [{ id: 'keep' }], [])
    expect(out[0].root).toEqual({ kind: 'terminal', panelId: 'keep' })
  })

  it('handles empty and missing layout lists', () => {
    expect(prunePanelLayoutsForSurvivingPanels(undefined, [], [])).toEqual([])
    expect(prunePanelLayoutsForSurvivingPanels([], [{ id: 'x' }], [])).toEqual([])
  })
})
