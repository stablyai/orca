import { describe, expect, it } from 'vitest'
import {
  collectLeaves,
  insertSplit,
  leafKey,
  type PeersLayoutNode,
  type PeersPaneLeaf,
  pruneLeaves,
  removeLeaf,
  setRatioAtPath
} from './peers-split-tree'

function leaf(hostId: string, handle: string): PeersPaneLeaf {
  return { hostId, handle, title: `${hostId}/${handle}` }
}

function leafNode(hostId: string, handle: string): PeersLayoutNode {
  return { type: 'leaf', target: leaf(hostId, handle) }
}

describe('insertSplit', () => {
  it('places the new leaf first for left', () => {
    const tree = insertSplit(leafNode('h1', 'a'), 'h1:a', 'left', leaf('h2', 'b'))
    expect(tree).toEqual({
      type: 'split',
      direction: 'row',
      first: leafNode('h2', 'b'),
      second: leafNode('h1', 'a')
    })
  })

  it('places the new leaf second for right', () => {
    const tree = insertSplit(leafNode('h1', 'a'), 'h1:a', 'right', leaf('h2', 'b'))
    expect(tree).toEqual({
      type: 'split',
      direction: 'row',
      first: leafNode('h1', 'a'),
      second: leafNode('h2', 'b')
    })
  })

  it('places the new leaf first for top and uses column direction', () => {
    const tree = insertSplit(leafNode('h1', 'a'), 'h1:a', 'top', leaf('h2', 'b'))
    expect(tree).toEqual({
      type: 'split',
      direction: 'column',
      first: leafNode('h2', 'b'),
      second: leafNode('h1', 'a')
    })
  })

  it('places the new leaf second for bottom', () => {
    const tree = insertSplit(leafNode('h1', 'a'), 'h1:a', 'bottom', leaf('h2', 'b'))
    expect(tree).toEqual({
      type: 'split',
      direction: 'column',
      first: leafNode('h1', 'a'),
      second: leafNode('h2', 'b')
    })
  })

  it('moves an existing leaf instead of duplicating it', () => {
    const base: PeersLayoutNode = {
      type: 'split',
      direction: 'row',
      first: leafNode('h1', 'a'),
      second: leafNode('h2', 'b')
    }
    const moved = insertSplit(base, 'h1:a', 'right', leaf('h2', 'b'))
    expect(collectLeaves(moved).map(leafKey).sort()).toEqual(['h1:a', 'h2:b'])
    expect(moved).toEqual({
      type: 'split',
      direction: 'row',
      first: leafNode('h1', 'a'),
      second: leafNode('h2', 'b')
    })
  })

  it('is a no-op when splitting a leaf with itself', () => {
    const tree = leafNode('h1', 'a')
    expect(insertSplit(tree, 'h1:a', 'left', leaf('h1', 'a'))).toBe(tree)
  })
})

describe('removeLeaf', () => {
  it('promotes the sibling when removing one of two leaves', () => {
    const base: PeersLayoutNode = {
      type: 'split',
      direction: 'row',
      first: leafNode('h1', 'a'),
      second: leafNode('h2', 'b')
    }
    expect(removeLeaf(base, 'h1:a')).toEqual(leafNode('h2', 'b'))
  })

  it('returns null when removing the only leaf', () => {
    expect(removeLeaf(leafNode('h1', 'a'), 'h1:a')).toBeNull()
  })

  it('collapses a nested split correctly', () => {
    const base: PeersLayoutNode = {
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
    const result = removeLeaf(base, 'h2:b')
    expect(result).toEqual({
      type: 'split',
      direction: 'row',
      first: leafNode('h1', 'a'),
      second: leafNode('h3', 'c')
    })
  })
})

describe('setRatioAtPath', () => {
  const base: PeersLayoutNode = {
    type: 'split',
    direction: 'row',
    first: leafNode('h1', 'a'),
    second: leafNode('h2', 'b')
  }

  it('sets ratio at the root', () => {
    const result = setRatioAtPath(base, [], 0.4)
    expect(result).toMatchObject({ ratio: 0.4 })
  })

  it('clamps below the minimum', () => {
    const result = setRatioAtPath(base, [], 0.01)
    expect(result).toMatchObject({ ratio: 0.15 })
  })

  it('clamps above the maximum', () => {
    const result = setRatioAtPath(base, [], 0.99)
    expect(result).toMatchObject({ ratio: 0.85 })
  })

  it('sets ratio on a nested split', () => {
    const nested: PeersLayoutNode = {
      type: 'split',
      direction: 'row',
      first: leafNode('h1', 'a'),
      second: base
    }
    const result = setRatioAtPath(nested, ['second'], 0.3)
    expect(result).toMatchObject({ second: { ratio: 0.3 } })
  })
})

describe('pruneLeaves', () => {
  it('removes dead leaves and promotes survivors', () => {
    const base: PeersLayoutNode = {
      type: 'split',
      direction: 'row',
      first: leafNode('h1', 'a'),
      second: leafNode('h2', 'b')
    }
    const result = pruneLeaves(base, (target) => target.hostId === 'h1')
    expect(result).toEqual(leafNode('h1', 'a'))
  })

  it('returns null when every leaf dies', () => {
    const base: PeersLayoutNode = {
      type: 'split',
      direction: 'row',
      first: leafNode('h1', 'a'),
      second: leafNode('h2', 'b')
    }
    expect(pruneLeaves(base, () => false)).toBeNull()
  })

  it('leaves an all-alive tree unchanged', () => {
    const base = leafNode('h1', 'a')
    expect(pruneLeaves(base, () => true)).toEqual(base)
  })
})
