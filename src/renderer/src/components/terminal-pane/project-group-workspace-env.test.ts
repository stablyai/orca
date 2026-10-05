import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { buildProjectGroupWorkspaceEnv } from './project-group-workspace-env'

const state = {
  repos: [
    { id: 'repo-a', path: '/work/a', displayName: 'A', projectGroupId: 'g1' },
    { id: 'repo-b', path: '/work/b', displayName: 'B', projectGroupId: null }
  ] as Repo[],
  projectGroups: [{ id: 'g1', name: 'Platform' }] as ProjectGroup[]
}

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
