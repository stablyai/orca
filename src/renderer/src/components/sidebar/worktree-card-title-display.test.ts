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
