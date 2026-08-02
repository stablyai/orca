import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'

import { createGitHubSlice, prChecksCacheSuffix } from './github'
import { createHostedReviewSlice } from './hosted-review'
import { getHostedReviewCacheKey } from './hosted-review-cache-identity'
import type { AppState } from '../types'
import type { PRCheckDetail, PRInfo } from '../../../../shared/types'

const mockApi = {
  gh: {
    prChecks: vi.fn()
  },
  cache: {
    setGitHub: vi.fn()
  }
}

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        ...createGitHubSlice(...a),
        ...createHostedReviewSlice(...a)
      }) as AppState
  )
}

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 12,
    title: 'Test PR',
    state: 'open',
    url: 'https://example.com/pr/12',
    checksStatus: 'pending',
    updatedAt: '2026-03-28T00:00:00Z',
    mergeable: 'UNKNOWN',
    headSha: 'head-oid',
    ...overrides
  }
}

beforeEach(() => {
  mockApi.gh.prChecks.mockReset()
  mockApi.gh.prChecks.mockResolvedValue([])
  mockApi.cache.setGitHub.mockReset()
  mockApi.cache.setGitHub.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createGitHubSlice.fetchPRChecks checks cache freshness', () => {
  it('expires empty checks cache entries after the shorter empty TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'

    mockApi.gh.prChecks.mockResolvedValue([])

    await store.getState().fetchPRChecks(repoPath, 12, branch, undefined, null, { repoId })
    vi.setSystemTime(11_001)
    await store.getState().fetchPRChecks(repoPath, 12, branch, undefined, null, { repoId })

    expect(mockApi.gh.prChecks).toHaveBeenCalledTimes(2)
  })

  it('keeps repeated automatic empty checks refreshes cacheable', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'

    mockApi.gh.prChecks.mockResolvedValue([])

    await store.getState().fetchPRChecks(repoPath, 12, branch, undefined, null, { repoId })
    vi.setSystemTime(11_001)
    await store.getState().fetchPRChecks(repoPath, 12, branch, undefined, null, { repoId })

    expect(mockApi.gh.prChecks).toHaveBeenCalledTimes(2)
    expect(mockApi.gh.prChecks).toHaveBeenNthCalledWith(1, {
      repoPath,
      repoId,
      prNumber: 12,
      headSha: undefined,
      prRepo: null,
      noCache: false
    })
    expect(mockApi.gh.prChecks).toHaveBeenNthCalledWith(2, {
      repoPath,
      repoId,
      prNumber: 12,
      headSha: undefined,
      prRepo: null,
      noCache: false
    })
  })

  it('keeps non-empty checks cache entries fresh for the normal checks TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'

    mockApi.gh.prChecks.mockResolvedValue([
      { name: 'build', status: 'completed', conclusion: 'success', url: null }
    ])

    await store.getState().fetchPRChecks(repoPath, 12, branch, undefined, null, { repoId })
    vi.setSystemTime(11_001)
    await store.getState().fetchPRChecks(repoPath, 12, branch, undefined, null, { repoId })

    expect(mockApi.gh.prChecks).toHaveBeenCalledTimes(1)
  })

  it('dedupes simultaneous cacheable empty checks requests', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'
    const request = deferred<PRCheckDetail[]>()
    mockApi.gh.prChecks.mockReturnValueOnce(request.promise)

    const first = store.getState().fetchPRChecks(repoPath, 12, branch, undefined, null, { repoId })
    const second = store.getState().fetchPRChecks(repoPath, 12, branch, undefined, null, { repoId })

    expect(mockApi.gh.prChecks).toHaveBeenCalledTimes(1)
    request.resolve([])

    await expect(first).resolves.toEqual([])
    await expect(second).resolves.toEqual([])
  })

  it('does not dedupe forced checks onto an in-flight cacheable request', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'
    const cacheableRequest = deferred<PRCheckDetail[]>()
    const forcedChecks = [
      { name: 'build', status: 'completed', conclusion: 'success', url: null } as const
    ]
    mockApi.gh.prChecks
      .mockReturnValueOnce(cacheableRequest.promise)
      .mockResolvedValueOnce(forcedChecks)

    const cacheable = store
      .getState()
      .fetchPRChecks(repoPath, 12, branch, undefined, null, { repoId })
    const forced = store
      .getState()
      .fetchPRChecks(repoPath, 12, branch, undefined, null, { force: true, repoId })

    expect(mockApi.gh.prChecks).toHaveBeenCalledTimes(1)
    cacheableRequest.resolve([])

    await expect(cacheable).resolves.toEqual([])
    await expect(forced).resolves.toEqual(forcedChecks)
    expect(mockApi.gh.prChecks).toHaveBeenCalledTimes(2)
    expect(mockApi.gh.prChecks).toHaveBeenNthCalledWith(2, {
      repoPath,
      repoId,
      prNumber: 12,
      headSha: undefined,
      prRepo: null,
      noCache: true
    })
  })

  it('dedupes simultaneous forced checks requests', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'
    const request = deferred<PRCheckDetail[]>()
    const checks = [
      { name: 'build', status: 'completed', conclusion: 'success', url: null } as const
    ]
    mockApi.gh.prChecks.mockReturnValueOnce(request.promise)

    const first = store
      .getState()
      .fetchPRChecks(repoPath, 12, branch, undefined, null, { force: true, repoId })
    const second = store
      .getState()
      .fetchPRChecks(repoPath, 12, branch, undefined, null, { force: true, repoId })

    expect(mockApi.gh.prChecks).toHaveBeenCalledTimes(1)
    request.resolve(checks)

    await expect(first).resolves.toEqual(checks)
    await expect(second).resolves.toEqual(checks)
    expect(mockApi.gh.prChecks).toHaveBeenCalledWith({
      repoPath,
      repoId,
      prNumber: 12,
      headSha: undefined,
      prRepo: null,
      noCache: true
    })
  })

  it('treats explicit noCache checks requests as fresh requests', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'

    mockApi.gh.prChecks.mockResolvedValue([
      { name: 'build', status: 'completed', conclusion: 'success', url: null }
    ])

    await store.getState().fetchPRChecks(repoPath, 12, branch, undefined, null, { repoId })
    await store
      .getState()
      .fetchPRChecks(repoPath, 12, branch, undefined, null, { noCache: true, repoId })

    expect(mockApi.gh.prChecks).toHaveBeenCalledTimes(2)
    expect(mockApi.gh.prChecks).toHaveBeenNthCalledWith(2, {
      repoPath,
      repoId,
      prNumber: 12,
      headSha: undefined,
      prRepo: null,
      noCache: true
    })
  })

  it('preserves cached checks when the checks IPC fails', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const checksCacheKey = `${repoPath}::pr-checks::12`
    const cachedChecks = [
      { name: 'build', status: 'completed', conclusion: 'failure', url: null } as const
    ]

    store.setState({
      checksCache: {
        [checksCacheKey]: {
          data: cachedChecks,
          fetchedAt: 1,
          headSha: 'abc123head'
        }
      }
    } as unknown as Partial<AppState>)
    mockApi.gh.prChecks.mockRejectedValueOnce(new Error('rate limited'))

    await expect(
      store.getState().fetchPRChecks(repoPath, 12, branch, 'abc123head', null, { force: true })
    ).resolves.toEqual(cachedChecks)

    expect(store.getState().checksCache[checksCacheKey]?.data).toEqual(cachedChecks)
    expect(store.getState().checksCache[checksCacheKey]?.fetchedAt).toBe(1)
  })

  it('does not return cached checks for a different requested head SHA after IPC failure', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const checksCacheKey = `${repoPath}::pr-checks::12`
    const oldHeadChecks = [
      { name: 'build', status: 'completed', conclusion: 'success', url: null } as const
    ]

    store.setState({
      checksCache: {
        [checksCacheKey]: {
          data: oldHeadChecks,
          fetchedAt: 1,
          headSha: 'old-head'
        }
      }
    } as unknown as Partial<AppState>)
    mockApi.gh.prChecks.mockRejectedValueOnce(new Error('rate limited'))

    await expect(
      store.getState().fetchPRChecks(repoPath, 12, branch, 'new-head', null, { force: true })
    ).resolves.toEqual([])

    expect(store.getState().checksCache[checksCacheKey]?.data).toEqual(oldHeadChecks)
    expect(store.getState().checksCache[checksCacheKey]?.headSha).toBe('old-head')
  })
})

