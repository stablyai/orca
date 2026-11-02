import { describe, expect, it } from 'vitest'
import { getWorktreeGitIdentityDisplay } from './git-identity-display'

describe('worktree git identity display', () => {
  it('shows a branch name when the worktree has a branch ref', () => {
    expect(
      getWorktreeGitIdentityDisplay({
        branch: 'refs/heads/review/merge-queue',
        head: 'abcdef123456'
      })
    ).toEqual({ kind: 'branch', branchName: 'review/merge-queue' })
  })

  it('shows detached HEAD labels when branch is empty and head is known', () => {
    expect(
      getWorktreeGitIdentityDisplay({
        branch: '',
        head: 'abcdef123456'
      })
    ).toEqual({
      kind: 'detached',
      shortHead: 'abcdef1',
      sidebarLabel: 'Detached HEAD @ abcdef1',
      sourceControlLabel: 'Detached HEAD · abcdef1',
      tooltip: 'Detached HEAD at abcdef1. You are viewing a commit, not a branch.'
    })
  })
})
