import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearBranchLineTotalRequestGateForTests,
  getBranchLineTotalMergeBase,
  setBranchLineTotalMergeBase
} from './branch-line-total-request-gate'

describe('branch line total request gate', () => {
  beforeEach(() => {
    clearBranchLineTotalRequestGateForTests()
  })

  it('reports no merge base for a worktree that never opened the chip', () => {
    expect(getBranchLineTotalMergeBase('wt-never-gated')).toBeUndefined()
  })

  it('stores the merge base a visible chip asked for', () => {
    setBranchLineTotalMergeBase('wt-1', 'merge-base-1')

    expect(getBranchLineTotalMergeBase('wt-1')).toBe('merge-base-1')
  })

  it('replaces the merge base when the fork point moves', () => {
    setBranchLineTotalMergeBase('wt-1', 'merge-base-1')
    setBranchLineTotalMergeBase('wt-1', 'merge-base-2')

    expect(getBranchLineTotalMergeBase('wt-1')).toBe('merge-base-2')
  })

  it('deletes the entry when the chip is hidden', () => {
    setBranchLineTotalMergeBase('wt-1', 'merge-base-1')
    setBranchLineTotalMergeBase('wt-1', null)

    expect(getBranchLineTotalMergeBase('wt-1')).toBeUndefined()
  })

  it('treats an empty merge base as no gate rather than an empty request param', () => {
    setBranchLineTotalMergeBase('wt-1', 'merge-base-1')
    setBranchLineTotalMergeBase('wt-1', '')

    expect(getBranchLineTotalMergeBase('wt-1')).toBeUndefined()
  })

  it('keeps entries independent per worktree', () => {
    setBranchLineTotalMergeBase('wt-1', 'merge-base-1')
    setBranchLineTotalMergeBase('wt-2', 'merge-base-2')
    setBranchLineTotalMergeBase('wt-1', null)

    expect(getBranchLineTotalMergeBase('wt-1')).toBeUndefined()
    expect(getBranchLineTotalMergeBase('wt-2')).toBe('merge-base-2')
  })
})
