import { describe, expect, it } from 'vitest'
import { matchWorktreePaletteReview } from './worktree-palette-review-match'
import { searchWorktrees } from './worktree-palette-search'
import type { Repo, Worktree } from '../../../shared/types'
import type { HostedReviewInfo } from '../../../shared/hosted-review'

// Regression tests for the production crash (report c5d87873, macOS, Orca 1.4.147):
//   TypeError: Cannot read properties of undefined (reading 'toLowerCase')
//   at matchWorktreePaletteReview -> searchWorktrees -> WorktreeJumpPalette useMemo
// A rehydrated review/PR cache entry can carry an undefined `title` even though the
// type declares it non-optional, so the Cmd+J worktree palette crashed on any text query.

type MatcherReview = Parameters<typeof matchWorktreePaletteReview>[0]

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

describe('matchWorktreePaletteReview title null-safety', () => {
  it('returns null instead of throwing when a cached review has no title', () => {
    const review = { number: 42, provider: 'github' } as unknown as MatcherReview
    expect(() => matchWorktreePaletteReview(review, 'feature', 'feature')).not.toThrow()
    expect(matchWorktreePaletteReview(review, 'feature', 'feature')).toBeNull()
  })

  it('still matches on the title text when a title is present', () => {
    const review = {
      number: 42,
      title: 'Fix the thing',
      provider: 'github'
    } as unknown as MatcherReview
    const match = matchWorktreePaletteReview(review, 'thing', 'thing')
    expect(match).not.toBeNull()
    expect(match?.text).toBe('Fix the thing')
    expect(match?.matchRange).toEqual({ start: 8, end: 13 })
  })

  it('still matches on the PR number even when the title is missing', () => {
    const review = { number: 42, provider: 'github' } as unknown as MatcherReview
    const match = matchWorktreePaletteReview(review, '42', '42')
    expect(match?.text).toBe('PR #42')
  })
})

describe('searchWorktrees with a titleless cached review (Cmd+J palette crash path)', () => {
  it('does not throw when the checks-review cache entry has no title', () => {
    const worktree = makeWorktree()
    const titlelessReview = {
      number: 7,
      provider: 'github',
      state: 'open',
      url: 'https://example.test/pr/7'
    } as unknown as HostedReviewInfo
    const checksReviewByWorktree = new Map<Worktree, HostedReviewInfo | null>([
      [worktree, titlelessReview]
    ])

    expect(() =>
      searchWorktrees(
        [worktree],
        'nonmatchingtext',
        repoMap,
        null,
        null,
        undefined,
        checksReviewByWorktree
      )
    ).not.toThrow()
  })
})
