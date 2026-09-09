import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _clearGitHubPRRefreshStartedEntriesForTest } from '../github/request-coordination'
import {
  createTestStore,
  installLinkedPRClearStub,
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

  it('clears a linked merged PR when the resolved PR definitively diverged from the request head', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/new-work'
    const worktreeId = 'wt-diverged-linked-pr'
    const worktree = makePRRefreshWorktree({
      id: worktreeId,
      repoId,
      branch,
      head: 'current-head',
      linkedPR: 12
    })
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree
    })
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({
        number: 12,
        state: 'merged',
        headSha: 'merged-pr-head',
        headDivergedFromMergedPRAtOid: 'current-head'
      }),
      fetchedAt: 2
    })

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, {
        force: true,
        repoId,
        worktreeId,
        linkedPRNumber: 12
      })
    ).resolves.toMatchObject({ number: 12 })

    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      worktreeId,
      { linkedPR: null },
      { shouldApply: expect.any(Function) }
    )
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBeNull()
    expect(store.getState().prCache[`${repoId}::${branch}`]).toBeUndefined()
  })

  it('unlinks a stale open PR and re-resolves the current branch with one follow-up lookup', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/current'
    const worktreeId = 'wt-stale-open-pr'
    const stalePR = makePR({
      number: 12,
      title: 'Stale linked PR',
      headSha: 'old-head',
      headRefName: 'feature/old'
    })
    const currentPR = makePR({
      number: 13,
      title: 'Current branch PR',
      headSha: 'current-head',
      headRefName: branch
    })
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree: makePRRefreshWorktree({
        id: worktreeId,
        repoId,
        branch,
        head: 'current-head',
        linkedPR: 12
      })
    })
    mockApi.gh.refreshPRNow
      .mockResolvedValueOnce({ kind: 'found', pr: stalePR, fetchedAt: 2 })
      .mockResolvedValueOnce({ kind: 'found', pr: currentPR, fetchedAt: 3 })

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, {
        force: true,
        repoId,
        worktreeId,
        linkedPRNumber: 12
      })
    ).resolves.toEqual(stalePR)

    await vi.waitFor(() => {
      expect(mockApi.gh.refreshPRNow).toHaveBeenCalledTimes(2)
      expect(store.getState().prCache[`${repoId}::${branch}`]?.data).toEqual(currentPR)
    })
    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      worktreeId,
      { linkedPR: null },
      {
        suppressHostedReviewRefresh: true,
        shouldApply: expect.any(Function)
      }
    )
    expect(mockApi.gh.refreshPRNow.mock.calls[1]?.[0]).toMatchObject({
      candidate: expect.objectContaining({
        branch,
        linkedPRNumber: null,
        worktreeId
      })
    })
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBeNull()
  })

  it('clears a linked merged PR on a fresh cache hit that already carries a head-scoped divergence signal', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/cached-diverged'
    const worktreeId = 'wt-cached-diverged'
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree: makePRRefreshWorktree({
        id: worktreeId,
        repoId,
        branch,
        head: 'current-head',
        linkedPR: 12
      })
    })
    store.setState({
      prCache: {
        [`${repoId}::${branch}`]: {
          data: makePR({
            number: 12,
            state: 'merged',
            headSha: 'merged-pr-head',
            headDivergedFromMergedPRAtOid: 'current-head'
          }),
          fetchedAt: Date.now()
        }
      }
    } as unknown as Partial<AppState>)

    const result = await store.getState().fetchPRForBranch(repoPath, branch, {
      repoId,
      worktreeId,
      linkedPRNumber: 12
    })

    expect(result).toMatchObject({ number: 12 })
    expect(mockApi.gh.refreshPRNow).not.toHaveBeenCalled()
    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      worktreeId,
      { linkedPR: null },
      { shouldApply: expect.any(Function) }
    )
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBeNull()
  })

  it('does not clear a linked merged PR when the request head equals the PR head', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/at-pr-head'
    const worktreeId = 'wt-at-pr-head'
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree: makePRRefreshWorktree({
        id: worktreeId,
        repoId,
        branch,
        head: 'same-head',
        linkedPR: 12
      })
    })
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({
        number: 12,
        state: 'merged',
        headSha: 'same-head',
        headDivergedFromMergedPRAtOid: 'same-head'
      }),
      fetchedAt: 2
    })

    await store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId,
      worktreeId,
      linkedPRNumber: 12
    })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBe(12)
  })

  it('does not clear a linked merged PR when the request head is confirmed contained', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/contained'
    const worktreeId = 'wt-contained'
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree: makePRRefreshWorktree({
        id: worktreeId,
        repoId,
        branch,
        head: 'contained-head',
        linkedPR: 12
      })
    })
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({
        number: 12,
        state: 'merged',
        headSha: 'merged-pr-head',
        confirmedContainedHeadOid: 'contained-head',
        headDivergedFromMergedPRAtOid: 'contained-head'
      }),
      fetchedAt: 2
    })

    await store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId,
      worktreeId,
      linkedPRNumber: 12
    })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBe(12)
  })

  it('does not clear a linked open PR even when a divergence bit is present', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/open-pr'
    const worktreeId = 'wt-open-pr'
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree: makePRRefreshWorktree({
        id: worktreeId,
        repoId,
        branch,
        head: 'current-head',
        linkedPR: 12
      })
    })
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({
        number: 12,
        state: 'open',
        headSha: 'pr-head',
        headDivergedFromMergedPRAtOid: 'current-head'
      }),
      fetchedAt: 2
    })

    await store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId,
      worktreeId,
      linkedPRNumber: 12
    })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('does not clear a linked PR on a null PR result', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/null-pr'
    const worktreeId = 'wt-null-pr'
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree: makePRRefreshWorktree({
        id: worktreeId,
        repoId,
        branch,
        head: 'current-head',
        linkedPR: 12
      })
    })
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({ kind: 'no-pr', fetchedAt: 2 })

    await store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId,
      worktreeId,
      linkedPRNumber: 12
    })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('does not clear when divergence is unset even if containment does not match the head', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/unknown-probe'
    const worktreeId = 'wt-unknown-probe'
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree: makePRRefreshWorktree({
        id: worktreeId,
        repoId,
        branch,
        head: 'current-head',
        linkedPR: 12
      })
    })
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({
        number: 12,
        state: 'merged',
        headSha: 'merged-pr-head',
        confirmedContainedHeadOid: 'other-head'
      }),
      fetchedAt: 2
    })

    await store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId,
      worktreeId,
      linkedPRNumber: 12
    })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBe(12)
  })

  it('does not clear when the linked PR number changed before the lookup completed', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/relinked'
    const worktreeId = 'wt-relinked'
    let resolveRefresh: (
      value: Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>
    ) => void = () => {}
    const refresh = new Promise<Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>>((resolve) => {
      resolveRefresh = resolve
    })
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree: makePRRefreshWorktree({
        id: worktreeId,
        repoId,
        branch,
        head: 'current-head',
        linkedPR: 12
      })
    })
    mockApi.gh.refreshPRNow.mockReturnValueOnce(refresh)

    const request = store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId,
      worktreeId,
      linkedPRNumber: 12
    })
    store.setState({
      worktreesByRepo: {
        [repoId]: [
          makePRRefreshWorktree({
            id: worktreeId,
            repoId,
            branch,
            head: 'current-head',
            linkedPR: 13
          })
        ]
      }
    } as unknown as Partial<AppState>)
    resolveRefresh({
      kind: 'found',
      pr: makePR({
        number: 12,
        state: 'merged',
        headSha: 'merged-pr-head',
        headDivergedFromMergedPRAtOid: 'current-head'
      }),
      fetchedAt: 2
    })

    await expect(request).resolves.toBeNull()
    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBe(13)
  })

  it('does not clear when the worktree head moved after the lookup started', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/head-moved'
    const worktreeId = 'wt-head-moved'
    let resolveRefresh: (
      value: Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>
    ) => void = () => {}
    const refresh = new Promise<Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>>((resolve) => {
      resolveRefresh = resolve
    })
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree: makePRRefreshWorktree({
        id: worktreeId,
        repoId,
        branch,
        head: 'request-head',
        linkedPR: 12
      })
    })
    mockApi.gh.refreshPRNow.mockReturnValueOnce(refresh)

    const request = store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId,
      worktreeId,
      linkedPRNumber: 12
    })
    store.setState({
      worktreesByRepo: {
        [repoId]: [
          makePRRefreshWorktree({
            id: worktreeId,
            repoId,
            branch,
            head: 'new-head',
            linkedPR: 12
          })
        ]
      }
    } as unknown as Partial<AppState>)
    resolveRefresh({
      kind: 'found',
      pr: makePR({
        number: 12,
        state: 'merged',
        headSha: 'merged-pr-head',
        headDivergedFromMergedPRAtOid: 'request-head'
      }),
      fetchedAt: 2
    })

    await expect(request).resolves.toMatchObject({ number: 12 })
    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      worktreeId,
      { linkedPR: null },
      { shouldApply: expect.any(Function) }
    )
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBe(12)
    expect(store.getState().prCache[`${repoId}::${branch}`]).toMatchObject({
      data: expect.objectContaining({ number: 12 })
    })
  })
})
