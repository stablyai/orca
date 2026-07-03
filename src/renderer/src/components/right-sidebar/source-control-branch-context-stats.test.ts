import { describe, expect, it } from 'vitest'
import {
  buildSourceControlBranchContextStats,
  resolveSourceControlDisplayedBaseRef,
  shouldShowSourceControlBranchContextRow
} from './source-control-branch-context-stats'
import type { GitBranchCompareSummary } from '../../../../shared/types'

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

  it('shows the row when compare summary or configured base ref exists', () => {
    expect(shouldShowSourceControlBranchContextRow(null, null)).toBe(false)
    expect(shouldShowSourceControlBranchContextRow(null, 'origin/main')).toBe(true)
    expect(
      shouldShowSourceControlBranchContextRow({ ...readySummary, status: 'loading' }, null)
    ).toBe(true)
    expect(shouldShowSourceControlBranchContextRow(readySummary, null)).toBe(true)
  })

  it('renders upstream ahead and behind counts', () => {
    const stats = buildSourceControlBranchContextStats({
      summary: { ...readySummary, commitsAhead: 0 },
      baseRef: 'origin/main',
      upstreamStatus: { hasUpstream: true, ahead: 2, behind: 1 }
    })
    expect(stats.map((stat) => stat.label)).toEqual(['↑2', '↓1'])
    expect(stats[0]?.title).toBe('2 commits ahead of origin/main')
    expect(stats[1]?.title).toBe('1 commit behind origin/main')
  })

  it('shows branch-compare ahead when it differs from upstream ahead', () => {
    const stats = buildSourceControlBranchContextStats({
      summary: readySummary,
      baseRef: 'origin/main',
      upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 }
    })
    expect(stats.map((stat) => stat.label)).toEqual(['↑1', '↑3'])
    expect(stats[0]?.title).toBe('1 commit ahead of origin/main')
    expect(stats[1]?.title).toBe('3 commits ahead of origin/main')
  })

  it('dedupes branch-compare ahead when it matches upstream ahead', () => {
    const stats = buildSourceControlBranchContextStats({
      summary: { ...readySummary, commitsAhead: 2 },
      baseRef: 'origin/main',
      upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 }
    })
    expect(stats.map((stat) => stat.label)).toEqual(['↑2'])
    expect(stats[0]?.title).toBe('2 commits ahead of origin/main')
  })

  it('falls back to branch-compare ahead without upstream', () => {
    const stats = buildSourceControlBranchContextStats({
      summary: readySummary,
      baseRef: 'origin/main'
    })
    expect(stats.map((stat) => stat.label)).toEqual(['↑3'])
    expect(stats[0]?.title).toBe('3 commits ahead of origin/main')
  })

  it('returns no stats when branch is even with base', () => {
    expect(
      buildSourceControlBranchContextStats({
        summary: { ...readySummary, commitsAhead: 0 },
        baseRef: 'origin/main',
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
      })
    ).toEqual([])
  })
})
