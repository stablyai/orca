import { describe, expect, it } from 'vitest'
import { selectReviewCacheData, selectReviewCacheEntry } from './review-cache-entry-selection'

type Review = { id: string }
type ReviewEntry = { data: Review | null; fetchedAt: number }

const ACTIVE_KEY = 'repo-active::feature'

function replaceUnrelatedEntry(
  cache: Record<string, ReviewEntry>,
  index: number
): Record<string, ReviewEntry> {
  return {
    ...cache,
    [`repo-background-${index % 100}::feature`]: {
      data: { id: `background-${index}` },
      fetchedAt: index
    }
  }
}

describe('review cache entry selection', () => {
  it('turns unrelated active-panel cache invalidations into stable selections', () => {
    const activeHostedReview = { id: 'hosted-active' }
    const activePullRequest = { id: 'pr-active' }
    let hostedCache: Record<string, ReviewEntry> = {
      [ACTIVE_KEY]: { data: activeHostedReview, fetchedAt: 1 }
    }
    let pullRequestCache: Record<string, ReviewEntry> = {
      [ACTIVE_KEY]: { data: activePullRequest, fetchedAt: 1 }
    }
    let previousHostedMap = hostedCache
    let previousPullRequestMap = pullRequestCache
    let previousHostedSelection = selectReviewCacheData(hostedCache, ACTIVE_KEY)
    let previousPullRequestSelection = selectReviewCacheEntry(pullRequestCache, ACTIVE_KEY)
    let wholeMapInvalidations = 0
    let scopedSelectionInvalidations = 0

    for (let index = 0; index < 200; index += 1) {
      hostedCache = replaceUnrelatedEntry(hostedCache, index)
      pullRequestCache = replaceUnrelatedEntry(pullRequestCache, index)
      if (hostedCache !== previousHostedMap) {
        wholeMapInvalidations += 1
      }
      if (pullRequestCache !== previousPullRequestMap) {
        wholeMapInvalidations += 1
      }

      const hostedSelection = selectReviewCacheData(hostedCache, ACTIVE_KEY)
      const pullRequestSelection = selectReviewCacheEntry(pullRequestCache, ACTIVE_KEY)
      if (hostedSelection !== previousHostedSelection) {
        scopedSelectionInvalidations += 1
      }
      if (pullRequestSelection !== previousPullRequestSelection) {
        scopedSelectionInvalidations += 1
      }

      previousHostedMap = hostedCache
      previousPullRequestMap = pullRequestCache
      previousHostedSelection = hostedSelection
      previousPullRequestSelection = pullRequestSelection
    }

    expect(wholeMapInvalidations).toBe(400)
    expect(scopedSelectionInvalidations).toBe(0)
  })

  it('publishes relevant entry replacements and handles absent keys', () => {
    const first = { data: { id: 'first' }, fetchedAt: 1 }
    const second = { data: { id: 'second' }, fetchedAt: 2 }

    expect(selectReviewCacheEntry({ [ACTIVE_KEY]: first }, ACTIVE_KEY)).toBe(first)
    expect(selectReviewCacheEntry({ [ACTIVE_KEY]: second }, ACTIVE_KEY)).toBe(second)
    expect(selectReviewCacheData({ [ACTIVE_KEY]: second }, ACTIVE_KEY)).toBe(second.data)
    expect(selectReviewCacheEntry({}, ACTIVE_KEY)).toBeUndefined()
    expect(selectReviewCacheData({}, ACTIVE_KEY)).toBeNull()
    expect(selectReviewCacheEntry({ [ACTIVE_KEY]: first }, null)).toBeUndefined()
  })
})
