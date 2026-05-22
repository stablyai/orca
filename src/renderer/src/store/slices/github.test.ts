/* eslint-disable max-lines -- Why: colocating the PR/issue cache, work-item
envelope, and IssueSourceIndicator suppression tests in one file keeps the
GitHub slice's cross-cutting invariants verifiable in one place. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { createGitHubSlice, prChecksCacheSuffix, workItemsCacheKey } from './github'
import { createHostedReviewSlice } from './hosted-review'
import type { AppState } from '../types'
import type { GitHubWorkItem, PRInfo } from '../../../../shared/types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE } from '../../../../shared/work-items'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { getHostedReviewCacheKey } from './hosted-review-cache-identity'

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

const mockApi = {
  gh: {
    prForBranch: vi.fn().mockResolvedValue(null),
    refreshPRNow: vi.fn(),
    enqueuePRRefresh: vi.fn().mockResolvedValue(undefined),
    issue: vi.fn().mockResolvedValue(null),
    prChecks: vi.fn().mockResolvedValue([]),
    prComments: vi.fn().mockResolvedValue([]),
    listWorkItems: vi.fn(),
    getProjectViewTable: vi.fn()
  },
  hostedReview: {
    forBranch: vi.fn().mockResolvedValue(null),
    getCreationEligibility: vi.fn(),
    create: vi.fn()
  },
  runtimeEnvironments: {
    call: runtimeEnvironmentTransportCall
  },
  cache: {
    getGitHub: vi.fn().mockResolvedValue(null),
    setGitHub: vi.fn().mockResolvedValue(undefined)
  }
}

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

function resetRemoteRuntimeMocks() {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
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

describe('createGitHubSlice.evictGitHubRepoCaches', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('evicts repo-id and legacy path scoped cache entries', () => {
    const store = createTestStore()
    const repoId = 'repo-1'
    const repoPath = '/repo/one'
    store.setState({
      workItemsInvalidationNonce: 4,
      workItemsCache: {
        [workItemsCacheKey(repoId, 20, '')]: { data: [], fetchedAt: 1 },
        [workItemsCacheKey(repoPath, 20, '')]: { data: [], fetchedAt: 1 },
        [workItemsCacheKey('repo-2', 20, '')]: { data: [], fetchedAt: 1 }
      },
      prCache: {
        [`${repoId}::branch`]: { data: makePR(), fetchedAt: 1 },
        [`${repoPath}::branch`]: { data: makePR(), fetchedAt: 1 },
        'repo-2::branch': { data: makePR(), fetchedAt: 1 }
      },
      issueCache: {
        [`${repoId}::12`]: { data: {} as never, fetchedAt: 1 },
        [`${repoPath}::12`]: { data: {} as never, fetchedAt: 1 },
        'repo-2::12': { data: {} as never, fetchedAt: 1 }
      },
      checksCache: {
        [`${repoId}::pr-checks::12`]: { data: [], fetchedAt: 1 },
        [`${repoPath}::pr-checks::12`]: { data: [], fetchedAt: 1 },
        'repo-2::pr-checks::12': { data: [], fetchedAt: 1 }
      },
      commentsCache: {
        [`${repoId}::pr-comments::12`]: { data: [], fetchedAt: 1 },
        [`${repoPath}::pr-comments::12`]: { data: [], fetchedAt: 1 },
        'repo-2::pr-comments::12': { data: [], fetchedAt: 1 }
      }
    })

    store.getState().evictGitHubRepoCaches(repoId, repoPath)
    const state = store.getState()

    expect(Object.keys(state.workItemsCache)).toEqual([workItemsCacheKey('repo-2', 20, '')])
    expect(Object.keys(state.prCache)).toEqual(['repo-2::branch'])
    expect(Object.keys(state.issueCache)).toEqual(['repo-2::12'])
    expect(Object.keys(state.checksCache)).toEqual(['repo-2::pr-checks::12'])
    expect(Object.keys(state.commentsCache)).toEqual(['repo-2::pr-comments::12'])
    expect(state.workItemsInvalidationNonce).toBe(5)
  })

  it('does not bump the work-item invalidation nonce when no work-item entries are evicted', () => {
    const store = createTestStore()
    store.setState({
      workItemsInvalidationNonce: 4,
      prCache: {
        'repo-1::branch': { data: makePR(), fetchedAt: 1 }
      }
    })

    store.getState().evictGitHubRepoCaches('repo-1', '/repo/one')

    expect(store.getState().prCache).toEqual({})
    expect(store.getState().workItemsInvalidationNonce).toBe(4)
  })

  it('clears matching in-flight work-item dedupe keys before the next fetch', async () => {
    const store = createTestStore()
    type WorkItemsEnvelope = {
      items: []
      sources: { issues: null; prs: null; upstreamCandidate: null }
    }
    let resolveFirst: (value: WorkItemsEnvelope) => void = () => {}
    const firstRequest = new Promise<WorkItemsEnvelope>((resolve) => {
      resolveFirst = resolve
    })
    mockApi.gh.listWorkItems.mockReturnValueOnce(firstRequest).mockResolvedValueOnce({
      items: [],
      sources: { issues: null, prs: null, upstreamCandidate: null }
    })

    const firstFetch = store.getState().fetchWorkItems('repo-1', '/repo/one', 20, '')
    await Promise.resolve()
    store.getState().evictGitHubRepoCaches('repo-1', '/repo/one')
    const secondFetch = store.getState().fetchWorkItems('repo-1', '/repo/one', 20, '')
    resolveFirst({
      items: [],
      sources: { issues: null, prs: null, upstreamCandidate: null }
    })
    await firstFetch
    await secondFetch

    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(2)
  })
})

describe('createGitHubSlice.patchWorkItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('can scope patches to one repo when different repos have the same work-item id', () => {
    const store = createTestStore()
    const repoOneItem = {
      id: 'pr:42',
      repoId: 'repo-1',
      type: 'pr',
      number: 42,
      title: 'Repo one PR'
    } as GitHubWorkItem
    const repoTwoItem = {
      id: 'pr:42',
      repoId: 'repo-2',
      type: 'pr',
      number: 42,
      title: 'Repo two PR'
    } as GitHubWorkItem

    store.setState({
      workItemsCache: {
        [workItemsCacheKey('repo-1', 20, '')]: { data: [repoOneItem], fetchedAt: 1 },
        [workItemsCacheKey('repo-2', 20, '')]: { data: [repoTwoItem], fetchedAt: 1 }
      }
    })

    store.getState().patchWorkItem('pr:42', { reviewRequests: [] }, 'repo-1')

    const state = store.getState()
    const repoOnePatched = state.workItemsCache[workItemsCacheKey('repo-1', 20, '')]?.data?.[0]
    const repoTwoPatched = state.workItemsCache[workItemsCacheKey('repo-2', 20, '')]?.data?.[0]
    expect(repoOnePatched).toMatchObject({
      repoId: 'repo-1',
      reviewRequests: []
    })
    expect(repoTwoPatched).toBe(repoTwoItem)
  })
})

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
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
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
})

describe('createGitHubSlice.fetchPRComments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.prComments.mockResolvedValue([])
  })

  it('keys PR comments by normalized PR repo identity', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'

    mockApi.gh.prComments
      .mockResolvedValueOnce([
        { id: 1, author: 'upstream', authorAvatarUrl: '', body: '', createdAt: '', url: '' }
      ])
      .mockResolvedValueOnce([
        { id: 2, author: 'fork', authorAvatarUrl: '', body: '', createdAt: '', url: '' }
      ])

    await store.getState().fetchPRComments(repoPath, 12, {
      force: true,
      repoId,
      prRepo: { owner: 'Acme', repo: 'Widgets' }
    })
    await store.getState().fetchPRComments(repoPath, 12, {
      force: true,
      repoId,
      prRepo: { owner: 'Fork', repo: 'Widgets' }
    })

    expect(
      store.getState().commentsCache[`${repoId}::pr-comments::acme/widgets::12`]?.data?.[0].author
    ).toBe('upstream')
    expect(
      store.getState().commentsCache[`${repoId}::pr-comments::fork/widgets::12`]?.data?.[0].author
    ).toBe('fork')
    expect(mockApi.gh.prComments).toHaveBeenNthCalledWith(1, {
      repoPath,
      repoId,
      prNumber: 12,
      prRepo: { owner: 'Acme', repo: 'Widgets' },
      noCache: true
    })
  })

  it('stores runtime PR comments under runtime-scoped cache keys', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-comments',
      ok: true,
      result: [{ id: 1, author: 'remote', authorAvatarUrl: '', body: '', createdAt: '', url: '' }],
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    await store.getState().fetchPRComments(repoPath, 12, {
      force: true,
      repoId,
      prRepo: { owner: 'Acme', repo: 'Widgets' }
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.prComments',
      params: {
        repo: repoId,
        prNumber: 12,
        prRepo: { owner: 'Acme', repo: 'Widgets' },
        noCache: true
      },
      timeoutMs: 30_000
    })
    expect(
      store.getState().commentsCache[`runtime:env-1::${repoId}::pr-comments::acme/widgets::12`]
        ?.data?.[0].author
    ).toBe('remote')
    expect(
      store.getState().commentsCache[`${repoId}::pr-comments::acme/widgets::12`]
    ).toBeUndefined()
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

describe('createGitHubSlice.fetchPRForBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.prForBranch.mockResolvedValue(null)
    mockApi.gh.refreshPRNow.mockReset()
    mockApi.gh.refreshPRNow.mockResolvedValue({ kind: 'no-pr', fetchedAt: Date.now() })
    mockApi.hostedReview.forBranch.mockResolvedValue(null)
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
      linkedReviewHintKey: 'github:12'
    })
    expect(store.getState().hostedReviewCache[runtimeHostedReviewCacheKey]).toBeUndefined()
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

  it('preserves cached PR data when a forced coordinator refresh errors', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const cachedPR = makePR({ number: 12 })

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      prCache: {
        [`repo-1::${branch}`]: {
          data: cachedPR,
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'upstream-error',
      errorType: 'network',
      message: 'network unavailable',
      fetchedAt: Date.now()
    })

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, { force: true })
    ).resolves.toEqual(cachedPR)
    expect(store.getState().prCache[`repo-1::${branch}`]?.data).toEqual(cachedPR)
  })

  it('preserves visible cached PR data when a fallback refresh misses', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/fallback-miss'
    const cachedPR = makePR({ number: 12, title: 'Visible cached PR' })
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      prCache: {
        [`${repoId}::${branch}`]: {
          data: cachedPR,
          fetchedAt: 1
        }
      },
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: {
            provider: 'github',
            number: 12,
            title: 'Visible cached PR',
            state: 'open',
            url: 'https://github.com/acme/orca/pull/12',
            status: 'pending',
            updatedAt: '2026-03-28T00:00:00Z',
            mergeable: 'UNKNOWN'
          },
          fetchedAt: 1,
          linkedReviewHintKey: 'github:12'
        }
      }
    } as unknown as Partial<AppState>)
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({ kind: 'no-pr', fetchedAt: 2 })

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, {
        force: true,
        repoId,
        fallbackPRNumber: 12
      })
    ).resolves.toEqual(cachedPR)
    expect(store.getState().prCache[`${repoId}::${branch}`]).toEqual({
      data: cachedPR,
      fetchedAt: 1
    })
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toMatchObject({
      data: expect.objectContaining({ provider: 'github', number: 12 }),
      fetchedAt: 1,
      linkedReviewHintKey: 'github:12'
    })
  })

  it('uses a GitHub hosted-review cache entry as the fallback PR for direct refreshes', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/hosted-review-fallback'
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const pr = makePR({ number: 44, title: 'Hosted review fallback PR' })

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      prCache: {
        [`${repoId}::${branch}`]: {
          data: null,
          fetchedAt: Date.now()
        }
      },
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: {
            provider: 'github',
            number: 44,
            title: 'Hosted review fallback PR',
            state: 'open',
            url: 'https://github.com/acme/orca/pull/44',
            status: 'pending',
            updatedAt: '2026-03-28T00:00:00Z',
            mergeable: 'UNKNOWN'
          },
          fetchedAt: Date.now(),
          linkedReviewHintKey: 'github:44'
        }
      }
    } as unknown as Partial<AppState>)
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'found',
      pr,
      fetchedAt: Date.now()
    })

    await expect(store.getState().fetchPRForBranch(repoPath, branch, { repoId })).resolves.toEqual(
      pr
    )
    expect(mockApi.gh.refreshPRNow).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        repoId,
        repoPath,
        branch,
        fallbackPRNumber: 44,
        fallbackPRSource: 'hosted-review'
      })
    })
    expect(store.getState().prCache[`${repoId}::${branch}`]).toMatchObject({
      data: expect.objectContaining({ number: 44 })
    })
  })

  it('clears a stale GitHub hosted-review fallback after an exact PR miss', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/stale-hosted-review-fallback'
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      prCache: {
        [`${repoId}::${branch}`]: {
          data: null,
          fetchedAt: 1
        }
      },
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: {
            provider: 'github',
            number: 44,
            title: 'Stale hosted-review PR',
            state: 'open',
            url: 'https://github.com/acme/orca/pull/44',
            status: 'pending',
            updatedAt: '2026-03-28T00:00:00Z',
            mergeable: 'UNKNOWN'
          },
          fetchedAt: 1,
          linkedReviewHintKey: 'github:44'
        }
      }
    } as unknown as Partial<AppState>)
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({ kind: 'no-pr', fetchedAt: 2 })

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, { force: true, repoId })
    ).resolves.toBeNull()
    expect(store.getState().prCache[`${repoId}::${branch}`]).toEqual({
      data: null,
      fetchedAt: 2
    })
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
      data: null,
      fetchedAt: 2,
      linkedReviewHintKey: 'github:44'
    })
  })

  it('records PR refresh errors without clearing cached PR data', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const cacheKey = `${repoPath}::${branch}`
    const cachedPR = makePR({ number: 12 })

    store.setState({
      prCache: {
        [cacheKey]: {
          data: cachedPR,
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoPath, branch }],
      reason: 'manual',
      outcome: {
        kind: 'upstream-error',
        errorType: 'network',
        message: 'network unavailable',
        fetchedAt: Date.now()
      }
    })

    expect(store.getState().prCache[cacheKey]?.data).toEqual(cachedPR)
    expect(store.getState().prRefreshStates[cacheKey]).toMatchObject({
      status: 'error',
      reason: 'manual',
      message: 'network unavailable'
    })
  })

  it('preserves visible cached PR data when a fallback refresh event misses', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/event-fallback-miss'
    const cacheKey = `${repoId}::${branch}`
    const cachedPR = makePR({ number: 12, title: 'Visible event PR' })
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)

    store.setState({
      prCache: {
        [cacheKey]: {
          data: cachedPR,
          fetchedAt: 1
        }
      },
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: {
            provider: 'github',
            number: 12,
            title: 'Visible event PR',
            state: 'open',
            url: 'https://github.com/acme/orca/pull/12',
            status: 'pending',
            updatedAt: '2026-03-28T00:00:00Z',
            mergeable: 'UNKNOWN'
          },
          fetchedAt: 1,
          linkedReviewHintKey: 'github:12'
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch, fallbackPRNumber: 12 }],
      reason: 'visible',
      outcome: { kind: 'no-pr', fetchedAt: 2 }
    })

    expect(store.getState().prCache[cacheKey]).toEqual({ data: cachedPR, fetchedAt: 1 })
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toMatchObject({
      data: expect.objectContaining({ provider: 'github', number: 12 }),
      fetchedAt: 1,
      linkedReviewHintKey: 'github:12'
    })
  })

  it('updates hosted review cache from GitHub PR refresh events', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/test'
    const cacheKey = `${repoId}::${branch}`
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)

    store.setState({
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: {
            provider: 'github',
            number: 12,
            title: 'Old PR status',
            state: 'open',
            url: 'https://github.com/acme/orca/pull/12',
            status: 'pending',
            updatedAt: '2026-03-28T00:00:00Z',
            mergeable: 'UNKNOWN'
          },
          fetchedAt: 1,
          linkedReviewHintKey: 'github:12'
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      outcome: {
        kind: 'found',
        pr: makePR({
          number: 12,
          title: 'Fresh PR status',
          checksStatus: 'success',
          mergeable: 'MERGEABLE'
        }),
        fetchedAt: 2
      }
    })

    expect(store.getState().prCache[cacheKey]).toMatchObject({
      data: expect.objectContaining({ title: 'Fresh PR status', checksStatus: 'success' }),
      fetchedAt: 2
    })
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toMatchObject({
      data: expect.objectContaining({
        provider: 'github',
        title: 'Fresh PR status',
        status: 'success',
        mergeable: 'MERGEABLE'
      }),
      fetchedAt: 2,
      linkedReviewHintKey: 'github:12'
    })
  })

  it('does not let an older GitHub PR refresh event overwrite a newer hosted-review cache entry', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/event-race'
    const cacheKey = `${repoId}::${branch}`
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

    store.setState({
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: newerReview,
          fetchedAt: 3,
          linkedReviewHintKey: 'github:12'
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, title: 'Older event PR status' }),
        fetchedAt: 2
      }
    })

    expect(store.getState().prCache[cacheKey]).toBeUndefined()
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
      data: newerReview,
      fetchedAt: 3,
      linkedReviewHintKey: 'github:12'
    })
  })

  it('uses event request start time to reject older PR refreshes that finish later', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/start-race'
    const cacheKey = `${repoId}::${branch}`
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
    const stalePR = makePR({ number: 12, title: 'Stale PR status' })

    store.setState({
      prCache: {
        [cacheKey]: {
          data: stalePR,
          fetchedAt: 1
        }
      },
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: newerReview,
          fetchedAt: 3,
          linkedReviewHintKey: 'github:12'
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      requestStartedAt: 2,
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, title: 'Older request finished late' }),
        fetchedAt: 4
      }
    })

    expect(store.getState().prCache[cacheKey]).toBeUndefined()
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
      data: newerReview,
      fetchedAt: 3,
      linkedReviewHintKey: 'github:12'
    })
  })

  it('uses the in-flight event entry to allow same-millisecond coordinator refreshes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100)
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/event-same-ms'
    const cacheKey = `${repoId}::${branch}`
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const existingReview: HostedReviewInfo = {
      provider: 'github',
      number: 12,
      title: 'Existing same-ms hosted review status',
      state: 'open',
      url: 'https://github.com/acme/orca/pull/12',
      status: 'pending',
      updatedAt: '2026-03-28T00:00:00Z',
      mergeable: 'UNKNOWN'
    }

    try {
      store.setState({
        hostedReviewCache: {
          [hostedReviewCacheKey]: {
            data: existingReview,
            fetchedAt: 100,
            linkedReviewHintKey: 'github:12'
          }
        }
      } as unknown as Partial<AppState>)

      store.getState().applyGitHubPRRefreshEvent({
        sequence: 1,
        aliases: [{ cacheKey, repoId, repoPath, branch }],
        reason: 'visible',
        requestStartedAt: 100,
        status: 'in-flight'
      })
      store.getState().applyGitHubPRRefreshEvent({
        sequence: 1,
        aliases: [{ cacheKey, repoId, repoPath, branch }],
        reason: 'visible',
        requestStartedAt: 100,
        outcome: {
          kind: 'found',
          pr: makePR({ number: 12, title: 'Fresh same-ms event PR status' }),
          fetchedAt: 100
        }
      })

      expect(store.getState().prCache[cacheKey]?.data).toMatchObject({
        title: 'Fresh same-ms event PR status'
      })
      expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toMatchObject({
        data: expect.objectContaining({ title: 'Fresh same-ms event PR status' }),
        fetchedAt: 100
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not overwrite a non-GitHub hosted review from GitHub PR refresh events', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/gitlab-review'
    const cacheKey = `${repoId}::${branch}`
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const gitlabReview: HostedReviewInfo = {
      provider: 'gitlab',
      number: 5,
      title: 'GitLab MR',
      state: 'open',
      url: 'https://gitlab.com/acme/orca/-/merge_requests/5',
      status: 'pending',
      updatedAt: '2026-03-28T00:00:00Z',
      mergeable: 'UNKNOWN'
    }

    store.setState({
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: gitlabReview,
          fetchedAt: 1,
          linkedReviewHintKey: 'gitlab:5'
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, title: 'GitHub PR status' }),
        fetchedAt: 2
      }
    })

    expect(store.getState().prCache[cacheKey]).toBeUndefined()
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
      data: gitlabReview,
      fetchedAt: 1,
      linkedReviewHintKey: 'gitlab:5'
    })
  })

  it('does not apply local GitHub PR refresh events while a runtime is active', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/runtime'
    const cacheKey = `${repoId}::${branch}`
    const settings = { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings']
    const runtimeHostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, settings, repoId)

    store.setState({ settings } as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, title: 'Local PR status' }),
        fetchedAt: 2
      }
    })

    expect(store.getState().prCache[cacheKey]).toBeUndefined()
    expect(store.getState().prRefreshSequences[cacheKey]).toBeUndefined()
    expect(store.getState().hostedReviewCache[runtimeHostedReviewCacheKey]).toBeUndefined()
  })

  it('does not create hosted review cache entries from GitHub no-PR refreshes', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/missing'
    const cacheKey = `${repoId}::${branch}`
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      outcome: { kind: 'no-pr', fetchedAt: 2 }
    })

    expect(store.getState().prCache[cacheKey]).toEqual({ data: null, fetchedAt: 2 })
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toBeUndefined()
  })

  it('does not refresh provider-neutral null hosted review cache on a GitHub no-PR refresh', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/neutral'
    const cacheKey = `${repoId}::${branch}`
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)

    store.setState({
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: null,
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      outcome: { kind: 'no-pr', fetchedAt: 2 }
    })

    expect(store.getState().prCache[cacheKey]).toEqual({ data: null, fetchedAt: 2 })
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
      data: null,
      fetchedAt: 1
    })
  })

  it('clears GitHub-scoped null hosted review cache on a GitHub no-PR refresh', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/github-null'
    const cacheKey = `${repoId}::${branch}`
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)

    store.setState({
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: null,
          fetchedAt: 1,
          linkedReviewHintKey: 'github:12'
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      outcome: { kind: 'no-pr', fetchedAt: 2 }
    })

    expect(store.getState().prCache[cacheKey]).toEqual({ data: null, fetchedAt: 2 })
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
      data: null,
      fetchedAt: 2,
      linkedReviewHintKey: 'github:12'
    })
  })

  it('does not reuse a GitHub-scoped null hosted review cache for neutral discovery', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/github-null-then-gitlab'
    const cacheKey = `${repoId}::${branch}`
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const gitlabReview: HostedReviewInfo = {
      provider: 'gitlab',
      number: 5,
      title: 'GitLab MR',
      state: 'open',
      url: 'https://gitlab.com/acme/orca/-/merge_requests/5',
      status: 'success',
      updatedAt: '2026-03-28T00:00:00Z',
      mergeable: 'MERGEABLE'
    }

    store.setState({
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: null,
          fetchedAt: 1,
          linkedReviewHintKey: 'github:12'
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      outcome: { kind: 'no-pr', fetchedAt: 2 }
    })
    mockApi.hostedReview.forBranch.mockResolvedValueOnce(gitlabReview)

    await expect(
      store.getState().fetchHostedReviewForBranch(repoPath, branch, { repoId })
    ).resolves.toEqual(gitlabReview)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(1)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledWith({
      branch,
      linkedAzureDevOpsPR: null,
      linkedBitbucketPR: null,
      linkedGitHubPR: null,
      linkedGitLabMR: null,
      linkedGiteaPR: null,
      repoId,
      repoPath
    })
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
      data: gitlabReview,
      fetchedAt: expect.any(Number),
      linkedReviewHintKey: ''
    })
  })

  it('does not reuse a GitHub-scoped PR hit for neutral hosted review discovery', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/github-hit-then-gitlab'
    const cacheKey = `${repoId}::${branch}`
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const gitlabReview: HostedReviewInfo = {
      provider: 'gitlab',
      number: 5,
      title: 'GitLab MR',
      state: 'open',
      url: 'https://gitlab.com/acme/orca/-/merge_requests/5',
      status: 'success',
      updatedAt: '2026-03-28T00:00:00Z',
      mergeable: 'MERGEABLE'
    }

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, title: 'GitHub PR status' }),
        fetchedAt: 2
      }
    })
    mockApi.hostedReview.forBranch.mockResolvedValueOnce(gitlabReview)

    await expect(
      store.getState().fetchHostedReviewForBranch(repoPath, branch, { repoId })
    ).resolves.toEqual(gitlabReview)
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(1)
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
      data: gitlabReview,
      fetchedAt: expect.any(Number),
      linkedReviewHintKey: ''
    })
  })

  it('keeps cleared GitHub hosted review data scoped to GitHub PR discovery', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/github-data'
    const cacheKey = `${repoId}::${branch}`
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)

    store.setState({
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: {
            provider: 'github',
            number: 12,
            title: 'Old GitHub PR',
            state: 'open',
            url: 'https://github.com/acme/orca/pull/12',
            status: 'pending',
            updatedAt: '2026-03-28T00:00:00Z',
            mergeable: 'UNKNOWN'
          },
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      outcome: { kind: 'no-pr', fetchedAt: 2 }
    })

    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
      data: null,
      fetchedAt: 2,
      linkedReviewHintKey: 'github:12'
    })
  })

  it('does not clear non-GitHub hosted review cache on a GitHub no-PR refresh', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/gitlab'
    const cacheKey = `${repoId}::${branch}`
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const gitlabReview = {
      provider: 'gitlab' as const,
      number: 5,
      title: 'GitLab MR',
      state: 'open' as const,
      url: 'https://gitlab.com/acme/orca/-/merge_requests/5',
      status: 'success' as const,
      updatedAt: '2026-03-28T00:00:00Z',
      mergeable: 'MERGEABLE' as const
    }

    store.setState({
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: gitlabReview,
          fetchedAt: 1,
          linkedReviewHintKey: 'gitlab:5'
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      outcome: { kind: 'no-pr', fetchedAt: 2 }
    })

    expect(store.getState().prCache[cacheKey]).toBeUndefined()
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
      data: gitlabReview,
      fetchedAt: 1,
      linkedReviewHintKey: 'gitlab:5'
    })
  })
})

describe('createGitHubSlice.refreshGitHubForWorktreeIfStale', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('enqueues active PR refresh even when the cached PR is fresh', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const worktreeId = 'wt-1'

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: {
        'repo-1': [
          {
            id: worktreeId,
            repoId: 'repo-1',
            path: '/repo/worktrees/test',
            branch,
            displayName: 'test',
            isMainWorktree: false,
            isBare: false,
            isArchived: false
          }
        ]
      },
      worktreeCardProperties: ['pr'],
      prCache: {
        [`repo-1::${branch}`]: {
          data: makePR({ state: 'open' }),
          fetchedAt: Date.now()
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktreeIfStale(worktreeId)

    expect(mockApi.gh.enqueuePRRefresh).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        repoPath,
        branch,
        cacheKey: `repo-1::${branch}`,
        cachedPRState: 'open'
      }),
      reason: 'active',
      priority: 80
    })
  })

  it('enqueues active PR refresh with a GitHub hosted-review fallback number', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/hosted-review-fallback'
    const worktreeId = 'wt-1'
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: {
        [repoId]: [
          {
            id: worktreeId,
            repoId,
            path: '/repo/worktrees/test',
            branch,
            displayName: 'test',
            isMainWorktree: false,
            isBare: false,
            isArchived: false,
            linkedPR: null
          }
        ]
      },
      worktreeCardProperties: ['pr'],
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: {
            provider: 'github',
            number: 44,
            title: 'Hosted review fallback PR',
            state: 'open',
            url: 'https://github.com/acme/orca/pull/44',
            status: 'pending',
            updatedAt: '2026-03-28T00:00:00Z',
            mergeable: 'UNKNOWN'
          },
          fetchedAt: Date.now(),
          linkedReviewHintKey: 'github:44'
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktreeIfStale(worktreeId)

    expect(mockApi.gh.enqueuePRRefresh).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        repoPath,
        branch,
        fallbackPRNumber: 44
      }),
      reason: 'active',
      priority: 80
    })
  })

  it('does not enqueue active PR refresh when no PR-related surface is visible', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const worktreeId = 'wt-1'

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      groupBy: 'repo',
      worktreeCardProperties: ['comment'],
      rightSidebarOpen: false,
      rightSidebarTab: 'source-control',
      worktreesByRepo: {
        'repo-1': [
          {
            id: worktreeId,
            repoId: 'repo-1',
            path: '/repo/worktrees/test',
            branch,
            displayName: 'test',
            isMainWorktree: false,
            isBare: false,
            isArchived: false
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktreeIfStale(worktreeId)

    expect(mockApi.gh.enqueuePRRefresh).not.toHaveBeenCalled()
  })

  it('enqueues active PR refresh IPC for connected SSH-backed repos', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const worktreeId = 'wt-1'

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
      groupBy: 'pr-status',
      sshConnectionStates: new Map([['ssh-1', { status: 'connected' }]]),
      worktreesByRepo: {
        'repo-1': [
          {
            id: worktreeId,
            repoId: 'repo-1',
            path: '/repo/worktrees/test',
            branch,
            displayName: 'test',
            isMainWorktree: false,
            isBare: false,
            isArchived: false
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktreeIfStale(worktreeId)

    expect(mockApi.gh.enqueuePRRefresh).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        repoPath,
        branch,
        connectionId: 'ssh-1',
        connectionState: 'connected'
      }),
      reason: 'active',
      priority: 80
    })
  })

  it('enqueues active PR refresh when source control is the visible PR surface', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const worktreeId = 'wt-1'

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      groupBy: 'repo',
      worktreeCardProperties: ['comment'],
      rightSidebarOpen: true,
      rightSidebarTab: 'source-control',
      worktreesByRepo: {
        'repo-1': [
          {
            id: worktreeId,
            repoId: 'repo-1',
            path: '/repo/worktrees/test',
            branch,
            displayName: 'test',
            isMainWorktree: false,
            isBare: false,
            isArchived: false
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktreeIfStale(worktreeId)

    expect(mockApi.gh.enqueuePRRefresh).toHaveBeenCalledWith({
      candidate: expect.objectContaining({ repoPath, branch }),
      reason: 'active',
      priority: 80
    })
  })

  it('fetches PR through the runtime when activating a runtime workspace', async () => {
    resetRemoteRuntimeMocks()
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: makePR({ number: 12 }),
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/runtime'
    const worktreeId = 'wt-runtime'
    const hostedReviewCacheKey = getHostedReviewCacheKey(
      repoPath,
      branch,
      {
        activeRuntimeEnvironmentId: 'env-1'
      } as AppState['settings'],
      'repo-1'
    )

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      groupBy: 'pr-status',
      worktreeCardProperties: ['pr'],
      worktreesByRepo: {
        'repo-1': [
          {
            id: worktreeId,
            repoId: 'repo-1',
            path: '/repo/worktrees/runtime',
            branch,
            displayName: 'runtime',
            isMainWorktree: false,
            isBare: false,
            isArchived: false,
            linkedPR: 12
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktreeIfStale(worktreeId)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockApi.gh.enqueuePRRefresh).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.prForBranch',
      params: { repo: 'repo-1', branch, linkedPRNumber: 12 },
      timeoutMs: 30_000
    })
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toMatchObject({
      data: expect.objectContaining({
        provider: 'github',
        number: 12
      }),
      linkedReviewHintKey: 'github:12'
    })
    expect(store.getState().prCache[`runtime:env-1::repo-1::${branch}`]?.data).toMatchObject({
      number: 12
    })
    expect(store.getState().prCache[`repo-1::${branch}`]).toBeUndefined()
  })

  it('uses the cached PR number as a fallback refresh hint when worktree metadata is not linked yet', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/cached-pr'
    const worktreeId = 'wt-cached-pr'

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      groupBy: 'pr-status',
      worktreesByRepo: {
        [repoId]: [
          {
            id: worktreeId,
            repoId,
            path: '/repo/worktrees/cached-pr',
            branch,
            displayName: 'cached-pr',
            isMainWorktree: false,
            isBare: false,
            isArchived: false,
            linkedPR: null
          }
        ]
      },
      prCache: {
        [`${repoId}::${branch}`]: {
          data: makePR({ number: 42 }),
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktreeIfStale(worktreeId)

    expect(mockApi.gh.enqueuePRRefresh).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        repoPath,
        branch,
        linkedPRNumber: null,
        fallbackPRNumber: 42
      }),
      reason: 'active',
      priority: 80
    })
  })
})

describe('createGitHubSlice.refreshAllGitHub', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('refreshes stale PR data when source control is the visible PR surface', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      groupBy: 'repo',
      worktreeCardProperties: ['comment'],
      rightSidebarOpen: true,
      rightSidebarTab: 'source-control',
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            path: '/repo/worktrees/test',
            branch,
            displayName: 'test',
            isMainWorktree: false,
            isBare: false,
            isArchived: false,
            lastActivityAt: 1
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshAllGitHub()

    expect(mockApi.gh.enqueuePRRefresh).toHaveBeenCalledWith({
      candidate: expect.objectContaining({ repoPath, branch }),
      reason: 'swr',
      priority: 10
    })
  })

  it('refreshes runtime PR data directly instead of enqueueing local coordinator work', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: makePR({ number: 12 }),
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/runtime'

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      groupBy: 'repo',
      worktreeCardProperties: ['comment'],
      rightSidebarOpen: true,
      rightSidebarTab: 'source-control',
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            path: '/repo/worktrees/runtime',
            branch,
            displayName: 'runtime',
            isMainWorktree: false,
            isBare: false,
            isArchived: false,
            lastActivityAt: 1
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshAllGitHub()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockApi.gh.enqueuePRRefresh).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.prForBranch',
      params: { repo: 'repo-1', branch, linkedPRNumber: null },
      timeoutMs: 30_000
    })
  })
})

describe('createGitHubSlice.refreshGitHubForWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('refreshes runtime PR data directly after invalidating a worktree', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: makePR({ number: 12 }),
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/runtime'
    const worktreeId = 'wt-runtime'

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: {
        'repo-1': [
          {
            id: worktreeId,
            repoId: 'repo-1',
            path: '/repo/worktrees/runtime',
            branch,
            displayName: 'runtime',
            isMainWorktree: false,
            isBare: false,
            isArchived: false
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktree(worktreeId)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockApi.gh.enqueuePRRefresh).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.prForBranch',
      params: { repo: 'repo-1', branch, linkedPRNumber: null },
      timeoutMs: 30_000
    })
  })
})

describe('createGitHubSlice.fetchWorkItems source/error envelope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { items: [], sources: { issues: null, prs: null, upstreamCandidate: null } },
      _meta: { runtimeId: 'remote-runtime' }
    })
  })

  it('stores resolved sources on the cache entry for the indicator to read', async () => {
    // Why: parent design doc §1 suppression rule — the Tasks header indicator
    // consults `sources.issues` vs `sources.prs` on the cache entry. This is
    // the round-trip through fetchWorkItems that populates those fields.
    const store = createTestStore()
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      items: [],
      sources: { issues: { owner: 'up', repo: 'r' }, prs: { owner: 'fork', repo: 'r' } }
    })

    await store.getState().fetchWorkItems('repo-id', '/repo', 24, '')

    const result = store.getState().getWorkItemsSourcesAndError('repo-id', 24, '')
    expect(result.sources).toEqual({
      issues: { owner: 'up', repo: 'r' },
      prs: { owner: 'fork', repo: 'r' }
    })
    expect(result.error).toBeNull()
  })

  it('stamps the issues-side ClassifiedError with its source slug for banner copy', async () => {
    // Why: parent design doc §2 partial-failure rule — when the issue fetch
    // returns a 403 but the PR fetch succeeds, the cache entry carries the
    // successful items AND the error for the failing side so the banner +
    // list render together. The error's `source` is pinned to the issues
    // slug so the banner copy stays correct even if the cache entry later
    // receives new data from another read.
    const store = createTestStore()
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      items: [],
      sources: { issues: { owner: 'up', repo: 'r' }, prs: { owner: 'fork', repo: 'r' } },
      errors: { issues: { type: 'permission_denied', message: 'no access' } }
    })

    await store.getState().fetchWorkItems('repo-id', '/repo', 24, '')

    const result = store.getState().getWorkItemsSourcesAndError('repo-id', 24, '')
    expect(result.error).toMatchObject({
      type: 'permission_denied',
      message: 'no access',
      source: { owner: 'up', repo: 'r' }
    })
  })

  it('force-retry invalidates a still-failing in-flight request instead of deduping onto it', async () => {
    // Why: parent design doc §2 acceptance criterion 4 — the [Retry] button
    // must re-invoke the fetch with force=true and clear the banner on
    // success. That only works when force=true does not silently dedupe onto
    // a still-failing non-forcing request.
    const store = createTestStore()
    let resolveFailing: (v: unknown) => void = () => {}
    const failingRequest = new Promise((resolve) => {
      resolveFailing = resolve
    })
    mockApi.gh.listWorkItems.mockReturnValueOnce(failingRequest).mockResolvedValueOnce({
      items: [],
      sources: { issues: { owner: 'up', repo: 'r' }, prs: { owner: 'fork', repo: 'r' } }
    })

    const initialFetch = store.getState().fetchWorkItems('repo-id', '/repo', 24, '')
    const forcedFetch = store.getState().fetchWorkItems('repo-id', '/repo', 24, '', { force: true })

    // Let the initial request settle with an error so the force path runs.
    resolveFailing({
      items: [],
      sources: { issues: { owner: 'up', repo: 'r' }, prs: { owner: 'fork', repo: 'r' } },
      errors: { issues: { type: 'permission_denied', message: 'no access' } }
    })
    await initialFetch.catch(() => {})
    await forcedFetch

    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(2)
    const after = store.getState().getWorkItemsSourcesAndError('repo-id', 24, '')
    expect(after.error).toBeNull()
  })

  it('routes work item fetches through repo-scoped IPC even when a runtime is active', async () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      repos: [
        {
          id: 'repo-id',
          path: '/server/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1
        }
      ]
    } as Partial<AppState>)
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      items: [{ type: 'issue', number: 7, title: 'Server issue', url: 'https://example.test/7' }],
      sources: { issues: { owner: 'up', repo: 'r' }, prs: { owner: 'up', repo: 'r' } }
    })

    await store.getState().fetchWorkItems('repo-id', '/server/repo', 24, '')

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledWith({
      repoPath: '/server/repo',
      repoId: 'repo-id',
      limit: 24,
      query: undefined
    })
    expect(store.getState().workItemsCache['repo-id::24::'].data?.[0]).toMatchObject({
      repoId: 'repo-id',
      number: 7
    })
  })

  it('quietly skips SSH repos without a resolved GitHub remote in cross-repo fetches', async () => {
    const store = createTestStore()
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const item = {
      type: 'pr',
      number: 7,
      title: 'Server PR',
      url: 'https://example.test/7',
      updatedAt: '2026-05-21T00:00:00Z'
    } as GitHubWorkItem

    mockApi.gh.listWorkItems
      .mockRejectedValueOnce(new Error(GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE))
      .mockResolvedValueOnce({
        items: [item],
        sources: { issues: { owner: 'up', repo: 'r' }, prs: { owner: 'up', repo: 'r' } }
      })

    try {
      const result = await store.getState().fetchWorkItemsAcrossRepos(
        [
          { repoId: 'ssh-repo', path: '/server/ssh-repo' },
          { repoId: 'github-repo', path: '/server/github-repo' }
        ],
        24,
        100,
        ''
      )

      expect(result.failedCount).toBe(0)
      expect(result.items).toEqual([{ ...item, repoId: 'github-repo' }])
      expect(consoleWarn).not.toHaveBeenCalled()
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleWarn.mockRestore()
      consoleError.mockRestore()
    }
  })

  it('quietly skips SSH repos without a resolved GitHub remote in next-page fetches', async () => {
    const store = createTestStore()
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const item = {
      type: 'issue',
      number: 8,
      title: 'Server issue',
      url: 'https://example.test/8',
      updatedAt: '2026-05-21T00:00:00Z'
    } as GitHubWorkItem

    mockApi.gh.listWorkItems
      .mockRejectedValueOnce(new Error(GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE))
      .mockResolvedValueOnce({
        items: [item],
        sources: { issues: { owner: 'up', repo: 'r' }, prs: { owner: 'up', repo: 'r' } }
      })

    try {
      const result = await store.getState().fetchWorkItemsNextPage(
        [
          { repoId: 'ssh-repo', path: '/server/ssh-repo' },
          { repoId: 'github-repo', path: '/server/github-repo' }
        ],
        24,
        100,
        '',
        '2026-05-21T00:00:00Z'
      )

      expect(result.failedCount).toBe(0)
      expect(result.items).toEqual([{ ...item, repoId: 'github-repo' }])
      expect(consoleWarn).not.toHaveBeenCalled()
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it('routes project table fetches through the active runtime environment', async () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' }
    } as Partial<AppState>)
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: {
        ok: true,
        data: {
          project: {
            id: 'project-1',
            owner: 'acme',
            ownerType: 'organization',
            number: 1,
            title: 'Roadmap',
            url: 'https://github.com/orgs/acme/projects/1'
          },
          selectedView: {
            id: 'view-1',
            number: 1,
            name: 'Table',
            layout: 'TABLE_LAYOUT',
            filter: '',
            fields: [],
            groupByFields: [],
            sortByFields: []
          },
          rows: [],
          totalCount: 0,
          parentFieldDropped: false
        }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    const result = await store.getState().fetchProjectViewTable({
      owner: 'acme',
      ownerType: 'organization',
      projectNumber: 1,
      viewId: 'view-1'
    })

    expect(result.ok).toBe(true)
    expect(mockApi.gh.getProjectViewTable).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.project.viewTable',
      params: {
        owner: 'acme',
        ownerType: 'organization',
        projectNumber: 1,
        viewId: 'view-1'
      },
      timeoutMs: 60_000
    })
  })
})

describe('IssueSourceIndicator suppression', () => {
  it('hides when sources deep-equal, shows when they differ, hides when either is null', async () => {
    const { default: IssueSourceIndicator, sameGitHubOwnerRepo } =
      await import('../../components/github/IssueSourceIndicator')
    const React = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')

    // Same slug → null (no information to convey)
    expect(sameGitHubOwnerRepo({ owner: 'o', repo: 'r' }, { owner: 'o', repo: 'r' })).toBe(true)
    // Case-insensitive equality — the parent design doc calls out that `StablyAI/Orca`
    // and `stablyai/orca` resolve to the same repo and must suppress.
    expect(
      sameGitHubOwnerRepo({ owner: 'StablyAI', repo: 'Orca' }, { owner: 'stablyai', repo: 'orca' })
    ).toBe(true)
    expect(sameGitHubOwnerRepo({ owner: 'a', repo: 'r' }, { owner: 'b', repo: 'r' })).toBe(false)

    // null on either side → element renders as null (empty render)
    const sameEl = React.createElement(IssueSourceIndicator, {
      issues: { owner: 'o', repo: 'r' },
      prs: { owner: 'o', repo: 'r' }
    })
    expect(renderToStaticMarkup(sameEl)).toBe('')

    const nullIssueEl = React.createElement(IssueSourceIndicator, {
      issues: null,
      prs: { owner: 'o', repo: 'r' }
    })
    expect(renderToStaticMarkup(nullIssueEl)).toBe('')

    const diffEl = React.createElement(IssueSourceIndicator, {
      issues: { owner: 'up', repo: 'r' },
      prs: { owner: 'fork', repo: 'r' }
    })
    const defaultMarkup = renderToStaticMarkup(diffEl)
    expect(defaultMarkup).toContain('up/r')
    // Default variant is 'list' → plural prefix on list surfaces.
    expect(defaultMarkup).toContain('Issues from')

    // 'item' variant → singular prefix on detail surfaces where the chip
    // annotates a single issue (e.g. GitHubItemDialog).
    const itemEl = React.createElement(IssueSourceIndicator, {
      issues: { owner: 'up', repo: 'r' },
      prs: { owner: 'fork', repo: 'r' },
      variant: 'item'
    })
    const itemMarkup = renderToStaticMarkup(itemEl)
    expect(itemMarkup).toContain('up/r')
    expect(itemMarkup).toContain('Issue from')
    expect(itemMarkup).not.toContain('Issues from')
  })
})
