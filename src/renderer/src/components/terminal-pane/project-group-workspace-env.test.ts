import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { buildProjectGroupWorkspaceEnv } from './project-group-workspace-env'

const repos: Repo[] = [
  {
    id: 'repo-a',
    path: '/work/a',
    displayName: 'A',
    badgeColor: '#000000',
    addedAt: 0,
    projectGroupId: 'g1'
  },
  {
    id: 'repo-b',
    path: '/work/b',
    displayName: 'B',
    badgeColor: '#000000',
    addedAt: 0,
    projectGroupId: null
  }
]
const projectGroups: ProjectGroup[] = [
  {
    id: 'g1',
    name: 'Platform',
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
]
const state = { repos, projectGroups }

describe('buildProjectGroupWorkspaceEnv', () => {
  it('resolves the group of a worktree workspace through its repo', () => {
    const env = buildProjectGroupWorkspaceEnv(state, 'repo-a::/work/a/wt', null)

    expect(env.ORCA_PROJECT_GROUP_NAME).toBe('Platform')
    expect(JSON.parse(env.ORCA_PROJECT_GROUP_PROJECTS)).toEqual([
      { id: 'repo-a', name: 'A', path: '/work/a', kind: 'git' }
    ])
  })

  it('uses the group a folder workspace carries directly', () => {
    const env = buildProjectGroupWorkspaceEnv(state, 'folder:ws-1', { projectGroupId: 'g1' })

    expect(env.ORCA_PROJECT_GROUP_ID).toBe('g1')
  })

  it('adds nothing for an ungrouped worktree workspace', () => {
    expect(buildProjectGroupWorkspaceEnv(state, 'repo-b::/work/b', null)).toEqual({})
  })
})
