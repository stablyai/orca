import { describe, expect, it } from 'vitest'
import {
  MAX_PROJECT_GROUP_DEPTH,
  describeProjectGroupReparentRejection,
  getProjectGroupCreateChildRejection,
  getProjectGroupDepth,
  getProjectGroupReparentRejection,
  getProjectGroupSubtreeHeight
} from './project-group-reparent'

const node = (id: string, parentGroupId: string | null = null) => ({ id, parentGroupId })

// root → a → b → c, plus sibling root `other`
const tree = [node('root'), node('a', 'root'), node('b', 'a'), node('c', 'b'), node('other')]

function chain(length: number) {
  return Array.from({ length }, (_, index) =>
    node(`g${index}`, index === 0 ? null : `g${index - 1}`)
  )
}

describe('project-group-reparent', () => {
  it('measures depth from the root and height down to the deepest child', () => {
    expect(getProjectGroupDepth(tree, 'root')).toBe(0)
    expect(getProjectGroupDepth(tree, 'c')).toBe(3)
    expect(getProjectGroupSubtreeHeight(tree, 'root')).toBe(3)
    expect(getProjectGroupSubtreeHeight(tree, 'c')).toBe(0)
  })

  it('treats dangling parents as roots and survives persisted cycles', () => {
    expect(getProjectGroupDepth([node('orphan', 'missing')], 'orphan')).toBe(0)
    const cyclic = [node('x', 'y'), node('y', 'x')]
    expect(getProjectGroupDepth(cyclic, 'x')).toBeLessThanOrEqual(2)
    expect(getProjectGroupSubtreeHeight(cyclic, 'x')).toBe(1)
    expect(getProjectGroupReparentRejection(cyclic, 'x', 'y')).toBe('descendant')
  })

  it('rejects moving a group into itself or any descendant', () => {
    expect(getProjectGroupReparentRejection(tree, 'a', 'a')).toBe('self')
    expect(getProjectGroupReparentRejection(tree, 'a', 'b')).toBe('descendant')
    expect(getProjectGroupReparentRejection(tree, 'a', 'c')).toBe('descendant')
  })

  it('accepts top level, ancestors, and unrelated groups', () => {
    expect(getProjectGroupReparentRejection(tree, 'c', null)).toBeNull()
    expect(getProjectGroupReparentRejection(tree, 'c', 'root')).toBeNull()
    expect(getProjectGroupReparentRejection(tree, 'a', 'other')).toBeNull()
    expect(getProjectGroupReparentRejection(tree, 'other', 'c')).toBeNull()
  })

  it('rejects unknown groups and parents', () => {
    expect(getProjectGroupReparentRejection(tree, 'nope', null)).toBe('group-not-found')
    expect(getProjectGroupReparentRejection(tree, 'a', 'nope')).toBe('parent-not-found')
  })

  it('caps the deepest group of the moved subtree at MAX_PROJECT_GROUP_DEPTH', () => {
    const deep = chain(MAX_PROJECT_GROUP_DEPTH + 1) // g0..g6 → g6 already sits at the cap
    const leafId = `g${MAX_PROJECT_GROUP_DEPTH}`
    const groups = [...deep, node('lone'), node('pair'), node('pair-child', 'pair')]

    expect(getProjectGroupReparentRejection(groups, 'lone', leafId)).toBe('too-deep')
    expect(
      getProjectGroupReparentRejection(groups, 'lone', `g${MAX_PROJECT_GROUP_DEPTH - 1}`)
    ).toBe(null)
    // pair has height 1, so its parent must sit at most two levels above the cap
    expect(
      getProjectGroupReparentRejection(groups, 'pair', `g${MAX_PROJECT_GROUP_DEPTH - 1}`)
    ).toBe('too-deep')
    expect(
      getProjectGroupReparentRejection(groups, 'pair', `g${MAX_PROJECT_GROUP_DEPTH - 2}`)
    ).toBeNull()
    expect(
      getProjectGroupReparentRejection(groups, 'lone', leafId, MAX_PROJECT_GROUP_DEPTH + 1)
    ).toBe(null)
  })

  it('guards subgroup creation by parent existence and depth', () => {
    const deep = chain(MAX_PROJECT_GROUP_DEPTH + 1)
    expect(getProjectGroupCreateChildRejection(deep, 'missing')).toBe('parent-not-found')
    expect(getProjectGroupCreateChildRejection(deep, `g${MAX_PROJECT_GROUP_DEPTH}`)).toBe(
      'too-deep'
    )
    expect(getProjectGroupCreateChildRejection(deep, `g${MAX_PROJECT_GROUP_DEPTH - 1}`)).toBeNull()
  })

  it('describes every rejection with a user-readable reason', () => {
    expect(describeProjectGroupReparentRejection('self')).toMatch(/into itself/)
    expect(describeProjectGroupReparentRejection('descendant')).toMatch(/subgroups/)
    expect(describeProjectGroupReparentRejection('too-deep')).toContain(
      String(MAX_PROJECT_GROUP_DEPTH)
    )
    expect(describeProjectGroupReparentRejection('parent-not-found')).toMatch(/not found/)
    expect(describeProjectGroupReparentRejection('group-not-found')).toMatch(/not found/)
  })
})
