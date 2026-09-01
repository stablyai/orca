import { describe, expect, it } from 'vitest'
import {
  getDetachedHeadTooltip,
  getWorktreeGitIdentityDisplay,
  getWorktreeGitOperationIdentityDisplay,
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

describe('identity while an operation replays commits', () => {
  const midRebase = { branch: '', head: '285883d1c0ffee00', conflictOperation: 'rebase' as const }

  it('names the branch being rebased instead of collapsing to Detached HEAD', () => {
    expect(
      getWorktreeGitOperationIdentityDisplay({
        ...midRebase,
        operationHeadName: 'refs/heads/triage-e2e'
      })
    ).toEqual({
      kind: 'operation',
      operation: 'rebase',
      branchName: 'triage-e2e',
      shortHead: '285883d',
      head: '285883d1c0ffee00'
    })
  })

  // Wire compatibility: an old host omits operationProgress, so no head-name reaches us.
  it('falls back to the plain detached identity when the host did not name the branch', () => {
    expect(getWorktreeGitOperationIdentityDisplay({ ...midRebase })).toMatchObject({
      kind: 'detached',
      shortHead: '285883d'
    })
    expect(
      getWorktreeGitOperationIdentityDisplay({ ...midRebase, operationHeadName: '   ' })
    ).toMatchObject({ kind: 'detached' })
  })

  it('keeps the plain branch identity when nothing is running', () => {
    expect(
      getWorktreeGitOperationIdentityDisplay({
        branch: 'refs/heads/main',
        head: 'abc1234',
        conflictOperation: 'unknown',
        operationHeadName: 'refs/heads/triage-e2e'
      })
    ).toEqual({ kind: 'branch', branchName: 'main' })
  })

  it('names a merge and a cherry-pick too, not just a rebase', () => {
    expect(
      getWorktreeGitOperationIdentityDisplay({
        branch: 'refs/heads/main',
        head: 'abc1234',
        conflictOperation: 'merge',
        operationHeadName: 'refs/heads/main'
      })
    ).toMatchObject({ kind: 'operation', operation: 'merge', branchName: 'main' })
  })
})
