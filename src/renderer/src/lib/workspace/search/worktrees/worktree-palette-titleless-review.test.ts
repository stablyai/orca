import { describe, expect, it } from 'vitest'
import { searchWorktrees } from './worktree-palette-search'
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
      searchWorktrees([worktree], 'nonmatchingtext', repoMap, { checksReviewByWorktree })
    ).not.toThrow()
    // The number still indexes, so the titleless review stays reachable.
    expect(
      searchWorktrees([worktree], '#7', repoMap, { checksReviewByWorktree })[0].supportingText
    ).toMatchObject({ labelKind: 'pr', text: '#7' })
  })
})
