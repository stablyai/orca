import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { createGitHubSlice } from './github'
import type { AppState } from '../types'
import type { PRInfo } from '../../../../shared/types'

const mockApi = {
  gh: {
    prForBranch: vi.fn().mockResolvedValue(null),
    issue: vi.fn().mockResolvedValue(null),
    prChecks: vi.fn().mockResolvedValue([])
  },
  cache: {
    getGitHub: vi.fn().mockResolvedValue(null),
    setGitHub: vi.fn().mockResolvedValue(undefined)
  }
}

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        ...createGitHubSlice(...a)
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
    ...overrides
  }
}

describe('createGitHubSlice.fetchPRChecks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.gh.prChecks.mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('updates the matching PR cache entry with derived check status', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const prCacheKey = `${repoPath}::${branch}`

    store.setState({
      prCache: {
        [prCacheKey]: {
          data: makePR({ checksStatus: 'pending' }),
          fetchedAt: 1
        }
      }
    })

    mockApi.gh.prChecks.mockResolvedValue([
      { name: 'build', status: 'completed', conclusion: 'success', url: null },
      { name: 'lint', status: 'completed', conclusion: 'success', url: null }
    ])

    await store.getState().fetchPRChecks(repoPath, 12, branch, { force: true })

    expect(store.getState().prCache[prCacheKey]?.data?.checksStatus).toBe('success')
  })

  it('marks the PR cache entry as failure when any check fails', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const prCacheKey = `${repoPath}::${branch}`

    store.setState({
      prCache: {
        [prCacheKey]: {
          data: makePR({ checksStatus: 'pending' }),
          fetchedAt: 1
        }
      }
    })

    mockApi.gh.prChecks.mockResolvedValue([
      { name: 'build', status: 'completed', conclusion: 'success', url: null },
      { name: 'integration', status: 'completed', conclusion: 'failure', url: null }
    ])

    await store.getState().fetchPRChecks(repoPath, 12, branch, { force: true })

    expect(store.getState().prCache[prCacheKey]?.data?.checksStatus).toBe('failure')
  })

  it('normalizes refs/heads branch names before updating PR cache status', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const prCacheKey = `${repoPath}::${branch}`

    store.setState({
      prCache: {
        [prCacheKey]: {
          data: makePR({ checksStatus: 'pending' }),
          fetchedAt: 1
        }
      }
    })

    mockApi.gh.prChecks.mockResolvedValue([
      { name: 'build', status: 'completed', conclusion: 'success', url: null }
    ])

    await store.getState().fetchPRChecks(repoPath, 12, `refs/heads/${branch}`, { force: true })

    expect(store.getState().prCache[prCacheKey]?.data?.checksStatus).toBe('success')
  })

  it('persists the updated PR cache after deriving a new checks status', async () => {
    vi.useFakeTimers()

    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const prCacheKey = `${repoPath}::${branch}`

    store.setState({
      prCache: {
        [prCacheKey]: {
          data: makePR({ checksStatus: 'pending' }),
          fetchedAt: 1
        }
      }
    })

    mockApi.gh.prChecks.mockResolvedValue([
      { name: 'build', status: 'completed', conclusion: 'success', url: null }
    ])

    await store.getState().fetchPRChecks(repoPath, 12, branch, { force: true })
    await vi.advanceTimersByTimeAsync(1000)

    expect(mockApi.cache.setGitHub).toHaveBeenCalledWith({
      cache: {
        pr: store.getState().prCache,
        issue: store.getState().issueCache
      }
    })
  })

  it('syncs PR status from a fresh checks cache hit without refetching', async () => {
    vi.useFakeTimers()

    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const prCacheKey = `${repoPath}::${branch}`
    const checksCacheKey = `${repoPath}::pr-checks::12`

    store.setState({
      prCache: {
        [prCacheKey]: {
          data: makePR({ checksStatus: 'pending' }),
          fetchedAt: 1
        }
      },
      checksCache: {
        [checksCacheKey]: {
          data: [{ name: 'build', status: 'completed', conclusion: 'success', url: null }],
          fetchedAt: Date.now()
        }
      }
    })

    await store.getState().fetchPRChecks(repoPath, 12, branch)
    await vi.advanceTimersByTimeAsync(1000)

    expect(mockApi.gh.prChecks).not.toHaveBeenCalled()
    expect(store.getState().prCache[prCacheKey]?.data?.checksStatus).toBe('success')
    expect(mockApi.cache.setGitHub).toHaveBeenCalledWith({
      cache: {
        pr: store.getState().prCache,
        issue: store.getState().issueCache
      }
    })
  })
})
