import { describe, expect, it } from 'vitest'
import {
  getDetachedHeadTooltip,
  getWorktreeGitIdentityDisplay,
  shortGitHead
} from './worktree-git-identity-display'

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

  it('treats missing branch from git status as detached when head is known', () => {
    expect(
      getWorktreeGitIdentityDisplay({
        branch: undefined,
        head: '1234567890'
      })
    ).toMatchObject({ kind: 'detached', shortHead: '1234567' })
  })

  it('returns null when neither branch nor head is known', () => {
    expect(getWorktreeGitIdentityDisplay({ branch: '', head: '' })).toBeNull()
  })
})

describe('detached HEAD copy', () => {
  it('formats the required tooltip copy', () => {
    expect(getDetachedHeadTooltip(shortGitHead('abc123456789'))).toBe(
      'Detached HEAD at abc1234. You are viewing a commit, not a branch.'
    )
  })
})
