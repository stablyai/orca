import { describe, expect, it } from 'vitest'
import type { WorktreeLayoutNode } from '../../../shared/types'
import {
  clampWorktreeSplitRatio,
  collectLeafWorktreeIds,
  findLeafPath,
  getNodeAtPath,
  hasLeaf,
  leafCount,
  makeWorktreeLeaf,
  pickSplitDirection,
  pruneLeaves,
  removeLeaf,
  replaceLeaf,
  setRatioAtPath,
  splitLeafAtPath,
  splitLeafByWorktreeId
} from './worktree-layout-tree'

const leaf = (id: string): WorktreeLayoutNode => ({ type: 'leaf', worktreeId: id })

// A|B split, with the second child itself split into B|C:  (A , (B , C))
const nested: WorktreeLayoutNode = {
  type: 'split',
  direction: 'horizontal',
  first: leaf('A'),
  second: { type: 'split', direction: 'vertical', first: leaf('B'), second: leaf('C') }
}

describe('clampWorktreeSplitRatio', () => {
  it('clamps to [0.15, 0.85] and defaults NaN to 0.5', () => {
    expect(clampWorktreeSplitRatio(0.5)).toBe(0.5)
    expect(clampWorktreeSplitRatio(0.01)).toBe(0.15)
    expect(clampWorktreeSplitRatio(0.99)).toBe(0.85)
    expect(clampWorktreeSplitRatio(Number.NaN)).toBe(0.5)
  })
})

describe('traversal', () => {
  it('collects leaves in order', () => {
    expect(collectLeafWorktreeIds(nested)).toEqual(['A', 'B', 'C'])
    expect(collectLeafWorktreeIds(leaf('A'))).toEqual(['A'])
  })

  it('counts leaves', () => {
    expect(leafCount(nested)).toBe(3)
    expect(leafCount(leaf('A'))).toBe(1)
  })

  it('detects leaf membership', () => {
    expect(hasLeaf(nested, 'B')).toBe(true)
    expect(hasLeaf(nested, 'Z')).toBe(false)
  })

  it('finds leaf paths', () => {
    expect(findLeafPath(nested, 'A')).toEqual(['first'])
    expect(findLeafPath(nested, 'B')).toEqual(['second', 'first'])
    expect(findLeafPath(nested, 'C')).toEqual(['second', 'second'])
    expect(findLeafPath(nested, 'Z')).toBeNull()
    expect(findLeafPath(leaf('A'), 'A')).toEqual([])
  })

  it('resolves nodes at a path', () => {
    expect(getNodeAtPath(nested, ['first'])).toEqual(leaf('A'))
    expect(getNodeAtPath(nested, ['second', 'first'])).toEqual(leaf('B'))
    // Walking past a leaf is invalid.
    expect(getNodeAtPath(nested, ['first', 'second'])).toBeNull()
  })
})

describe('splitLeafAtPath / splitLeafByWorktreeId', () => {
  it('splits a single leaf into two, new sibling after by default', () => {
    const result = splitLeafAtPath(leaf('A'), [], 'horizontal', 'B')
    expect(result).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: leaf('A'),
      second: leaf('B'),
      ratio: 0.5
    })
  })

  it('honors placement=before', () => {
    const result = splitLeafAtPath(leaf('A'), [], 'vertical', 'B', 'before')
    expect(result.type === 'split' && result.first).toEqual(leaf('B'))
    expect(result.type === 'split' && result.second).toEqual(leaf('A'))
  })

  it('is a no-op when the new worktree is already present', () => {
    const result = splitLeafByWorktreeId(nested, 'A', 'horizontal', 'B')
    expect(result).toBe(nested)
  })

  it('is a no-op when the path is not a leaf', () => {
    // path [] on a split node is not a leaf.
    const result = splitLeafAtPath(nested, [], 'horizontal', 'Z')
    expect(result).toBe(nested)
  })

  it('splits a nested leaf by worktree id, leaving siblings intact', () => {
    const result = splitLeafByWorktreeId(nested, 'A', 'vertical', 'D')
    expect(collectLeafWorktreeIds(result)).toEqual(['A', 'D', 'B', 'C'])
    // The B|C subtree is untouched (same reference preserved elsewhere in real use).
    expect(hasLeaf(result, 'B')).toBe(true)
    expect(hasLeaf(result, 'C')).toBe(true)
  })

  it('is a no-op when the target worktree is absent', () => {
    expect(splitLeafByWorktreeId(nested, 'Z', 'horizontal', 'D')).toBe(nested)
  })
})

