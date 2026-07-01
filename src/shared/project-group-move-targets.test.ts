import { describe, expect, it } from 'vitest'
import type { ProjectGroup, Repo } from './types'
import { canMoveProjectToGroup, getProjectGroupMoveTargets } from './project-group-move-targets'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#111',
    addedAt: 1,
    ...overrides
  }
}

function makeGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Group',
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

describe('project group move targets', () => {
  it('allows local projects to move into local groups', () => {
    expect(canMoveProjectToGroup(makeRepo(), makeGroup())).toBe(true)
  })

  it('filters out groups from another execution host', () => {
    const localGroup = makeGroup({ id: 'local-group' })
    const remoteGroup = makeGroup({ id: 'remote-group', executionHostId: 'runtime:env-1' })

    expect(getProjectGroupMoveTargets(makeRepo(), [localGroup, remoteGroup])).toEqual([localGroup])
  })
})
