import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  buildJoinableProjectGroupMenuEntries,
  buildReparentableProjectGroupMenuEntries,
  findJoinableParentGroupForRepo,
  resolveProjectGroupParentMenuTargets
} from './project-group-menu-tree'

function makeGroup(id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

const localRepo: Repo = {
  id: 'repo-1',
  path: '/repo-1',
  displayName: 'Repo 1',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: 'local'
}

describe('buildJoinableProjectGroupMenuEntries', () => {
  it('orders subgroups recursively beneath their parent with depth and excludes other hosts', () => {
    const groups: ProjectGroup[] = [
      makeGroup('root-b', { name: 'B', tabOrder: 1, executionHostId: 'local' }),
      makeGroup('root-a', { name: 'A', tabOrder: 0, executionHostId: 'local' }),
      makeGroup('sub-a1', {
        name: 'A1',
        parentGroupId: 'root-a',
        tabOrder: 0,
        executionHostId: 'local'
      }),
      makeGroup('sub-a1-leaf', {
        name: 'A1 Leaf',
        parentGroupId: 'sub-a1',
        tabOrder: 0,
        executionHostId: 'local'
      }),
      makeGroup('remote-only', { name: 'Remote', tabOrder: 0, executionHostId: 'runtime:env-1' })
    ]

    const entries = buildJoinableProjectGroupMenuEntries(localRepo, groups)

    expect(
      entries.map((entry) => ({
        id: entry.group.id,
        depth: entry.depth,
        pathLabel: entry.pathLabel
      }))
    ).toEqual([
      { id: 'root-a', depth: 0, pathLabel: 'A' },
      { id: 'sub-a1', depth: 1, pathLabel: 'A / A1' },
      { id: 'sub-a1-leaf', depth: 2, pathLabel: 'A / A1 / A1 Leaf' },
      { id: 'root-b', depth: 0, pathLabel: 'B' }
    ])
  })

  it('orders pinned groups first within each level and respects rootProjectOrder for root groups', () => {
    const groups: ProjectGroup[] = [
      makeGroup('root-early-tab', {
        name: 'Early Tab',
        tabOrder: 0,
        rootProjectOrder: 2000,
        executionHostId: 'local'
      }),
      makeGroup('root-earlier-root-rank', {
        name: 'Earlier Root Rank',
        tabOrder: 5,
        rootProjectOrder: 500,
        executionHostId: 'local'
      }),
      makeGroup('root-pinned', {
        name: 'Pinned Root',
        tabOrder: 9,
        rootProjectOrder: 9000,
        isPinned: true,
        executionHostId: 'local'
      }),
      makeGroup('sub-unpinned', {
        name: 'Sub Unpinned',
        parentGroupId: 'root-pinned',
        tabOrder: 0,
        executionHostId: 'local'
      }),
      makeGroup('sub-pinned', {
        name: 'Sub Pinned',
        parentGroupId: 'root-pinned',
        tabOrder: 3,
        isPinned: true,
        executionHostId: 'local'
      })
    ]

    expect(
      buildJoinableProjectGroupMenuEntries(localRepo, groups).map((entry) => entry.group.id)
    ).toEqual([
      'root-pinned',
      'sub-pinned',
      'sub-unpinned',
      'root-earlier-root-rank',
      'root-early-tab'
    ])
  })

  it('picks the repo catalog copy when a colliding group id exists on multiple hosts', () => {
    const remoteRepo: Repo = {
      ...localRepo,
      executionHostId: 'runtime:env-1'
    }
    const groups: ProjectGroup[] = [
      makeGroup('shared-id', { name: 'Local Copy', executionHostId: 'local' }),
      makeGroup('shared-id', { name: 'Remote Copy', executionHostId: 'runtime:env-1' })
    ]

    const entries = buildJoinableProjectGroupMenuEntries(remoteRepo, groups)

    expect(entries.map((entry) => ({ id: entry.group.id, name: entry.group.name }))).toEqual([
      { id: 'shared-id', name: 'Remote Copy' }
    ])
  })

  it('omits leaf current group and returns empty when repo is already in the sole group, while keeping structural ancestor disabled', () => {
    const soleGroup = [makeGroup('g-only', { name: 'Only', executionHostId: 'local' })]
    expect(
      buildJoinableProjectGroupMenuEntries({ ...localRepo, projectGroupId: 'g-only' }, soleGroup)
    ).toEqual([])

    const nestedGroups = [
      makeGroup('g-parent', { name: 'Backend', tabOrder: 0, executionHostId: 'local' }),
      makeGroup('g-sub', {
        name: 'API',
        parentGroupId: 'g-parent',
        tabOrder: 0,
        executionHostId: 'local'
      }),
      makeGroup('g-leaf-current', { name: 'Current Leaf', tabOrder: 1, executionHostId: 'local' })
    ]

    expect(
      buildJoinableProjectGroupMenuEntries(
        { ...localRepo, projectGroupId: 'g-leaf-current' },
        nestedGroups
      ).map((entry) => ({ id: entry.group.id, depth: entry.depth, disabled: entry.disabled }))
    ).toEqual([
      { id: 'g-parent', depth: 0, disabled: false },
      { id: 'g-sub', depth: 1, disabled: false }
    ])

    expect(
      buildJoinableProjectGroupMenuEntries(
        { ...localRepo, projectGroupId: 'g-parent' },
        nestedGroups
      ).map((entry) => ({ id: entry.group.id, depth: entry.depth, disabled: entry.disabled }))
    ).toEqual([
      { id: 'g-parent', depth: 0, disabled: true },
      { id: 'g-sub', depth: 1, disabled: false },
      { id: 'g-leaf-current', depth: 0, disabled: false }
    ])
  })
})

describe('findJoinableParentGroupForRepo', () => {
  it('returns the parent group when a repo sits inside a subgroup on the same host and null otherwise', () => {
    const parent = makeGroup('g-parent', { name: 'Parent', executionHostId: 'local' })
    const sub = makeGroup('g-sub', {
      name: 'Sub',
      parentGroupId: 'g-parent',
      executionHostId: 'local'
    })
    const remoteParent = makeGroup('g-remote', {
      name: 'Remote Parent',
      executionHostId: 'runtime:env-1'
    })
    const subWithCrossHostParent = makeGroup('g-sub-cross', {
      name: 'Sub Cross',
      parentGroupId: 'g-remote',
      executionHostId: 'local'
    })
    const groups = [parent, sub, remoteParent, subWithCrossHostParent]

    expect(findJoinableParentGroupForRepo({ ...localRepo, projectGroupId: 'g-sub' }, groups)).toBe(
      parent
    )
    expect(
      findJoinableParentGroupForRepo({ ...localRepo, projectGroupId: 'g-parent' }, groups)
    ).toBeNull()
    expect(findJoinableParentGroupForRepo(localRepo, groups)).toBeNull()
    expect(
      findJoinableParentGroupForRepo({ ...localRepo, projectGroupId: 'g-sub-cross' }, groups)
    ).toBeNull()
  })
})

describe('buildReparentableProjectGroupMenuEntries & resolveProjectGroupParentMenuTargets', () => {
  it('excludes the group itself, its descendants, and other hosts while keeping current parent disabled only when sibling subgroups exist', () => {
    const rootA = makeGroup('root-a', { name: 'Root A', tabOrder: 0, executionHostId: 'local' })
    const subA1 = makeGroup('sub-a1', {
      name: 'Sub A1',
      parentGroupId: 'root-a',
      tabOrder: 0,
      executionHostId: 'local'
    })
    const leafOfA1 = makeGroup('leaf-a1', {
      name: 'Leaf A1',
      parentGroupId: 'sub-a1',
      tabOrder: 0,
      executionHostId: 'local'
    })
    const subA2 = makeGroup('sub-a2', {
      name: 'Sub A2',
      parentGroupId: 'root-a',
      tabOrder: 1,
      executionHostId: 'local'
    })
    const rootB = makeGroup('root-b', { name: 'Root B', tabOrder: 1, executionHostId: 'local' })
    const remote = makeGroup('remote', { name: 'Remote', executionHostId: 'runtime:env-1' })
    const groups = [rootA, subA1, leafOfA1, subA2, rootB, remote]

    // For sub-a1: excludes sub-a1 and leaf-a1; keeps root-a disabled because sub-a2 is selectable beneath it
    expect(
      buildReparentableProjectGroupMenuEntries('sub-a1', 'local', groups).map((entry) => ({
        id: entry.group.id,
        depth: entry.depth,
        disabled: entry.disabled
      }))
    ).toEqual([
      { id: 'root-a', depth: 0, disabled: true },
      { id: 'sub-a2', depth: 1, disabled: false },
      { id: 'root-b', depth: 0, disabled: false }
    ])

    // When sub-a1 is the ONLY child of root-a, root-a is omitted as a leaf no-op
    expect(
      buildReparentableProjectGroupMenuEntries('sub-a1', 'local', [
        rootA,
        subA1,
        leafOfA1,
        rootB
      ]).map((entry) => ({
        id: entry.group.id,
        depth: entry.depth,
        disabled: entry.disabled
      }))
    ).toEqual([{ id: 'root-b', depth: 0, disabled: false }])

    // Parent menu targets distinguish top-level, single-nested, and doubly-nested groups
    expect(resolveProjectGroupParentMenuTargets('root-a', 'local', groups)).toEqual({
      isNested: false,
      grandparentGroup: null
    })
    expect(resolveProjectGroupParentMenuTargets('sub-a1', 'local', groups)).toEqual({
      isNested: true,
      grandparentGroup: null
    })
    expect(resolveProjectGroupParentMenuTargets('leaf-a1', 'local', groups)).toEqual({
      isNested: true,
      grandparentGroup: rootA
    })
  })

  it('excludes direct-SSH groups when reparenting a local group and vice versa', () => {
    const localGroup = makeGroup('local-g', { name: 'Local', executionHostId: 'local' })
    const sshGroup = makeGroup('ssh-g', {
      name: 'SSH',
      connectionId: 'box-1',
      executionHostId: 'ssh:box-1'
    })
    const otherSshGroup = makeGroup('ssh-other', {
      name: 'Other SSH',
      connectionId: 'box-2',
      executionHostId: 'ssh:box-2'
    })
    const sameSshTarget = makeGroup('ssh-peer', {
      name: 'Same SSH Peer',
      connectionId: 'box-1',
      executionHostId: 'ssh:box-1'
    })
    const all = [localGroup, sshGroup, otherSshGroup, sameSshTarget]

    expect(buildReparentableProjectGroupMenuEntries('local-g', 'local', all)).toEqual([])
    expect(
      buildReparentableProjectGroupMenuEntries('ssh-g', 'ssh:box-1', all).map((e) => e.group.id)
    ).toEqual(['ssh-peer'])
  })
})
