import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _clearGitHubPRRefreshStartedEntriesForTest } from '../requests/request-coordination'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  mockApi,
  resetRemoteRuntimeMocks
} from '../github-slice-test-harness'
import type { AppState } from '../../types'
import { getHostedReviewCacheKey } from '../../slices/hosted-review/hosted-review-cache-identity'

describe('createGitHubSlice.fetchPRForBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.prForBranch.mockResolvedValue(null)
    mockApi.gh.refreshPRNow.mockReset()
    mockApi.gh.refreshPRNow.mockResolvedValue({ kind: 'no-pr', fetchedAt: Date.now() })
    mockApi.hostedReview.forBranch.mockResolvedValue(null)
    _clearGitHubPRRefreshStartedEntriesForTest()
  })

  afterEach(() => {
    _clearGitHubPRRefreshStartedEntriesForTest()
    vi.useRealTimers()
  })

  it.each(['open', 'draft'] as const)(
    'clears visible cached %s PR data when a fallback refresh misses',
    async (state) => {
      const store = createTestStore()
      const repoPath = '/repo'
      const repoId = 'repo-1'
      const branch = 'feature/fallback-miss'
      const cachedPR = makePR({ number: 12, state, title: 'Visible cached PR' })
      const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)

      store.setState({
        repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
        prCache: {
          [`${repoId}::${branch}`]: {
            data: cachedPR,
            fetchedAt: 1
          }
        },
        hostedReviewCache: {
          [hostedReviewCacheKey]: {
            data: {
              provider: 'github',
              number: 12,
              title: 'Visible cached PR',
              state,
              url: 'https://github.com/acme/orca/pull/12',
              status: 'pending',
              updatedAt: '2026-03-28T00:00:00Z',
              mergeable: 'UNKNOWN'
            },
            fetchedAt: 1,
            linkedReviewHintKey: 'github:12'
          }
        }
      } as unknown as Partial<AppState>)
      mockApi.gh.refreshPRNow.mockResolvedValueOnce({ kind: 'no-pr', fetchedAt: 2 })

      await expect(
        store.getState().fetchPRForBranch(repoPath, branch, {
          force: true,
          repoId,
          fallbackPRNumber: 12
        })
      ).resolves.toBeNull()
      expect(store.getState().prCache[`${repoId}::${branch}`]).toEqual({
        data: null,
        fetchedAt: 2
      })
      expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
        data: null,
        fetchedAt: 2,
        linkedReviewHintKey: 'github:12'
      })
    }
  )

  it('preserves cached merged PR data when a forced no-PR refresh matches the worktree head', async () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/merged-pr-head-match'
    const worktreeId = 'wt-merged-direct-match'
    const cachedPR = makePR({
      number: 12,
      title: 'Merged PR still checked out',
      state: 'merged',
      headSha: 'merged-head'
    })

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: {
        [repoId]: [
          makePRRefreshWorktree({
            id: worktreeId,
            repoId,
            branch,
            head: 'merged-head'
          })
        ]
      },
      prCache: {
        [`${repoId}::${branch}`]: {
          data: cachedPR,
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({ kind: 'no-pr', fetchedAt: 2 })

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, {
        force: true,
        repoId,
        worktreeId
      })
    ).resolves.toEqual(cachedPR)
    expect(store.getState().prCache[`${repoId}::${branch}`]).toEqual({
      data: cachedPR,
      fetchedAt: 1
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockApi.cache.setGitHub).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'worktree id is missing',
      worktreeId: undefined,
      linkedPRNumber: undefined,
      worktreesByRepo: {}
    },
    {
      name: 'worktree cannot be found',
      worktreeId: 'wt-missing',
      linkedPRNumber: undefined,
      worktreesByRepo: { 'repo-1': [] }
    },
    {
      name: 'worktree head is empty',
      worktreeId: 'wt-empty-head',
      linkedPRNumber: undefined,
      worktreesByRepo: {
        'repo-1': [
          makePRRefreshWorktree({
            id: 'wt-empty-head',
            branch: 'feature/merged-pr-stale-direct',
            head: ''
          })
        ]
      }
    },
    {
      name: 'cached PR head differs from worktree head',
      worktreeId: 'wt-moved-head',
      linkedPRNumber: undefined,
      worktreesByRepo: {
        'repo-1': [
          makePRRefreshWorktree({
            id: 'wt-moved-head',
            branch: 'feature/merged-pr-stale-direct',
            head: 'new-head'
          })
        ]
      }
    },
    {
      name: 'an explicit linked PR lookup misses',
      worktreeId: 'wt-linked-pr-miss',
      linkedPRNumber: 12,
      worktreesByRepo: {
        'repo-1': [
          makePRRefreshWorktree({
            id: 'wt-linked-pr-miss',
            branch: 'feature/merged-pr-stale-direct',
            head: 'merged-head',
            linkedPR: 12
          })
        ]
      }
    }
  ])('clears cached merged PR data on forced no-PR refresh when $name', async (testCase) => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/merged-pr-stale-direct'
    const cachedPR = makePR({
      number: 12,
      title: 'Stale merged PR',
      state: 'merged',
      headSha: 'merged-head'
    })

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: testCase.worktreesByRepo,
      prCache: {
        [`${repoId}::${branch}`]: {
          data: cachedPR,
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({ kind: 'no-pr', fetchedAt: 2 })

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, {
        force: true,
        repoId,
        worktreeId: testCase.worktreeId,
        linkedPRNumber: testCase.linkedPRNumber
      })
    ).resolves.toBeNull()
    const fetchedHeadOid = Object.values(testCase.worktreesByRepo)
      .flat()
      .find((worktree) => worktree.id === testCase.worktreeId)?.head
    expect(store.getState().prCache[`${repoId}::${branch}`]).toEqual({
      data: null,
      fetchedAt: 2,
      ...(fetchedHeadOid ? { fetchedHeadOid } : {})
    })
  })
})
