import { describe, expect, it } from 'vitest'
import { getWorktreeCardTitleDisplay } from './worktree-card-title-display'

describe('worktree card title display', () => {
  it('keeps custom workspace titles', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'Custom workspace',
        branchName: 'feature/custom',
        path: '/repo/worktrees/feature-custom',
        reviewTitle: 'Fix stale PR'
      })
    ).toBe('Custom workspace')
  })

  it('uses linked work titles instead of repeating the branch as the card title', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'feature/local-branch',
        branchName: 'feature/local-branch',
        path: '/repo/worktrees/pr-456',
        reviewTitle: 'Fix stale GH PR'
      })
    ).toBe('Fix stale GH PR')
  })

  it('falls back to the directory name when linked titles are still loading', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'feature/local-branch',
        branchName: 'feature/local-branch',
        path: '/repo/worktrees/pr-456',
        reviewTitle: 'Loading PR...'
      })
    ).toBe('pr-456')
  })

  it('does not fall back to a directory name that repeats the branch', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'feature/local-branch',
        branchName: 'feature/local-branch',
        path: '/repo/worktrees/local-branch',
        repositoryName: 'orca'
      })
    ).toBe('orca')
  })
})
