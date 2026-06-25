import { describe, expect, it } from 'vitest'
import {
  coerceWorktreeCardVisibleTitle,
  getWorktreeCardTitleDisplay
} from './worktree-card-title-display'

describe('worktree card title display', () => {
  it('keeps custom workspace titles', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'Custom workspace',
        branchName: 'feature/custom',
        reviewTitle: 'Fix stale PR'
      })
    ).toBe('Custom workspace')

    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: '  Custom workspace  ',
        branchName: 'feature/custom',
        reviewTitle: 'Fix stale PR'
      })
    ).toBe('  Custom workspace  ')
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

  it('uses linked work titles when the stored title is nullish and the branch is usable', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: undefined,
        branchName: 'feature/local-branch',
        reviewTitle: 'Fix stale GH PR'
      })
    ).toBe('Fix stale GH PR')

    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: null,
        branchName: 'feature/local-branch',
        issueTitle: 'Fix stale issue'
      })
    ).toBe('Fix stale issue')
  })

  it('treats blank stored titles as absent', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: '   ',
        branchName: 'feature/local-branch'
      })
    ).toBe('')

    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: '',
        branchName: 'feature/local-branch',
        linearIssueTitle: 'Fix stale Linear issue'
      })
    ).toBe('Fix stale Linear issue')
  })

  it('skips linked-title replacement when the branch name is nullish or blank', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'Custom workspace',
        branchName: undefined,
        reviewTitle: 'Fix stale GH PR'
      })
    ).toBe('Custom workspace')

    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: null,
        branchName: '   ',
        reviewTitle: 'Fix stale GH PR'
      })
    ).toBe('')
  })

  it('coerces legacy visible titles before downstream title operations', () => {
    expect(coerceWorktreeCardVisibleTitle(undefined).trim()).toBe('')
    expect(coerceWorktreeCardVisibleTitle(null).trim()).toBe('')
    expect(coerceWorktreeCardVisibleTitle('  Custom workspace  ')).toBe('  Custom workspace  ')
  })
})
