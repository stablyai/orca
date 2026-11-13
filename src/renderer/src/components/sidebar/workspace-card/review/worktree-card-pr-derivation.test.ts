import { expect, it } from 'vitest'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { deriveWorktreeCardPrDisplay } from './worktree-card-pr-derivation'

it('hides a head-mismatched merged branch review while preserving explicit links and current heads', () => {
  const worktree = makeWorktree({
    id: 'workspace',
    repoId: 'repo',
    head: 'new-head',
    linkedPR: null
  })
  const review: HostedReviewInfo = {
    provider: 'github',
    number: 42,
    title: 'Merged work',
    state: 'merged',
    url: 'https://github.com/example/repo/pull/42',
    status: 'success',
    updatedAt: '2026-11-01T00:00:00Z',
    mergeable: 'UNKNOWN',
    headSha: 'old-head'
  }
  const entry = { data: review, fetchedAt: 1, linkedReviewHintKey: '' }
  expect(deriveWorktreeCardPrDisplay(worktree, entry, undefined).prDisplay).toBeNull()
  expect(
    deriveWorktreeCardPrDisplay({ ...worktree, linkedPR: 42 }, entry, undefined).prDisplay
  ).toMatchObject({ provider: 'github', number: 42 })
  expect(
    deriveWorktreeCardPrDisplay({ ...worktree, head: 'old-head' }, entry, undefined).prDisplay
  ).toMatchObject({ provider: 'github', number: 42 })
})
