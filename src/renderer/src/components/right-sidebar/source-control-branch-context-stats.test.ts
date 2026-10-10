import { describe, expect, it } from 'vitest'
import {
  buildSourceControlCompareBaseStats,
  formatSourceControlRefLabel,
  resolveSourceControlDisplayedBaseRef,
  shouldShowSourceControlBranchContextChrome,
  shouldShowSourceControlBranchContextRow
} from './source-control/panel/branch-context-stats'
import type { GitBranchCompareSummary } from '../../../../shared/git-diff-compare-types'

const readySummary: GitBranchCompareSummary = {
  baseRef: 'origin/main',
  baseOid: 'base',
  compareRef: 'feature',
  headOid: 'head',
  mergeBase: 'base',
  changedFiles: 2,
  commitsAhead: 3,
  status: 'ready'
}

describe('source-control branch context stats', () => {
  it('prefers the compare summary base ref, then the configured compare base ref', () => {
    expect(resolveSourceControlDisplayedBaseRef(readySummary, 'origin/master')).toBe('origin/main')
    expect(resolveSourceControlDisplayedBaseRef(null, 'refs/remotes/origin/main')).toBe(
      'refs/remotes/origin/main'
    )
    expect(resolveSourceControlDisplayedBaseRef(null, null)).toBeNull()
  })

  it('formats refs for scannable labels without dropping remote qualification', () => {
    expect(formatSourceControlRefLabel('refs/remotes/origin/main')).toBe('origin/main')
    expect(formatSourceControlRefLabel('refs/heads/feature/foo')).toBe('feature/foo')
    expect(formatSourceControlRefLabel('origin/main')).toBe('origin/main')
    expect(formatSourceControlRefLabel('refs/tags/v1.2.3')).toBe('v1.2.3')
  })

  it('shows the row only when a displayable base ref exists', () => {
    expect(shouldShowSourceControlBranchContextRow(null, null)).toBe(false)
    expect(shouldShowSourceControlBranchContextRow(null, 'origin/main')).toBe(true)
    expect(
      shouldShowSourceControlBranchContextRow({ ...readySummary, status: 'loading' }, null)
    ).toBe(true)
    expect(shouldShowSourceControlBranchContextRow(readySummary, null)).toBe(true)
    // Summary without a usable base must not claim the row is visible.
    expect(shouldShowSourceControlBranchContextRow({ ...readySummary, baseRef: '   ' }, null)).toBe(
      false
    )
    expect(shouldShowSourceControlBranchContextRow({ ...readySummary, baseRef: '' }, null)).toBe(
      false
    )
  })

  it('shows toolbar chrome when head identity exists even without a base', () => {
    expect(shouldShowSourceControlBranchContextChrome(null, null, null)).toBe(false)
    expect(
      shouldShowSourceControlBranchContextChrome(null, null, {
        kind: 'branch',
        branchName: 'local-only'
      })
    ).toBe(true)
    expect(shouldShowSourceControlBranchContextChrome(readySummary, null, null)).toBe(true)
  })

  it('counts commits ahead of the compare base', () => {
    const stats = buildSourceControlCompareBaseStats(readySummary, 'refs/remotes/origin/main')
    expect(stats.map((stat) => stat.label)).toEqual(['\u21913'])
    expect(stats[0]?.title).toBe('3 commits ahead of origin/main')
  })

  it('names the base ref, never the tracked branch', () => {
    // The rebase case: upstream still points at the pre-rebase branch. This count
    // is against the compare base and says so, so the two cannot be conflated.
    const stats = buildSourceControlCompareBaseStats(
      { ...readySummary, commitsAhead: 36 },
      'origin/main'
    )
    expect(stats[0]?.label).toBe('\u219136')
    expect(stats[0]?.title).toBe('36 commits ahead of origin/main')
  })

  it('singularizes a single commit', () => {
    const stats = buildSourceControlCompareBaseStats(
      { ...readySummary, commitsAhead: 1, commitsBehind: 1 },
      'origin/main'
    )
    expect(stats.map((stat) => stat.title)).toEqual([
      '1 commit ahead of origin/main',
      '1 commit behind origin/main'
    ])
  })

  // The case the row exists for: a rebased branch is ahead of its base and behind it.
  it('counts both directions against the compare base', () => {
    const stats = buildSourceControlCompareBaseStats(
      { ...readySummary, commitsAhead: 33, commitsBehind: 12 },
      'refs/remotes/origin/main'
    )
    expect(stats.map((stat) => stat.label)).toEqual(['\u219133', '\u219312'])
    expect(stats[1]?.title).toBe('12 commits behind origin/main')
  })

  it('drops each direction independently when it is zero or unreported', () => {
    expect(
      buildSourceControlCompareBaseStats(
        { ...readySummary, commitsAhead: 0, commitsBehind: 4 },
        'origin/main'
      ).map((stat) => stat.label)
    ).toEqual(['\u21934'])
    // An older remote host omits commitsBehind entirely; ahead must still render.
    expect(
      buildSourceControlCompareBaseStats(
        { ...readySummary, commitsBehind: undefined },
        'origin/main'
      ).map((stat) => stat.label)
    ).toEqual(['\u21913'])
  })

  it('shows nothing without a ready summary or a positive count', () => {
    expect(buildSourceControlCompareBaseStats(null, 'origin/main')).toEqual([])
    expect(buildSourceControlCompareBaseStats(undefined, 'origin/main')).toEqual([])
    expect(
      buildSourceControlCompareBaseStats({ ...readySummary, status: 'loading' }, 'origin/main')
    ).toEqual([])
    expect(
      buildSourceControlCompareBaseStats(
        { ...readySummary, commitsAhead: 0, commitsBehind: 0 },
        'origin/main'
      )
    ).toEqual([])
    expect(
      buildSourceControlCompareBaseStats(
        { ...readySummary, commitsAhead: undefined, commitsBehind: undefined },
        'origin/main'
      )
    ).toEqual([])
  })
})
