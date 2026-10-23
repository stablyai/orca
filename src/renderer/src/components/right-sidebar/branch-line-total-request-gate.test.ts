import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearBranchLineTotalRequestGateForTests,
  getBranchLineTotalComparisonBase,
  setBranchLineTotalComparisonBase
} from './branch-line-total-request-gate'

describe('branch line total request gate', () => {
  beforeEach(() => {
    clearBranchLineTotalRequestGateForTests()
  })

  it('reports no comparison revision for a worktree that never opened the chip', () => {
    expect(getBranchLineTotalComparisonBase('wt-never-gated')).toBeUndefined()
  })

  it('stores the comparison revision a visible chip asked for', () => {
    setBranchLineTotalComparisonBase('wt-1', 'comparison-base-1')

    expect(getBranchLineTotalComparisonBase('wt-1')).toBe('comparison-base-1')
  })

  it('replaces the comparison revision when the base branch advances', () => {
    setBranchLineTotalComparisonBase('wt-1', 'comparison-base-1')
    setBranchLineTotalComparisonBase('wt-1', 'comparison-base-2')

    expect(getBranchLineTotalComparisonBase('wt-1')).toBe('comparison-base-2')
  })

  it('deletes the entry when the chip is hidden', () => {
    setBranchLineTotalComparisonBase('wt-1', 'comparison-base-1')
    setBranchLineTotalComparisonBase('wt-1', null)

    expect(getBranchLineTotalComparisonBase('wt-1')).toBeUndefined()
  })

  it('treats an empty comparison revision as no gate rather than an empty request param', () => {
    setBranchLineTotalComparisonBase('wt-1', 'comparison-base-1')
    setBranchLineTotalComparisonBase('wt-1', '')

    expect(getBranchLineTotalComparisonBase('wt-1')).toBeUndefined()
  })

  it('keeps entries independent per worktree', () => {
    setBranchLineTotalComparisonBase('wt-1', 'comparison-base-1')
    setBranchLineTotalComparisonBase('wt-2', 'comparison-base-2')
    setBranchLineTotalComparisonBase('wt-1', null)

    expect(getBranchLineTotalComparisonBase('wt-1')).toBeUndefined()
    expect(getBranchLineTotalComparisonBase('wt-2')).toBe('comparison-base-2')
  })
})
