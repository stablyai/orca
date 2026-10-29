import { describe, expect, it } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
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

describe('getWorktreeCardPrDisplay', () => {
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

  it('keeps the linked PR number visible when cached details belong to a different PR', () => {
    expect(getWorktreeCardPrDisplay(pr, 456)).toEqual({
      provider: 'github',
      number: 456,
      title: 'Loading PR...'
    })
  })

  it('keeps the linked GitLab MR number visible when cached details belong to a different MR', () => {
    expect(getWorktreeCardPrDisplay(gitLabReview, null, 654)).toEqual({
      provider: 'gitlab',
      number: 654,
      title: 'Loading MR...'
    })
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
