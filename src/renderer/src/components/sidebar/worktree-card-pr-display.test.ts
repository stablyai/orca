import { describe, expect, it } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { PRInfo } from '../../../../shared/types'
import {
  getWorktreeCardPrDisplay,
  isCachedMergedBranchPRCurrentForWorktree
} from './worktree-card-pr-display'

const pr: HostedReviewInfo = {
  provider: 'github',
  number: 123,
  title: 'Ready PR',
  state: 'open',
  url: 'https://github.com/stablyai/orca/pull/123',
  status: 'success',
  updatedAt: '2026-05-13T00:00:00.000Z',
  mergeable: 'MERGEABLE'
}

const gitLabReview: HostedReviewInfo = {
  provider: 'gitlab',
  number: 321,
  title: 'Ready MR',
  state: 'open',
  url: 'https://gitlab.com/stablyai/orca/-/merge_requests/321',
  status: 'success',
  updatedAt: '2026-05-13T00:00:00.000Z',
  mergeable: 'MERGEABLE'
}

const bitbucketReview: HostedReviewInfo = {
  provider: 'bitbucket',
  number: 789,
  title: 'Ready Bitbucket PR',
  state: 'open',
  url: 'https://bitbucket.org/stablyai/orca/pull-requests/789',
  status: 'success',
  updatedAt: '2026-05-13T00:00:00.000Z',
  mergeable: 'MERGEABLE'
}

describe('getWorktreeCardPrDisplay', () => {
  it('uses cached PR details when available', () => {
    expect(getWorktreeCardPrDisplay(pr, 123)).toBe(pr)
  })

  it('falls back to linkedPR while PR details load', () => {
    expect(getWorktreeCardPrDisplay(undefined, 456)).toEqual({
      provider: 'github',
      number: 456,
      title: 'Loading PR...'
    })
  })

  it('keeps linkedPR visible when PR details are unavailable', () => {
    expect(getWorktreeCardPrDisplay(null, 456)).toEqual({
      provider: 'github',
      number: 456,
      title: 'PR details unavailable'
    })
  })

  it('does not show a PR row for unlinked worktrees', () => {
    expect(getWorktreeCardPrDisplay(undefined, null)).toBeNull()
  })

  it('ignores linked-lookup PR details when the worktree is unlinked', () => {
    expect(
      getWorktreeCardPrDisplay(pr, null, null, null, null, null, {
        reviewHintKey: 'github:123'
      })
    ).toBeNull()
  })

  it('keeps an unlinked GitHub PR visible when branch provenance names the same PR', () => {
    expect(
      getWorktreeCardPrDisplay(pr, null, null, null, null, null, {
        reviewHintKey: 'github:123',
        branchLookupGitHubPRNumber: 123
      })
    ).toBe(pr)
  })

  it('still suppresses unlinked linked-lookup details when branch provenance names a different PR', () => {
    expect(
      getWorktreeCardPrDisplay(pr, null, null, null, null, null, {
        reviewHintKey: 'github:123',
        branchLookupGitHubPRNumber: 999
      })
    ).toBeNull()
  })

  it('does not let a GitHub branch PR number corroborate an unlinked GitLab MR', () => {
    expect(
      getWorktreeCardPrDisplay(gitLabReview, null, null, null, null, null, {
        reviewHintKey: 'gitlab:321',
        branchLookupGitHubPRNumber: 321
      })
    ).toBeNull()
  })

  it('does not let branch provenance override linked non-GitHub review metadata', () => {
    expect(
      getWorktreeCardPrDisplay(pr, null, 321, null, null, null, {
        reviewHintKey: 'gitlab:321',
        branchLookupGitHubPRNumber: 123
      })
    ).toBeNull()
  })

  it('shows branch-discovered GitHub PR details when the worktree is unlinked', () => {
    expect(
      getWorktreeCardPrDisplay(pr, null, null, null, null, null, {
        reviewHintKey: ''
      })
    ).toBe(pr)
  })

  it('treats missing cache hints as unsafe for unlinked GitHub PR details', () => {
    expect(getWorktreeCardPrDisplay(pr, null)).toBeNull()
  })

  it('keeps the linked PR number visible when cached details belong to a different PR', () => {
    expect(getWorktreeCardPrDisplay(pr, 456)).toEqual({
      provider: 'github',
      number: 456,
      title: 'Loading PR...'
    })
  })

  it('uses cached GitLab MR details when linked metadata matches', () => {
    expect(getWorktreeCardPrDisplay(gitLabReview, null, 321)).toBe(gitLabReview)
  })

  it('keeps the linked GitLab MR number visible when cached details belong to a different MR', () => {
    expect(getWorktreeCardPrDisplay(gitLabReview, null, 654)).toEqual({
      provider: 'gitlab',
      number: 654,
      title: 'Loading MR...'
    })
  })

  it('preserves branch-discovered hosted reviews for providers without worktree metadata', () => {
    expect(getWorktreeCardPrDisplay(bitbucketReview, null)).toBe(bitbucketReview)
  })
})

describe('isCachedMergedBranchPRCurrentForWorktree', () => {
  const mergedPR: PRInfo = {
    number: 55,
    title: 'Merged PR',
    state: 'merged',
    url: 'https://github.com/stablyai/orca/pull/55',
    checksStatus: 'success',
    updatedAt: '2026-07-03T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    headSha: 'final-head'
  }

  it('matches when the worktree sits exactly on the merged head', () => {
    expect(isCachedMergedBranchPRCurrentForWorktree(mergedPR, { head: 'final-head' })).toBe(true)
  })

  it('matches when the worktree head is a confirmed commit of the merged PR', () => {
    expect(
      isCachedMergedBranchPRCurrentForWorktree(
        { ...mergedPR, confirmedContainedHeadOid: 'behind-head' },
        { head: 'behind-head' }
      )
    ).toBe(true)
  })

  it('rejects a merged PR when the worktree head is neither the final head nor confirmed', () => {
    expect(
      isCachedMergedBranchPRCurrentForWorktree(
        { ...mergedPR, confirmedContainedHeadOid: 'other-head' },
        { head: 'reused-branch-head' }
      )
    ).toBe(false)
  })
})
