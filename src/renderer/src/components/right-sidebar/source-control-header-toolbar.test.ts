import { describe, expect, it } from 'vitest'
import {
  getNextSourceControlViewMode,
  shouldShowSourceControlCompareUnavailableCard
} from './source-control-header-toolbar'
import type { GitBranchCompareSummary } from '../../../../shared/types'

const readySummary: GitBranchCompareSummary = {
  baseRef: 'origin/main',
  baseOid: 'base',
  compareRef: 'feature',
  headOid: 'head',
  mergeBase: 'base',
  changedFiles: 2,
  commitsAhead: 1,
  status: 'ready'
}

describe('source-control header toolbar helpers', () => {
  it('toggles list and tree view modes', () => {
    expect(getNextSourceControlViewMode('list')).toBe('tree')
    expect(getNextSourceControlViewMode('tree')).toBe('list')
  })

  it('shows the compare-unavailable card only when compare failed and the body is empty', () => {
    expect(
      shouldShowSourceControlCompareUnavailableCard(
        { ...readySummary, status: 'error', errorMessage: 'nope' },
        false,
        false,
        false
      )
    ).toBe(true)

    expect(
      shouldShowSourceControlCompareUnavailableCard(
        { ...readySummary, status: 'error', errorMessage: 'nope' },
        true,
        false,
        false
      )
    ).toBe(false)

    expect(
      shouldShowSourceControlCompareUnavailableCard(
        { ...readySummary, status: 'error', errorMessage: 'nope' },
        false,
        true,
        false
      )
    ).toBe(false)

    expect(shouldShowSourceControlCompareUnavailableCard(readySummary, false, false, false)).toBe(
      false
    )

    expect(
      shouldShowSourceControlCompareUnavailableCard(
        { ...readySummary, status: 'loading' },
        false,
        false,
        false
      )
    ).toBe(false)
  })
})
