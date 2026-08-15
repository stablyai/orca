import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _clearGitHubPRRefreshStartedEntriesForTest } from './github'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  mockApi,
  resetRemoteRuntimeMocks
} from './github-slice-test-harness'
import type { AppState } from '../types'
import { getHostedReviewCacheKey } from './hosted-review-cache-identity'

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

  it('preserves cached PR data when a forced coordinator refresh errors', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const cachedPR = makePR({ number: 12 })

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      prCache: {
        [`repo-1::${branch}`]: {
          data: cachedPR,
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'upstream-error',
      errorType: 'network',
      message: 'network unavailable',
      fetchedAt: Date.now()
    })

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, { force: true })
    ).resolves.toEqual(cachedPR)
    expect(store.getState().prCache[`repo-1::${branch}`]?.data).toEqual(cachedPR)
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

  it('writes a merged fallback result over an open cached PR', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/fallback-found-merged'
    const cachedPR = makePR({ number: 12, title: 'Visible open PR', state: 'open' })
    const mergedPR = makePR({
      number: 12,
      title: 'Merged PR',
      state: 'merged',
      headSha: 'head-oid'
    })
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
            title: 'Visible open PR',
            state: 'open',
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
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'found',
      pr: mergedPR,
      fetchedAt: 2
    })

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, {
        force: true,
        repoId,
        fallbackPRNumber: 12
      })
    ).resolves.toEqual(mergedPR)
    expect(store.getState().prCache[`${repoId}::${branch}`]).toEqual({
      data: mergedPR,
      fetchedAt: 2
    })
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toMatchObject({
      data: expect.objectContaining({ provider: 'github', number: 12, state: 'merged' }),
      fetchedAt: 2,
      linkedReviewHintKey: 'github:12'
    })
  })

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

  it('preserves cached merged PR data when the worktree head is a confirmed PR commit', async () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/merged-pr-behind-head'
    const worktreeId = 'wt-merged-behind-head'
    const cachedPR = makePR({
      number: 13,
      title: 'Merged PR with unpulled final head',
      state: 'merged',
      headSha: 'merged-final-head',
      confirmedContainedHeadOid: 'behind-head'
    })

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: {
        [repoId]: [
          makePRRefreshWorktree({
            id: worktreeId,
            repoId,
            branch,
            head: 'behind-head'
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
    expect(store.getState().prCache[`${repoId}::${branch}`]).toEqual({
      data: null,
      fetchedAt: 2
    })
  })

  it('uses a GitHub hosted-review cache entry as the fallback PR for direct refreshes', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/hosted-review-fallback'
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const pr = makePR({ number: 44, title: 'Hosted review fallback PR' })

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      prCache: {
        [`${repoId}::${branch}`]: {
          data: null,
          fetchedAt: Date.now()
        }
      },
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: {
            provider: 'github',
            number: 44,
            title: 'Hosted review fallback PR',
            state: 'open',
            url: 'https://github.com/acme/orca/pull/44',
            status: 'pending',
            updatedAt: '2026-03-28T00:00:00Z',
            mergeable: 'UNKNOWN'
          },
          fetchedAt: Date.now(),
          linkedReviewHintKey: 'github:44'
        }
      }
    } as unknown as Partial<AppState>)
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'found',
      pr,
      fetchedAt: Date.now()
    })

    await expect(store.getState().fetchPRForBranch(repoPath, branch, { repoId })).resolves.toEqual(
      pr
    )
    expect(mockApi.gh.refreshPRNow).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        repoId,
        repoPath,
        branch,
        fallbackPRNumber: 44,
        fallbackPRSource: 'hosted-review'
      })
    })
    expect(store.getState().prCache[`${repoId}::${branch}`]).toMatchObject({
      data: expect.objectContaining({ number: 44 })
    })
  })

  it('clears a stale GitHub hosted-review fallback after an exact PR miss', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/stale-hosted-review-fallback'
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      prCache: {
        [`${repoId}::${branch}`]: {
          data: null,
          fetchedAt: 1
        }
      },
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: {
            provider: 'github',
            number: 44,
            title: 'Stale hosted-review PR',
            state: 'open',
            url: 'https://github.com/acme/orca/pull/44',
            status: 'pending',
            updatedAt: '2026-03-28T00:00:00Z',
            mergeable: 'UNKNOWN'
          },
          fetchedAt: 1,
          linkedReviewHintKey: 'github:44'
        }
      }
    } as unknown as Partial<AppState>)
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({ kind: 'no-pr', fetchedAt: 2 })

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, { force: true, repoId })
    ).resolves.toBeNull()
    expect(store.getState().prCache[`${repoId}::${branch}`]).toEqual({
      data: null,
      fetchedAt: 2
    })
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
      data: null,
      fetchedAt: 2,
      linkedReviewHintKey: 'github:44'
    })
  })

  it('records PR refresh errors without clearing cached PR data', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const cacheKey = `${repoPath}::${branch}`
    const cachedPR = makePR({ number: 12 })

    store.setState({
      prCache: {
        [cacheKey]: {
          data: cachedPR,
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoPath, branch }],
      reason: 'manual',
      outcome: {
        kind: 'upstream-error',
        errorType: 'network',
        message: 'network unavailable',
        fetchedAt: Date.now()
      }
    })

    expect(store.getState().prCache[cacheKey]?.data).toEqual(cachedPR)
    expect(store.getState().prRefreshStates[cacheKey]).toMatchObject({
      status: 'error',
      reason: 'manual',
      message: 'network unavailable'
    })
  })
})
