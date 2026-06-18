import { describe, expect, it } from 'vitest'
import { getWorktreeCardTitleDisplay } from './worktree-card-title-display'

describe('worktree card title display', () => {
  it('keeps custom workspace titles', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'Custom workspace',
        branchName: 'feature/custom',
        reviewTitle: 'Fix stale PR'
      })
    ).toBe('Custom workspace')
  })

  it('uses linked work titles instead of repeating the branch as the card title', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'feature/local-branch',
        branchName: 'feature/local-branch',
        reviewTitle: 'Fix stale GH PR'
      })
    ).toBe('Fix stale GH PR')
  })

  it('keeps the stored title while linked titles are still loading', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'feature/local-branch',
        branchName: 'feature/local-branch',
        reviewTitle: 'Loading PR...'
      })
    ).toBe('feature/local-branch')
  })

  it('keeps the stored title when there is no linked work title', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'feature/local-branch',
        branchName: 'feature/local-branch'
      })
    ).toBe('feature/local-branch')
  })

  it('does not replace a branch-like workspace name with the repository name', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'test454545',
        branchName: 'test454545'
      })
    ).toBe('test454545')
  })
})
