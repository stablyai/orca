import { describe, expect, it } from 'vitest'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../../../shared/types'
import {
  mergeFolderGitTargets,
  selectFolderSourceControlRepos
} from './folder-source-control-repos'

function repo(overrides: Partial<Repo>): Repo {
  return {
    id: 'repo-id',
    path: '/root/repo',
    displayName: 'repo',
    badgeColor: '#000000',
    addedAt: 1,
    ...overrides
  }
}

describe('selectFolderSourceControlRepos', () => {
  it('returns git repos under a folder repo path', () => {
    const parent = repo({
      id: 'parent',
      path: '/root',
      displayName: 'root',
      kind: 'folder',
      projectGroupId: 'group-1'
    })
    const first = repo({
      id: 'first',
      path: '/root/first',
      displayName: 'first',
      projectGroupId: 'group-1'
    })
    const second = repo({
      id: 'second',
      path: '/root/nested/second',
      displayName: 'second',
      projectGroupId: 'group-1'
    })
    const outside = repo({ id: 'outside', path: '/other', displayName: 'outside' })

    expect(
      selectFolderSourceControlRepos(
        {
          projectGroups: [{ id: 'group-1', parentGroupId: null } as ProjectGroup],
          repos: [parent, first, second, outside]
        },
        'worktree:parent::/root',
        parent
      ).map((entry) => entry.id)
    ).toEqual(['first', 'second'])
  })

  it('returns git repos for folder workspaces through candidate repos', () => {
    const folderWorkspace = {
      id: 'folder-1',
      projectGroupId: 'group-1',
      folderPath: '/root'
    } as FolderWorkspace
    const first = repo({ id: 'first', path: '/root/first', projectGroupId: 'group-1' })
    const folder = repo({
      id: 'parent',
      path: '/root',
      displayName: 'root',
      kind: 'folder',
      projectGroupId: 'group-1'
    })

    expect(
      selectFolderSourceControlRepos(
        {
          folderWorkspaces: [folderWorkspace],
          projectGroups: [{ id: 'group-1', parentGroupId: null } as ProjectGroup],
          repos: [first, folder]
        },
        'folder:folder-1',
        null
      ).map((entry) => entry.id)
    ).toEqual(['first'])
  })
})

describe('mergeFolderGitTargets', () => {
  it('adds scanned git directories that are not registered as Orca repos', () => {
    const known = repo({ id: 'known', path: '/root/known', displayName: 'known' })

    expect(
      mergeFolderGitTargets({
        repos: [known],
        scannedRepos: [
          { path: '/root/known', displayName: 'known', depth: 1 },
          { path: '/root/extra', displayName: 'extra', depth: 1 },
          { path: '/outside', displayName: 'outside', depth: 1 }
        ],
        parentPath: '/root'
      }).map((target) => target.key)
    ).toEqual(['known', 'path:/root/extra'])
  })
})
