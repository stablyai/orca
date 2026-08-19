import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prChecksCacheSuffix, prCommentsCacheSuffix } from './github'
import {
  createTestStore,
  githubSourceContext,
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
import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'

describe('createGitHubSlice.fetchPRChecks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.prChecks.mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('updates the matching PR cache entry with derived check status', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'
    const prCacheKey = `${repoId}::${branch}`

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

    await store
      .getState()
      .fetchPRChecks(repoPath, 12, branch, undefined, null, { force: true, repoId })

    expect(store.getState().prCache[prCacheKey]?.data?.checksStatus).toBe('success')
  })

  it('stores runtime checks under runtime-scoped cache keys', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-checks',
      ok: true,
      result: [{ name: 'build', status: 'completed', conclusion: 'success', url: null }],
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/runtime-checks'
    const runtimePrCacheKey = `runtime:env-1::${repoId}::${branch}`
    const runtimeChecksCacheKey = `runtime:env-1::${repoId}::pr-checks::12`
    const localChecksCacheKey = `${repoId}::pr-checks::12`

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
      ],
      prCache: {
        [runtimePrCacheKey]: {
          data: makePR({ checksStatus: 'pending' }),
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)

    await store
      .getState()
      .fetchPRChecks(repoPath, 12, branch, undefined, null, { force: true, repoId })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.prChecks',
      params: { repo: repoId, prNumber: 12, headSha: undefined, prRepo: null, noCache: true },
      timeoutMs: 30_000
    })
    expect(store.getState().checksCache[runtimeChecksCacheKey]?.data).toEqual([
      { name: 'build', status: 'completed', conclusion: 'success', url: null }
    ])
    expect(store.getState().checksCache[localChecksCacheKey]).toBeUndefined()
    expect(store.getState().prCache[runtimePrCacheKey]?.data?.checksStatus).toBe('success')
  })

  it('keeps known local repo checks on local cache keys when a runtime is focused', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/local-checks'
    const localPrCacheKey = `${repoId}::${branch}`
    const localChecksCacheKey = `${repoId}::pr-checks::12`
    const runtimeChecksCacheKey = `runtime:env-1::${repoId}::pr-checks::12`

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      prCache: {
        [localPrCacheKey]: {
          data: makePR({ checksStatus: 'pending' }),
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)

    mockApi.gh.prChecks.mockResolvedValueOnce([
      { name: 'build', status: 'completed', conclusion: 'success', url: null }
    ])

    await store
      .getState()
      .fetchPRChecks(repoPath, 12, branch, undefined, null, { force: true, repoId })

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.prChecks).toHaveBeenCalledWith({
      repoPath,
      repoId,
      prNumber: 12,
      headSha: undefined,
      prRepo: null,
      noCache: true,
      sourceContext: undefined
    })
    expect(store.getState().checksCache[localChecksCacheKey]?.data).toEqual([
      { name: 'build', status: 'completed', conclusion: 'success', url: null }
    ])
    expect(store.getState().checksCache[runtimeChecksCacheKey]).toBeUndefined()
    expect(store.getState().prCache[localPrCacheKey]?.data?.checksStatus).toBe('success')
  })

  it('marks the PR cache entry as failure when any check fails', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'
    const prCacheKey = `${repoId}::${branch}`

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

    await store
      .getState()
      .fetchPRChecks(repoPath, 12, branch, undefined, null, { force: true, repoId })

    expect(store.getState().prCache[prCacheKey]?.data?.checksStatus).toBe('failure')
  })

  it('normalizes refs/heads branch names before updating PR cache status', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'
    const prCacheKey = `${repoId}::${branch}`

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

    await store
      .getState()
      .fetchPRChecks(repoPath, 12, `refs/heads/${branch}`, undefined, null, { force: true, repoId })

    expect(store.getState().prCache[prCacheKey]?.data?.checksStatus).toBe('success')
  })

  it('persists the updated PR cache after deriving a new checks status', async () => {
    vi.useFakeTimers()

    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'
    const prCacheKey = `${repoId}::${branch}`

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

    await store
      .getState()
      .fetchPRChecks(repoPath, 12, branch, undefined, null, { force: true, repoId })
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

  it('passes the cached PR head SHA to the checks IPC request', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'
    const prCacheKey = `${repoId}::${branch}`

    store.setState({
      prCache: {
        [prCacheKey]: {
          data: makePR({ headSha: 'abc123head' }),
          fetchedAt: 1
        }
      }
    })

    await store
      .getState()
      .fetchPRChecks(repoPath, 12, branch, 'abc123head', null, { force: true, repoId })

    expect(mockApi.gh.prChecks).toHaveBeenCalledWith({
      repoPath,
      repoId,
      prNumber: 12,
      headSha: 'abc123head',
      prRepo: null,
      noCache: true
    })
  })

  it('keys PR checks by normalized PR repo identity', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'

    mockApi.gh.prChecks
      .mockResolvedValueOnce([
        { name: 'upstream', status: 'completed', conclusion: 'success', url: null }
      ])
      .mockResolvedValueOnce([
        { name: 'fork', status: 'completed', conclusion: 'failure', url: null }
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
    await store
      .getState()
      .fetchPRChecks(
        repoPath,
        12,
        branch,
        'head-b',
        { owner: 'Fork', repo: 'Widgets' },
        { force: true, repoId }
      )

    expect(
      store.getState().checksCache[
        `${repoId}::${prChecksCacheSuffix(12, { owner: 'Acme', repo: 'Widgets' }, 'head-a')}`
      ]?.data?.[0].name
    ).toBe('upstream')
    expect(
      store.getState().checksCache[
        `${repoId}::${prChecksCacheSuffix(12, { owner: 'Fork', repo: 'Widgets' }, 'head-b')}`
      ]?.data?.[0].name
    ).toBe('fork')
    expect(mockApi.gh.prChecks).toHaveBeenNthCalledWith(1, {
      repoPath,
      repoId,
      prNumber: 12,
      headSha: 'head-a',
      prRepo: { owner: 'Acme', repo: 'Widgets' },
      noCache: true
    })
  })

  it('isolates PR detail caches by Enterprise host', () => {
    const githubRepo = { owner: 'Acme', repo: 'Widgets', host: 'github.com' }
    const enterpriseRepo = {
      owner: 'Acme',
      repo: 'Widgets',
      host: 'github.acme-corp.com'
    }

    expect(prChecksCacheSuffix(12, enterpriseRepo, 'head')).not.toBe(
      prChecksCacheSuffix(12, githubRepo, 'head')
    )
    expect(prCommentsCacheSuffix(12, enterpriseRepo)).not.toBe(
      prCommentsCacheSuffix(12, githubRepo)
    )
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

  it('updates repo-scoped PR cache entry instead of repoPath fallback key', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'
    const repoScopedKey = `${repoId}::${branch}`
    const pathScopedKey = `${repoPath}::${branch}`

    store.setState({
      prCache: {
        [repoScopedKey]: { data: makePR({ checksStatus: 'pending' }), fetchedAt: 1 },
        [pathScopedKey]: { data: makePR({ checksStatus: 'pending' }), fetchedAt: 1 }
      }
    })

    mockApi.gh.prChecks.mockResolvedValue([
      { name: 'build', status: 'completed', conclusion: 'success', url: null }
    ])

    await store
      .getState()
      .fetchPRChecks(repoPath, 12, branch, undefined, null, { force: true, repoId })

    expect(store.getState().prCache[repoScopedKey]?.data?.checksStatus).toBe('success')
    expect(store.getState().prCache[pathScopedKey]?.data?.checksStatus).toBe('pending')
  })

  it('routes explicit source-context PR checks through the source runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-source-checks',
      ok: true,
      result: [{ name: 'source-build', status: 'completed', conclusion: 'success', url: null }],
      _meta: { runtimeId: 'source-runtime' }
    })
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'caller-repo-id'
    const sourceContext = githubSourceContext('runtime:source-runtime', 'runtime-repo-id')
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' } as AppState['settings'],
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    await store.getState().fetchPRChecks(repoPath, 12, 'feature/source', 'head-1', null, {
      force: true,
      repoId,
      sourceContext
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'source-runtime',
      method: 'github.prChecks',
      params: {
        repo: 'runtime-repo-id',
        prNumber: 12,
        headSha: 'head-1',
        prRepo: null,
        noCache: true
      },
      timeoutMs: 30_000
    })
    expect(
      store.getState().checksCache[
        `${getTaskSourceCacheScope(sourceContext)}::${repoId}::${prChecksCacheSuffix(12, null, 'head-1')}`
      ]?.data?.[0].name
    ).toBe('source-build')
    expect(mockApi.gh.prChecks).not.toHaveBeenCalled()
  })
})

