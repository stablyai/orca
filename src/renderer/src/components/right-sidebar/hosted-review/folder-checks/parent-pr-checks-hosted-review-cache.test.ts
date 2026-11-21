import { expect, it } from 'vitest'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { canUseParentPrChecksHostedReviewCacheEntry } from './parent-pr-checks-hosted-review-cache'

function mergedReview(provider: HostedReviewInfo['provider'], number: number): HostedReviewInfo {
  return {
    provider,
    number,
    title: 'Merged work',
    state: 'merged',
    url: 'https://example.test/review',
    status: 'success',
    updatedAt: '2026-11-01T00:00:00Z',
    mergeable: 'UNKNOWN',
    headSha: 'old-head'
  }
}

it('keeps a linked merged GitLab MR after the worktree head moves past headSha', () => {
  const worktree = makeWorktree({
    id: 'repo-a',
    repoId: 'repo-a',
    head: 'newer-head',
    linkedGitLabMR: 9
  })
  const review = mergedReview('gitlab', 9)
  expect(
    canUseParentPrChecksHostedReviewCacheEntry(worktree, review, { data: review, fetchedAt: 1 })
  ).toBe(true)
})

it('still rejects a linked merged GitHub PR whose head is not the worktree head', () => {
  const worktree = makeWorktree({
    id: 'repo-a',
    repoId: 'repo-a',
    head: 'newer-head',
    linkedPR: 9
  })
  const review = mergedReview('github', 9)
  expect(
    canUseParentPrChecksHostedReviewCacheEntry(worktree, review, { data: review, fetchedAt: 1 })
  ).toBe(false)
})

it('rejects a merged GitLab cache when the linked MR number differs', () => {
  const worktree = makeWorktree({
    id: 'repo-a',
    repoId: 'repo-a',
    head: 'newer-head',
    linkedGitLabMR: 4
  })
  const review = mergedReview('gitlab', 9)
  expect(
    canUseParentPrChecksHostedReviewCacheEntry(worktree, review, { data: review, fetchedAt: 1 })
  ).toBe(false)
})
