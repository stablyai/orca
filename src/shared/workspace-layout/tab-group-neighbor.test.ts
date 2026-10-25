import { describe, expect, it } from 'vitest'
import type { TabGroupLayoutNode } from '../tab-types'
import { findTabGroupNeighbor } from './tab-group-neighbor'

const leaf = (groupId: string): TabGroupLayoutNode => ({ type: 'leaf', groupId })
const row = (
  first: TabGroupLayoutNode,
  second: TabGroupLayoutNode,
  ratio?: number
): TabGroupLayoutNode => ({ type: 'split', direction: 'horizontal', first, second, ratio })
const column = (
  first: TabGroupLayoutNode,
  second: TabGroupLayoutNode,
  ratio?: number
): TabGroupLayoutNode => ({ type: 'split', direction: 'vertical', first, second, ratio })

describe('findTabGroupNeighbor', () => {
  it('returns null for a single group in every direction', () => {
    for (const direction of ['left', 'right', 'up', 'down'] as const) {
      expect(findTabGroupNeighbor(leaf('a'), 'a', direction)).toBeNull()
    }
  })

  it('moves between side-by-side groups and stops at the edges', () => {
    const layout = row(leaf('a'), leaf('b'))
    expect(findTabGroupNeighbor(layout, 'a', 'right')).toBe('b')
    expect(findTabGroupNeighbor(layout, 'b', 'left')).toBe('a')
    expect(findTabGroupNeighbor(layout, 'a', 'left')).toBeNull()
    expect(findTabGroupNeighbor(layout, 'b', 'right')).toBeNull()
    expect(findTabGroupNeighbor(layout, 'a', 'up')).toBeNull()
    expect(findTabGroupNeighbor(layout, 'a', 'down')).toBeNull()
  })

  it('moves between stacked groups', () => {
    const layout = column(leaf('top'), leaf('bottom'))
    expect(findTabGroupNeighbor(layout, 'top', 'down')).toBe('bottom')
    expect(findTabGroupNeighbor(layout, 'bottom', 'up')).toBe('top')
    expect(findTabGroupNeighbor(layout, 'top', 'up')).toBeNull()
    expect(findTabGroupNeighbor(layout, 'top', 'right')).toBeNull()
  })

  it('crosses split boundaries to the group that actually touches the edge', () => {
    // [ a | (b over c) ]
    const layout = row(leaf('a'), column(leaf('b'), leaf('c')))
    expect(findTabGroupNeighbor(layout, 'b', 'left')).toBe('a')
    expect(findTabGroupNeighbor(layout, 'c', 'left')).toBe('a')
    expect(findTabGroupNeighbor(layout, 'b', 'down')).toBe('c')
    expect(findTabGroupNeighbor(layout, 'c', 'up')).toBe('b')
    expect(findTabGroupNeighbor(layout, 'a', 'down')).toBeNull()
  })

  it('picks the touching group with the longest shared edge', () => {
    // [ a | (b 30% over c 70%) ]
    const layout = row(leaf('a'), column(leaf('b'), leaf('c'), 0.3))
    expect(findTabGroupNeighbor(layout, 'a', 'right')).toBe('c')
  })

  it('breaks equal overlaps by recency, then by visual order', () => {
    const layout = row(leaf('a'), column(leaf('b'), leaf('c')))
    expect(findTabGroupNeighbor(layout, 'a', 'right')).toBe('b')
    const recency = (groupId: string): number => (groupId === 'c' ? 2 : 1)
    expect(findTabGroupNeighbor(layout, 'a', 'right', recency)).toBe('c')
  })

  it('ignores groups that only touch at a corner', () => {
    // (a over b) | (c over d) with mismatched seams: a's right edge touches c and d.
    const layout = row(column(leaf('a'), leaf('b'), 0.5), column(leaf('c'), leaf('d'), 0.5))
    expect(findTabGroupNeighbor(layout, 'a', 'right')).toBe('c')
    expect(findTabGroupNeighbor(layout, 'b', 'right')).toBe('d')
  })

  it('returns null for a group that is not in the layout', () => {
    expect(findTabGroupNeighbor(row(leaf('a'), leaf('b')), 'missing', 'right')).toBeNull()
  })
})
