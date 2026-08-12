import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../shared/types'
import { applyWorktreeHeadIdentities } from './worktree-head-identity-apply'

function makeWorktree(overrides: Partial<Worktree>): Worktree {
  return {
    id: 'repo-1::/repos/project/wt-a',
    repoId: 'repo-1',
    path: '/repos/project/wt-a',
    branch: 'refs/heads/feature',
    head: 'aaa111',
    displayName: 'wt-a',
    ...overrides
  } as Worktree
}

describe('applyWorktreeHeadIdentities', () => {
  it('updates the matching background worktree row by path', () => {
    const updateWorktreeGitIdentity = vi.fn()
    applyWorktreeHeadIdentities(
      {
        repoId: 'repo-1',
        identities: [
          { worktreePath: '/repos/project/wt-a', head: 'bbb222', branch: 'refs/heads/feature' }
        ]
      },
      {
        getWorktreesForRepo: () => [makeWorktree({})],
        updateWorktreeGitIdentity
      }
    )
    expect(updateWorktreeGitIdentity).toHaveBeenCalledTimes(1)
    expect(updateWorktreeGitIdentity).toHaveBeenCalledWith('repo-1::/repos/project/wt-a', {
      head: 'bbb222',
      branch: 'refs/heads/feature'
    })
  })

  it('matches Windows-flavored paths that differ only by separators and casing', () => {
    const updateWorktreeGitIdentity = vi.fn()
    applyWorktreeHeadIdentities(
      {
        repoId: 'repo-1',
        identities: [{ worktreePath: 'C:\\Repos\\Project\\wt-a', head: 'bbb222', branch: null }]
      },
      {
        getWorktreesForRepo: () => [
          makeWorktree({ id: 'repo-1::C:/repos/project/wt-a', path: 'C:/repos/project/wt-a' })
        ],
        updateWorktreeGitIdentity
      }
    )
    expect(updateWorktreeGitIdentity).toHaveBeenCalledWith('repo-1::C:/repos/project/wt-a', {
      head: 'bbb222',
      branch: null
    })
  })

  it('skips identities whose worktree row does not exist', () => {
    const updateWorktreeGitIdentity = vi.fn()
    applyWorktreeHeadIdentities(
      {
        repoId: 'repo-1',
        identities: [{ worktreePath: '/repos/project/removed', head: 'bbb222', branch: null }]
      },
      {
        getWorktreesForRepo: () => [makeWorktree({})],
        updateWorktreeGitIdentity
      }
    )
    expect(updateWorktreeGitIdentity).not.toHaveBeenCalled()
  })

  it('no-ops for repos with no loaded worktrees', () => {
    const updateWorktreeGitIdentity = vi.fn()
    applyWorktreeHeadIdentities(
      {
        repoId: 'repo-unknown',
        identities: [{ worktreePath: '/repos/project/wt-a', head: 'bbb222', branch: null }]
      },
      {
        getWorktreesForRepo: () => undefined,
        updateWorktreeGitIdentity
      }
    )
    expect(updateWorktreeGitIdentity).not.toHaveBeenCalled()
  })
})
