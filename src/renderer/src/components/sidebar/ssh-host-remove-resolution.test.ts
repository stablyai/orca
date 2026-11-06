import { describe, it, expect } from 'vitest'
import { resolveSshHostRemoval } from './ssh-host-remove-resolution'

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
      worktrees
    })
    expect(result.workspaceWorktreeIds.sort()).toEqual(
      ['repo-a::/wt/feature', 'repo-b::/wt/x'].sort()
    )
    expect(result.hostRepoIds.sort()).toEqual(['repo-a', 'repo-b'])
    expect(result.workspaceCount).toBe(4)
  })

  it('reports zero workspaces for a target nothing points at', () => {
    const result = resolveSshHostRemoval({
      targetId: 'ssh-unused',
      repos,
      worktrees
    })
    expect(result.workspaceCount).toBe(0)
    expect(result.hostRepoIds).toEqual([])
  })

  it('dedupes duplicate repo and worktree rows so the count is not inflated', () => {
    const result = resolveSshHostRemoval({
      // Model transient duplicate rows during host merge.
      targetId: 'ssh-1',
      repos: [
        { id: 'repo-a', connectionId: 'ssh-1' },
        { id: 'repo-a', connectionId: 'ssh-1' }
      ],
      worktrees: [
        { id: 'repo-a::/wt/x', repoId: 'repo-a', isMainWorktree: false },
        { id: 'repo-a::/wt/x', repoId: 'repo-a', isMainWorktree: false },
        { id: 'repo-a::/wt/x', repoId: 'repo-a', isMainWorktree: false }
      ]
    })
    expect(result.hostRepoIds).toEqual(['repo-a'])
    expect(result.workspaceWorktreeIds).toEqual(['repo-a::/wt/x'])
    expect(result.workspaceCount).toBe(2)
  })
})
