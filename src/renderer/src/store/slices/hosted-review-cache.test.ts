import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import { createHostedReviewSlice } from './hosted-review'
import {
  _clearHostedReviewRequestGenerationsForTest,
  _getHostedReviewRequestGenerationCountForTest
} from './hosted-review-request-state'
import { getHostedReviewCacheKey } from './hosted-review-cache-identity'
import type { HostedReviewInfo } from '../../../../shared/source-control/hosted-review/hosted-review-contracts'

const runtimeRpc = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: runtimeRpc.callRuntimeRpc }))

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

  it('retains last-good after refused manual dispatch without restoring a superseded renderer owner', async () => {
    const store = makeStore()
    mockApi.hostedReview.forBranch.mockResolvedValueOnce(review)
    await store.getState().fetchHostedReviewForBranch('/repo', 'feature')
    const original = Object.values(store.getState().hostedReviewCache)[0]
    let finishOld: (value: HostedReviewInfo) => void = () => {}
    mockApi.hostedReview.forBranch
      .mockReturnValueOnce(
        new Promise<HostedReviewInfo>((resolve) => {
          finishOld = resolve
        })
      )
      .mockRejectedValueOnce(new Error('capacity refused'))
    const before = store.getState().fetchHostedReviewForBranch('/repo', 'feature', { force: true })
    const options = { force: true, userRefresh: true }
    await expect(
      store.getState().fetchHostedReviewForBranch('/repo', 'feature', options)
    ).rejects.toThrow('capacity refused')
    finishOld({ ...review, state: 'merged' })
    await before
    expect(Object.values(store.getState().hostedReviewCache)[0]).toEqual(original)
    expect(_getHostedReviewRequestGenerationCountForTest()).toBe(0)
    mockApi.hostedReview.forBranch.mockResolvedValueOnce({ ...review, state: 'merged' })
    await expect(
      store.getState().fetchHostedReviewForBranch('/repo', 'feature', { force: true })
    ).resolves.toMatchObject({ state: 'merged' })
  })

  it('settles a failed manual runtime flight separately for an ordinary joiner without renewing last-good', async () => {
    const store = makeStore()
    store.setState((state) => ({
      repos: state.repos.map((repo) => ({ ...repo, executionHostId: 'runtime:paired' }))
    }))
    runtimeRpc.callRuntimeRpc.mockResolvedValueOnce(review)
    await store.getState().fetchHostedReviewForBranch('/repo', 'feature')
    const original = Object.values(store.getState().hostedReviewCache)[0]
    let reject: (error: Error) => void = () => {}
    runtimeRpc.callRuntimeRpc.mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail
      })
    )
    const manual = store
      .getState()
      .fetchHostedReviewForBranch('/repo', 'feature', { force: true, userRefresh: true })
    const failed = expect(manual).rejects.toThrow('offline')
    const ordinary = store
      .getState()
      .fetchHostedReviewForBranch('/repo', 'feature', { force: true })
    reject(new Error('offline'))
    await failed
    await expect(ordinary).resolves.toEqual(review)
    expect(runtimeRpc.callRuntimeRpc).toHaveBeenCalledTimes(2)
    expect(runtimeRpc.callRuntimeRpc).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'environment', environmentId: 'paired' }),
      'hostedReview.forBranch',
      expect.objectContaining({ userRefresh: true }),
      { timeoutMs: 30_000 }
    )
    expect(Object.values(store.getState().hostedReviewCache)[0]).toEqual(original)
    expect(_getHostedReviewRequestGenerationCountForTest()).toBe(0)
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
