import { describe, expect, it, vi } from 'vitest'
import {
  BRANCH_REFRESH_INTERVAL_MS,
  CompareSummary,
  CompareSummaryToolbarButton,
  refreshSourceControlAfterRemoteAction,
  resolveSourceControlBaseRef,
  resolveSourceControlCompareBaseRef,
  resolveSourceControlPickerBaseRef,
  shouldClearBranchCompareForMissingBase,
  shouldRefreshBranchCompareForRemoteStatus,
  shouldRefreshBranchCompareForStatusHead,
  shouldShowCompareSummary
} from './SourceControl'
import type { GitBranchCompareSummary, GitUpstreamStatus } from '../../../../shared/types'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function collectText(node: unknown): string {
  if (node == null) {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join('')
  }
  const element = node as ReactElementLike
  return collectText(element.props?.children)
}

function findCompareSummaryToolbarButton(node: unknown, label: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === CompareSummaryToolbarButton && entry.props.label === label) {
      found = entry
    }
  })
  if (!found) {
    throw new Error(`toolbar button not found: ${label}`)
  }
  return found
}

function collectCompareSummaryToolbarLabels(node: unknown): string[] {
  const labels: string[] = []
  visit(node, (entry) => {
    if (entry.type === CompareSummaryToolbarButton && typeof entry.props.label === 'string') {
      labels.push(entry.props.label)
    }
  })
  return labels
}

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

