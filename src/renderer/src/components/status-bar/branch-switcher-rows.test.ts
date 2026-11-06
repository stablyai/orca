import { describe, expect, it } from 'vitest'
import { branchSwitcherRows, otherWorktreeRows, worktreeRowMatches } from './branch-switcher-rows'

describe('otherWorktreeRows', () => {
  it('leaves out the active and archived worktrees', () => {
    expect(
      otherWorktreeRows(
        [
          { id: 'a', displayName: 'active', branch: 'refs/heads/a', isArchived: false },
          { id: 'b', displayName: 'main', branch: 'refs/heads/main', isArchived: false },
          { id: 'c', displayName: 'old', branch: 'refs/heads/old', isArchived: true }
        ],
        'a'
      )
    ).toEqual([{ id: 'b', displayName: 'main', branch: 'main' }])
  })

  it('matches a search on the name or the branch', () => {
    const row = { id: 'b', displayName: 'Theme Fixes', branch: 'bhumi-4.0' }
    expect(worktreeRowMatches(row, ' theme ')).toBe(true)
    expect(worktreeRowMatches(row, 'BHUMI')).toBe(true)
    expect(worktreeRowMatches(row, 'other')).toBe(false)
  })
})

describe('branchSwitcherRows', () => {
  it('keeps one row per branch and prefers the local ref in either order', () => {
    expect(
      branchSwitcherRows([
        { refName: 'origin/main', localBranchName: 'main' },
        { refName: 'main', localBranchName: 'main' },
        { refName: 'dev', localBranchName: 'dev' },
        { refName: 'origin/dev', localBranchName: 'dev' },
        { refName: 'origin/feat/a', localBranchName: 'feat/a' }
      ])
    ).toEqual([
      { branch: 'main', label: 'main', remoteOnly: false },
      { branch: 'dev', label: 'dev', remoteOnly: false },
      { branch: 'feat/a', label: 'origin/feat/a', remoteOnly: true }
    ])
  })
})
