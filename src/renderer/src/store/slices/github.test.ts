/* eslint-disable max-lines -- Why: colocating the PR/issue cache, work-item
envelope, and IssueSourceIndicator suppression tests in one file keeps the
GitHub slice's cross-cutting invariants verifiable in one place. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { createGitHubSlice, workItemsCacheKey } from './github'
import type { AppState } from '../types'
import type { GitHubWorkItem, PRInfo } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

const mockApi = {
  gh: {
    prForBranch: vi.fn().mockResolvedValue(null),
    issue: vi.fn().mockResolvedValue(null),
    prChecks: vi.fn().mockResolvedValue([]),
    prComments: vi.fn().mockResolvedValue([]),
    listWorkItems: vi.fn(),
    getProjectViewTable: vi.fn()
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
      store.getState().checksCache[`${repoId}::pr-checks::acme/widgets::12`]?.data?.[0].name
    ).toBe('upstream')
    expect(
      store.getState().checksCache[`${repoId}::pr-checks::fork/widgets::12`]?.data?.[0].name
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
      store.getState().checksCache[`${repoId}::pr-checks::acme/widgets::12`]?.data?.[0].name
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
})

describe('createGitHubSlice.fetchPRForBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.prForBranch.mockResolvedValue(null)
  })

  it('lets a forced refresh bypass a non-forced inflight request and keeps the newer result', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const prCacheKey = `${repoPath}::${branch}`

    let resolveInitial: ((value: null) => void) | undefined
    const initialRequest = new Promise<null>((resolve) => {
      resolveInitial = resolve
    })

    mockApi.gh.prForBranch
      .mockReturnValueOnce(initialRequest)
      .mockResolvedValueOnce(makePR({ number: 99, title: 'Forced refresh PR' }))

    const initialFetch = store.getState().fetchPRForBranch(repoPath, branch)
    const forcedFetch = store.getState().fetchPRForBranch(repoPath, branch, { force: true })

    await expect(forcedFetch).resolves.toMatchObject({ number: 99, title: 'Forced refresh PR' })
    expect(mockApi.gh.prForBranch).toHaveBeenCalledTimes(2)
    expect(store.getState().prCache[prCacheKey]?.data).toMatchObject({ number: 99 })

    resolveInitial?.(null)
    await expect(initialFetch).resolves.toBeNull()

    expect(store.getState().prCache[prCacheKey]?.data).toMatchObject({ number: 99 })
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
