import { describe, expect, it } from 'vitest'
import {
  buildSourceControlBranchContextStats,
  formatSourceControlRefLabel,
  resolveSourceControlDisplayedBaseRef,
  shouldShowSourceControlBranchContextChrome,
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

  it('renders upstream ahead and behind counts against the tracking branch', () => {
    const stats = buildSourceControlBranchContextStats({
      summary: { ...readySummary, commitsAhead: 0 },
      baseRef: 'origin/main',
      upstreamStatus: {
        hasUpstream: true,
        upstreamName: 'origin/feature',
        ahead: 2,
        behind: 1
      }
    })
    expect(stats.map((stat) => stat.label)).toEqual(['↑2', '↓1'])
    expect(stats[0]?.title).toBe('2 commits ahead of origin/feature')
    expect(stats[1]?.title).toBe('1 commit behind origin/feature')
  })

  it('shows both upstream and compare ahead when counts match but targets differ', () => {
    const stats = buildSourceControlBranchContextStats({
      summary: readySummary,
      baseRef: 'origin/main',
      upstreamStatus: {
        hasUpstream: true,
        upstreamName: 'origin/feature',
        ahead: 3,
        behind: 0
      }
    })
    expect(stats.map((stat) => ({ key: stat.key, label: stat.label, title: stat.title }))).toEqual([
      {
        key: 'upstream-ahead',
        label: '↑3',
        title: '3 commits ahead of origin/feature'
      },
      {
        key: 'compare-ahead',
        label: '↑3',
        title: '3 commits ahead of origin/main'
      }
    ])
  })

  it('shows branch-compare ahead when it differs from upstream ahead', () => {
    const stats = buildSourceControlBranchContextStats({
      summary: readySummary,
      baseRef: 'origin/main',
      upstreamStatus: {
        hasUpstream: true,
        upstreamName: 'origin/feature',
        ahead: 1,
        behind: 0
      }
    })
    expect(stats.map((stat) => stat.label)).toEqual(['↑1', '↑3'])
    expect(stats[0]?.title).toBe('1 commit ahead of origin/feature')
    expect(stats[1]?.title).toBe('3 commits ahead of origin/main')
  })

  it('dedupes branch-compare ahead only when target and count match upstream', () => {
    const stats = buildSourceControlBranchContextStats({
      summary: { ...readySummary, commitsAhead: 2 },
      baseRef: 'origin/main',
      upstreamStatus: {
        hasUpstream: true,
        upstreamName: 'origin/main',
        ahead: 2,
        behind: 0
      }
    })
    expect(stats.map((stat) => stat.label)).toEqual(['↑2'])
    expect(stats[0]?.key).toBe('upstream-ahead')
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

  it('formats namespaced base refs in stat titles', () => {
    const stats = buildSourceControlBranchContextStats({
      summary: readySummary,
      baseRef: 'refs/remotes/origin/main'
    })
    expect(stats[0]?.title).toBe('3 commits ahead of origin/main')
  })

  it('falls back to a generic upstream label when upstreamName is missing', () => {
    const stats = buildSourceControlBranchContextStats({
      summary: { ...readySummary, commitsAhead: 0 },
      baseRef: 'origin/main',
      upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 }
    })
    expect(stats[0]?.title).toBe('2 commits ahead of upstream')
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
