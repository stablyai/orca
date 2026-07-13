import { describe, expect, it } from 'vitest'
import { getWorktreePaletteSearchScope, searchWorktrees } from './worktree-palette-search'
import {
  WORKTREE_PALETTE_QUERY_MAX_BYTES,
  isWorktreePaletteQueryTooLarge
} from './worktree-palette-query-bounds'
import type { Repo, Worktree } from '../../../shared/types'
import type { HostedReviewInfo } from '../../../shared/hosted-review'

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

describe('worktree-palette-search', () => {
  it('uses the filtered recent list for empty queries', () => {
    const visible = makeWorktree({ id: 'visible' })
    const hidden = makeWorktree({ id: 'hidden-by-filter' })

    const scope = getWorktreePaletteSearchScope({
      hasQuery: false,
      allWorktrees: [visible, hidden],
      emptyQueryWorktrees: [visible]
    })

    expect(scope.map((worktree) => worktree.id)).toEqual(['visible'])
  })

  it('uses all non-archived worktrees for typed queries', () => {
    const visible = makeWorktree({ id: 'visible' })
    const hiddenByFilter = makeWorktree({ id: 'hidden-by-filter' })
    const archived = makeWorktree({ id: 'archived', isArchived: true })

    const scope = getWorktreePaletteSearchScope({
      hasQuery: true,
      allWorktrees: [visible, hiddenByFilter, archived],
      emptyQueryWorktrees: [visible]
    })

    expect(scope.map((worktree) => worktree.id)).toEqual(['visible', 'hidden-by-filter'])
  })

  it('returns every worktree with no match metadata for an empty query', () => {
    const results = searchWorktrees([makeWorktree()], '', repoMap, null, null)

    expect(results).toEqual([
      {
        worktreeId: 'wt-1',
        matchedField: null,
        displayNameRange: null,
        branchRange: null,
        repoRange: null,
        supportingText: null
      }
    ])
  })

  it('rejects oversized pasted queries before reading worktree metadata', () => {
    const oversizedQuery = 'secret-worktree-palette-search'.repeat(WORKTREE_PALETTE_QUERY_MAX_BYTES)
    const worktree = {
      get id(): string {
        throw new Error('oversized worktree palette searches must not read ids')
      },
      get displayName(): string {
        throw new Error('oversized worktree palette searches must not scan names')
      },
      get branch(): string {
        throw new Error('oversized worktree palette searches must not scan branches')
      }
    } as Worktree

    expect(isWorktreePaletteQueryTooLarge(oversizedQuery)).toBe(true)
    expect(searchWorktrees([worktree], oversizedQuery, repoMap, null, null)).toEqual([])
  })

  it('rejects oversized whitespace before trimming worktree palette queries', () => {
    expect(
      searchWorktrees(
        [makeWorktree()],
        ' '.repeat(WORKTREE_PALETTE_QUERY_MAX_BYTES + 1),
        repoMap,
        null,
        null
      )
    ).toEqual([])
  })

  it('enforces the query budget by UTF-8 byte length', () => {
    const query = 'é'.repeat(WORKTREE_PALETTE_QUERY_MAX_BYTES)

    expect(query.length).toBe(WORKTREE_PALETTE_QUERY_MAX_BYTES)
    expect(isWorktreePaletteQueryTooLarge(query)).toBe(true)
    expect(searchWorktrees([makeWorktree()], query, repoMap, null, null)).toEqual([])
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
      repoMap,
      null,
      null
    )

    expect(results).toHaveLength(1)
    expect(results[0].supportingText?.labelKind).toBe('comment')
    expect(results[0].supportingText?.text).toContain('implementation')
    expect(
      results[0].supportingText?.text.slice(
        results[0].supportingText.matchRange!.start,
        results[0].supportingText.matchRange!.end
      )
    ).toBe('implementation')
  })

  it('keeps PR title matches in the search result model instead of inferring them during render', () => {
    const results = searchWorktrees(
      [makeWorktree({ branch: 'refs/heads/feature/palette-refresh', linkedPR: 426 })],
      'quick jump',
      repoMap,
      {
        '/repo/orca::feature/palette-refresh': {
          data: {
            number: 426,
            title: 'Refresh the worktree quick jump palette'
          }
        }
      },
      null
    )

    expect(results).toHaveLength(1)
    expect(results[0].supportingText).toEqual({
      labelKind: 'pr',
      text: 'Refresh the worktree quick jump palette',
      matchRange: { start: 21, end: 31 }
    })
  })

  it('matches the GitLab review title and number already selected by Checks', () => {
    const review: HostedReviewInfo = {
      provider: 'gitlab',
      number: 17,
      title: 'Reuse checks tab review metadata',
      state: 'open',
      url: 'https://gitlab.com/acme/orca/-/merge_requests/17',
      status: 'success',
      updatedAt: '2026-07-12T00:00:00Z',
      mergeable: 'MERGEABLE'
    }
    const worktree = makeWorktree()
    const reviews = new Map([[worktree, review]])

    const titleResults = searchWorktrees(
      [worktree],
      'checks tab',
      repoMap,
      null,
      null,
      undefined,
      reviews
    )
    const numberResults = searchWorktrees(
      [worktree],
      '!17',
      repoMap,
      null,
      null,
      undefined,
      reviews
    )

    expect(titleResults[0].supportingText).toEqual({
      labelKind: 'mr',
      text: review.title,
      matchRange: { start: 6, end: 16 }
    })
    expect(numberResults[0].supportingText).toEqual({
      labelKind: 'mr',
      text: 'MR !17',
      matchRange: { start: 4, end: 6 }
    })
  })

  it('does not search stale GitHub cache metadata when Checks selected another review', () => {
    const review: HostedReviewInfo = {
      provider: 'gitlab',
      number: 17,
      title: 'Current merge request',
      state: 'open',
      url: 'https://gitlab.com/acme/orca/-/merge_requests/17',
      status: 'success',
      updatedAt: '2026-07-12T00:00:00Z',
      mergeable: 'MERGEABLE'
    }
    const staleWorktree = makeWorktree({
      branch: 'refs/heads/feature/palette-refresh',
      linkedPR: 99
    })
    const reviews = new Map([[staleWorktree, review]])

    expect(
      searchWorktrees(
        [staleWorktree],
        'stale github title',
        repoMap,
        {
          '/repo/orca::feature/palette-refresh': {
            data: { number: 99, title: 'Stale GitHub title' }
          }
        },
        null,
        undefined,
        reviews
      )
    ).toEqual([])

    expect(
      searchWorktrees([staleWorktree], '#99', repoMap, null, null, undefined, reviews)
    ).toEqual([])
  })

  it('does not search stale GitHub metadata while a linked non-GitHub review is loading', () => {
    const stalePRCache = {
      '/repo/orca::feature/palette-refresh': {
        data: { number: 99, title: 'Stale GitHub title' }
      }
    }
    const staleWorktree = makeWorktree({
      branch: 'refs/heads/feature/palette-refresh',
      linkedPR: 99,
      linkedGitLabMR: 17
    })
    const authoritativeEmptyReviews = new Map<Worktree, HostedReviewInfo | null>([
      [staleWorktree, null]
    ])

    expect(
      searchWorktrees(
        [staleWorktree],
        'stale github title',
        repoMap,
        stalePRCache,
        null,
        undefined,
        authoritativeEmptyReviews
      )
    ).toEqual([])
    expect(
      searchWorktrees(
        [staleWorktree],
        '#99',
        repoMap,
        stalePRCache,
        null,
        undefined,
        authoritativeEmptyReviews
      )
    ).toEqual([])
  })

  it('keeps review matches isolated between same-id worktrees on different hosts', () => {
    const localWorktree = makeWorktree({ hostId: 'local' })
    const sshWorktree = makeWorktree({ hostId: 'ssh:staging' })
    const review: HostedReviewInfo = {
      provider: 'gitlab',
      number: 17,
      title: 'Remote-only merge request',
      state: 'open',
      url: 'https://gitlab.com/acme/orca/-/merge_requests/17',
      status: 'success',
      updatedAt: '2026-07-12T00:00:00Z',
      mergeable: 'MERGEABLE'
    }

    const results = searchWorktrees(
      [localWorktree, sshWorktree],
      'remote-only',
      repoMap,
      null,
      null,
      undefined,
      new Map([[sshWorktree, review]])
    )

    expect(results).toHaveLength(1)
    expect(results[0].supportingText?.text).toBe(review.title)
  })

  it('scopes PR and MR number sigils to their providers', () => {
    const gitHubReview: HostedReviewInfo = {
      provider: 'github',
      number: 42,
      title: 'GitHub pull request',
      state: 'open',
      url: 'https://github.com/acme/orca/pull/42',
      status: 'success',
      updatedAt: '2026-07-12T00:00:00Z',
      mergeable: 'MERGEABLE'
    }
    const gitLabReview: HostedReviewInfo = {
      provider: 'gitlab',
      number: 17,
      title: 'GitLab merge request',
      state: 'open',
      url: 'https://gitlab.com/acme/orca/-/merge_requests/17',
      status: 'success',
      updatedAt: '2026-07-12T00:00:00Z',
      mergeable: 'MERGEABLE'
    }
    const gitHubWorktree = makeWorktree()
    const gitLabWorktree = makeWorktree()

    expect(
      searchWorktrees(
        [gitHubWorktree],
        '!42',
        repoMap,
        null,
        null,
        undefined,
        new Map([[gitHubWorktree, gitHubReview]])
      )
    ).toEqual([])
    expect(
      searchWorktrees(
        [gitLabWorktree],
        '#17',
        repoMap,
        null,
        null,
        undefined,
        new Map([[gitLabWorktree, gitLabReview]])
      )
    ).toEqual([])
    expect(
      searchWorktrees(
        [makeWorktree({ linkedIssue: 42 })],
        '!42',
        repoMap,
        null,
        null,
        new Map([['wt-1', [{ port: 42 }]]])
      )
    ).toEqual([])
  })

  it('preserves input order when query matches a repo name', () => {
    const worktrees = [
      makeWorktree({
        id: 'wt-feature',
        branch: 'refs/heads/feature/foo',
        displayName: 'foo feature',
        isMainWorktree: false
      }),
      makeWorktree({
        id: 'wt-bugfix',
        branch: 'refs/heads/bugfix/bar',
        displayName: 'bar bugfix',
        isMainWorktree: false
      }),
      makeWorktree({
        id: 'wt-main',
        branch: 'refs/heads/main',
        displayName: 'main',
        isMainWorktree: true
      })
    ]

    const results = searchWorktrees(worktrees, 'orca', repoMap, null, null)

    // All three match on the repo name, order preserved from input
    expect(results).toHaveLength(3)
    expect(results[0].worktreeId).toBe('wt-feature')
    expect(results[1].worktreeId).toBe('wt-bugfix')
    expect(results[2].worktreeId).toBe('wt-main')
  })

  it('supports "repo/worktree" composite queries and highlights both segments', () => {
    const worktrees = [
      makeWorktree({
        id: 'wt-main',
        branch: 'refs/heads/main',
        displayName: 'main'
      }),
      makeWorktree({
        id: 'wt-feature',
        branch: 'refs/heads/feature/foo',
        displayName: 'feature foo'
      })
    ]

    const results = searchWorktrees(worktrees, 'orca/main', repoMap, null, null)

    expect(results).toHaveLength(1)
    expect(results[0].worktreeId).toBe('wt-main')
    expect(results[0].matchedField).toBe('branch')
    expect(results[0].repoRange).toEqual({ start: 9, end: 13 })
    expect(results[0].branchRange).toEqual({ start: 0, end: 4 })
  })

  it('falls back to single-token matching when a composite query has no composite hits', () => {
    const results = searchWorktrees(
      [makeWorktree({ branch: 'refs/heads/feature/palette-refresh' })],
      'feature/palette',
      repoMap,
      null,
      null
    )

    expect(results).toHaveLength(1)
    expect(results[0].matchedField).toBe('branch')
    expect(results[0].branchRange).toEqual({ start: 0, end: 'feature/palette'.length })
  })

  it('matches issue numbers with a leading hash and returns issue render context', () => {
    const results = searchWorktrees(
      [makeWorktree({ linkedIssue: 304 })],
      '#304',
      repoMap,
      null,
      null
    )

    expect(results).toHaveLength(1)
    expect(results[0].supportingText).toEqual({
      labelKind: 'issue',
      text: 'Issue #304',
      matchRange: { start: 7, end: 10 }
    })
  })

  it('matches workspace ports by port number before issue and PR numbers', () => {
    const results = searchWorktrees(
      [makeWorktree({ id: 'wt-port', linkedIssue: 3000 })],
      '3000',
      repoMap,
      null,
      null,
      new Map([
        [
          'wt-port',
          [
            {
              port: 3000,
              processName: 'vite'
            }
          ]
        ]
      ])
    )

    expect(results).toHaveLength(1)
    expect(results[0].matchedField).toBe('port')
    expect(results[0].supportingText).toEqual({
      labelKind: 'port',
      text: '3000 · vite',
      matchRange: { start: 0, end: 4 }
    })
  })
})
