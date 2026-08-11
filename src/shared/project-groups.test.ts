import { describe, expect, it } from 'vitest'
import {
  clearMissingProjectGroupMemberships,
  createProjectGroup,
  findProjectGroupForConnection,
  getEffectiveProjectGroupManualRank,
  getNextProjectGroupOrder,
  getProjectGroupSubtreeIds,
  normalizeProjectGroupName,
  normalizeProjectGroups
} from './project-groups'
import type { ProjectGroup, Repo } from './types'

function repo(overrides: Partial<Repo>): Repo {
  return {
    id: overrides.id ?? 'repo-1',
    path: overrides.path ?? '/repo',
    displayName: overrides.displayName ?? 'repo',
    badgeColor: '#999',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

describe('project-groups', () => {
  it('creates a durable project group with normalized defaults', () => {
    const group = createProjectGroup({
      name: '  Platform  ',
      parentPath: '/srv/platform',
      createdFrom: 'folder-scan',
      tabOrder: 3,
      now: 100
    })

    expect(group).toMatchObject({
      name: 'Platform',
      parentPath: '/srv/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 3,
      isCollapsed: false,
      color: null,
      createdAt: 100,
      updatedAt: 100
    })
  })

  it('trims empty group names to a fallback', () => {
    expect(normalizeProjectGroupName('   ', 'Existing')).toBe('Existing')
  })

  it('normalizes persisted groups and drops malformed entries', () => {
    const groups = normalizeProjectGroups([
      { id: 'b', name: 'B', tabOrder: 2 },
      {
        id: 'a',
        name: 'A',
        tabOrder: 1,
        parentGroupId: 'missing',
        createdFrom: 'folder-scan',
        isCollapsed: true
      },
      { id: 'a', name: 'duplicate' },
      { name: 'missing id' }
    ])

    expect(groups.map((group) => group.id)).toEqual(['a', 'b'])
    expect(groups[0]).toMatchObject({
      createdFrom: 'folder-scan',
      isCollapsed: true,
      parentGroupId: null
    })
  })

  it('preserves normalized execution ownership for persisted groups', () => {
    const groups = normalizeProjectGroups([
      { id: 'runtime', name: 'Runtime', tabOrder: 1, executionHostId: 'runtime:env-1' },
      { id: 'local', name: 'Local', tabOrder: 2, executionHostId: 'local' },
      { id: 'invalid', name: 'Invalid', tabOrder: 3, executionHostId: 'runtime:' }
    ])

    expect(groups.find((group) => group.id === 'runtime')?.executionHostId).toBe('runtime:env-1')
    expect(groups.find((group) => group.id === 'local')?.executionHostId).toBe('local')
    expect(groups.find((group) => group.id === 'invalid')?.executionHostId).toBeUndefined()
  })

  it('preserves the distinction between omitted and explicitly local connection ownership', () => {
    const groups = normalizeProjectGroups([
      { id: 'legacy', name: 'Legacy' },
      { id: 'local', name: 'Local', connectionId: null }
    ])

    expect(groups.find((group) => group.id === 'legacy')).not.toHaveProperty('connectionId')
    expect(groups.find((group) => group.id === 'local')).toHaveProperty('connectionId', null)
  })

  it('clears repo memberships whose group no longer exists', () => {
    const groups = [createProjectGroup({ name: 'Known', createdFrom: 'manual', tabOrder: 0 })]
    const repos = clearMissingProjectGroupMemberships(
      [
        repo({ id: 'known', projectGroupId: groups[0].id }),
        repo({ id: 'missing', projectGroupId: 'x' })
      ],
      groups
    )

    expect(repos.find((entry) => entry.id === 'known')?.projectGroupId).toBe(groups[0].id)
    expect(repos.find((entry) => entry.id === 'missing')?.projectGroupId).toBeNull()
  })

  it('keeps memberships only when the group exists on the repo execution host', () => {
    const localGroup = {
      ...createProjectGroup({ name: 'Local', createdFrom: 'manual', tabOrder: 0 }),
      id: 'shared-group',
      connectionId: null
    }
    const sshGroup = { ...localGroup, name: 'SSH', connectionId: 'ssh-1' }
    const repos = clearMissingProjectGroupMemberships(
      [
        repo({ id: 'local', projectGroupId: localGroup.id, connectionId: null }),
        repo({ id: 'ssh', projectGroupId: sshGroup.id, connectionId: 'ssh-1' }),
        repo({
          id: 'runtime',
          projectGroupId: localGroup.id,
          executionHostId: 'runtime:env-1'
        })
      ],
      [localGroup, sshGroup]
    )

    expect(repos.find((entry) => entry.id === 'local')?.projectGroupId).toBe('shared-group')
    expect(repos.find((entry) => entry.id === 'ssh')?.projectGroupId).toBe('shared-group')
    expect(repos.find((entry) => entry.id === 'runtime')?.projectGroupId).toBeNull()
  })

  it('retains unique legacy group membership until ownership backfill', () => {
    const legacyGroup = createProjectGroup({ name: 'Legacy', createdFrom: 'manual', tabOrder: 0 })
    delete legacyGroup.connectionId

    expect(
      clearMissingProjectGroupMemberships(
        [repo({ projectGroupId: legacyGroup.id, connectionId: 'ssh-1' })],
        [legacyGroup]
      )[0]?.projectGroupId
    ).toBe(legacyGroup.id)
  })

  it('selects same-id groups by connection and requires uniqueness when omitted', () => {
    const localGroup = {
      ...createProjectGroup({ name: 'Local', createdFrom: 'manual', tabOrder: 0 }),
      id: 'shared-group',
      connectionId: null
    }
    const sshGroup = { ...localGroup, name: 'SSH', connectionId: 'ssh-1' }

    for (const groups of [
      [localGroup, sshGroup],
      [sshGroup, localGroup]
    ]) {
      expect(findProjectGroupForConnection(groups, localGroup.id, 'ssh-1')).toBe(sshGroup)
      expect(findProjectGroupForConnection(groups, localGroup.id, null)).toBe(localGroup)
      expect(findProjectGroupForConnection(groups, localGroup.id)).toBeUndefined()
    }
    expect(findProjectGroupForConnection([sshGroup], sshGroup.id)).toBe(sshGroup)
    expect(findProjectGroupForConnection([sshGroup], sshGroup.id, null)).toBeUndefined()
    expect(
      findProjectGroupForConnection(
        [{ ...sshGroup, connectionId: null, executionHostId: 'ssh:ssh-1' }],
        sshGroup.id,
        null
      )
    ).toBeUndefined()

    const legacyGroup: ProjectGroup = { ...localGroup }
    delete legacyGroup.connectionId
    expect(findProjectGroupForConnection([legacyGroup], legacyGroup.id, null)).toBe(legacyGroup)
    for (const groups of [
      [legacyGroup, sshGroup],
      [sshGroup, legacyGroup]
    ]) {
      expect(findProjectGroupForConnection(groups, legacyGroup.id, null)).toBe(legacyGroup)
      expect(findProjectGroupForConnection(groups, legacyGroup.id, 'ssh-1')).toBe(sshGroup)
      expect(findProjectGroupForConnection(groups, legacyGroup.id)).toBeUndefined()
      const memberships = clearMissingProjectGroupMemberships(
        [
          repo({ id: 'legacy-local', projectGroupId: legacyGroup.id, connectionId: null }),
          repo({ id: 'legacy-ssh', projectGroupId: legacyGroup.id, connectionId: 'ssh-1' }),
          repo({
            id: 'legacy-runtime',
            projectGroupId: legacyGroup.id,
            executionHostId: 'runtime:env-1'
          })
        ],
        groups
      )
      expect(memberships.find((entry) => entry.id === 'legacy-local')?.projectGroupId).toBe(
        legacyGroup.id
      )
      expect(memberships.find((entry) => entry.id === 'legacy-ssh')?.projectGroupId).toBe(
        legacyGroup.id
      )
      expect(memberships.find((entry) => entry.id === 'legacy-runtime')?.projectGroupId).toBeNull()
    }
  })

  it('falls back to global repo order when projectGroupOrder is unset', () => {
    const repoOrder = new Map([
      ['a', 0],
      ['b', 2]
    ])

    expect(
      getEffectiveProjectGroupManualRank(repo({ id: 'a', projectGroupOrder: 5 }), repoOrder)
    ).toBe(5)
    expect(getEffectiveProjectGroupManualRank(repo({ id: 'a' }), repoOrder)).toBe(0)
    expect(getEffectiveProjectGroupManualRank(repo({ id: 'b' }), repoOrder)).toBe(2000)
    expect(getEffectiveProjectGroupManualRank(repo({ id: 'c' }), repoOrder, 1)).toBe(1000)
  })

  it('computes the next order inside a group independently from ungrouped repos', () => {
    expect(
      getNextProjectGroupOrder(
        [
          repo({ id: 'a', projectGroupId: 'g', projectGroupOrder: 2 }),
          repo({ id: 'b', projectGroupId: null, projectGroupOrder: 9 })
        ],
        'g'
      )
    ).toBe(3)
  })

  it('collects descendant group ids for subtree deletion', () => {
    expect(
      [
        ...getProjectGroupSubtreeIds(
          [
            { id: 'root', parentGroupId: null },
            { id: 'child', parentGroupId: 'root' },
            { id: 'grandchild', parentGroupId: 'child' },
            { id: 'sibling', parentGroupId: null }
          ],
          'root'
        )
      ].sort()
    ).toEqual(['child', 'grandchild', 'root'])
  })

  it('collects wide descendant groups without overflowing argument limits', () => {
    const groups = [
      { id: 'root', parentGroupId: null },
      ...Array.from({ length: 130_000 }, (_, index) => ({
        id: `child-${index}`,
        parentGroupId: 'root'
      }))
    ]

    const subtreeIds = getProjectGroupSubtreeIds(groups, 'root')

    expect(subtreeIds.size).toBe(130_001)
    expect(subtreeIds.has('root')).toBe(true)
    expect(subtreeIds.has('child-129999')).toBe(true)
  })
})
