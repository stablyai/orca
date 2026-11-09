import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { persistGitHubCacheChanges } from '../cache/cache-persistence'
import {
  createTestStore,
  makePR,
  mockApi,
  resetRemoteRuntimeMocks
} from '../github-slice-test-harness'

import { prChecksCacheSuffix } from '../cache/cache-identity'

describe('createGitHubSlice.fetchPRChecks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.prChecks.mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('syncs PR status from a fresh checks cache hit without refetching', async () => {
    vi.useFakeTimers()

    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'
    const prCacheKey = `${repoId}::${branch}`
    const checksCacheKey = `${repoId}::pr-checks::12`

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

    persistGitHubCacheChanges(store)
    await store.getState().fetchPRChecks(repoPath, 12, branch, undefined, null, { repoId })
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

  it('does not sync stale checks into a PR cache entry for a different PR repo', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'
    const prCacheKey = `${repoId}::${branch}`

    store.setState({
      prCache: {
        [prCacheKey]: {
          data: makePR({
            checksStatus: 'pending',
            prRepo: { owner: 'Fork', repo: 'Widgets' }
          }),
          fetchedAt: 1
        }
      }
    })

    mockApi.gh.prChecks.mockResolvedValue([
      { name: 'build', status: 'completed', conclusion: 'success', url: null }
    ])

    await store
      .getState()
      .fetchPRChecks(
        repoPath,
        12,
        branch,
        'head-a',
        { owner: 'Acme', repo: 'Widgets' },
        { force: true, repoId }
      )

    expect(store.getState().prCache[prCacheKey]?.data?.checksStatus).toBe('pending')
    expect(
      store.getState().checksCache[
        `${repoId}::${prChecksCacheSuffix(12, { owner: 'Acme', repo: 'Widgets' }, 'head-a')}`
      ]?.data?.[0].name
    ).toBe('build')
  })
})
