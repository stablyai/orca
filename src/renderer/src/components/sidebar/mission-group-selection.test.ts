import { describe, expect, it } from 'vitest'
import { getMissionEligibleGroupRepoIds } from './mission-group-selection'
import type { ProjectGroup, Repo } from '../../../../shared/types'

function makeGroup(overrides: Partial<ProjectGroup> & { id: string }): ProjectGroup {
  return {
    name: overrides.id,
    parentPath: null,
    connectionId: null,
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

function makeRepo(overrides: Partial<Repo> & { id: string }): Repo {
  return {
    path: `/repos/${overrides.id}`,
    displayName: overrides.id,
    badgeColor: '#000',
    addedAt: 1,
    ...overrides
  }
}

describe('getMissionEligibleGroupRepoIds', () => {
  it('collects eligible repos across the group subtree, excluding runtime repos', () => {
    const groups = [makeGroup({ id: 'root' }), makeGroup({ id: 'child', parentGroupId: 'root' })]
    const repos = [
      makeRepo({ id: 'a', projectGroupId: 'root' }),
      makeRepo({ id: 'b', projectGroupId: 'child' }),
      makeRepo({ id: 'runtime', projectGroupId: 'root', executionHostId: 'runtime:env-1' }),
      makeRepo({ id: 'outside', projectGroupId: null })
    ]
    expect(getMissionEligibleGroupRepoIds(groups, repos, 'root')).toEqual(['a', 'b'])
    expect(getMissionEligibleGroupRepoIds(groups, repos, 'child')).toEqual(['b'])
  })
})
