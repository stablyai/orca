import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'

import { createGitHubSlice } from './github'
import { prChecksCacheSuffix } from '../github/cache-identity'
import { createHostedReviewSlice } from './hosted-review'
import { getHostedReviewCacheKey } from './hosted-review-cache-identity'
import type { AppState } from '../types'

import type { PRInfo } from '../../../../shared/github/pull-request-types'

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