describe('createGitHubSlice.fetchPRCheckDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.prCheckDetails.mockResolvedValue(null)
  })

  it('routes active runtime check-detail loads through runtime RPC', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-check-details',
      ok: true,
      result: {
        name: 'build',
        status: 'completed',
        conclusion: 'failure',
        url: null,
        detailsUrl: null,
        startedAt: null,
        completedAt: null,
        title: null,
        summary: null,
        text: null,
        annotations: [],
        jobs: []
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
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

    await store.getState().fetchPRCheckDetails(
      repoPath,
      {
        checkRunId: 123,
        checkName: 'build',
        prRepo: { owner: 'Acme', repo: 'Widgets' }
      },
      { repoId }
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.prCheckDetails',
      params: {
        repo: repoId,
        checkRunId: 123,
        workflowRunId: undefined,
        checkName: 'build',
        url: undefined,
        prRepo: { owner: 'Acme', repo: 'Widgets' }
      },
      timeoutMs: 30_000
    })
    expect(mockApi.gh.prCheckDetails).not.toHaveBeenCalled()
  })

  it('bounds the whole runtime check-detail load when compatibility probing stalls', async () => {
    vi.useFakeTimers()
    try {
      runtimeEnvironmentTransportCall.mockImplementation(() => new Promise(() => {}))
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
      const rejection = expect(request).rejects.toThrow('Timed out loading check details.')

      await vi.advanceTimersByTimeAsync(30_000)

      await rejection
      expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
      expect(mockApi.gh.prCheckDetails).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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
        selector: 'env-1',
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

  it('loads known local repo check details through local IPC when a runtime is focused', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    await store.getState().fetchPRCheckDetails(
      repoPath,
      {
        checkRunId: 123,
        checkName: 'build',
        prRepo: { owner: 'Acme', repo: 'Widgets' }
      },
      { repoId }
    )

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.prCheckDetails).toHaveBeenCalledWith({
      repoPath,
      repoId,
      checkRunId: 123,
      workflowRunId: undefined,
      checkName: 'build',
      url: undefined,
      prRepo: { owner: 'Acme', repo: 'Widgets' },
      sourceContext: undefined
    })
  })
})
