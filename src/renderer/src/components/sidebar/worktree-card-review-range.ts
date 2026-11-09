import type { AppState } from '@/store/types'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import { createHostScopedRepoOf } from '../../../../shared/sidebar-list/sidebar-feed-index'
import {
  createLineageRangeAggregate,
  type LineageRangeAggregate
} from '../../../../shared/sidebar-list/lineage-range-aggregate'
import {
  isLineageRange,
  lineageIdentities,
  type WorktreeLineageSource,
  type WorktreeLineageTree
} from '../../../../shared/sidebar-list/worktree-lineage-range'
import type { HostedReviewState } from '../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { Worktree } from '../../../../shared/worktree/types'
import { getProviderChecksOutcome } from '../../../../shared/source-control/checks/provider-check-summary'
import {
  getWorktreeReviewCacheKeys,
  selectWorktreeCardPrDisplay
} from './workspace-card/review/worktree-card-pr-derivation'
import type { WorktreeCardPrDisplay } from './workspace-card/review/worktree-card-pr-display'
import { worktreeForIdentity } from './worktree-card-slot-rollup'
import {
  changedReviewKeys,
  reviewSnapshot,
  type ReviewSnapshot
} from './worktree-card-review-snapshot'

export type ReviewRollupState = HostedReviewState | 'unknown'
export const REVIEW_STATE_ORDER: readonly ReviewRollupState[] = [
  'open',
  'draft',
  'merged',
  'closed',
  'unknown'
]
type PrSummary = { count: number; review: WorktreeCardPrDisplay | null; rank?: number }
export type PrStates = Record<ReviewRollupState, PrSummary>
export const emptyReviewStates = (): PrStates => ({
  open: { count: 0, review: null },
  draft: { count: 0, review: null },
  merged: { count: 0, review: null },
  closed: { count: 0, review: null },
  unknown: { count: 0, review: null }
})

function priority(review: WorktreeCardPrDisplay): number {
  const outcome = review.status && getProviderChecksOutcome(review.checksSummary, review.status)
  return outcome === 'failure' ? 0 : outcome === 'pending' ? 1 : outcome === 'cancelled' ? 2 : 3
}
export function mergeReviewSummary(into: PrSummary, from: PrSummary): void {
  into.count += from.count
  if (
    from.review &&
    (!into.review ||
      priority(from.review) < priority(into.review) ||
      (priority(from.review) === priority(into.review) &&
        (from.rank ?? Infinity) < (into.rank ?? Infinity)))
  ) {
    into.review = from.review
    into.rank = from.rank
  }
}
export function addReview(
  states: PrStates,
  review: WorktreeCardPrDisplay | null,
  rank?: number
): void {
  if (review) {
    mergeReviewSummary(states[review.state ?? 'unknown'], { count: 1, review, rank })
  }
}
function combine(left: PrStates, right: PrStates): PrStates {
  const result = emptyReviewStates()
  for (const key of REVIEW_STATE_ORDER) {
    mergeReviewSummary(result[key], left[key])
    mergeReviewSummary(result[key], right[key])
  }
  return result
}

const repoReaders = new WeakMap<AppState['repos'], ReturnType<typeof createHostScopedRepoOf>>()
function repoFor(state: AppState, worktree: Worktree) {
  let repoOf = repoReaders.get(state.repos)
  if (!repoOf) {
    repoOf = createHostScopedRepoOf(state.repos, getIndexedRepoMap(state.repos))
    repoReaders.set(state.repos, repoOf)
  }
  return repoOf(worktree)
}
export function ownWorktreeReview(
  state: AppState,
  worktree: Worktree
): WorktreeCardPrDisplay | null {
  return selectWorktreeCardPrDisplay(state, worktree, repoFor(state, worktree))
}

type TreeReviews = {
  snapshot: ReviewSnapshot
  aggregate: LineageRangeAggregate<PrStates>
  prIndices: Map<string, number[]>
  hostedIndices: Map<string, number[]>
  ranks: number[]
}
const treeReviews = new WeakMap<WorktreeLineageTree, TreeReviews>()

