import { describe, expect, it } from 'vitest'
import {
  getDetachedHeadTooltip,
  getWorktreeGitIdentityDisplay,
  getWorktreeIdentityBranchName,
  getRebasingTooltip,
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

  it('shows a rebasing label with the recovered branch', () => {
    expect(
      getWorktreeGitIdentityDisplay({
        branch: '',
        head: 'abcdef123456',
        rebasing: true,
        rebaseBranch: 'refs/heads/feature/x'
      })
    ).toEqual({
      kind: 'rebasing',
      branchName: 'feature/x',
      shortHead: 'abcdef1',
      sidebarLabel: 'feature/x (rebasing)',
      sourceControlLabel: 'feature/x (rebasing)',
      tooltip: 'Rebasing feature/x. HEAD is temporarily detached; your branch is intact.'
    })
  })

  it('falls back to a branch-less rebasing label when the branch is unrecoverable', () => {
    expect(
      getWorktreeGitIdentityDisplay({
        branch: '',
        head: 'abcdef123456',
        rebasing: true,
        rebaseBranch: null
      })
    ).toEqual({
      kind: 'rebasing',
      branchName: null,
      shortHead: 'abcdef1',
      sidebarLabel: 'Rebasing @ abcdef1',
      sourceControlLabel: 'Rebasing · abcdef1',
      tooltip: 'Rebase in progress at abcdef1. HEAD is temporarily detached.'
    })
  })

  it('keeps the plain detached label when a detached HEAD is not rebasing', () => {
    expect(
      getWorktreeGitIdentityDisplay({ branch: '', head: 'abcdef123456', rebasing: false })
    ).toMatchObject({ kind: 'detached', sidebarLabel: 'Detached HEAD @ abcdef1' })
  })

  it('prefers a real branch even when a stale rebasing flag is present', () => {
    expect(
      getWorktreeGitIdentityDisplay({
        branch: 'refs/heads/main',
        head: 'abcdef123456',
        rebasing: true
      })
    ).toEqual({ kind: 'branch', branchName: 'main' })
  })
})

describe('worktree identity branch name (PR resolution)', () => {
  it('returns the branch name for a branch identity', () => {
    expect(getWorktreeIdentityBranchName({ kind: 'branch', branchName: 'feature/y' })).toBe(
      'feature/y'
    )
  })

  it('resolves a rebasing identity to its recovered branch', () => {
    expect(
      getWorktreeIdentityBranchName({
        kind: 'rebasing',
        branchName: 'feature/y',
        shortHead: 'abc1234',
        sidebarLabel: 'feature/y (rebasing)',
        sourceControlLabel: 'feature/y (rebasing)',
        tooltip: 'x'
      })
    ).toBe('feature/y')
  })

  it('returns null for a branch-less rebasing identity', () => {
    expect(
      getWorktreeIdentityBranchName({
        kind: 'rebasing',
        branchName: null,
        shortHead: 'abc1234',
        sidebarLabel: 'Rebasing @ abc1234',
        sourceControlLabel: 'Rebasing · abc1234',
        tooltip: 'x'
      })
    ).toBeNull()
  })

  it('returns null for a detached identity and for null', () => {
    expect(
      getWorktreeIdentityBranchName({
        kind: 'detached',
        shortHead: 'abc1234',
        sidebarLabel: 'Detached HEAD @ abc1234',
        sourceControlLabel: 'Detached HEAD · abc1234',
        tooltip: 'x'
      })
    ).toBeNull()
    expect(getWorktreeIdentityBranchName(null)).toBeNull()
  })
})

describe('detached HEAD copy', () => {
  it('formats the required tooltip copy', () => {
    expect(getDetachedHeadTooltip(shortGitHead('abc123456789'))).toBe(
      'Detached HEAD at abc1234. You are viewing a commit, not a branch.'
    )
  })
})

describe('rebasing copy', () => {
  it('names the branch when recovered', () => {
    expect(getRebasingTooltip('feature/z', 'abc1234')).toBe(
      'Rebasing feature/z. HEAD is temporarily detached; your branch is intact.'
    )
  })

  it('falls back to the short head when the branch is unknown', () => {
    expect(getRebasingTooltip(null, 'abc1234')).toBe(
      'Rebase in progress at abc1234. HEAD is temporarily detached.'
    )
  })
})
