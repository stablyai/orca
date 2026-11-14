import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _clearGitHubPRRefreshStartedEntriesForTest } from '../requests/request-coordination'
import {
  createTestStore,
  makePR,
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

  it('ignores a direct exact linked PR refresh after the worktree was unlinked', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/unlinked-direct-pr'
    const worktreeId = 'wt-unlinked-direct-pr'
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    let resolveRefresh: (
      value: Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>
    ) => void = () => {}
    const refresh = new Promise<Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>>((resolve) => {
      resolveRefresh = resolve
    })
    mockApi.gh.refreshPRNow.mockReturnValueOnce(refresh)

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: {
        [repoId]: [
          {
            id: worktreeId,
            repoId,
            path: '/repo/worktrees/unlinked-direct-pr',
            branch,
            displayName: 'unlinked-direct-pr',
            isMainWorktree: false,
            isBare: false,
            isArchived: false,
            linkedPR: 12
          }
        ]
      }
    } as unknown as Partial<AppState>)

    const request = store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId,
      worktreeId,
      linkedPRNumber: 12
    })
    store.setState({
      worktreesByRepo: {
        [repoId]: [
          {
            id: worktreeId,
            repoId,
            path: '/repo/worktrees/unlinked-direct-pr',
            branch,
            displayName: 'unlinked-direct-pr',
            isMainWorktree: false,
            isBare: false,
            isArchived: false,
            linkedPR: null
          }
        ]
      },
      hostedReviewCache: {},
      prCache: {}
    } as unknown as Partial<AppState>)
    resolveRefresh({
      kind: 'found',
      pr: makePR({ number: 12, title: 'Stale exact linked PR' }),
      fetchedAt: Date.now()
    })

    await expect(request).resolves.toBeNull()

    expect(store.getState().prCache[`${repoId}::${branch}`]).toBeUndefined()
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toBeUndefined()
  })
})
