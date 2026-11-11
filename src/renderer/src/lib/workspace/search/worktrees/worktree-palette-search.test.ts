import { describe, expect, it } from 'vitest'
import { searchWorktrees } from './worktree-palette-search'
import '../../../../../../shared/palette-match/worktree-palette-query-bounds'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/tmp/wt-1',
    head: 'abc123',
    branch: 'refs/heads/feature/worktree-jump',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Jump Palette',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

const repoMap = new Map<string, Repo>([
  [
    'repo-1',
    {
      id: 'repo-1',
      path: '/repo/orca',
      displayName: 'stablyai/orca',
      badgeColor: '#22c55e',
      addedAt: 0
    }
  ]
])

function gitLabReview(overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'gitlab',
    number: 17,
    title: 'Reuse checks tab review metadata',
    state: 'open',
    url: 'https://gitlab.com/acme/orca/-/merge_requests/17',
    status: 'success',
    updatedAt: '2026-07-12T00:00:00Z',
    mergeable: 'MERGEABLE',
    ...overrides
  }
}

describe('worktree-palette-search', () => {
  it('does not search stale GitHub cache metadata when Checks selected another review', () => {
    const staleWorktree = makeWorktree({
      branch: 'refs/heads/feature/palette-refresh',
      linkedPR: 99
    })
    const checksReviewByWorktree = new Map([
      [staleWorktree, gitLabReview({ title: 'Current merge request' })]
    ])
    const prCache = {
      '/repo/orca::feature/palette-refresh': { data: { number: 99, title: 'Stale GitHub title' } }
    }

    expect(
      searchWorktrees([staleWorktree], 'stale github title', repoMap, {
        prCache,
        checksReviewByWorktree
      })
    ).toEqual([])
    expect(searchWorktrees([staleWorktree], '#99', repoMap, { checksReviewByWorktree })).toEqual([])
  })

  it('does not search stale GitHub metadata while a linked non-GitHub review is loading', () => {
    const prCache = {
      '/repo/orca::feature/palette-refresh': { data: { number: 99, title: 'Stale GitHub title' } }
    }
    const staleWorktree = makeWorktree({
      branch: 'refs/heads/feature/palette-refresh',
      linkedPR: 99,
      linkedGitLabMR: 17
    })
    const checksReviewByWorktree = new Map<Worktree, HostedReviewInfo | null>([
      [staleWorktree, null]
    ])

    expect(
      searchWorktrees([staleWorktree], 'stale github title', repoMap, {
        prCache,
        checksReviewByWorktree
      })
    ).toEqual([])
    expect(
      searchWorktrees([staleWorktree], '#99', repoMap, { prCache, checksReviewByWorktree })
    ).toEqual([])
  })

  it('matches a pasted GitHub issue URL to the linked worktree instead of the URL text', () => {
    const results = searchWorktrees(
      [
        makeWorktree({ id: 'wt-issue', linkedIssue: 14198 }),
        makeWorktree({ id: 'wt-other', linkedIssue: 7, displayName: 'github.com' })
      ],
      'https://github.com/stablyai/orca/issues/14198',
      repoMap
    )

    expect(results).toEqual([
      expect.objectContaining({
        worktreeId: 'wt-issue',
        matchedFields: ['issue'],
        qualityClass: 'exact-intent',
        supportingText: {
          labelKind: 'issue',
          text: 'Issue #14198',
          matchRanges: [{ start: 0, end: 'Issue #14198'.length }],
          accessibilityLabel: 'Linked issue'
        }
      })
    ])
  })

  it("finds each linked issue by its saved title before the issue's card has rendered", () => {
    const issue = (number: number, title: string, url?: string) => ({
      provider: 'github' as const,
      type: 'issue' as const,
      number,
      title,
      ...(url ? { url } : {})
    })
    const worktrees = [
      makeWorktree({
        id: 'wt-cli',
        linkedIssue: 11704,
        linkedItems: [issue(11704, 'verificacion de permisos')]
      }),
      makeWorktree({
        id: 'wt-two-repos',
        linkedIssue: 42,
        linkedItems: [
          issue(42, 'alpha release', 'https://github.com/stablyai/orca/issues/42'),
          issue(42, 'zebra crossing', 'https://github.com/other/repo/issues/42')
        ]
      })
    ]
    const search = (query: string) =>
      searchWorktrees(worktrees, query, repoMap).map((result) => result.worktreeId)

    expect(search('verificacion')).toEqual(['wt-cli'])
    expect(search('zebra')).toEqual(['wt-two-repos'])
  })
})
