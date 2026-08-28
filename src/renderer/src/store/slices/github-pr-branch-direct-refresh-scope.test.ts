import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _clearGitHubPRRefreshStartedEntriesForTest,
  _getGitHubPRRequestGenerationCountForTest
} from '../github/request-coordination'
import {
  createTestStore,
  makePR,
  mockApi,
  resetRemoteRuntimeMocks
} from './github-slice-test-harness'
import type { AppState } from '../types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
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

  it('lets a forced refresh bypass a non-forced inflight request and keeps the newer result', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const prCacheKey = `${repoPath}::${branch}`
    const refreshPRNow = mockApi.gh.refreshPRNow
    ;(mockApi.gh as unknown as { refreshPRNow?: typeof refreshPRNow }).refreshPRNow = undefined

    let resolveInitial: ((value: null) => void) | undefined
    const initialRequest = new Promise<null>((resolve) => {
      resolveInitial = resolve
    })

    mockApi.gh.prForBranch
      .mockReturnValueOnce(initialRequest)
      .mockResolvedValueOnce(makePR({ number: 99, title: 'Forced refresh PR' }))

    try {
      const initialFetch = store.getState().fetchPRForBranch(repoPath, branch)
      const forcedFetch = store.getState().fetchPRForBranch(repoPath, branch, { force: true })

      await expect(forcedFetch).resolves.toMatchObject({ number: 99, title: 'Forced refresh PR' })
      expect(mockApi.gh.prForBranch).toHaveBeenCalledTimes(2)
      expect(store.getState().prCache[prCacheKey]?.data).toMatchObject({ number: 99 })

      resolveInitial?.(null)
      await expect(initialFetch).resolves.toBeNull()

      expect(store.getState().prCache[prCacheKey]?.data).toMatchObject({ number: 99 })
    } finally {
      mockApi.gh.refreshPRNow = refreshPRNow
    }
  })

  it('does not retain PR request generation keys after the active request settles', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/no-generation-leak'
    const beforeCount = _getGitHubPRRequestGenerationCountForTest()
    const refreshPRNow = mockApi.gh.refreshPRNow
    ;(mockApi.gh as unknown as { refreshPRNow?: typeof refreshPRNow }).refreshPRNow = undefined
    mockApi.gh.prForBranch.mockResolvedValueOnce(makePR({ number: 31 }))

    try {
      await expect(
        store.getState().fetchPRForBranch(repoPath, branch, { force: true })
      ).resolves.toMatchObject({ number: 31 })
      expect(_getGitHubPRRequestGenerationCountForTest()).toBe(beforeCount)
    } finally {
      mockApi.gh.refreshPRNow = refreshPRNow
    }
  })

  it('passes SSH connection identity to GitHub refresh IPC for SSH-backed repos', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const pr = makePR({ number: 44 })

    store.setState({
      repos: [
        {
          id: 'repo-1',
          path: repoPath,
          name: 'repo',
          kind: 'git',
          connectionId: 'ssh-1'
        }
      ],
      prCache: {
        [`repo-1::${branch}`]: {
          data: pr,
          fetchedAt: Date.now()
        }
      }
    } as unknown as Partial<AppState>)
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'found',
      pr,
      fetchedAt: Date.now()
    })

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, { force: true })
    ).resolves.toMatchObject({ number: 44 })
    expect(mockApi.gh.prForBranch).not.toHaveBeenCalled()
    expect(mockApi.gh.refreshPRNow).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        repoId: 'repo-1',
        repoPath,
        branch,
        cacheKey: `ssh:ssh-1::repo-1::${branch}`,
        connectionId: 'ssh-1'
      })
    })
  })

  it('does not reuse local fresh PR cache for SSH-backed repos', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const pr = makePR({ number: 44 })

    store.setState({
      repos: [
        {
          id: 'repo-1',
          path: repoPath,
          name: 'repo',
          kind: 'git',
          connectionId: 'ssh-1'
        }
      ],
      prCache: {
        [`repo-1::${branch}`]: {
          data: makePR({ number: 12, title: 'Local stale PR' }),
          fetchedAt: Date.now()
        }
      }
    } as unknown as Partial<AppState>)
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'found',
      pr,
      fetchedAt: Date.now()
    })

    await expect(store.getState().fetchPRForBranch(repoPath, branch)).resolves.toMatchObject({
      number: 44
    })

    expect(mockApi.gh.refreshPRNow).toHaveBeenCalled()
    expect(store.getState().prCache[`ssh:ssh-1::repo-1::${branch}`]?.data).toMatchObject({
      number: 44
    })
    expect(store.getState().prCache[`repo-1::${branch}`]?.data).toMatchObject({
      title: 'Local stale PR'
    })
  })

  it('writes direct PR refresh results to the hosted-review scope captured at request start', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/scope-switch'
    const localHostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const runtimeHostedReviewCacheKey = getHostedReviewCacheKey(
      repoPath,
      branch,
      { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repoId
    )
    let resolveRefresh: (
      value: Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>
    ) => void = () => {}
    const refresh = new Promise<Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>>((resolve) => {
      resolveRefresh = resolve
    })
    mockApi.gh.refreshPRNow.mockReturnValueOnce(refresh)

    store.setState({
      settings: null,
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    const request = store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings']
    } as Partial<AppState>)
    resolveRefresh({
      kind: 'found',
      pr: makePR({ number: 12, title: 'Local request result' }),
      fetchedAt: 2
    })

    await expect(request).resolves.toMatchObject({ title: 'Local request result' })
    expect(store.getState().hostedReviewCache[localHostedReviewCacheKey]).toMatchObject({
      data: expect.objectContaining({ provider: 'github', title: 'Local request result' }),
      linkedReviewHintKey: 'github:12',
      branchLookupGitHubPRNumber: 12
    })
    expect(store.getState().hostedReviewCache[runtimeHostedReviewCacheKey]).toBeUndefined()
  })

  it('does not mark an exact linked PR refresh as branch-discovered', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/exact-linked-provenance'
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({ number: 12 }),
      fetchedAt: 2
    })

    await store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId,
      linkedPRNumber: 12
    })

    const cacheEntry = store.getState().hostedReviewCache[hostedReviewCacheKey]
    expect(cacheEntry).toMatchObject({
      data: expect.objectContaining({ provider: 'github', number: 12 }),
      linkedReviewHintKey: 'github:12'
    })
    expect(cacheEntry).not.toHaveProperty('branchLookupGitHubPRNumber')
  })

  it('does not let an older direct PR refresh overwrite a newer hosted-review cache entry', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/newer-hosted-review'
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const newerReview: HostedReviewInfo = {
      provider: 'github',
      number: 12,
      title: 'Newer hosted review status',
      state: 'open',
      url: 'https://github.com/acme/orca/pull/12',
      status: 'success',
      updatedAt: '2026-03-28T00:00:00Z',
      mergeable: 'MERGEABLE'
    }
    let resolveRefresh: (
      value: Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>
    ) => void = () => {}
    const refresh = new Promise<Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>>((resolve) => {
      resolveRefresh = resolve
    })
    mockApi.gh.refreshPRNow.mockReturnValueOnce(refresh)

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    const request = store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId
    })
    store.setState({
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: newerReview,
          fetchedAt: Date.now() + 1_000,
          linkedReviewHintKey: 'github:12'
        }
      }
    } as unknown as Partial<AppState>)
    resolveRefresh({
      kind: 'found',
      pr: makePR({ number: 12, title: 'Older direct PR refresh' }),
      fetchedAt: Date.now() + 2_000
    })

    await expect(request).resolves.toMatchObject({ title: 'Older direct PR refresh' })
    expect(store.getState().prCache[`${repoId}::${branch}`]).toBeUndefined()
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
      data: newerReview,
      fetchedAt: expect.any(Number),
      linkedReviewHintKey: 'github:12'
    })
  })

  it('writes exact fallback PR data even when the matching hosted-review cache is newer', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/newer-matching-hosted-review'
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const matchingReview: HostedReviewInfo = {
      provider: 'github',
      number: 12,
      title: 'Already attached PR',
      state: 'open',
      url: 'https://github.com/acme/orca/pull/12',
      status: 'pending',
      updatedAt: '2026-03-28T00:00:00Z',
      mergeable: 'UNKNOWN'
    }
    const pr = makePR({ number: 12, title: 'Exact fallback PR' })
    let resolveRefresh: (
      value: Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>
    ) => void = () => {}
    const refresh = new Promise<Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>>((resolve) => {
      resolveRefresh = resolve
    })
    mockApi.gh.refreshPRNow.mockReturnValueOnce(refresh)

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    const request = store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId,
      fallbackPRNumber: 12
    })
    store.setState({
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: matchingReview,
          fetchedAt: Date.now() + 1_000,
          linkedReviewHintKey: 'github:12'
        }
      }
    } as unknown as Partial<AppState>)
    resolveRefresh({
      kind: 'found',
      pr,
      fetchedAt: Date.now() + 2_000
    })

    await expect(request).resolves.toEqual(pr)
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
      data: matchingReview,
      fetchedAt: expect.any(Number),
      linkedReviewHintKey: 'github:12'
    })
    expect(store.getState().prCache[`${repoId}::${branch}`]).toEqual({
      data: pr,
      fetchedAt: expect.any(Number)
    })
  })

  it('writes exact linked PR data after create-PR handoff races a hosted-review refresh', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/create-pr'
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const createdReview: HostedReviewInfo = {
      provider: 'github',
      number: 88,
      title: 'Created PR',
      state: 'open',
      url: 'https://github.com/acme/orca/pull/88',
      status: 'pending',
      updatedAt: '2026-03-28T00:00:00Z',
      mergeable: 'UNKNOWN'
    }
    const pr = makePR({ number: 88, title: 'Created PR' })
    let resolveRefresh: (
      value: Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>
    ) => void = () => {}
    const refresh = new Promise<Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>>((resolve) => {
      resolveRefresh = resolve
    })
    mockApi.gh.refreshPRNow.mockReturnValueOnce(refresh)

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    const request = store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId,
      linkedPRNumber: 88
    })
    store.setState({
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: createdReview,
          fetchedAt: Date.now() + 1_000,
          linkedReviewHintKey: 'github:88'
        }
      }
    } as unknown as Partial<AppState>)
    resolveRefresh({
      kind: 'found',
      pr,
      fetchedAt: Date.now() + 2_000
    })

    await expect(request).resolves.toEqual(pr)
    expect(store.getState().prCache[`${repoId}::${branch}`]).toEqual({
      data: pr,
      fetchedAt: expect.any(Number)
    })
  })

  it('does not let a same-millisecond direct PR refresh overwrite an external hosted-review write', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100)
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/same-ms-hosted-review'
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const externalReview: HostedReviewInfo = {
      provider: 'github',
      number: 12,
      title: 'Same-ms external hosted review status',
      state: 'open',
      url: 'https://github.com/acme/orca/pull/12',
      status: 'success',
      updatedAt: '2026-03-28T00:00:00Z',
      mergeable: 'MERGEABLE'
    }
    let resolveRefresh: (
      value: Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>
    ) => void = () => {}
    const refresh = new Promise<Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>>((resolve) => {
      resolveRefresh = resolve
    })
    mockApi.gh.refreshPRNow.mockReturnValueOnce(refresh)

    try {
      store.setState({
        repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
      } as unknown as Partial<AppState>)

      const request = store.getState().fetchPRForBranch(repoPath, branch, {
        force: true,
        repoId
      })
      store.setState({
        hostedReviewCache: {
          [hostedReviewCacheKey]: {
            data: externalReview,
            fetchedAt: Date.now(),
            linkedReviewHintKey: 'github:12'
          }
        }
      } as unknown as Partial<AppState>)
      resolveRefresh({
        kind: 'found',
        pr: makePR({ number: 12, title: 'Same-ms direct PR refresh' }),
        fetchedAt: Date.now()
      })

      await expect(request).resolves.toMatchObject({ title: 'Same-ms direct PR refresh' })
      expect(store.getState().prCache[`${repoId}::${branch}`]).toBeUndefined()
      expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
        data: externalReview,
        fetchedAt: 100,
        linkedReviewHintKey: 'github:12'
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
