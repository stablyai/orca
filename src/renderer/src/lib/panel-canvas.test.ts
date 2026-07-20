import { describe, expect, it } from 'vitest'
import {
  appendCanvasLeaf,
  canvasLeafFor,
  canvasNodeFromLayout,
  collectCanvasLeaves,
  countCanvasLeaves,
  isPanelCanvasLeaf,
  layoutNodeFromCanvas,
  removeCanvasLeaf,
  setCanvasSplitSizes,
  splitCanvasLeaf,
  canvasShellLeafFor,
  duplicateCanvasLeaf,
  type PanelCanvasNode,
  type PanelCanvasSplit
} from './panel-canvas'

function row(children: PanelCanvasNode[], sizes?: number[]): PanelCanvasSplit {
  return { id: crypto.randomUUID(), direction: 'row', children, ...(sizes ? { sizes } : {}) }
}

describe('canvas ↔ layout round trip', () => {
  it('hydrates a layout with fresh ids and strips them back off', () => {
    const layout = {
      direction: 'row' as const,
      children: [
        { kind: 'terminal' as const, panelId: 'a' },
        {
          direction: 'column' as const,
          children: [
            { kind: 'web' as const, panelId: 'b' },
            { kind: 'terminal' as const, panelId: 'c' }
          ],
          sizes: [1, 2]
        }
      ]
    }
    const canvas = canvasNodeFromLayout(layout)
    expect(countCanvasLeaves(canvas)).toBe(3)
    const ids = new Set(collectCanvasLeaves(canvas).map((leaf) => leaf.id))
    expect(ids.size).toBe(3)
    expect(layoutNodeFromCanvas(canvas)).toEqual(layout)
  })
})

describe('splitCanvasLeaf', () => {
  it('wraps a targeted leaf in a new split of the requested direction', () => {
    const a = canvasLeafFor('terminal', 'a')
    const b = canvasLeafFor('terminal', 'b')
    const next = splitCanvasLeaf(a, a.id, b, 'column')
    expect(isPanelCanvasLeaf(next)).toBe(false)
    if (!isPanelCanvasLeaf(next)) {
      expect(next.direction).toBe('column')
      expect(next.children).toEqual([a, b])
    }
  })

  it('inserts as a sibling when the parent already splits in that direction', () => {
    const a = canvasLeafFor('terminal', 'a')
    const b = canvasLeafFor('terminal', 'b')
    const c = canvasLeafFor('terminal', 'c')
    const root = row([a, b], [3, 1])
    const next = splitCanvasLeaf(root, a.id, c, 'row') as PanelCanvasSplit
    expect(
      next.children.map((child) =>
        isPanelCanvasLeaf(child) && child.kind !== 'shell' ? child.panelId : '?'
      )
    ).toEqual(['a', 'c', 'b'])
    // Why: stale sizes would misalign weights with the grown children array.
    expect(next.sizes).toBeUndefined()
  })

  it('leaves the tree untouched (same references) when the target is absent', () => {
    const root = row([canvasLeafFor('terminal', 'a'), canvasLeafFor('terminal', 'b')])
    expect(splitCanvasLeaf(root, 'missing', canvasLeafFor('web', 'w'), 'row')).toBe(root)
  })
})

describe('appendCanvasLeaf', () => {
  it('extends a same-direction root instead of nesting', () => {
    const root = row([canvasLeafFor('terminal', 'a'), canvasLeafFor('terminal', 'b')], [1, 2])
    const next = appendCanvasLeaf(root, canvasLeafFor('web', 'c'), 'row') as PanelCanvasSplit
    expect(next.children).toHaveLength(3)
    expect(next.sizes).toBeUndefined()
  })

  it('wraps in a new split when directions differ', () => {
    const root = row([canvasLeafFor('terminal', 'a'), canvasLeafFor('terminal', 'b')])
    const next = appendCanvasLeaf(root, canvasLeafFor('web', 'c'), 'column') as PanelCanvasSplit
    expect(next.direction).toBe('column')
    expect(next.children[0]).toBe(root)
  })
})

describe('removeCanvasLeaf', () => {
  it('returns null when the last leaf is removed', () => {
    const a = canvasLeafFor('terminal', 'a')
    expect(removeCanvasLeaf(a, a.id)).toBeNull()
  })

  it('collapses a split left with one child into that child', () => {
    const a = canvasLeafFor('terminal', 'a')
    const b = canvasLeafFor('web', 'b')
    const next = removeCanvasLeaf(row([a, b]), a.id)
    expect(next).toBe(b)
  })

  it('drops sizes when the child count changes', () => {
    const a = canvasLeafFor('terminal', 'a')
    const b = canvasLeafFor('terminal', 'b')
    const c = canvasLeafFor('terminal', 'c')
    const next = removeCanvasLeaf(row([a, b, c], [1, 2, 3]), b.id) as PanelCanvasSplit
    expect(next.children).toEqual([a, c])
    expect(next.sizes).toBeUndefined()
  })
})

describe('setCanvasSplitSizes', () => {
  it('writes sizes on the targeted split only', () => {
    const inner = row([canvasLeafFor('terminal', 'a'), canvasLeafFor('terminal', 'b')])
    const outer: PanelCanvasSplit = {
      id: crypto.randomUUID(),
      direction: 'column',
      children: [inner, canvasLeafFor('web', 'c')]
    }
    const next = setCanvasSplitSizes(outer, inner.id, [2, 5]) as PanelCanvasSplit
    const nextInner = next.children[0] as PanelCanvasSplit
    expect(nextInner.sizes).toEqual([2, 5])
    expect(next.sizes).toBeUndefined()
  })
})

describe('shell leaves in the canvas tree', () => {
  it('round trips a shell leaf through layout and back', () => {
    const layout = {
      direction: 'column' as const,
      children: [
        { kind: 'shell' as const, host: 'node-a', label: 'node-a' },
        { kind: 'terminal' as const, panelId: 'p1' }
      ]
    }
    const canvas = canvasNodeFromLayout(layout)
    expect(countCanvasLeaves(canvas)).toBe(2)
    expect(layoutNodeFromCanvas(canvas)).toEqual(layout)
  })

  it('duplicates a shell leaf with a fresh id and the same host', () => {
    const shell = canvasShellLeafFor('node-b', 'node-b')
    const copy = duplicateCanvasLeaf(shell)
    expect(copy).toEqual({ id: expect.any(String), kind: 'shell', host: 'node-b', label: 'node-b' })
    expect(copy.id).not.toBe(shell.id)
  })

  it('duplicates a panel leaf with a fresh id and the same panel', () => {
    const panel = canvasLeafFor('web', 'p1')
    const copy = duplicateCanvasLeaf(panel)
    expect(copy).toEqual({ id: expect.any(String), kind: 'web', panelId: 'p1' })
    expect(copy.id).not.toBe(panel.id)
  })
})
