import { describe, expect, it } from 'vitest'
import {
  buildMergedProjectGroupIndex,
  buildProjectGroupHostIndex,
  findMergedProjectGroup,
  findMergedProjectGroupByRowId,
  findProjectGroupByHost,
  mergeProjectGroupsAcrossHosts,
  resolveMergedProjectGroupId
} from './cross-host-project-group-merge'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'

function group(overrides: Partial<ProjectGroup> & Pick<ProjectGroup, 'id' | 'name'>): ProjectGroup {
  return {
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('mergeProjectGroupsAcrossHosts', () => {
  it('folds same-named copies from two hosts into one row', () => {
    const local = group({
      id: 'local-adaptam',
      name: 'adaptam',
      parentPath: '/Users/a/Adaptam'
    })
    const remote = group({
      id: 'remote-adaptam',
      name: 'adaptam',
      parentPath: '/Users/b/Adaptam',
      executionHostId: 'runtime:m1'
    })

    const merged = mergeProjectGroupsAcrossHosts([remote, local])

    expect(merged).toHaveLength(1)
    expect(merged[0].primary).toBe(local)
    expect(merged[0].members).toEqual([remote, local])
  })

  it('keeps differently named groups apart', () => {
    const merged = mergeProjectGroupsAcrossHosts([
      group({ id: 'a', name: 'adaptam' }),
      group({ id: 'b', name: 'fjordbyte', executionHostId: 'runtime:m1' })
    ])

    expect(merged.map((entry) => entry.primary.id)).toEqual(['a', 'b'])
  })

  it('merges on the whole parent chain, not the leaf name alone', () => {
    const localParent = group({ id: 'local-root', name: 'doozyx' })
    const localChild = group({
      id: 'local-child',
      name: 'tools',
      parentGroupId: 'local-root'
    })
    const remoteParent = group({
      id: 'remote-root',
      name: 'doozyx',
      executionHostId: 'runtime:m1'
    })
    const remoteChild = group({
      id: 'remote-child',
      name: 'tools',
      parentGroupId: 'remote-root',
      executionHostId: 'runtime:m1'
    })
    const unrelatedTopLevel = group({ id: 'top-tools', name: 'tools' })

    const merged = mergeProjectGroupsAcrossHosts([
      localParent,
      localChild,
      remoteParent,
      remoteChild,
      unrelatedTopLevel
    ])

    expect(
      merged.map((entry) => [entry.primary.id, entry.members.map((member) => member.id)])
    ).toEqual([
      ['local-root', ['local-root', 'remote-root']],
      ['local-child', ['local-child', 'remote-child']],
      ['top-tools', ['top-tools']]
    ])
  })

  it('does not merge a remote child into a same-named group on another host branch', () => {
    const merged = mergeProjectGroupsAcrossHosts([
      group({ id: 'local-parent', name: 'work' }),
      group({
        id: 'local-child',
        name: 'tools',
        parentGroupId: 'local-parent'
      }),
      group({
        id: 'remote-child',
        name: 'tools',
        executionHostId: 'runtime:m1'
      })
    ])

    expect(merged.map((entry) => entry.primary.id)).toEqual([
      'local-parent',
      'local-child',
      'remote-child'
    ])
  })

  it('ignores case and surrounding whitespace when matching names', () => {
    const merged = mergeProjectGroupsAcrossHosts([
      group({ id: 'local', name: 'Adaptam' }),
      group({ id: 'remote', name: ' adaptam ', executionHostId: 'runtime:m1' })
    ])

    expect(merged).toHaveLength(1)
  })

  it('picks a stable primary when neither copy is local', () => {
    const older = group({
      id: 'b',
      name: 'adaptam',
      createdAt: 10,
      executionHostId: 'runtime:m1'
    })
    const newer = group({
      id: 'a',
      name: 'adaptam',
      createdAt: 20,
      executionHostId: 'runtime:m2'
    })

    expect(mergeProjectGroupsAcrossHosts([newer, older])[0].primary).toBe(older)
    expect(mergeProjectGroupsAcrossHosts([older, newer])[0].primary).toBe(older)
  })

  it('keeps two same-named groups on one host apart', () => {
    // Why: same-host siblings are two real groups the user can move projects
    // between; folding them would make one of them unreachable.
    const merged = mergeProjectGroupsAcrossHosts([
      group({ id: 'local-a', name: 'adaptam', createdAt: 1 }),
      group({ id: 'local-b', name: 'adaptam', createdAt: 2 }),
      group({ id: 'remote-a', name: 'adaptam', executionHostId: 'runtime:m1' })
    ])

    expect(merged.map((entry) => entry.primary.id)).toEqual(['local-a', 'local-b', 'remote-a'])
    expect(merged.every((entry) => entry.members.length === 1)).toBe(true)
  })

  it('does not merge name chains that only collide once flattened', () => {
    // Why: a folder-scan group name is a relative path and can contain a slash.
    const parent = group({ id: 'local-parent', name: 'packages' })
    const nested = group({
      id: 'local-nested',
      name: 'shared',
      parentGroupId: 'local-parent'
    })
    const flat = group({
      id: 'remote-flat',
      name: 'packages/shared',
      executionHostId: 'runtime:m1'
    })

    const merged = mergeProjectGroupsAcrossHosts([parent, nested, flat])

    expect(merged.map((entry) => entry.primary.id)).toEqual([
      'local-parent',
      'local-nested',
      'remote-flat'
    ])
  })

  it('terminates on a cyclic parent chain', () => {
    const merged = mergeProjectGroupsAcrossHosts([
      group({ id: 'a', name: 'loop-a', parentGroupId: 'b' }),
      group({ id: 'b', name: 'loop-b', parentGroupId: 'a' })
    ])

    expect(merged).toHaveLength(2)
  })
})

describe('buildMergedProjectGroupIndex', () => {
  it('resolves every host copy id to the merged row', () => {
    const index = buildMergedProjectGroupIndex([
      group({ id: 'local-adaptam', name: 'adaptam' }),
      group({
        id: 'remote-adaptam',
        name: 'adaptam',
        executionHostId: 'runtime:m1'
      })
    ])

    expect(resolveMergedProjectGroupId(index, 'remote-adaptam')).toBe('local-adaptam')
    expect(resolveMergedProjectGroupId(index, 'local-adaptam')).toBe('local-adaptam')
  })

  it('separates two hosts that reuse one group id for different groups', () => {
    const local = group({ id: 'shared-id', name: 'adaptam' })
    const remote = group({
      id: 'shared-id',
      name: 'fjordbyte',
      executionHostId: 'runtime:m1'
    })
    const index = buildMergedProjectGroupIndex([local, remote])

    expect(findMergedProjectGroup(index, 'shared-id', 'local')?.primary.name).toBe('adaptam')
    expect(findMergedProjectGroup(index, 'shared-id', 'runtime:m1')?.primary.name).toBe('fjordbyte')
    // Why: with no host to disambiguate, no answer is right — better none than a wrong row.
    expect(findMergedProjectGroup(index, 'shared-id')).toBeUndefined()
  })

  it('keeps an unknown group id addressable by falling back to itself', () => {
    const index = buildMergedProjectGroupIndex([group({ id: 'known', name: 'adaptam' })])

    expect(resolveMergedProjectGroupId(index, 'not-fetched-yet')).toBe('not-fetched-yet')
  })

  it('memoizes on the project-group array identity', () => {
    const groups = [group({ id: 'a', name: 'adaptam' })]

    expect(buildMergedProjectGroupIndex(groups)).toBe(buildMergedProjectGroupIndex(groups))
  })
})

describe('host-qualified lookups', () => {
  it('does not fall back to another host after a host-qualified miss', () => {
    const remote = group({
      id: 'adaptam',
      name: 'adaptam',
      executionHostId: 'runtime:m1'
    })
    const index = buildMergedProjectGroupIndex([remote])

    expect(findMergedProjectGroup(index, 'adaptam', 'local')).toBeUndefined()
    expect(resolveMergedProjectGroupId(index, 'adaptam', 'local')).toBe('adaptam')
    expect(findMergedProjectGroup(index, 'adaptam', 'runtime:m1')).toBe(index.merged[0])
  })

  it('gives two hosts that reuse one group id distinct row ids', () => {
    const local = group({ id: 'shared-id', name: 'adaptam' })
    const remote = group({
      id: 'shared-id',
      name: 'fjordbyte',
      executionHostId: 'runtime:m1'
    })
    const index = buildMergedProjectGroupIndex([local, remote])

    const localRowId = resolveMergedProjectGroupId(index, 'shared-id', 'local')
    const remoteRowId = resolveMergedProjectGroupId(index, 'shared-id', 'runtime:m1')
    expect(localRowId).not.toBe(remoteRowId)
    expect(findMergedProjectGroupByRowId(index, localRowId)?.primary).toBe(local)
    expect(findMergedProjectGroupByRowId(index, remoteRowId)?.primary).toBe(remote)
  })

  it('leaves the row id as the plain primary id when no id is reused', () => {
    const index = buildMergedProjectGroupIndex([
      group({ id: 'local-adaptam', name: 'adaptam' }),
      group({
        id: 'remote-adaptam',
        name: 'adaptam',
        executionHostId: 'runtime:m1'
      })
    ])

    expect(index.merged[0].rowId).toBe('local-adaptam')
    expect(findMergedProjectGroupByRowId(index, 'local-adaptam')).toBe(index.merged[0])
  })
})

describe('buildProjectGroupHostIndex', () => {
  it('scopes a raw group lookup to its owning host', () => {
    const local = group({ id: 'shared-id', name: 'adaptam' })
    const remote = group({
      id: 'shared-id',
      name: 'fjordbyte',
      executionHostId: 'runtime:m1'
    })
    const index = buildProjectGroupHostIndex([local, remote])

    expect(findProjectGroupByHost(index, 'shared-id', 'local')).toBe(local)
    expect(findProjectGroupByHost(index, 'shared-id', 'runtime:m1')).toBe(remote)
    expect(findProjectGroupByHost(index, 'shared-id')).toBeUndefined()
    expect(findProjectGroupByHost(index, 'shared-id', 'runtime:m2')).toBeUndefined()
  })

  it('answers an id-only lookup when that id belongs to one group', () => {
    const only = group({
      id: 'adaptam',
      name: 'adaptam',
      executionHostId: 'runtime:m1'
    })

    expect(findProjectGroupByHost(buildProjectGroupHostIndex([only]), 'adaptam')).toBe(only)
  })

  it('memoizes on the project-group array identity', () => {
    const groups = [group({ id: 'a', name: 'adaptam' })]

    expect(buildProjectGroupHostIndex(groups)).toBe(buildProjectGroupHostIndex(groups))
  })
})