describe('removeLeaf', () => {
  it('removes a leaf and collapses the parent split into the sibling', () => {
    const result = removeLeaf(nested, 'A')
    expect(result).toEqual({
      type: 'split',
      direction: 'vertical',
      first: leaf('B'),
      second: leaf('C')
    })
  })

  it('collapses a deep sibling correctly', () => {
    const result = removeLeaf(nested, 'B')
    // (A , (B , C)) with B gone => (A , C)
    expect(result).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: leaf('A'),
      second: leaf('C')
    })
  })

  it('returns null when removing the only leaf', () => {
    expect(removeLeaf(leaf('A'), 'A')).toBeNull()
  })

  it('is a no-op (same reference) when the worktree is absent', () => {
    expect(removeLeaf(nested, 'Z')).toBe(nested)
  })
})

describe('replaceLeaf', () => {
  it('retargets a pane to a new worktree', () => {
    const result = replaceLeaf(nested, 'A', 'X')
    expect(collectLeafWorktreeIds(result)).toEqual(['X', 'B', 'C'])
  })

  it('is a no-op when the new worktree is already visible', () => {
    expect(replaceLeaf(nested, 'A', 'B')).toBe(nested)
  })

  it('is a no-op when old === new or old is absent', () => {
    expect(replaceLeaf(nested, 'A', 'A')).toBe(nested)
    expect(replaceLeaf(nested, 'Z', 'X')).toBe(nested)
  })
})

describe('setRatioAtPath', () => {
  it('sets and clamps the ratio at a split path', () => {
    const result = setRatioAtPath(nested, [], 0.99)
    expect(result.type === 'split' && result.ratio).toBe(0.85)
    const nestedRatio = setRatioAtPath(nested, ['second'], 0.3)
    const secondChild = getNodeAtPath(nestedRatio, ['second'])
    expect(secondChild?.type === 'split' && secondChild.ratio).toBe(0.3)
  })

  it('is a no-op when the path is not a split', () => {
    expect(setRatioAtPath(nested, ['first'], 0.4)).toBe(nested)
    expect(setRatioAtPath(leaf('A'), [], 0.4)).toEqual(leaf('A'))
  })
})

describe('pruneLeaves', () => {
  it('drops invalid leaves and collapses splits', () => {
    const result = pruneLeaves(nested, new Set(['A', 'C']))
    expect(result).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: leaf('A'),
      second: leaf('C')
    })
  })

  it('returns null when nothing survives', () => {
    expect(pruneLeaves(nested, new Set(['Z']))).toBeNull()
  })

  it('keeps the tree unchanged (same reference) when all leaves are valid', () => {
    expect(pruneLeaves(nested, new Set(['A', 'B', 'C']))).toBe(nested)
  })
})

describe('makeWorktreeLeaf', () => {
  it('builds a leaf node', () => {
    expect(makeWorktreeLeaf('A')).toEqual({ type: 'leaf', worktreeId: 'A' })
  })
})

describe('pickSplitDirection', () => {
  it('splits a wide pane left/right (horizontal → new pane to the right)', () => {
    expect(pickSplitDirection({ width: 1600, height: 900 })).toBe('horizontal')
  })

  it('splits a tall pane top/bottom (vertical → new pane below)', () => {
    expect(pickSplitDirection({ width: 800, height: 1200 })).toBe('vertical')
  })

  it('treats a square pane as wide (>=) → horizontal', () => {
    expect(pickSplitDirection({ width: 1000, height: 1000 })).toBe('horizontal')
  })
})
