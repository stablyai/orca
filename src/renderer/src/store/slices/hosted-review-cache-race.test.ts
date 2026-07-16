import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import { createHostedReviewSlice, getHostedReviewCacheKey } from './hosted-review'
import type { HostedReviewInfo, HostedReviewLookupResult } from '../../../../shared/hosted-review'

const runtimeRpc = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: runtimeRpc.callRuntimeRpc,
  getActiveRuntimeTarget: (
    settings: { activeRuntimeEnvironmentId?: string | null } | null | undefined
  ) => {
    const environmentId = settings?.activeRuntimeEnvironmentId?.trim()
    return environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }
  }
}))

const mockApi = {
  hostedReview: {
    forBranch: vi.fn(),
    getCreationEligibility: vi.fn(),
    create: vi.fn()
  }
}

globalThis.window = { api: mockApi } as never

function makeStore(settings: AppState['settings'] = null) {
  return create<
    Pick<
      AppState,
      | 'hostedReviewCache'
      | 'fetchHostedReviewForBranch'
      | 'getHostedReviewCreationEligibility'
      | 'createHostedReview'
      | 'settings'
      | 'repos'
    >
  >()((...args) => ({
    settings,
    repos: [{ id: 'repo-1', path: '/repo', connectionId: null } as AppState['repos'][number]],
    ...createHostedReviewSlice(...(args as Parameters<typeof createHostedReviewSlice>))
  }))
}

const review: HostedReviewInfo = {
  provider: 'gitlab',
  number: 5,
  title: 'Shared MR status',
  state: 'open',
  url: 'https://gitlab.com/g/p/-/merge_requests/5',
  status: 'success',
  updatedAt: '2026-05-10T00:00:00.000Z',
  mergeable: 'MERGEABLE'
}

const found = (value: HostedReviewInfo): HostedReviewLookupResult => ({
  kind: 'found',
  review: value
})

function makeGitHubReview(title: string): HostedReviewInfo {
  return {
    ...review,
    provider: 'github',
    number: 42,
    title,
    url: 'https://github.com/acme/orca/pull/42'
  }
}

