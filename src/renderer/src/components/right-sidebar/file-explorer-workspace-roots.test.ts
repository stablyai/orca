import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import type { ProjectGroup, Repo, Worktree } from '../../../../shared/types'
import {
  getFileExplorerRootForPath,
  getFileExplorerWorkspaceRoots
} from './file-explorer-workspace-roots'

function repo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'path' | 'displayName'>): Repo {
  return {
    addedAt: 1,
    badgeColor: 'blue',
    ...overrides
  } as Repo
}

function group(overrides: Partial<ProjectGroup> & Pick<ProjectGroup, 'id' | 'name'>): ProjectGroup {
  return {
    color: null,
    connectionId: null,
    createdAt: 1,
    createdFrom: 'manual',
    executionHostId: null,
    isCollapsed: false,
    parentGroupId: null,
    parentPath: null,
    tabOrder: 0,
    updatedAt: 1,
    ...overrides
  }
}

function worktree(
  overrides: Partial<Worktree> & Pick<Worktree, 'id' | 'repoId' | 'path'>
): Worktree {
  return {
    branch: 'main',
    comment: '',
    displayName: overrides.path.split('/').at(-1) ?? overrides.path,
    head: '',
    isArchived: false,
    isBare: false,
    isMainWorktree: true,
    isPinned: false,
    isUnread: false,
    lastActivityAt: 1,
    linkedIssue: null,
    linkedLinearIssue: null,
    linkedPR: null,
    manualOrder: 0,
    sortOrder: 0,
    ...overrides
  } as Worktree
}

function state(overrides: {
  projectGroups: ProjectGroup[]
  repos: Repo[]
  worktrees: Worktree[]
}): Pick<AppState, 'projectGroups' | 'repos' | 'settings' | 'worktreesByRepo'> {
  const worktreesByRepo: AppState['worktreesByRepo'] = {}
  for (const entry of overrides.worktrees) {
    worktreesByRepo[entry.repoId] = [...(worktreesByRepo[entry.repoId] ?? []), entry]
  }
  return {
    projectGroups: overrides.projectGroups,
    repos: overrides.repos,
    settings: { activeRuntimeEnvironmentId: null } as AppState['settings'],
    worktreesByRepo
  }
}

describe('getFileExplorerWorkspaceRoots', () => {
  it('projects unrelated repos in the same manual group as independent roots', () => {
    const groupA = group({ id: 'group-a', name: 'Full stack' })
    const roots = getFileExplorerWorkspaceRoots(
      state({
        projectGroups: [groupA],
        repos: [
          repo({
            id: 'api',
            path: '/srv/api',
            displayName: 'api',
            projectGroupId: groupA.id,
            connectionId: 'ssh-api'
          }),
          repo({
            id: 'web',
            path: '/Users/me/web',
            displayName: 'web',
            projectGroupId: groupA.id
          })
        ],
        worktrees: [
          worktree({
            id: 'api::/srv/api',
            repoId: 'api',
            path: '/srv/api',
            hostId: 'ssh:ssh-api'
          }),
          worktree({
            id: 'web::/Users/me/web',
            repoId: 'web',
            path: '/Users/me/web',
            hostId: 'runtime:env-web'
          })
        ]
      }),
      'api::/srv/api'
    )

    expect(
      roots.map((root) => [
        root.name,
        root.path,
        root.worktreeId,
        root.connectionId,
        root.runtimeEnvironmentId
      ])
    ).toEqual([
      ['api', '/srv/api', 'api::/srv/api', 'ssh-api', null],
      ['web', '/Users/me/web', 'web::/Users/me/web', null, 'env-web']
    ])
  })

  it('keeps a single root when the active repo is not grouped', () => {
    const roots = getFileExplorerWorkspaceRoots(
      state({
        projectGroups: [],
        repos: [repo({ id: 'api', path: '/srv/api', displayName: 'api' })],
        worktrees: [worktree({ id: 'api::/srv/api', repoId: 'api', path: '/srv/api' })]
      }),
      'api::/srv/api'
    )

    expect(roots).toHaveLength(1)
    expect(roots[0].path).toBe('/srv/api')
  })

  it('resolves the deepest root for nested paths', () => {
    const parent = {
      id: 'parent',
      name: 'parent',
      path: '/repo',
      repoId: 'parent',
      worktreeId: 'parent::/repo',
      isActive: true
    }
    const child = {
      id: 'child',
      name: 'child',
      path: '/repo/packages/app',
      repoId: 'child',
      worktreeId: 'child::/repo/packages/app',
      isActive: false
    }

    expect(getFileExplorerRootForPath([parent, child], '/repo/packages/app/src/index.ts')).toBe(
      child
    )
  })
})
