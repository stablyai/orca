import { describe, expect, it } from 'vitest'
import {
  computePeersLayoutRects,
  findSplitBoxAtPath,
  ratioFromPointerInSplitBox
} from './peers-split-rects'
import type { PeersLayoutNode } from './peers-split-tree'

function leafNode(hostId: string, handle: string): PeersLayoutNode {
  return { type: 'leaf', target: { hostId, handle, title: handle } }
}

describe('computePeersLayoutRects', () => {
  it('splits a two-pane row layout evenly', () => {
    const node: PeersLayoutNode = {
      type: 'split',
      direction: 'row',
      first: leafNode('h1', 'a'),
      second: leafNode('h2', 'b')
    }
    const { panes, dividers } = computePeersLayoutRects(node, { width: 200, height: 100 })
    expect(panes).toEqual([
      {
        key: 'h1:a',
        target: { hostId: 'h1', handle: 'a', title: 'a' },
        rect: { x: 0, y: 0, width: 97, height: 100 }
      },
      {
        key: 'h2:b',
        target: { hostId: 'h2', handle: 'b', title: 'b' },
        rect: { x: 103, y: 0, width: 97, height: 100 }
      }
    ])
    expect(dividers).toEqual([
      { path: [], direction: 'row', rect: { x: 97, y: 0, width: 6, height: 100 } }
    ])
  })

  it('splits a column layout by ratio', () => {
    const node: PeersLayoutNode = {
      type: 'split',
      direction: 'column',
      ratio: 0.25,
      first: leafNode('h1', 'a'),
      second: leafNode('h2', 'b')
    }
    const { panes, dividers } = computePeersLayoutRects(node, { width: 100, height: 200 })
    expect(panes[0].rect).toEqual({ x: 0, y: 0, width: 100, height: 48.5 })
    expect(panes[1].rect).toEqual({ x: 0, y: 54.5, width: 100, height: 145.5 })
    expect(dividers[0].rect).toEqual({ x: 0, y: 48.5, width: 100, height: 6 })
  })

  it('computes nested three-pane split rects and divider paths', () => {
    const node: PeersLayoutNode = {
      type: 'split',
      direction: 'row',
      first: leafNode('h1', 'a'),
      second: {
        type: 'split',
        direction: 'column',
        first: leafNode('h2', 'b'),
        second: leafNode('h3', 'c')
      }
    }
    const { panes, dividers } = computePeersLayoutRects(node, { width: 200, height: 200 })
    expect(panes.map((pane) => pane.key)).toEqual(['h1:a', 'h2:b', 'h3:c'])
    expect(panes[0].rect).toEqual({ x: 0, y: 0, width: 97, height: 200 })
    expect(dividers).toEqual([
      { path: [], direction: 'row', rect: { x: 97, y: 0, width: 6, height: 200 } },
      { path: ['second'], direction: 'column', rect: { x: 103, y: 97, width: 97, height: 6 } }
    ])
    expect(panes[1].rect).toEqual({ x: 103, y: 0, width: 97, height: 97 })
    expect(panes[2].rect).toEqual({ x: 103, y: 103, width: 97, height: 97 })
  })
})

describe('findSplitBoxAtPath', () => {
  const node: PeersLayoutNode = {
    type: 'split',
    direction: 'row',
    first: leafNode('h1', 'a'),
    second: {
      type: 'split',
      direction: 'column',
      first: leafNode('h2', 'b'),
      second: leafNode('h3', 'c')
    }
  }

  it('returns the whole box for an empty path', () => {
    expect(findSplitBoxAtPath(node, { width: 200, height: 200 }, [])).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 200
    })
  })

  it('returns the nested split box before its own ratio subdivides it', () => {
    expect(findSplitBoxAtPath(node, { width: 200, height: 200 }, ['second'])).toEqual({
      x: 103,
      y: 0,
      width: 97,
      height: 200
    })
  })

  it('returns null when the path runs into a leaf', () => {
    expect(findSplitBoxAtPath(node, { width: 200, height: 200 }, ['first', 'first'])).toBeNull()
  })
})

describe('ratioFromPointerInSplitBox', () => {
  it('computes the ratio along the row axis', () => {
    const box = { x: 0, y: 0, width: 200, height: 100 }
    expect(ratioFromPointerInSplitBox(box, 'row', { x: 50, y: 0 })).toBeCloseTo(0.25)
  })

  it('computes the ratio along the column axis', () => {
    const box = { x: 0, y: 0, width: 100, height: 200 }
    expect(ratioFromPointerInSplitBox(box, 'column', { x: 0, y: 150 })).toBeCloseTo(0.75)
  })

  it('clamps a pointer outside the split box to the 0-1 range', () => {
    const box = { x: 0, y: 0, width: 200, height: 100 }
    expect(ratioFromPointerInSplitBox(box, 'row', { x: -50, y: 0 })).toBe(0)
    expect(ratioFromPointerInSplitBox(box, 'row', { x: 500, y: 0 })).toBe(1)
  })

  it('returns the midpoint instead of NaN/Infinity for a zero-size box', () => {
    const box = { x: 0, y: 0, width: 0, height: 0 }
    expect(ratioFromPointerInSplitBox(box, 'row', { x: 10, y: 0 })).toBe(0.5)
    expect(ratioFromPointerInSplitBox(box, 'column', { x: 0, y: 10 })).toBe(0.5)
  })
})
