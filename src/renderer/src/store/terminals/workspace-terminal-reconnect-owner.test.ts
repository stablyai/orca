import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildWorkspaceTerminalReconnectOwnerResolver } from './workspace-terminal-reconnect-owner'

function worktree(id: string, hostId?: Worktree['hostId']): Worktree {
  return {
    id,
    repoId: 'repo-1',
    path: '/remote/worktree',
    head: '',
    branch: '',
    isBare: false,
    isMainWorktree: false,
    displayName: 'worktree',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...(hostId ? { hostId } : {})
  }
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo-1',
    displayName: 'repo',
    badgeColor: '#fff',
    addedAt: 1,
    ...overrides
  }
}

describe('workspace terminal reconnect owner', () => {
  it('normalizes an encoded execution-host envelope in connectionId', () => {
    const rawWorktreeId = 'repo-1::/remote/worktree'
    const resolveOwner = buildWorkspaceTerminalReconnectOwnerResolver(
      [repo({ connectionId: 'ssh:target%20with%20spaces' })],
      { 'repo-1': [worktree(rawWorktreeId)] }
    )

    expect(resolveOwner(rawWorktreeId)).toEqual({
      kind: 'resolved',
      connectionId: 'target with spaces',
      sshTargetId: 'target with spaces'
    })
  })

  it('uses an SSH executionHostId when connectionId is absent', () => {
    const rawWorktreeId = 'repo-1::/remote/worktree'
    const resolveOwner = buildWorkspaceTerminalReconnectOwnerResolver(
      [repo({ executionHostId: 'ssh:target%20with%20spaces' })],
      { 'repo-1': [worktree(rawWorktreeId)] }
    )

    expect(resolveOwner(rawWorktreeId)).toEqual({
      kind: 'resolved',
      connectionId: 'target with spaces',
      sshTargetId: 'target with spaces'
    })
  })
})
