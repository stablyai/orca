import { describe, expect, it } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { getWorktreeCardPrDisplay } from './worktree-card-pr-display'

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

  it('ignores cached branch PR details when the worktree is unlinked', () => {
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