describe('SourceControl compare summary', () => {
  it('prefers the worktree creation base for branch compare', () => {
    expect(
      resolveSourceControlBaseRef({
        worktreeBaseRef: 'refs/remotes/origin/main',
        reviewBaseRefName: 'main',
        repoBaseRef: 'main',
        defaultBaseRef: 'origin/main'
      })
    ).toBe('refs/remotes/origin/main')
  })

  it('repairs stale PR head SHA compare bases from linked review metadata', () => {
    expect(
      resolveSourceControlBaseRef({
        worktreeBaseRef: '06103ea1889e259fd771b93d206e14c9a4c66391',
        reviewBaseRefName: 'main',
        repoBaseRef: null,
        defaultBaseRef: 'origin/main'
      })
    ).toBe('origin/main')
  })

  it('keeps non-SHA worktree base refs ahead of review metadata', () => {
    expect(
      resolveSourceControlBaseRef({
        worktreeBaseRef: 'refs/remotes/upstream/release',
        reviewBaseRefName: 'main',
        repoBaseRef: null,
        defaultBaseRef: 'origin/main'
      })
    ).toBe('refs/remotes/upstream/release')
  })

  it('rewrites stale SHA compare bases using the configured remote style', () => {
    expect(
      resolveSourceControlBaseRef({
        worktreeBaseRef: '06103ea1889e259fd771b93d206e14c9a4c66391',
        reviewBaseRefName: 'release/next',
        repoBaseRef: null,
        defaultBaseRef: 'refs/remotes/upstream/main'
      })
    ).toBe('refs/remotes/upstream/release/next')

    expect(
      resolveSourceControlBaseRef({
        worktreeBaseRef: '06103ea1889e259fd771b93d206e14c9a4c66391',
        reviewBaseRefName: 'release',
        repoBaseRef: null,
        defaultBaseRef: 'upstream/main'
      })
    ).toBe('upstream/release')
  })

  it('does not treat nested branch suffix matches as the review target', () => {
    expect(
      resolveSourceControlBaseRef({
        worktreeBaseRef: '06103ea1889e259fd771b93d206e14c9a4c66391',
        reviewBaseRefName: 'main',
        repoBaseRef: null,
        defaultBaseRef: 'origin/release/main'
      })
    ).toBe('origin/main')

    expect(
      resolveSourceControlBaseRef({
        worktreeBaseRef: '06103ea1889e259fd771b93d206e14c9a4c66391',
        reviewBaseRefName: 'main',
        repoBaseRef: null,
        defaultBaseRef: 'refs/remotes/upstream/release/main'
      })
    ).toBe('refs/remotes/upstream/main')
  })

  it('keeps exact slash-containing target branch matches', () => {
    expect(
      resolveSourceControlBaseRef({
        worktreeBaseRef: '06103ea1889e259fd771b93d206e14c9a4c66391',
        reviewBaseRefName: 'release/main',
        repoBaseRef: null,
        defaultBaseRef: 'origin/release/main'
      })
    ).toBe('origin/release/main')
  })

  it('waits for a remote candidate before repairing stale SHA compare bases', () => {
    expect(
      resolveSourceControlBaseRef({
        worktreeBaseRef: '06103ea1889e259fd771b93d206e14c9a4c66391',
        reviewBaseRefName: 'release',
        repoBaseRef: null,
        defaultBaseRef: null
      })
    ).toBeNull()
  })

  it('shows the repaired pinned base ref in the base picker', () => {
    expect(
      resolveSourceControlPickerBaseRef({
        pinnedBaseRef: '06103ea1889e259fd771b93d206e14c9a4c66391',
        effectiveBaseRef: 'origin/main'
      })
    ).toBe('origin/main')

    expect(
      resolveSourceControlPickerBaseRef({
        pinnedBaseRef: null,
        effectiveBaseRef: 'origin/main'
      })
    ).toBeUndefined()
  })

  it('falls back to repo and default base refs when worktree metadata is absent', () => {
    expect(
      resolveSourceControlBaseRef({
        worktreeBaseRef: '  ',
        repoBaseRef: ' origin/release ',
        defaultBaseRef: 'origin/main'
      })
    ).toBe('origin/release')

    expect(
      resolveSourceControlBaseRef({
        repoBaseRef: null,
        defaultBaseRef: 'origin/main'
      })
    ).toBe('origin/main')
  })

  it('keeps the compare base equal to the merge target when the setting is off', () => {
    expect(
      resolveSourceControlCompareBaseRef({
        enabled: false,
        worktreeBaseRef: null,
        repoBaseRef: null,
        upstreamName: 'origin/feature',
        fallbackBaseRef: 'origin/master'
      })
    ).toBe('origin/master')

    expect(
      resolveSourceControlCompareBaseRef({
        enabled: false,
        upstreamName: 'origin/feature',
        fallbackBaseRef: null
      })
    ).toBeNull()
  })

  it('prefers a pinned base over the upstream when the setting is on', () => {
    expect(
      resolveSourceControlCompareBaseRef({
        enabled: true,
        worktreeBaseRef: 'refs/remotes/origin/release',
        repoBaseRef: 'origin/main',
        upstreamName: 'origin/feature',
        fallbackBaseRef: 'origin/master'
      })
    ).toBe('refs/remotes/origin/release')

    expect(
      resolveSourceControlCompareBaseRef({
        enabled: true,
        worktreeBaseRef: null,
        repoBaseRef: ' origin/main ',
        upstreamName: 'origin/feature',
        fallbackBaseRef: 'origin/master'
      })
    ).toBe('origin/main')
  })

  it('uses the current branch upstream when on and no base is pinned', () => {
    expect(
      resolveSourceControlCompareBaseRef({
        enabled: true,
        worktreeBaseRef: null,
        repoBaseRef: null,
        upstreamName: 'origin/feature',
        fallbackBaseRef: 'origin/master'
      })
    ).toBe('origin/feature')
  })

  it('falls back to the merge target when on and the branch has no upstream', () => {
    expect(
      resolveSourceControlCompareBaseRef({
        enabled: true,
        worktreeBaseRef: null,
        repoBaseRef: null,
        upstreamName: null,
        fallbackBaseRef: 'origin/master'
      })
    ).toBe('origin/master')
  })

  it('returns null only when no upstream or fallback base exists', () => {
    expect(
      resolveSourceControlCompareBaseRef({
        enabled: true,
        worktreeBaseRef: null,
        repoBaseRef: null,
        upstreamName: null,
        fallbackBaseRef: null
      })
    ).toBeNull()
  })

  it('keeps the branch compare while upstream status is still loading', () => {
    // remoteStatus undefined means upstream status has not loaded yet; the
    // upstream policy can still make compareBaseRef momentarily null when no
    // fallback base is available.
    expect(
      shouldClearBranchCompareForMissingBase({
        isFolder: false,
        compareBaseRef: null,
        remoteStatus: undefined
      })
    ).toBe(false)
  })

  it('clears the branch compare once upstream loads with no upstream and no base', () => {
    const loadedNoUpstream: GitUpstreamStatus = {
      hasUpstream: false,
      ahead: 0,
      behind: 0
    }
    expect(
      shouldClearBranchCompareForMissingBase({
        isFolder: false,
        compareBaseRef: null,
        remoteStatus: loadedNoUpstream
      })
    ).toBe(true)
  })

  it('keeps the branch compare when a compare base is resolved', () => {
    expect(
      shouldClearBranchCompareForMissingBase({
        isFolder: false,
        compareBaseRef: 'origin/main',
        remoteStatus: undefined
      })
    ).toBe(false)
  })

  it('never clears the branch compare in folder mode', () => {
    const loadedNoUpstream: GitUpstreamStatus = {
      hasUpstream: false,
      ahead: 0,
      behind: 0
    }
    expect(
      shouldClearBranchCompareForMissingBase({
        isFolder: true,
        compareBaseRef: null,
        remoteStatus: loadedNoUpstream
      })
    ).toBe(false)
  })

  it('wires toolbar actions without rendering the dead view-mode toggle', () => {
    const onChangeBaseRef = vi.fn()
    const onRetry = vi.fn()
    const node = CompareSummary({
      summary: readySummary,
      onChangeBaseRef,
      onRetry
    })

    expect(collectCompareSummaryToolbarLabels(node)).toEqual([
      'Change base ref',
      'Refresh branch compare'
    ])

    const changeBaseRef = findCompareSummaryToolbarButton(node, 'Change base ref').props.onClick
    if (typeof changeBaseRef === 'function') {
      changeBaseRef()
    }
    expect(onChangeBaseRef).toHaveBeenCalledTimes(1)

    const refresh = findCompareSummaryToolbarButton(node, 'Refresh branch compare').props.onClick
    if (typeof refresh === 'function') {
      refresh()
    }
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('omits the whole compare row when the branch has no commits ahead', () => {
    const cleanSummary = { ...readySummary, commitsAhead: 0 }
    const node = CompareSummary({
      summary: cleanSummary,
      onChangeBaseRef: vi.fn(),
      onRetry: vi.fn()
    })

    expect(shouldShowCompareSummary(cleanSummary)).toBe(false)
    expect(node).toBeNull()
    const text = collectText(node)
    expect(text).not.toContain('0 commits ahead')
    expect(text).not.toContain('origin/main')
  })

  it('keeps non-zero summary copy compact', () => {
    const node = CompareSummary({
      summary: readySummary,
      onChangeBaseRef: vi.fn(),
      onRetry: vi.fn()
    })

    const text = collectText(node)
    expect(text).toContain('1 ahead')
    expect(text).not.toContain('1 commit ahead of origin/main')
  })

  it('omits the view-mode toggle from unavailable compare rows', () => {
    const node = CompareSummary({
      summary: {
        ...readySummary,
        status: 'error',
        errorMessage: 'Unable to compare'
      },
      onChangeBaseRef: vi.fn(),
      onRetry: vi.fn()
    })

    expect(collectCompareSummaryToolbarLabels(node)).toEqual(['Change base ref', 'Retry'])
  })

  it('keeps a 30 second branch compare fallback refresh', () => {
    expect(BRANCH_REFRESH_INTERVAL_MS).toBe(30_000)
  })

  it('refreshes branch compare when git status observes a new head for the same base', () => {
    expect(
      shouldRefreshBranchCompareForStatusHead(
        { baseRef: 'origin/main', statusHead: 'old-head', worktreeId: 'wt-1' },
        { baseRef: 'origin/main', statusHead: 'new-head', worktreeId: 'wt-1' }
      )
    ).toBe(true)
  })

  it('does not refresh branch compare for initial, unknown, or unrelated status heads', () => {
    expect(
      shouldRefreshBranchCompareForStatusHead(null, {
        baseRef: 'origin/main',
        statusHead: 'head',
        worktreeId: 'wt-1'
      })
    ).toBe(false)
    expect(
      shouldRefreshBranchCompareForStatusHead(
        { baseRef: 'origin/main', statusHead: 'old-head', worktreeId: 'wt-1' },
        { baseRef: 'origin/main', statusHead: null, worktreeId: 'wt-1' }
      )
    ).toBe(false)
    expect(
      shouldRefreshBranchCompareForStatusHead(
        { baseRef: 'origin/main', statusHead: 'old-head', worktreeId: 'wt-1' },
        { baseRef: 'origin/main', statusHead: 'new-head', worktreeId: 'wt-2' }
      )
    ).toBe(false)
    expect(
      shouldRefreshBranchCompareForStatusHead(
        { baseRef: 'origin/main', statusHead: 'old-head', worktreeId: 'wt-1' },
        { baseRef: 'origin/release', statusHead: 'new-head', worktreeId: 'wt-1' }
      )
    ).toBe(false)
  })

  it('refreshes branch compare when upstream status changes for the same base', () => {
    expect(
      shouldRefreshBranchCompareForRemoteStatus(
        {
          ahead: 1,
          baseRef: 'origin/main',
          behind: 0,
          hasUpstream: true,
          upstreamName: 'origin/main',
          worktreeId: 'wt-1'
        },
        {
          ahead: 0,
          baseRef: 'origin/main',
          behind: 0,
          hasUpstream: true,
          upstreamName: 'origin/main',
          worktreeId: 'wt-1'
        }
      )
    ).toBe(true)
  })

  it('does not refresh branch compare for initial or unrelated upstream status snapshots', () => {
    const current = {
      ahead: 0,
      baseRef: 'origin/main',
      behind: 0,
      hasUpstream: true,
      upstreamName: 'origin/main',
      worktreeId: 'wt-1'
    }

    expect(shouldRefreshBranchCompareForRemoteStatus(null, current)).toBe(false)
    expect(
      shouldRefreshBranchCompareForRemoteStatus(current, {
        ...current,
        baseRef: 'origin/release',
        ahead: 1
      })
    ).toBe(false)
    expect(
      shouldRefreshBranchCompareForRemoteStatus(current, {
        ...current,
        worktreeId: 'wt-2',
        ahead: 1
      })
    ).toBe(false)
  })

  it('keeps immediate refresh paths for remote actions', () => {
    const refreshGitStatus = vi.fn(async () => {})
    const refreshBranchCompare = vi.fn(async () => {})
    const refreshGitHistory = vi.fn(async () => {})

    refreshSourceControlAfterRemoteAction({
      refreshGitStatus,
      refreshBranchCompare,
      refreshGitHistory
    })

    expect(refreshGitStatus).toHaveBeenCalledTimes(1)
    expect(refreshBranchCompare).toHaveBeenCalledTimes(1)
    expect(refreshGitHistory).toHaveBeenCalledTimes(1)
    // Direct commit, manual, retry, and base-ref refresh paths remain component-level
    // behavior covered by the existing UI wiring; keep this test on the pure helper.
  })
})
