import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { persistGitHubCacheChanges } from '../github/cache-persistence'
import { prChecksCacheSuffix } from '../github/cache-identity'
import {
  createTestStore,
  makePR,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall
} from './github-slice-test-harness'
import type { AppState } from '../types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import '../../../../shared/task-source-context'

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

  it('bounds checks cache entries across many repo and head combinations', async () => {
    vi.useFakeTimers()

    try {
      const store = createTestStore()
      mockApi.gh.prChecks.mockResolvedValue([])

      for (let i = 0; i <= 500; i++) {
        vi.setSystemTime(1_000 + i)
        await store.getState().fetchPRChecks(`/repo/${i}`, 12, `feature/${i}`, `head-${i}`, null, {
          force: true,
          repoId: `repo-${i}`
        })
      }

      const cache = store.getState().checksCache
      expect(Object.keys(cache)).toHaveLength(500)
      expect(cache[`repo-0::${prChecksCacheSuffix(12, null, 'head-0')}`]).toBeUndefined()
      expect(cache[`repo-500::${prChecksCacheSuffix(12, null, 'head-500')}`]).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
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

describe('createGitHubSlice.fetchPRCheckDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.prCheckDetails.mockResolvedValue(null)
  })

  it('shares one timeout budget between runtime compatibility and check details', async () => {
    vi.useFakeTimers()
    try {
      runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
        const compatibility = createCompatibleRuntimeStatusResponseIfNeeded(args)
        if (compatibility) {
          return new Promise((resolve) => setTimeout(() => resolve(compatibility), 20_000))
        }
        return runtimeEnvironmentCall(args)
      })
      runtimeEnvironmentCall.mockImplementation(() => new Promise(() => {}))
      const store = createTestStore()
      const repoPath = '/repo'
      const repoId = 'repo-id'
      store.setState({
        settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
        repos: [
          {
            id: repoId,
            path: repoPath,
            name: 'repo',
            kind: 'git',
            executionHostId: 'runtime:env-1'
          }
        ]
      } as unknown as Partial<AppState>)

      const request = store
        .getState()
        .fetchPRCheckDetails(repoPath, { checkRunId: 123, checkName: 'build' }, { repoId })
      let settled = false
      void request.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      const rejection = expect(request).rejects.toThrow('Timed out loading check details.')

      await vi.advanceTimersByTimeAsync(20_000)
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        subscriptionId: expect.any(String),
        selector: 'env-1',
        expectedEnvironmentPairingRevision: undefined,
        expectedEnvironmentRuntimeId: undefined,
        method: 'github.prCheckDetails',
        params: {
          repo: repoId,
          checkRunId: 123,
          workflowRunId: undefined,
          checkName: 'build',
          url: undefined,
          prRepo: null
        },
        timeoutMs: 30_000
      })

      await vi.advanceTimersByTimeAsync(9_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)

      await rejection
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
