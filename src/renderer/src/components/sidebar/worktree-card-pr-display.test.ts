import { describe, expect, it } from 'vitest'
import type { PRInfo } from '../../../../shared/types'
import { getWorktreeCardPrDisplay } from './worktree-card-pr-display'

const pr: PRInfo = {
  number: 123,
  title: 'Ready PR',
  state: 'open',
  url: 'https://github.com/stablyai/orca/pull/123',
  checksStatus: 'success',
  updatedAt: '2026-05-13T00:00:00.000Z',
  mergeable: 'MERGEABLE'
}

describe('getWorktreeCardPrDisplay', () => {
  it('uses cached PR details when available', () => {
    expect(getWorktreeCardPrDisplay(pr, 456)).toBe(pr)
  })

  it('falls back to linkedPR while PR details load', () => {
    expect(getWorktreeCardPrDisplay(undefined, 456)).toEqual({
      number: 456,
      title: 'Loading PR...'
    })
  })

  it('keeps linkedPR visible when PR details are unavailable', () => {
    expect(getWorktreeCardPrDisplay(null, 456)).toEqual({
      number: 456,
      title: 'PR details unavailable'
    })
  })

  it('does not show a PR row for unlinked worktrees', () => {
    expect(getWorktreeCardPrDisplay(undefined, null)).toBeNull()
  })
})
