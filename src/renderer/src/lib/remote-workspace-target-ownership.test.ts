import { describe, expect, it } from 'vitest'
import type { Repo, Worktree } from '../../../shared/types'
import { getRemoteWorkspaceTargetWorktreeIds } from './remote-workspace-target-ownership'

function repo(executionHostId: Repo['executionHostId'], connectionId: string | null): Repo {
  return {
    id: 'repo-1',
    path: executionHostId === 'local' ? '/local/repo' : '/remote/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1,
    connectionId,
    executionHostId
  }
}

function worktree(id: string, hostId: Worktree['hostId']): Worktree {
  return {
    id,
    repoId: 'repo-1',
    path: id,
    head: 'abc123',
    branch: 'main',
    isBare: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isMainWorktree: false,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    hostId
  }
}

describe('getRemoteWorkspaceTargetWorktreeIds', () => {
  it('keeps duplicate repository ids scoped to the connected SSH owner', () => {
    const ids = getRemoteWorkspaceTargetWorktreeIds(
      'devbox',
      [repo('local', null), repo('ssh:devbox', 'devbox')],
      {
        'repo-1': [worktree('local-worktree', 'local'), worktree('ssh-worktree', 'ssh:devbox')]
      }
    )

    expect([...ids]).toEqual(['ssh-worktree'])
  })
})
