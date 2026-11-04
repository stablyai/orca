import { describe, expect, it } from 'vitest'
import { searchWorktrees } from './worktree-palette-search'
import '../../../shared/palette-match/worktree-palette-query-bounds'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { HostedReviewInfo } from '../../../shared/source-control/hosted-review/hosted-review-contracts'

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
  it('falls back to branch text when a cleared display name left it undefined', () => {
    const cleared = makeWorktree({
      displayName: undefined as unknown as string,
      branch: 'refs/heads/feature/worktree-jump'
    })

    expect(() => searchWorktrees([cleared], 'jump', repoMap)).not.toThrow()
    // Highlight range indexes the branch-derived label the palette actually renders.
    expect(searchWorktrees([cleared], 'jump', repoMap)[0]).toMatchObject({
      worktreeId: 'wt-1',
      matchedFields: ['displayName'],
      displayNameRanges: [
        { start: 'feature/worktree-'.length, end: 'feature/worktree-jump'.length }
      ]
    })
  })

  it('returns a truncated comment snippet with the highlighted match range', () => {
    const results = searchWorktrees(
      [
        makeWorktree({
          comment:
            'This worktree carries the quick jump refresh implementation details for the new palette.'
        })
      ],
      'implementation',
      repoMap
    )

    expect(results).toHaveLength(1)
    expect(results[0].supportingText?.labelKind).toBe('comment')
    expect(results[0].supportingText?.accessibilityLabel).toBe('Workspace comment')
    expect(results[0].supportingText?.text).toContain('implementation')
    const [range] = results[0].supportingText?.matchRanges ?? []
    expect(results[0].supportingText?.text.slice(range.start, range.end)).toBe('implementation')
  })

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

  it('supports "repo/worktree" composite queries and highlights both segments', () => {
    const worktrees = [
      makeWorktree({ id: 'wt-main', branch: 'refs/heads/main', displayName: 'main' }),
      makeWorktree({
        id: 'wt-feature',
        branch: 'refs/heads/feature/foo',
        displayName: 'feature foo'
      })
    ]

    const results = searchWorktrees(worktrees, 'orca/main', repoMap)

    expect(results).toHaveLength(1)
    expect(results[0].worktreeId).toBe('wt-main')
    expect(results[0].matchedFields).toEqual(['repo', 'branch'])
    expect(results[0].repoRanges).toEqual([{ start: 9, end: 13 }])
    expect(results[0].branchRanges).toEqual([{ start: 0, end: 4 }])
  })

  it('requires every token of a multi-token query to land somewhere', () => {
    const worktree = makeWorktree({ comment: 'waiting on infra' })

    expect(searchWorktrees([worktree], 'jump palette', repoMap)).toHaveLength(1)
    expect(searchWorktrees([worktree], 'jump nowhere', repoMap)).toEqual([])
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
})
