import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { getQuickTasksRepos } from './quick-tasks-repos'

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/stack/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git',
    ...overrides
  }
}

describe('getQuickTasksRepos', () => {
  const repos = [
    repo('app-a-api', { projectGroupId: 'app-a' }),
    repo('app-a-web', { projectGroupId: 'app-a-front' }),
    repo('app-a-notes', { projectGroupId: 'app-a', kind: 'folder' }),
    repo('app-b-api', { projectGroupId: 'app-b' })
  ]
  const projectGroups = [
    { id: 'app-a', parentGroupId: null },
    { id: 'app-a-front', parentGroupId: 'app-a' },
    { id: 'app-b', parentGroupId: null }
  ]

  it('lists every git repo in a folder workspace group subtree', () => {
    const result = getQuickTasksRepos({
      activeWorkspaceKey: 'folder:fw-1',
      activeRepo: null,
      folderWorkspaces: [{ id: 'fw-1', projectGroupId: 'app-a' }],
      projectGroups,
      repos
    })

    expect(result.map((r) => r.id)).toEqual(['app-a-api', 'app-a-web'])
  })

  it('uses only the active git repo for a worktree workspace', () => {
    const base = { folderWorkspaces: [], projectGroups, repos }

    expect(
      getQuickTasksRepos({ ...base, activeWorkspaceKey: 'worktree:wt-1', activeRepo: repos[3] })
    ).toEqual([repos[3]])
    expect(
      getQuickTasksRepos({ ...base, activeWorkspaceKey: 'worktree:wt-1', activeRepo: repos[2] })
    ).toEqual([])
  })
})
