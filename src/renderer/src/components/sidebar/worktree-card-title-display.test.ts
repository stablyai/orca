import { describe, expect, it } from 'vitest'
import {
  coerceWorktreeCardVisibleTitle,
  getWorktreeCardTitleDisplay
} from './worktree-card-title-display'

describe('worktree card title display', () => {
  it('keeps the stored title while linked titles are still loading', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'feature/local-branch',
        branchName: 'feature/local-branch',
        reviewTitle: 'Loading PR...'
      })
    ).toBe('feature/local-branch')
  })

  it('coerces legacy visible titles before downstream title operations', () => {
    expect(coerceWorktreeCardVisibleTitle(undefined).trim()).toBe('')
    expect(coerceWorktreeCardVisibleTitle(null).trim()).toBe('')
    expect(coerceWorktreeCardVisibleTitle('  Custom workspace  ')).toBe('  Custom workspace  ')
  })
})

describe('session-derived workspace card titles', () => {
  it('uses session names for automatic labels, including established branches', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'main',
        branchName: 'main',
        sessionTitle: 'Fix shipping estimates'
      })
    ).toBe('Fix shipping estimates')
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'Previous task',
        branchName: 'main',
        displayNameMode: 'automatic',
        sessionTitle: 'New task'
      })
    ).toBe('New task')
  })

  it('keeps manually fixed labels even when identical to the branch', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'main',
        branchName: 'main',
        displayNameMode: 'fixed',
        sessionTitle: 'Other task',
        issueTitle: 'Linked task'
      })
    ).toBe('main')
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'My project',
        branchName: 'main',
        sessionTitle: 'Other task'
      })
    ).toBe('My project')
  })

  it('keeps linked task subjects ahead of session names', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'main',
        branchName: 'main',
        sessionTitle: 'Session task',
        issueTitle: 'Linked task'
      })
    ).toBe('Linked task')
  })

  it('falls back to the original name when sessions close or have no title', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'main',
        branchName: 'main',
        sessionTitle: '  '
      })
    ).toBe('main')
  })

  it('preserves explicit non-git folder names without naming provenance', () => {
    expect(
      getWorktreeCardTitleDisplay({
        storedDisplayName: 'My folder',
        branchName: '',
        sessionTitle: 'Agent task'
      })
    ).toBe('My folder')
  })
})
