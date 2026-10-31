import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { isFileOnLocalHostFromState } from './connection-owner-resolution'

type State = Parameters<typeof isFileOnLocalHostFromState>[0]

function makeRepo(overrides: Partial<Repo> & { id: string }): Repo {
  return { path: '/srv/repo', displayName: 'repo', badgeColor: '#000', addedAt: 0, ...overrides }
}

function makeWorktree(overrides: Partial<Worktree> & { id: string; repoId: string }): Worktree {
  return {
    path: '/srv/repo',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Workspace',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function stateWith(repos: Repo[], worktrees: Worktree[]): State {
  return {
    folderWorkspaces: [],
    projectGroups: [],
    repos,
    worktreesByRepo: { [repos[0].id]: worktrees }
  }
}

const FILE = '/srv/repo/a.ts'

describe('isFileOnLocalHostFromState', () => {
  it('accepts a local repo worktree', () => {
    const state = stateWith(
      [makeRepo({ id: 'r' })],
      [makeWorktree({ id: 'r::/srv/repo', repoId: 'r' })]
    )
    expect(isFileOnLocalHostFromState(state, 'r::/srv/repo', FILE)).toBe(true)
  })

  it('rejects a runtime-hosted worktree whose connection id reads as null', () => {
    const state = stateWith(
      [makeRepo({ id: 'r' })],
      [makeWorktree({ id: 'r::/srv/repo', repoId: 'r', hostId: 'runtime:env-a' })]
    )
    expect(isFileOnLocalHostFromState(state, 'r::/srv/repo', FILE)).toBe(false)
  })

  it('rejects a worktree owned by a runtime environment even when its host reads local', () => {
    const state = stateWith(
      [makeRepo({ id: 'r' })],
      [makeWorktree({ id: 'r::/srv/repo', repoId: 'r', runtimeOwnerEnvironmentId: 'env-a' })]
    )
    expect(isFileOnLocalHostFromState(state, 'r::/srv/repo', FILE)).toBe(false)
  })

  it('rejects SSH-backed and unresolved worktrees', () => {
    const ssh = stateWith(
      [makeRepo({ id: 'r', connectionId: 'ssh-1' })],
      [makeWorktree({ id: 'r::/srv/repo', repoId: 'r' })]
    )
    expect(isFileOnLocalHostFromState(ssh, 'r::/srv/repo', FILE)).toBe(false)
    const unresolved = stateWith([makeRepo({ id: 'other' })], [])
    expect(isFileOnLocalHostFromState(unresolved, 'missing::/srv/repo', FILE)).toBe(false)
    expect(isFileOnLocalHostFromState(unresolved, null, FILE)).toBe(false)
  })

  it('accepts a local folder workspace and rejects one pinned to a runtime host', () => {
    const folder = (executionHostId: FolderWorkspace['executionHostId']): State => ({
      folderWorkspaces: [
        {
          id: 'f1',
          projectGroupId: 'g1',
          name: 'Folder',
          folderPath: '/srv/repo',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          createdAt: 0,
          updatedAt: 0,
          executionHostId
        }
      ],
      projectGroups: [],
      repos: [makeRepo({ id: 'r' })],
      worktreesByRepo: {}
    })
    const key = folderWorkspaceKey('f1')
    expect(isFileOnLocalHostFromState(folder(null), key, FILE)).toBe(true)
    expect(isFileOnLocalHostFromState(folder('runtime:env-a'), key, FILE)).toBe(false)
  })
})
