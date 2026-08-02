import { describe, expect, it } from 'vitest'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review'
import {
  filterWorkspaceCleanupCandidates,
  getWorkspaceCleanupGitLabel,
  getWorkspaceCleanupReviewInfo,
  getWorkspaceCleanupSearchText,
  hasWorkspaceCleanupLocalContext,
  sortWorkspaceCleanupCandidates,
  type WorkspaceCleanupReviewInfo
} from './workspace-cleanup-presentation'
import {
  DEFAULT_FILTERS,
  NOW,
  makeCandidate,
  makeReview,
  makeState
} from './workspace-cleanup-presentation-fixtures'

describe('workspace cleanup presentation', () => {
  it('finds hosted review details from renderer state', () => {
    const cacheKey = getHostedReviewCacheKey('/repo', 'alpha', {}, 'repo-1', undefined)
    const state = makeState({
      hostedReviewCache: {
        [cacheKey]: { data: makeReview(), fetchedAt: NOW }
      }
    })

    expect(getWorkspaceCleanupReviewInfo(makeCandidate(), state)).toMatchObject({
      hasReview: true,
      label: 'PR #42',
      state: 'open',
      title: 'Review alpha cleanup'
    })
  })

  it('filters by time, review, git, and context', () => {
    const openReview: WorkspaceCleanupReviewInfo = {
      hasReview: true,
      label: 'PR #7',
      state: 'open',
      provider: 'github',
      title: 'Review row'
    }
    const rows = [
      makeCandidate({ worktreeId: 'repo-1::/repo/clean', displayName: 'clean' }),
      makeCandidate({
        worktreeId: 'repo-1::/repo/dirty-review',
        displayName: 'dirty-review',
        git: { clean: false, upstreamAhead: 0, upstreamBehind: 0, checkedAt: NOW },
        lastActivityAt: NOW - 100 * 24 * 60 * 60 * 1000,
        localContext: {
          terminalTabCount: 1,
          cleanEditorTabCount: 0,
          browserTabCount: 0,
          diffCommentCount: 0,
          newestDiffCommentAt: null,
          retainedDoneAgentCount: 0
        }
      }),
      makeCandidate({
        worktreeId: 'repo-1::/repo/unknown',
        displayName: 'unknown',
        git: { clean: null, upstreamAhead: null, upstreamBehind: null, checkedAt: null },
        blockers: ['git-status-error']
      })
    ]
    const reviewInfo = new Map<string, WorkspaceCleanupReviewInfo>([
      ['repo-1::/repo/dirty-review', openReview]
    ])

    expect(
      filterWorkspaceCleanupCandidates(
        rows,
        {
          ...DEFAULT_FILTERS,
          time: '90d',
          review: 'open-review',
          git: 'dirty',
          context: 'has-context'
        },
        reviewInfo,
        NOW
      ).map((row) => row.displayName)
    ).toEqual(['dirty-review'])

    expect(
      filterWorkspaceCleanupCandidates(
        rows,
        { ...DEFAULT_FILTERS, git: 'unknown' },
        reviewInfo,
        NOW
      ).map((row) => row.displayName)
    ).toEqual(['unknown'])
  })

  it('treats unknown-base clean rows as unknown git risk', () => {
    const candidate = makeCandidate({
      git: { clean: true, upstreamAhead: null, upstreamBehind: null, checkedAt: NOW },
      blockers: ['unknown-base']
    })

    expect(getWorkspaceCleanupGitLabel(candidate)).toBe('Unknown')
    expect(
      filterWorkspaceCleanupCandidates(
        [candidate],
        { ...DEFAULT_FILTERS, git: 'clean' },
        new Map(),
        NOW
      )
    ).toEqual([])
    expect(
      filterWorkspaceCleanupCandidates(
        [candidate],
        { ...DEFAULT_FILTERS, git: 'unknown' },
        new Map(),
        NOW
      )
    ).toEqual([candidate])
  })

  it('search includes repo, branch, path, review, git, and context labels', () => {
    const candidate = makeCandidate({
      repoName: 'Search Repo',
      branch: 'feature/search',
      path: '/repo/search-target',
      git: { clean: null, upstreamAhead: null, upstreamBehind: null, checkedAt: null },
      localContext: {
        terminalTabCount: 0,
        cleanEditorTabCount: 0,
        browserTabCount: 1,
        diffCommentCount: 0,
        newestDiffCommentAt: null,
        retainedDoneAgentCount: 0
      }
    })
    const reviewInfo: WorkspaceCleanupReviewInfo = {
      hasReview: true,
      label: 'MR #9',
      state: 'closed',
      provider: 'gitlab',
      title: 'Searchable review'
    }
    const text = getWorkspaceCleanupSearchText(candidate, reviewInfo)

    expect(text).toContain('search repo')
    expect(text).toContain('feature/search')
    expect(text).toContain('/repo/search-target')
    expect(text).toContain('mr #9')
    expect(text).toContain('unknown')
    expect(text).toContain('has context')
  })

  it('sorts by activity, name, repo, review, and git', () => {
    const rows = [
      makeCandidate({
        worktreeId: 'repo-1::/repo/bravo',
        displayName: 'bravo',
        repoName: 'Repo B',
        lastActivityAt: NOW - 5,
        git: { clean: false, upstreamAhead: 0, upstreamBehind: 0, checkedAt: NOW }
      }),
      makeCandidate({
        worktreeId: 'repo-1::/repo/alpha',
        displayName: 'alpha',
        repoName: 'Repo A',
        lastActivityAt: NOW - 10,
        git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: NOW }
      }),
      makeCandidate({
        worktreeId: 'repo-1::/repo/charlie',
        displayName: 'charlie',
        repoName: 'Repo C',
        lastActivityAt: NOW - 1,
        git: { clean: true, upstreamAhead: 2, upstreamBehind: 0, checkedAt: NOW },
        blockers: ['unpushed-commits']
      })
    ]
    const reviewInfo = new Map<string, WorkspaceCleanupReviewInfo>([
      [
        'repo-1::/repo/charlie',
        {
          hasReview: true,
          label: 'PR #3',
          state: 'open',
          provider: 'github',
          title: null
        }
      ]
    ])

    expect(
      sortWorkspaceCleanupCandidates(rows, 'activity', 'asc').map((row) => row.displayName)
    ).toEqual(['alpha', 'bravo', 'charlie'])
    expect(
      sortWorkspaceCleanupCandidates(rows, 'name', 'asc').map((row) => row.displayName)
    ).toEqual(['alpha', 'bravo', 'charlie'])
    expect(
      sortWorkspaceCleanupCandidates(rows, 'repo', 'asc').map((row) => row.displayName)
    ).toEqual(['alpha', 'bravo', 'charlie'])
    expect(
      sortWorkspaceCleanupCandidates(rows, 'review', 'desc', reviewInfo).map(
        (row) => row.displayName
      )
    ).toEqual(['charlie', 'alpha', 'bravo'])
    expect(
      sortWorkspaceCleanupCandidates(rows, 'git', 'desc').map((row) => row.displayName)
    ).toEqual(['charlie', 'bravo', 'alpha'])
  })

  it('detects local context', () => {
    expect(hasWorkspaceCleanupLocalContext(makeCandidate())).toBe(false)
    expect(
      hasWorkspaceCleanupLocalContext(
        makeCandidate({
          localContext: {
            terminalTabCount: 0,
            cleanEditorTabCount: 1,
            browserTabCount: 0,
            diffCommentCount: 0,
            newestDiffCommentAt: null,
            retainedDoneAgentCount: 0
          }
        })
      )
    ).toBe(true)
  })
})
