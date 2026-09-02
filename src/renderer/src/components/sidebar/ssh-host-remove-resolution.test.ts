import { describe, it, expect } from 'vitest'
import { resolveSshHostRemoval } from './ssh-host-remove-resolution'
import type { SshConnectionState } from '../../../../shared/ssh-types'

function connected(id: string): Map<string, SshConnectionState> {
  return new Map([[id, { targetId: id, status: 'connected', error: null, reconnectAttempt: 0 }]])
}

describe('resolveSshHostRemoval', () => {
  const repos = [
    { id: 'repo-a', connectionId: 'ssh-1' },
    { id: 'repo-b', connectionId: 'ssh-1' },
    { id: 'repo-local', connectionId: null }
  ]
  const worktrees = [
    { id: 'repo-a::/wt/main', repoId: 'repo-a', isMainWorktree: true },
    { id: 'repo-a::/wt/feature', repoId: 'repo-a', isMainWorktree: false },
    { id: 'repo-b::/wt/x', repoId: 'repo-b', isMainWorktree: false },
    { id: 'repo-local::/wt/y', repoId: 'repo-local', isMainWorktree: false }
  ]

  it('collects non-main worktrees and root repos on the target', () => {
    const result = resolveSshHostRemoval({
      targetId: 'ssh-1',
      repos,
      worktrees,
      sshConnectionStates: new Map()
    })
    expect(result.workspaceWorktreeIds.sort()).toEqual(
      ['repo-a::/wt/feature', 'repo-b::/wt/x'].sort()
    )
    expect(result.hostRepoIds.sort()).toEqual(['repo-a', 'repo-b'])
    // 2 child worktrees + 2 root repos.
    expect(result.workspaceCount).toBe(4)
    expect(result.isConnected).toBe(false)
  })

  it('ignores repos and worktrees on other hosts', () => {
    const result = resolveSshHostRemoval({
      targetId: 'ssh-1',
      repos,
      worktrees,
      sshConnectionStates: new Map()
    })
    expect(result.workspaceWorktreeIds).not.toContain('repo-local::/wt/y')
    expect(result.hostRepoIds).not.toContain('repo-local')
  })

  it('reports connected when the target relay is connected', () => {
    const result = resolveSshHostRemoval({
      targetId: 'ssh-1',
      repos,
      worktrees,
      sshConnectionStates: connected('ssh-1')
    })
    expect(result.isConnected).toBe(true)
  })

  it('reports zero workspaces for a target nothing points at', () => {
    const result = resolveSshHostRemoval({
      targetId: 'ssh-unused',
      repos,
      worktrees,
      sshConnectionStates: new Map()
    })
    expect(result.workspaceCount).toBe(0)
    expect(result.hostRepoIds).toEqual([])
  })

  it('dedupes duplicate repo and worktree rows so the count is not inflated', () => {
    const result = resolveSshHostRemoval({
      // Store transiently holds duplicate rows (e.g. mid host merge).
      targetId: 'ssh-1',
      repos: [
        { id: 'repo-a', connectionId: 'ssh-1' },
        { id: 'repo-a', connectionId: 'ssh-1' } // duplicate repo row
      ],
      worktrees: [
        { id: 'repo-a::/wt/x', repoId: 'repo-a', isMainWorktree: false },
        { id: 'repo-a::/wt/x', repoId: 'repo-a', isMainWorktree: false }, // duplicate
        { id: 'repo-a::/wt/x', repoId: 'repo-a', isMainWorktree: false } // triplicate
      ],
      sshConnectionStates: new Map()
    })
    expect(result.hostRepoIds).toEqual(['repo-a'])
    expect(result.workspaceWorktreeIds).toEqual(['repo-a::/wt/x'])
    // 1 root repo + 1 unique child worktree.
    expect(result.workspaceCount).toBe(2)
  })
})
