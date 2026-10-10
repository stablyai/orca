import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import { createHostedReviewSlice } from './hosted-review'
import {
  _clearHostedReviewRequestGenerationsForTest,
  _getHostedReviewRequestGenerationCountForTest
} from './hosted-review-request-state'
import { getHostedReviewCacheKey } from './hosted-review-cache-identity'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'

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

describe('hosted review cache revalidation', () => {
  beforeEach(() => {
    mockApi.hostedReview.forBranch.mockReset()
    mockApi.hostedReview.getCreationEligibility.mockReset()
    mockApi.hostedReview.create.mockReset()
    runtimeRpc.callRuntimeRpc.mockReset()
    _clearHostedReviewRequestGenerationsForTest()
  })

  afterEach(() => {
    vi.useRealTimers()
    _clearHostedReviewRequestGenerationsForTest()
  })

  it('dedupes repeated linked PR retries while a stronger lookup is in flight', async () => {
    let resolveLinkedLookup: (value: typeof review) => void = () => {}
    const linkedLookup = new Promise<typeof review>((resolve) => {
      resolveLinkedLookup = resolve
    })
    mockApi.hostedReview.forBranch.mockResolvedValueOnce(null).mockReturnValueOnce(linkedLookup)
    const store = makeStore()

    await expect(store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr')).resolves.toBe(
      null
    )

    const firstLinkedFetch = store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr', {
      linkedGitHubPR: 42
    })
    const secondLinkedFetch = store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr', {
      linkedGitHubPR: 42
    })

    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(2)
    resolveLinkedLookup(review)
    await expect(firstLinkedFetch).resolves.toEqual(review)
    await expect(secondLinkedFetch).resolves.toEqual(review)
  })

  it('serves stale hosted review metadata while revalidating in the background', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const updatedReview: HostedReviewInfo = {
      ...review,
      title: 'Updated linked PR status',
      status: 'failure',
      updatedAt: '2026-05-10T00:01:01.000Z'
    }
    let resolveRefresh: (value: typeof updatedReview) => void = () => {}
    const refresh = new Promise<typeof updatedReview>((resolve) => {
      resolveRefresh = resolve
    })
    mockApi.hostedReview.forBranch
      .mockResolvedValueOnce(review)
      .mockReturnValueOnce(refresh as Promise<HostedReviewInfo>)
    const store = makeStore()

    await expect(
      store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr', {
        linkedGitHubPR: 42
      })
    ).resolves.toEqual(review)
    vi.setSystemTime(60_001)
    await expect(
      store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr', {
        linkedGitHubPR: 42,
        staleWhileRevalidate: true
      })
    ).resolves.toEqual(review)
    await expect(
      store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr', {
        linkedGitHubPR: 42,
        staleWhileRevalidate: true
      })
    ).resolves.toEqual(review)

    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(2)
    const cacheKey = getHostedReviewCacheKey(
      '/repo',
      'feature/pr',
      null,
      'repo-1',
      null,
      null,
      true
    )
    expect(store.getState().hostedReviewCache[cacheKey]?.data).toEqual(review)

    resolveRefresh(updatedReview)
    await refresh
    await Promise.resolve()

    expect(store.getState().hostedReviewCache[cacheKey]?.data).toEqual(updatedReview)
  })

  it('coalesces M card poll ticks into one trailing run after the slowTaskBackoff gap', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let resolveRefresh: (value: HostedReviewInfo) => void = () => {}
    const slowRefresh = new Promise<HostedReviewInfo>((resolve) => {
      resolveRefresh = resolve
    })
    mockApi.hostedReview.forBranch
      .mockResolvedValueOnce(review)
      .mockReturnValueOnce(slowRefresh)
      .mockResolvedValue(review)
    const store = makeStore()
    const options = { linkedGitHubPR: 42, staleWhileRevalidate: true }

    await store
      .getState()
      .fetchHostedReviewForBranch('/repo', 'feature/slow-poll', { linkedGitHubPR: 42 })
    vi.setSystemTime(60_001)
    await store.getState().fetchHostedReviewForBranch('/repo', 'feature/slow-poll', options)
    for (let tick = 0; tick < 5; tick += 1) {
      await store.getState().fetchHostedReviewForBranch('/repo', 'feature/slow-poll', options)
    }
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(10_000)
    resolveRefresh(review)
    await slowRefresh
    await Promise.resolve()
    await Promise.resolve()
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(49_999)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(3)
  })

  it('lets a force refresh supersede queued stale-while-revalidate work', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let resolveBackground: (value: HostedReviewInfo) => void = () => {}
    let resolveForce: (value: HostedReviewInfo) => void = () => {}
    const background = new Promise<HostedReviewInfo>((resolve) => {
      resolveBackground = resolve
    })
    const force = new Promise<HostedReviewInfo>((resolve) => {
      resolveForce = resolve
    })
    const forcedReview = { ...review, title: 'Manual refresh result' }
    mockApi.hostedReview.forBranch
      .mockResolvedValueOnce(review)
      .mockReturnValueOnce(background)
      .mockReturnValueOnce(force)
      .mockResolvedValue(review)
    const store = makeStore()
    const branch = 'feature/force-supersedes-poll'
    const staleOptions = { linkedGitHubPR: 42, staleWhileRevalidate: true }

    await store.getState().fetchHostedReviewForBranch('/repo', branch, { linkedGitHubPR: 42 })
    vi.setSystemTime(60_001)
    await store.getState().fetchHostedReviewForBranch('/repo', branch, staleOptions)
    await store.getState().fetchHostedReviewForBranch('/repo', branch, staleOptions)
    const forceRefresh = store
      .getState()
      .fetchHostedReviewForBranch('/repo', branch, { linkedGitHubPR: 42, force: true })
    await store.getState().fetchHostedReviewForBranch('/repo', branch, staleOptions)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(10_000)
    resolveBackground(review)
    await background
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(3)

    resolveForce(forcedReview)
    await expect(forceRefresh).resolves.toEqual(forcedReview)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(3)
  })

  it('does not serve stale metadata when a stronger linked PR hint changes the lookup', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const linkedReview: HostedReviewInfo = {
      ...review,
      provider: 'github',
      number: 42,
      title: 'Exact linked PR',
      url: 'https://github.com/acme/orca/pull/42'
    }
    mockApi.hostedReview.forBranch.mockResolvedValueOnce(review).mockResolvedValueOnce(linkedReview)
    const store = makeStore()

    await expect(store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr')).resolves.toBe(
      review
    )
    vi.setSystemTime(60_001)
    await expect(
      store.getState().fetchHostedReviewForBranch('/repo', 'feature/pr', {
        linkedGitHubPR: 42,
        staleWhileRevalidate: true
      })
    ).resolves.toEqual(linkedReview)

    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(2)
  })

  it('bounds cached hosted review branches by evicting the oldest entries', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    mockApi.hostedReview.forBranch.mockImplementation(async ({ branch }: { branch: string }) => ({
      ...review,
      number: Number(branch.replace('feature/cache-', '')) || review.number,
      title: branch
    }))
    const store = makeStore()

    for (let i = 0; i < 501; i += 1) {
      vi.setSystemTime(1_000 + i)
      await store.getState().fetchHostedReviewForBranch('/repo', `feature/cache-${i}`)
    }

    expect(
      store.getState().hostedReviewCache[
        getHostedReviewCacheKey('/repo', 'feature/cache-0', null, 'repo-1', null, null, true)
      ]
    ).toBeUndefined()
    expect(
      store.getState().hostedReviewCache[
        getHostedReviewCacheKey('/repo', 'feature/cache-500', null, 'repo-1', null, null, true)
      ]?.data
    ).toMatchObject({ title: 'feature/cache-500' })
    expect(Object.keys(store.getState().hostedReviewCache)).toHaveLength(500)
    expect(_getHostedReviewRequestGenerationCountForTest()).toBe(0)
  })
})