describe('hosted review cache race protection', () => {
  beforeEach(() => {
    mockApi.hostedReview.forBranch.mockReset()
    mockApi.hostedReview.getCreationEligibility.mockReset()
    mockApi.hostedReview.create.mockReset()
    runtimeRpc.callRuntimeRpc.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not let an older successful fetch overwrite a newer external cache write', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100)
    const olderReview: HostedReviewInfo = { ...review, title: 'Older hosted review status' }
    const newerReview = makeGitHubReview('Newer GitHub refresh status')
    let resolveFetch: (value: HostedReviewLookupResult) => void = () => {}
    const fetch = new Promise<HostedReviewLookupResult>((resolve) => {
      resolveFetch = resolve
    })
    mockApi.hostedReview.forBranch.mockReturnValueOnce(fetch)
    const store = makeStore()
    const cacheKey = getHostedReviewCacheKey(
      '/repo',
      'feature/race',
      null,
      'repo-1',
      null,
      null,
      true
    )

    const request = store.getState().fetchHostedReviewForBranch('/repo', 'feature/race')
    vi.setSystemTime(200)
    store.setState({
      hostedReviewCache: {
        [cacheKey]: {
          data: newerReview,
          fetchedAt: Date.now(),
          linkedReviewHintKey: 'github:42'
        }
      }
    })
    vi.setSystemTime(300)
    resolveFetch(found(olderReview))

    await expect(request).resolves.toEqual(olderReview)
    expect(store.getState().hostedReviewCache[cacheKey]).toEqual({
      data: newerReview,
      fetchedAt: 200,
      linkedReviewHintKey: 'github:42'
    })
  })

  it('does not let an older failed fetch overwrite a newer external cache write', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const newerReview = makeGitHubReview('Newer GitHub refresh status')
    let rejectFetch: (error: Error) => void = () => {}
    const fetch = new Promise<HostedReviewInfo>((_resolve, reject) => {
      rejectFetch = reject
    })
    mockApi.hostedReview.forBranch.mockReturnValueOnce(fetch)
    const store = makeStore()
    const cacheKey = getHostedReviewCacheKey(
      '/repo',
      'feature/error-race',
      null,
      'repo-1',
      null,
      null,
      true
    )

    try {
      const request = store.getState().fetchHostedReviewForBranch('/repo', 'feature/error-race')
      vi.setSystemTime(200)
      store.setState({
        hostedReviewCache: {
          [cacheKey]: {
            data: newerReview,
            fetchedAt: Date.now(),
            linkedReviewHintKey: 'github:42'
          }
        }
      })
      vi.setSystemTime(300)
      rejectFetch(new Error('older lookup failed'))

      // Why: a failed lookup preserves (and returns) the last known review
      // instead of caching a definitive miss that would blank the card.
      await expect(request).resolves.toEqual(newerReview)
      expect(store.getState().hostedReviewCache[cacheKey]).toEqual({
        data: newerReview,
        fetchedAt: 200,
        linkedReviewHintKey: 'github:42'
      })
    } finally {
      consoleError.mockRestore()
    }
  })

  it('keeps the last known review when a refresh fails instead of caching a miss', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cachedReview = makeGitHubReview('Known PR status')
    const cacheKey = getHostedReviewCacheKey(
      '/repo',
      'feature/keep-on-error',
      null,
      'repo-1',
      null,
      null,
      true
    )
    let rejectFetch: (error: Error) => void = () => {}
    const fetch = new Promise<HostedReviewInfo>((_resolve, reject) => {
      rejectFetch = reject
    })
    mockApi.hostedReview.forBranch.mockReturnValueOnce(fetch)
    const store = makeStore()
    store.setState({
      hostedReviewCache: {
        [cacheKey]: { data: cachedReview, fetchedAt: 100, linkedReviewHintKey: 'github:42' }
      }
    })

    try {
      const request = store
        .getState()
        .fetchHostedReviewForBranch('/repo', 'feature/keep-on-error', { force: true })
      vi.setSystemTime(300)
      rejectFetch(new Error('transient gh failure'))

      await expect(request).resolves.toEqual(cachedReview)
      // Why: the cached review survives untouched; no fresh `data: null` miss is
      // written, so the card keeps showing the PR and retries on the next poll.
      expect(store.getState().hostedReviewCache[cacheKey]).toEqual({
        data: cachedReview,
        fetchedAt: 100,
        linkedReviewHintKey: 'github:42'
      })
    } finally {
      consoleError.mockRestore()
    }
  })

  it('preserves cached review and deduplicates expected upstream diagnostics while retrying', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cachedReview = makeGitHubReview('Known PR status')
    const cacheKey = getHostedReviewCacheKey(
      '/repo',
      'feature/typed-upstream-error',
      null,
      'repo-1',
      null,
      null,
      true
    )
    mockApi.hostedReview.forBranch.mockResolvedValue({
      kind: 'upstream-error',
      provider: 'github',
      errorType: 'repo_unavailable'
    })
    const store = makeStore()
    store.setState({
      hostedReviewCache: {
        [cacheKey]: { data: cachedReview, fetchedAt: 100, linkedReviewHintKey: 'github:42' }
      }
    })

    try {
      await expect(
        store
          .getState()
          .fetchHostedReviewForBranch('/repo', 'feature/typed-upstream-error', { force: true })
      ).resolves.toEqual(cachedReview)
      await expect(
        store
          .getState()
          .fetchHostedReviewForBranch('/repo', 'feature/typed-upstream-error', { force: true })
      ).resolves.toEqual(cachedReview)

      expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(2)
      expect(consoleWarn).toHaveBeenCalledTimes(1)
      expect(consoleWarn).toHaveBeenCalledWith('[hosted-review] lookup unavailable', {
        repoId: 'repo-1',
        provider: 'github',
        errorType: 'repo_unavailable'
      })
      expect(store.getState().hostedReviewCache[cacheKey]).toEqual({
        data: cachedReview,
        fetchedAt: 100,
        linkedReviewHintKey: 'github:42'
      })
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it('ignores a superseded upstream diagnostic after a newer request completes', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let resolveOlder: (value: HostedReviewLookupResult) => void = () => {}
    let resolveCurrent: (value: HostedReviewLookupResult) => void = () => {}
    const older = new Promise<HostedReviewLookupResult>((resolve) => {
      resolveOlder = resolve
    })
    const current = new Promise<HostedReviewLookupResult>((resolve) => {
      resolveCurrent = resolve
    })
    mockApi.hostedReview.forBranch
      .mockReturnValueOnce(older)
      .mockResolvedValueOnce(found(review))
      .mockReturnValueOnce(current)
    const store = makeStore()

    try {
      const olderRequest = store
        .getState()
        .fetchHostedReviewForBranch('/repo', 'feature/stale-diagnostic')
      await store
        .getState()
        .fetchHostedReviewForBranch('/repo', 'feature/stale-diagnostic', { force: true })
      const currentRequest = store
        .getState()
        .fetchHostedReviewForBranch('/repo', 'feature/stale-diagnostic', { force: true })

      resolveOlder({ kind: 'upstream-error', provider: 'github', errorType: 'network' })
      await olderRequest
      resolveCurrent(found(review))
      await currentRequest

      expect(consoleWarn).not.toHaveBeenCalled()
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it('does not let a superseded success clear the current failure diagnostic', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let resolveOlder: (value: HostedReviewLookupResult) => void = () => {}
    let resolveCurrent: (value: HostedReviewLookupResult) => void = () => {}
    const older = new Promise<HostedReviewLookupResult>((resolve) => {
      resolveOlder = resolve
    })
    const current = new Promise<HostedReviewLookupResult>((resolve) => {
      resolveCurrent = resolve
    })
    const failure = {
      kind: 'upstream-error' as const,
      provider: 'github' as const,
      errorType: 'network' as const
    }
    mockApi.hostedReview.forBranch
      .mockReturnValueOnce(older)
      .mockResolvedValueOnce(failure)
      .mockReturnValueOnce(current)
    const store = makeStore()

    try {
      const olderRequest = store
        .getState()
        .fetchHostedReviewForBranch('/repo', 'feature/stale-success')
      await store
        .getState()
        .fetchHostedReviewForBranch('/repo', 'feature/stale-success', { force: true })
      const currentRequest = store
        .getState()
        .fetchHostedReviewForBranch('/repo', 'feature/stale-success', { force: true })

      resolveOlder(found(review))
      await olderRequest
      resolveCurrent(failure)
      await currentRequest

      expect(consoleWarn).toHaveBeenCalledTimes(1)
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it('does not clear an expected failure diagnostic after an unexpected rejection', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = {
      kind: 'upstream-error' as const,
      provider: 'github' as const,
      errorType: 'network' as const
    }
    mockApi.hostedReview.forBranch
      .mockResolvedValueOnce(failure)
      .mockRejectedValueOnce(new Error('unexpected lookup defect'))
      .mockResolvedValueOnce(failure)
    const store = makeStore()

    try {
      await store
        .getState()
        .fetchHostedReviewForBranch('/repo', 'feature/rejected-diagnostic', { force: true })
      await store
        .getState()
        .fetchHostedReviewForBranch('/repo', 'feature/rejected-diagnostic', { force: true })
      await store
        .getState()
        .fetchHostedReviewForBranch('/repo', 'feature/rejected-diagnostic', { force: true })

      expect(consoleWarn).toHaveBeenCalledTimes(1)
      expect(consoleError).toHaveBeenCalledTimes(1)
    } finally {
      consoleWarn.mockRestore()
      consoleError.mockRestore()
    }
  })

  it('does not let a same-millisecond external cache write after request start be overwritten', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100)
    const olderReview: HostedReviewInfo = {
      ...review,
      title: 'Older same-ms hosted review status'
    }
    const newerReview = makeGitHubReview('Newer same-ms GitHub refresh status')
    let resolveFetch: (value: HostedReviewLookupResult) => void = () => {}
    const fetch = new Promise<HostedReviewLookupResult>((resolve) => {
      resolveFetch = resolve
    })
    mockApi.hostedReview.forBranch.mockReturnValueOnce(fetch)
    const store = makeStore()
    const cacheKey = getHostedReviewCacheKey(
      '/repo',
      'feature/same-ms-race',
      null,
      'repo-1',
      null,
      null,
      true
    )

    const request = store.getState().fetchHostedReviewForBranch('/repo', 'feature/same-ms-race')
    store.setState({
      hostedReviewCache: {
        [cacheKey]: {
          data: newerReview,
          fetchedAt: Date.now(),
          linkedReviewHintKey: 'github:42'
        }
      }
    })
    resolveFetch(found(olderReview))

    await expect(request).resolves.toEqual(olderReview)
    expect(store.getState().hostedReviewCache[cacheKey]).toEqual({
      data: newerReview,
      fetchedAt: 100,
      linkedReviewHintKey: 'github:42'
    })
  })

  it('does not block a pre-existing same-millisecond cache entry from being refreshed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100)
    const staleReview: HostedReviewInfo = {
      ...review,
      title: 'Pre-existing same-ms hosted review status'
    }
    const freshReview: HostedReviewInfo = {
      ...review,
      title: 'Fresh same-ms hosted review status'
    }
    mockApi.hostedReview.forBranch.mockResolvedValueOnce(found(freshReview))
    const store = makeStore()
    const cacheKey = getHostedReviewCacheKey(
      '/repo',
      'feature/same-ms-existing',
      null,
      'repo-1',
      null,
      null,
      true
    )

    store.setState({
      hostedReviewCache: {
        [cacheKey]: {
          data: staleReview,
          fetchedAt: Date.now()
        }
      }
    })

    await expect(
      store
        .getState()
        .fetchHostedReviewForBranch('/repo', 'feature/same-ms-existing', { force: true })
    ).resolves.toEqual(freshReview)
    expect(store.getState().hostedReviewCache[cacheKey]).toEqual({
      data: freshReview,
      fetchedAt: 100,
      linkedReviewHintKey: ''
    })
  })

  it('does not reuse a provider-scoped inflight request for neutral discovery', async () => {
    const githubReview = makeGitHubReview('Linked GitHub PR status')
    let resolveGitHubLookup: (value: HostedReviewLookupResult) => void = () => {}
    const githubLookup = new Promise<HostedReviewLookupResult>((resolve) => {
      resolveGitHubLookup = resolve
    })
    mockApi.hostedReview.forBranch
      .mockReturnValueOnce(githubLookup)
      .mockResolvedValueOnce(found(review))
    const store = makeStore()

    const linkedRequest = store.getState().fetchHostedReviewForBranch('/repo', 'feature/inflight', {
      linkedGitHubPR: 42
    })
    const neutralRequest = store.getState().fetchHostedReviewForBranch('/repo', 'feature/inflight')

    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(2)
    expect(mockApi.hostedReview.forBranch).toHaveBeenNthCalledWith(2, {
      branch: 'feature/inflight',
      currentHeadOid: null,
      linkedAzureDevOpsPR: null,
      linkedBitbucketPR: null,
      linkedGitHubPR: null,
      linkedGitLabMR: null,
      linkedGiteaPR: null,
      repoPath: '/repo'
    })
    resolveGitHubLookup(found(githubReview))

    await expect(linkedRequest).resolves.toEqual(githubReview)
    await expect(neutralRequest).resolves.toEqual(review)
  })
})
