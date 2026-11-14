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

it('uses cached merged head proof when the hosted review of the same PR lacks it', () => {
  const worktree = makeWorktree({ id: 'workspace', repoId: 'repo', head: 'current-head' })
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
  const result = deriveWorktreeCardPrDisplay(
    worktree,
    { data: review, fetchedAt: 2, linkedReviewHintKey: '' },
    {
      data: { ...review, checksStatus: 'success', confirmedContainedHeadOid: 'current-head' },
      fetchedAt: 1
    }
  )
  expect(result.prDisplay).toMatchObject({ provider: 'github', number: 42 })
})

it('preserves a newer hosted PR when a different merged PR has cached head proof', () => {
  const worktree = makeWorktree({ id: 'workspace', repoId: 'repo', head: 'current-head' })
  const review: HostedReviewInfo = {
    provider: 'github',
    number: 43,
    title: 'New work',
    state: 'open',
    url: 'https://github.com/example/repo/pull/43',
    status: 'success',
    updatedAt: '2026-11-01T00:00:00Z',
    mergeable: 'UNKNOWN',
    headSha: 'current-head'
  }
  const result = deriveWorktreeCardPrDisplay(
    worktree,
    { data: review, fetchedAt: 2, linkedReviewHintKey: '' },
    {
      data: {
        ...review,
        number: 42,
        state: 'merged',
        url: 'https://github.com/example/repo/pull/42',
        checksStatus: 'success'
      },
      fetchedAt: 1
    }
  )
  expect(result.prDisplay).toMatchObject({
    provider: 'github',
    number: 43,
    state: 'open',
    url: 'https://github.com/example/repo/pull/43'
  })
})
