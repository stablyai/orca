import { describe, expect, it } from 'vitest'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import { resolveAdjacentTabGroupId } from './tab-group-focus-cycle'

// a | (b over c)
const layout: TabGroupLayoutNode = {
  type: 'split',
  direction: 'horizontal',
  first: { type: 'leaf', groupId: 'a' },
  second: {
    type: 'split',
    direction: 'vertical',
    first: { type: 'leaf', groupId: 'b' },
    second: { type: 'leaf', groupId: 'c' }
  }
}
const groups = [{ id: 'c' }, { id: 'a' }, { id: 'b' }]

describe('resolveAdjacentTabGroupId', () => {
  it('follows on-screen order through nested splits and wraps at both ends', () => {
    expect(resolveAdjacentTabGroupId(layout, groups, 'a', 1)).toBe('b')
    expect(resolveAdjacentTabGroupId(layout, groups, 'b', 1)).toBe('c')
    expect(resolveAdjacentTabGroupId(layout, groups, 'c', 1)).toBe('a')
    expect(resolveAdjacentTabGroupId(layout, groups, 'a', -1)).toBe('c')
  })

  it('skips layout leaves whose group no longer exists', () => {
    expect(resolveAdjacentTabGroupId(layout, [{ id: 'a' }, { id: 'c' }], 'a', 1)).toBe('c')
    expect(resolveAdjacentTabGroupId(layout, [{ id: 'a' }], 'a', 1)).toBeNull()
  })
})
