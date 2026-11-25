import { describe, expect, it } from 'vitest'
import { canCreateProjectGroupUnder, canMoveProjectGroup } from './project-group-nesting'

// a > b > c (three levels), plus top-level x and y > z.
const groups = [
  { id: 'a', parentGroupId: null },
  { id: 'b', parentGroupId: 'a' },
  { id: 'c', parentGroupId: 'b' },
  { id: 'x', parentGroupId: null },
  { id: 'y', parentGroupId: null },
  { id: 'z', parentGroupId: 'y' }
]

describe('canMoveProjectGroup', () => {
  it('never lets a group move into itself or its own subgroups', () => {
    expect(canMoveProjectGroup(groups, 'a', 'a')).toBe(false)
    expect(canMoveProjectGroup(groups, 'a', 'b')).toBe(false)
    expect(canMoveProjectGroup(groups, 'a', 'c')).toBe(false)
  })

  it('caps the resulting tree at three levels, counting the moved subtree', () => {
    expect(canMoveProjectGroup(groups, 'x', 'b')).toBe(true)
    expect(canMoveProjectGroup(groups, 'x', 'c')).toBe(false)
    expect(canMoveProjectGroup(groups, 'y', 'a')).toBe(true)
    expect(canMoveProjectGroup(groups, 'y', 'b')).toBe(false)
  })

  it('always allows the top level and rejects unknown groups', () => {
    expect(canMoveProjectGroup(groups, 'c', null)).toBe(true)
    expect(canMoveProjectGroup(groups, 'x', 'missing')).toBe(false)
    expect(canMoveProjectGroup(groups, 'missing', 'x')).toBe(false)
  })
})

describe('canCreateProjectGroupUnder', () => {
  it('allows a subgroup only while the parent is above the last level', () => {
    expect(canCreateProjectGroupUnder(groups, 'b')).toBe(true)
    expect(canCreateProjectGroupUnder(groups, 'c')).toBe(false)
    expect(canCreateProjectGroupUnder(groups, 'missing')).toBe(false)
  })
})
