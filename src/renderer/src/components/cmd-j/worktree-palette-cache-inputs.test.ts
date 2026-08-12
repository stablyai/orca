import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import {
  EMPTY_WORKTREE_PALETTE_CACHE_INPUTS,
  selectWorktreePaletteCacheInputs
} from './worktree-palette-cache-inputs'

describe('selectWorktreePaletteCacheInputs', () => {
  it('stays referentially stable across review cache writes while the palette is closed', () => {
    const emptyState: Pick<AppState, 'prCache' | 'issueCache' | 'hostedReviewCache'> = {
      prCache: {},
      issueCache: {},
      hostedReviewCache: {}
    }
    const filledState: Pick<AppState, 'prCache' | 'issueCache' | 'hostedReviewCache'> = {
      prCache: { pr: { data: null, fetchedAt: 1 } },
      issueCache: { issue: { data: null, fetchedAt: 1 } },
      hostedReviewCache: { review: { data: null, fetchedAt: 1 } }
    }

    const before = selectWorktreePaletteCacheInputs(emptyState, false)
    const after = selectWorktreePaletteCacheInputs(filledState, false)

    expect(before).toBe(EMPTY_WORKTREE_PALETTE_CACHE_INPUTS)
    expect(after).toBe(before)
  })

  it('returns live cache identities while the palette is visible', () => {
    const state = {
      prCache: {},
      issueCache: {},
      hostedReviewCache: {}
    } as Pick<AppState, 'prCache' | 'issueCache' | 'hostedReviewCache'>

    const selected = selectWorktreePaletteCacheInputs(state, true)

    expect(selected).toEqual(state)
    expect(selected.prCache).toBe(state.prCache)
    expect(selected.issueCache).toBe(state.issueCache)
    expect(selected.hostedReviewCache).toBe(state.hostedReviewCache)
  })
})
