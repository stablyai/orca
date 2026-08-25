import { describe, expect, it } from 'vitest'
import {
  getWorktreePaletteSearchScope,
  makeEmptyPaletteSearchResult,
  searchWorktrees
} from './worktree-palette-search'
import {
  WORKTREE_PALETTE_QUERY_MAX_BYTES,
  isWorktreePaletteQueryTooLarge
} from './worktree-palette-query-bounds'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
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
    expect(searchWorktrees([makeWorktree()], '', repoMap)).toEqual([
      makeEmptyPaletteSearchResult('wt-1')
    ])
    expect(makeEmptyPaletteSearchResult('wt-1')).toEqual({
      worktreeId: 'wt-1',
      matchedFields: [],
      displayNameRanges: [],
      branchRanges: [],
      repoRanges: [],
      hostRanges: [],
      supportingText: null,
      qualityClass: null,
      rank: null
    })
  })

  it('finds an emoji-named workspace by its readable branch shortcode', () => {
    const results = searchWorktrees(
      [makeWorktree({ displayName: '🚀', branch: 'refs/heads/rocket' })],
      'rocket',
      repoMap
    )

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      worktreeId: 'wt-1',
      matchedFields: ['branch'],
      branchRanges: [{ start: 0, end: 6 }]
    })
  })

  it('drops oversized pasted queries instead of matching their text', () => {
    // Documents are built per worktree set, not per keystroke, so the byte guard
    // now lives in query preparation rather than in a pre-scan bail-out.
    const oversizedQuery = 'jump-palette'.repeat(WORKTREE_PALETTE_QUERY_MAX_BYTES)

    expect(isWorktreePaletteQueryTooLarge(oversizedQuery)).toBe(true)
    expect(searchWorktrees([makeWorktree()], oversizedQuery, repoMap)).toEqual([])
  })

  it('rejects oversized whitespace before trimming worktree palette queries', () => {
    const query = ' '.repeat(WORKTREE_PALETTE_QUERY_MAX_BYTES + 1)

    expect(searchWorktrees([makeWorktree()], query, repoMap)).toEqual([])
  })

  it('enforces the query budget by UTF-8 byte length', () => {
    const query = 'é'.repeat(WORKTREE_PALETTE_QUERY_MAX_BYTES)

    expect(query.length).toBe(WORKTREE_PALETTE_QUERY_MAX_BYTES)
    expect(isWorktreePaletteQueryTooLarge(query)).toBe(true)
    expect(searchWorktrees([makeWorktree()], query, repoMap)).toEqual([])
  })

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

  it('falls back to the folder name when both display name and branch are missing', () => {
    const folderWorkspace = makeWorktree({
      displayName: undefined as unknown as string,
      branch: '',
      path: '/tmp/design-review'
    })

    expect(searchWorktrees([folderWorkspace], 'design', repoMap)[0]).toMatchObject({
      matchedFields: ['displayName'],
      displayNameRanges: [{ start: 0, end: 6 }]
    })
  })

  it('survives a cleared display name on composite repo/branch queries', () => {
    const cleared = makeWorktree({
      displayName: undefined as unknown as string,
      branch: undefined as unknown as string
    })

    expect(() => searchWorktrees([cleared], 'orca/jump', repoMap)).not.toThrow()
  })

  it('still lists a branch-less row on the empty query, which renders every row', () => {
    // Why: the empty query short-circuits before any branch read, so the row reaches the
    // render loop untouched — the label resolution there has to be guarded too.
    const cleared = makeWorktree({
      displayName: undefined as unknown as string,
      branch: undefined as unknown as string
    })

    expect(searchWorktrees([cleared], '', repoMap)).toEqual([makeEmptyPaletteSearchResult('wt-1')])
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

  it('keeps PR matches in the search result model instead of inferring them during render', () => {
    const results = searchWorktrees(
      [makeWorktree({ branch: 'refs/heads/feature/palette-refresh', linkedPR: 426 })],
      'quick jump',
      repoMap,
      {
        prCache: {
          '/repo/orca::feature/palette-refresh': {
            data: { number: 426, title: 'Refresh the worktree quick jump palette' }
          }
        }
      }
    )

    expect(results).toHaveLength(1)
    // `jump` also hits the visible display name, so only `quick` is left to explain.
    expect(results[0].displayNameRanges).toEqual([{ start: 0, end: 4 }])
    expect(results[0].supportingText).toEqual({
      labelKind: 'pr',
      text: '#426 · Refresh the worktree quick jump palette',
      matchRanges: [{ start: 28, end: 33 }],
      accessibilityLabel: 'Pull request'
    })
  })

  it('matches the GitLab review title and number already selected by Checks', () => {
    const worktree = makeWorktree()
    const checksReviewByWorktree = new Map([[worktree, gitLabReview()]])

    const titleResults = searchWorktrees([worktree], 'checks tab', repoMap, {
      checksReviewByWorktree
    })
    const numberResults = searchWorktrees([worktree], '!17', repoMap, { checksReviewByWorktree })

    expect(titleResults[0].supportingText).toEqual({
      labelKind: 'mr',
      text: '!17 · Reuse checks tab review metadata',
      matchRanges: [
        { start: 12, end: 18 },
        { start: 19, end: 22 }
      ],
      accessibilityLabel: 'Merge request'
    })
    expect(numberResults[0].supportingText).toEqual({
      labelKind: 'mr',
      text: '!17 · Reuse checks tab review metadata',
      matchRanges: [{ start: 0, end: 3 }],
      accessibilityLabel: 'Merge request'
    })
  })

  it('matches a review number only exactly, not as an incidental substring', () => {
    const worktree = makeWorktree()
    const checksReviewByWorktree = new Map([
      [worktree, gitLabReview({ number: 4123, title: 'Fix reconnect' })]
    ])

    expect(searchWorktrees([worktree], '!4123', repoMap, { checksReviewByWorktree })).toHaveLength(
      1
    )
    expect(searchWorktrees([worktree], '!123', repoMap, { checksReviewByWorktree })).toEqual([])
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

  it('keeps review matches isolated between worktrees on different hosts', () => {
    const localWorktree = makeWorktree({ id: 'repo-1::/local/wt', hostId: 'local' })
    const sshWorktree = makeWorktree({ id: 'repo-1-ssh::/remote/wt', hostId: 'ssh:staging' })
    const review = gitLabReview({ title: 'Remote-only merge request' })

    const results = searchWorktrees([localWorktree, sshWorktree], 'remote-only', repoMap, {
      checksReviewByWorktree: new Map([[sshWorktree, review]])
    })

    expect(results).toHaveLength(1)
    expect(results[0].supportingText?.text).toBe('!17 · Remote-only merge request')
  })

  it('scopes PR and MR number sigils to their providers', () => {
    const gitHubWorktree = makeWorktree()
    const gitHubReview = gitLabReview({
      provider: 'github',
      number: 42,
      title: 'GitHub pull request',
      url: 'https://github.com/acme/orca/pull/42'
    })
    const gitLabWorktree = makeWorktree()

    expect(
      searchWorktrees([gitHubWorktree], '!42', repoMap, {
        checksReviewByWorktree: new Map([[gitHubWorktree, gitHubReview]])
      })
    ).toEqual([])
    expect(
      searchWorktrees([gitLabWorktree], '#17', repoMap, {
        checksReviewByWorktree: new Map([[gitLabWorktree, gitLabReview()]])
      })
    ).toEqual([])
    expect(
      searchWorktrees([makeWorktree({ linkedIssue: 42 })], '!42', repoMap, {
        workspacePortsByWorktreeId: new Map([['wt-1', [{ port: 42 }]]])
      })
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

    // All three match on the repo name, order preserved from input.
    expect(searchWorktrees(worktrees, 'orca', repoMap).map((result) => result.worktreeId)).toEqual([
      'wt-feature',
      'wt-bugfix',
      'wt-main'
    ])
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

  it('falls back to single-token matching when a composite query has no composite hits', () => {
    const results = searchWorktrees(
      [makeWorktree({ branch: 'refs/heads/feature/palette-refresh' })],
      'feature/palette',
      repoMap
    )

    expect(results).toHaveLength(1)
    expect(results[0].matchedFields).toEqual(['branch'])
    expect(results[0].branchRanges).toEqual([{ start: 0, end: 'feature/palette'.length }])
  })

  it('requires every token of a multi-token query to land somewhere', () => {
    const worktree = makeWorktree({ comment: 'waiting on infra' })

    expect(searchWorktrees([worktree], 'jump palette', repoMap)).toHaveLength(1)
    expect(searchWorktrees([worktree], 'jump nowhere', repoMap)).toEqual([])
  })

  it('matches the remote host chip label rendered on the row', () => {
    const worktree = makeWorktree({ hostId: 'ssh:staging' })
    const hostLabelByWorktreeId = new Map([['wt-1', 'staging-box']])

    expect(
      searchWorktrees([worktree], 'staging', repoMap, { hostLabelByWorktreeId })[0]
    ).toMatchObject({ matchedFields: ['host'], hostRanges: [{ start: 0, end: 7 }] })
    // Without a rendered chip there is nothing to explain the hit, so it must not match.
    expect(searchWorktrees([worktree], 'staging', repoMap)).toEqual([])
  })

  it('matches issue numbers with a leading hash and returns issue render context', () => {
    const results = searchWorktrees([makeWorktree({ linkedIssue: 304 })], '#304', repoMap)

    expect(results).toHaveLength(1)
    expect(results[0].supportingText).toEqual({
      labelKind: 'issue',
      text: '#304',
      matchRanges: [{ start: 0, end: 4 }],
      accessibilityLabel: 'Linked issue'
    })
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

  it('matches a pasted GitHub pull URL to the linked worktree', () => {
    const results = searchWorktrees(
      [
        makeWorktree({
          id: 'wt-pr',
          linkedPR: 12789,
          linkedWorkItem: {
            provider: 'github',
            type: 'pr',
            number: 12789,
            title: 'Perf',
            url: 'https://github.com/stablyai/orca/pull/12789'
          }
        }),
        makeWorktree({ id: 'wt-issue', linkedIssue: 12789 })
      ],
      'https://github.com/stablyai/orca/pull/12789',
      repoMap
    )

    expect(results.map((result) => result.worktreeId)).toEqual(['wt-pr'])
  })

  it('matches a pasted Linear issue URL to the linked worktree', () => {
    const results = searchWorktrees(
      [
        makeWorktree({
          id: 'wt-linear',
          linkedLinearIssue: 'STA-4052',
          linkedLinearIssueOrganizationUrlKey: 'stably'
        }),
        makeWorktree({ id: 'wt-name', displayName: 'linear.app' })
      ],
      'https://linear.app/stably/issue/STA-4052/agent-terminals-disappearing-randomly',
      repoMap
    )

    expect(results.map((result) => result.worktreeId)).toEqual(['wt-linear'])
  })

  it('matches workspace ports by port number before issue and PR numbers', () => {
    const results = searchWorktrees(
      [makeWorktree({ id: 'wt-port', linkedIssue: 3000 })],
      '3000',
      repoMap,
      { workspacePortsByWorktreeId: new Map([['wt-port', [{ port: 3000, processName: 'vite' }]]]) }
    )

    expect(results).toHaveLength(1)
    expect(results[0].matchedFields).toEqual(['port'])
    expect(results[0].supportingText).toEqual({
      labelKind: 'port',
      text: '3000 · vite',
      matchRanges: [{ start: 0, end: 4 }],
      accessibilityLabel: 'Listening port'
    })
  })

  it('still prefix-matches port numbers, unlike review numbers', () => {
    const worktree = makeWorktree({ id: 'wt-port' })
    const workspacePortsByWorktreeId = new Map([['wt-port', [{ port: 3000 }]]])

    expect(
      searchWorktrees([worktree], '300', repoMap, { workspacePortsByWorktreeId })
    ).toHaveLength(1)
  })
})
