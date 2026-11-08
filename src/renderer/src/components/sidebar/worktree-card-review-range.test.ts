// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { buildWorktreeOccurrencePlan } from '../../../../shared/worktree-occurrence-plan'
import { buildWorktreeLineageRanges } from '../../../../shared/sidebar-list/worktree-lineage-range'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import { getWorktreeReviewCacheKeys } from './workspace-card/review/worktree-card-pr-derivation'
import {
  createHiddenReviewStatesSelector,
  selectHiddenReviewStates
} from './worktree-card-review-range'

it('updates shared review keys, removes old representatives, and excludes reviews outside the subtree', () => {
  const repo = { id: 'repo', path: '/repo', displayName: 'repo', badgeColor: 'gray', addedAt: 1 }
  const parent = makeWorktree({ id: 'parent', repoId: repo.id, branch: 'refs/heads/parent' })
  const first = makeWorktree({ id: 'first', repoId: repo.id, branch: 'refs/heads/shared' })
  const second = makeWorktree({ id: 'second', repoId: repo.id, branch: 'refs/heads/shared' })
  const nested = makeWorktree({ id: 'nested', repoId: repo.id, branch: 'refs/heads/nested' })
  const rows = [parent, first, second, nested]
  const plan = buildWorktreeOccurrencePlan({
    rows,
    identityOf: getWorktreeHostIdentity,
    childrenByParentIdentity: new Map([
      [getWorktreeHostIdentity(parent), [first, second]],
      [getWorktreeHostIdentity(second), [nested]]
    ]),
    isPinned: () => false,
    duplicatePinned: false,
    sectionsOf: ({ natural }) => [{ key: 'all', items: natural }]
  })
  const ranges = [...buildWorktreeLineageRanges(plan).values()]
  const root = ranges.find((range) => range.tree.worktrees[range.index]!.id === parent.id)!
  const child = ranges.find((range) => range.tree.worktrees[range.index]!.id === second.id)!
  const state = {
    ...useAppStore.getState(),
    repos: [repo],
    worktreesByRepo: { repo: rows },
    prCache: {},
    hostedReviewCache: {}
  }
  const keys = getWorktreeReviewCacheKeys(first, repo, state.settings)
  const nestedKeys = getWorktreeReviewCacheKeys(nested, repo, state.settings)
  const pr: PRInfo = {
    number: 10,
    title: 'Review',
    state: 'open',
    url: 'https://example.test/10',
    checksStatus: 'success',
    updatedAt: '',
    mergeable: 'UNKNOWN'
  }
  const ready = { ...state, prCache: { [keys.prCacheKey]: { data: pr, fetchedAt: 1 } } }
  const select = createHiddenReviewStatesSelector(root)
  expect(select(ready).open.count).toBe(2)
  expect(selectHiddenReviewStates(ready, child).open.count).toBe(0)
  const withNested = {
    ...ready,
    prCache: {
      ...ready.prCache,
      [nestedKeys.prCacheKey]: { data: { ...pr, number: 20 }, fetchedAt: 1 }
    }
  }
  const summary = select(withNested)
  expect(summary.open.count).toBe(3)
  expect(summary.open.review?.number).toBe(10)
  expect(selectHiddenReviewStates(withNested, child).open.review?.number).toBe(20)
  const failed = {
    ...withNested,
    prCache: {
      ...withNested.prCache,
      [nestedKeys.prCacheKey]: {
        data: { ...pr, number: 20, checksStatus: 'failure' as const },
        fetchedAt: 2
      }
    }
  }
  expect(select(failed).open.review?.number).toBe(20)
  const removed = { ...failed, prCache: { [keys.prCacheKey]: ready.prCache[keys.prCacheKey]! } }
  expect(select(removed).open.count).toBe(2)
  expect(select(removed).open.review?.number).toBe(10)
  const closed = {
    ...removed,
    prCache: {},
    hostedReviewCache: {
      [keys.hostedReviewCacheKey]: {
        data: {
          provider: 'gitlab' as const,
          number: 30,
          title: 'MR',
          state: 'closed' as const,
          url: 'https://example.test/30',
          status: 'success' as const,
          mergeable: 'UNKNOWN' as const,
          updatedAt: ''
        },
        fetchedAt: 3,
        linkedReviewHintKey: ''
      }
    }
  }
  expect(select(closed).open.count).toBe(0)
  expect(select(closed).closed.count).toBe(2)
})