describe('createGitHubSlice.applyGitHubPRRefreshEvent checks cache reuse', () => {
  it('does not derive neutral PR status from stale empty checks during refresh events', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/stale-empty-checks'
    const cacheKey = `${repoId}::${branch}`
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const checksCacheKey = `${repoId}::${prChecksCacheSuffix(12, null, 'head-oid')}`

    store.setState({
      checksCache: {
        [checksCacheKey]: {
          data: [],
          fetchedAt: 1_000,
          headSha: 'head-oid'
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, checksStatus: 'pending', headSha: 'head-oid' }),
        fetchedAt: 21_000
      }
    })

    expect(store.getState().prCache[cacheKey]).toMatchObject({
      data: expect.objectContaining({ checksStatus: 'pending' }),
      fetchedAt: 21_000
    })
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toMatchObject({
      data: expect.objectContaining({ provider: 'github', status: 'pending' }),
      fetchedAt: 21_000
    })
  })

  it('reuses fresh head-specific checks cache entries during refresh events', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/fresh-head-checks'
    const cacheKey = `${repoId}::${branch}`
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const checksCacheKey = `${repoId}::${prChecksCacheSuffix(12, null, 'head-oid')}`

    store.setState({
      checksCache: {
        [checksCacheKey]: {
          data: [{ name: 'build', status: 'completed', conclusion: 'success', url: null }],
          fetchedAt: 20_000,
          headSha: 'head-oid'
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, checksStatus: 'pending', headSha: 'head-oid' }),
        fetchedAt: 21_000
      }
    })

    expect(store.getState().prCache[cacheKey]).toMatchObject({
      data: expect.objectContaining({ checksStatus: 'success' }),
      fetchedAt: 21_000
    })
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toMatchObject({
      data: expect.objectContaining({ provider: 'github', status: 'success' }),
      fetchedAt: 21_000
    })
  })
})