function reviewForIndex(
  state: AppState,
  tree: WorktreeLineageTree,
  index: number,
  rank: number
): PrStates {
  const result = emptyReviewStates()
  addReview(
    result,
    ownWorktreeReview(
      state,
      worktreeForIdentity(state, tree.identities[index]!) ?? tree.worktrees[index]!
    ),
    rank
  )
  return result
}

function reviewsForTree(state: AppState, tree: WorktreeLineageTree): TreeReviews {
  const snapshot = reviewSnapshot(state)
  const cached = treeReviews.get(tree)
  if (cached?.snapshot === snapshot) {
    return cached
  }
  if (
    cached &&
    snapshot.structure.every((value, index) => value === cached.snapshot.structure[index])
  ) {
    const changed = changedReviewKeys(cached.snapshot, snapshot)
    const indices = new Set<number>()
    for (const [keys, index] of [
      [changed.pr, cached.prIndices],
      [changed.hosted, cached.hostedIndices]
    ] as const) {
      for (const key of keys) {
        for (const i of index.get(key) ?? []) {
          indices.add(i)
        }
      }
    }
    for (const index of indices) {
      cached.aggregate.update(index, reviewForIndex(state, tree, index, cached.ranks[index]!))
    }
    cached.snapshot = snapshot
    return cached
  }
  // Preserve the original rollup's tie order: last sibling first, with its own review before children.
  const children: number[][] = Array.from({ length: tree.identities.length }, () => [])
  const stack: number[] = []
  tree.parents.forEach((parent, index) => (parent < 0 ? stack : children[parent]!).push(index))
  const ranks: number[] = []
  let rank = 0
  while (stack.length) {
    const index = stack.pop()!
    ranks[index] = rank++
    for (const child of children[index]!) {
      stack.push(child)
    }
  }
  const prIndices = new Map<string, number[]>()
  const hostedIndices = new Map<string, number[]>()
  const own = tree.identities.map((identity, index) => {
    const worktree = worktreeForIdentity(state, identity) ?? tree.worktrees[index]!
    const keys = getWorktreeReviewCacheKeys(worktree, repoFor(state, worktree), state.settings)
    for (const [key, indices] of [
      [keys.prCacheKey, prIndices],
      [keys.hostedReviewCacheKey, hostedIndices]
    ] as const) {
      if (!key) {
        continue
      }
      const bucket = indices.get(key) ?? []
      bucket.push(index)
      indices.set(key, bucket)
    }
    const result = emptyReviewStates()
    addReview(result, ownWorktreeReview(state, worktree), ranks[index])
    return result
  })
  const result = {
    snapshot,
    aggregate: createLineageRangeAggregate(own, emptyReviewStates, combine),
    prIndices,
    hostedIndices,
    ranks
  }
  treeReviews.set(tree, result)
  return result
}

export function selectHiddenReviewStates(state: AppState, source: WorktreeLineageSource): PrStates {
  if (source.length === 0) {
    return emptyReviewStates()
  }
  if (isLineageRange(source)) {
    return reviewsForTree(state, source.tree).aggregate.read(
      source.index + 1,
      source.tree.ends[source.index]!
    )
  }
  const result = emptyReviewStates()
  for (const identity of lineageIdentities(source)) {
    const worktree = worktreeForIdentity(state, identity)
    if (worktree) {
      addReview(result, ownWorktreeReview(state, worktree))
    }
  }
  return result
}

export function createHiddenReviewStatesSelector(source: WorktreeLineageSource) {
  let previous: ReviewSnapshot | undefined
  let result = emptyReviewStates()
  return (state: AppState): PrStates => {
    const snapshot = reviewSnapshot(state)
    if (snapshot !== previous) {
      previous = snapshot
      const next = selectHiddenReviewStates(state, source)
      if (
        REVIEW_STATE_ORDER.some(
          (key) => next[key].count !== result[key].count || next[key].review !== result[key].review
        )
      ) {
        result = next
      }
    }
    return result
  }
}
