import { describe, expect, it } from 'vitest'
import {
  MAX_PROJECT_GROUP_LEVELS,
  canCreateProjectSubgroup,
  describeProjectGroupMoveRejection,
  getProjectGroupLevel,
  getProjectGroupMoveRejection,
  getProjectGroupSubtreeLevels,
  type ProjectGroupNestingNode
} from './project-group-nesting'

function group(
  id: string,
  parentGroupId: string | null = null,
  connectionId?: string | null
): ProjectGroupNestingNode {
  return { id, parentGroupId, connectionId }
}

// Builds prefix1 > prefix2 > … > prefix<levels>, each the parent of the next.
function chain(prefix: string, levels: number, connectionId?: string): ProjectGroupNestingNode[] {
  return Array.from({ length: levels }, (_, index) =>
    group(`${prefix}${index + 1}`, index === 0 ? null : `${prefix}${index}`, connectionId)
  )
}

describe('project group levels', () => {
  it('counts a top-level group as level 1 and a missing parent as top level', () => {
    const groups = [...chain('l', 3), group('orphan', 'missing')]

    expect(getProjectGroupLevel(groups, 'l1')).toBe(1)
    expect(getProjectGroupLevel(groups, 'l3')).toBe(3)
    expect(getProjectGroupLevel(groups, 'orphan')).toBe(1)
    expect(getProjectGroupLevel(groups, 'unknown')).toBe(0)
  })

  it('measures subtree levels with a leaf counting as 1', () => {
    const groups = [...chain('l', 3), group('sibling', 'l1')]

    expect(getProjectGroupSubtreeLevels(groups, 'l1')).toBe(3)
    expect(getProjectGroupSubtreeLevels(groups, 'l2')).toBe(2)
    expect(getProjectGroupSubtreeLevels(groups, 'sibling')).toBe(1)
    expect(getProjectGroupSubtreeLevels(groups, 'unknown')).toBe(0)
  })

  it('stays finite on a parent cycle', () => {
    const groups = [group('a', 'b'), group('b', 'a')]

    expect(getProjectGroupLevel(groups, 'a')).toBe(2)
    expect(getProjectGroupSubtreeLevels(groups, 'a')).toBe(2)
  })

  it('allows a subgroup under level 2 but not under level 3', () => {
    const groups = chain('l', MAX_PROJECT_GROUP_LEVELS)

    expect(canCreateProjectSubgroup(groups, 'l2')).toBe(true)
    expect(canCreateProjectSubgroup(groups, 'l3')).toBe(false)
    expect(canCreateProjectSubgroup(groups, 'unknown')).toBe(false)
  })
})

describe('getProjectGroupMoveRejection', () => {
  const groups = [
    ...chain('l', 3),
    group('leaf'),
    group('pair'),
    group('pair-child', 'pair'),
    group('remote', null, 'conn-1')
  ]

  it('rejects unknown groups, itself, and its own subgroups', () => {
    expect(getProjectGroupMoveRejection(groups, 'unknown', 'l1')).toBe('group-not-found')
    expect(getProjectGroupMoveRejection(groups, 'leaf', 'unknown')).toBe('parent-not-found')
    expect(getProjectGroupMoveRejection(groups, 'l2', 'l2')).toBe('self')
    expect(getProjectGroupMoveRejection(groups, 'l1', 'l3')).toBe('descendant')
  })

  it('rejects a parent on another host', () => {
    expect(getProjectGroupMoveRejection(groups, 'leaf', 'remote')).toBe('host-mismatch')
    expect(getProjectGroupMoveRejection(groups, 'remote', 'l1')).toBe('host-mismatch')
    expect(
      getProjectGroupMoveRejection([...groups, group('ssh', null, 'conn-1')], 'ssh', 'remote')
    ).toBe(null)
  })

  it('counts the moved subtree against the level cap', () => {
    expect(getProjectGroupMoveRejection(groups, 'leaf', 'l2')).toBe(null)
    expect(getProjectGroupMoveRejection(groups, 'leaf', 'l3')).toBe('too-deep')
    expect(getProjectGroupMoveRejection(groups, 'pair', 'l1')).toBe(null)
    expect(getProjectGroupMoveRejection(groups, 'pair', 'l2')).toBe('too-deep')
  })

  it('always allows the top level', () => {
    expect(getProjectGroupMoveRejection(groups, 'l3', null)).toBe(null)
    expect(getProjectGroupMoveRejection(groups, 'remote', null)).toBe(null)
  })

  it('lets an imported tree deeper than the cap move without getting deeper', () => {
    const deep = [...chain('l', 3), ...chain('d', 5)]

    expect(getProjectGroupMoveRejection(deep, 'd5', 'l3')).toBe(null)
    expect(getProjectGroupMoveRejection(deep, 'd4', 'l3')).toBe(null)
    expect(getProjectGroupMoveRejection(deep, 'd3', 'l3')).toBe('too-deep')
    expect(getProjectGroupMoveRejection(deep, 'd3', 'd1')).toBe(null)
  })

  it('names the cap in the too-deep message', () => {
    expect(describeProjectGroupMoveRejection('too-deep')).toContain(
      `${MAX_PROJECT_GROUP_LEVELS} levels`
    )
  })
})
