import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { persistGitHubCacheChanges } from '../github/cache-persistence'
import { hostedReviewInfoFromGitHubPRInfo } from '../../../../shared/hosted-review-github'
import { _clearGitHubPRRefreshStartedEntriesForTest } from '../github/request-coordination'
import { getHostedReviewCacheKey } from './hosted-review-cache-identity'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  mockApi,
  resetRemoteRuntimeMocks
} from './github-slice-test-harness'

describe.each(['manual', 'coordinator'] as const)('%s rejected PR cache results', (source) => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetRemoteRuntimeMocks()
    mockApi.gh.refreshPRNow.mockReset()
    _clearGitHubPRRefreshStartedEntriesForTest()
  })

  afterEach(() => {
    _clearGitHubPRRefreshStartedEntriesForTest()
    vi.useRealTimers()
  })

  it.each([
    {
      name: 'clears a rejected integration PR even at its merged head',
      rejectedUrl: 'https://github.com/acme/orca/pull/12',
      head: 'merged-head',
      preserves: false
    },
    {
      name: 'clears a rejected integration PR at a confirmed contained commit',
      rejectedUrl: 'https://github.com/acme/orca/pull/12',
      head: 'contained-head',
      preserves: false
    },
    {
      name: 'preserves a merged PR when the rejected number belongs to another repository',
      rejectedUrl: 'https://github.com/other/orca/pull/12',
      head: 'merged-head',
      preserves: true
    },
    {
      name: 'preserves a merged PR when the rejected number belongs to another server',
      rejectedUrl: 'https://github.example.com/acme/orca/pull/12',
      head: 'merged-head',
      preserves: true
    }
  ])('$name', async ({ rejectedUrl, head, preserves }) => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/from-develop'
    const worktreeId = 'wt-new-feature'
    const cacheKey = `${repoId}::${branch}`
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const cachedPR = makePR({
      number: 12,
      state: 'merged',
      url: 'https://github.com/acme/orca/pull/12',
      headSha: 'merged-head',
      confirmedContainedHeadOid: 'contained-head'
    })
    const cachedReview = hostedReviewInfoFromGitHubPRInfo(cachedPR)
    store.setState({
      repos: [
        { id: repoId, path: repoPath, displayName: 'repo', badgeColor: '', addedAt: 1, kind: 'git' }
      ],
      worktreesByRepo: {
        [repoId]: [makePRRefreshWorktree({ id: worktreeId, repoId, branch, head })]
      },
      prCache: { [cacheKey]: { data: cachedPR, fetchedAt: 1 } },
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: cachedReview,
          fetchedAt: 1,
          linkedReviewHintKey: 'github:12'
        }
      }
    })
    const outcome = { kind: 'no-pr' as const, fetchedAt: 2, rejectedPRUrls: [rejectedUrl] }
    persistGitHubCacheChanges(store)
    if (source === 'manual') {
      mockApi.gh.refreshPRNow.mockResolvedValueOnce(outcome)
      await expect(
        store.getState().fetchPRForBranch(repoPath, branch, {
          force: true,
          repoId,
          worktreeId,
          fallbackPRNumber: 12,
          fallbackPRSource: 'pr-cache'
        })
      ).resolves.toEqual(preserves ? cachedPR : null)
    } else {
      store.getState().applyGitHubPRRefreshEvent({
        sequence: 1,
        reason: 'visible',
        aliases: [
          {
            cacheKey,
            repoId,
            repoPath,
            branch,
            worktreeId,
            fallbackPRNumber: 12,
            fallbackPRSource: 'pr-cache'
          }
        ],
        outcome
      })
    }

    expect(store.getState().prCache[cacheKey]?.data).toEqual(preserves ? cachedPR : null)
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]?.data).toEqual(
      preserves ? cachedReview : null
    )
    await vi.advanceTimersByTimeAsync(1000)
    if (preserves) {
      expect(mockApi.cache.setGitHub).not.toHaveBeenCalled()
    } else {
      expect(mockApi.cache.setGitHub).toHaveBeenCalledWith({
        cache: expect.objectContaining({
          pr: { [cacheKey]: expect.objectContaining({ data: null, fetchedAt: 2 }) }
        })
      })
    }
  })
})
