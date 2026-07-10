/* eslint-disable max-lines -- Why: colocating the PR/issue cache, work-item
envelope, and IssueSourceIndicator suppression tests in one file keeps the
GitHub slice's cross-cutting invariants verifiable in one place. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import {
  _clearGitHubPRRefreshStartedEntriesForTest,
  _getGitHubPRRefreshStartedEntryCountForTest,
  _getGitHubPRRequestGenerationCountForTest,
  createGitHubSlice,
  issueCacheKey,
  mergePRCommentIntoList,
  prChecksCacheSuffix,
  prCommentsCacheSuffix,
  projectViewCacheKey,
  workItemsCacheKey
} from './github'
import { createHostedReviewSlice } from './hosted-review'
import type { AppState } from '../types'
import type { GitHubWorkItem, PRInfo, Worktree } from '../../../../shared/types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE } from '../../../../shared/work-items'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { getHostedReviewCacheKey } from './hosted-review-cache-identity'
import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { GITHUB_WORK_ITEMS_QUERY_MAX_BYTES } from './github-work-items-query-bounds'

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

const mockApi = {
  gh: {
    prForBranch: vi.fn().mockResolvedValue(null),
    refreshPRNow: vi.fn(),
    enqueuePRRefresh: vi.fn().mockResolvedValue(undefined),
    issue: vi.fn().mockResolvedValue(null),
    prChecks: vi.fn().mockResolvedValue([]),
    prCheckDetails: vi.fn().mockResolvedValue(null),
    prComments: vi.fn().mockResolvedValue([]),
    addIssueComment: vi.fn(),
    addPRReviewCommentReply: vi.fn(),
    resolveReviewThread: vi.fn(),
    listWorkItems: vi.fn(),
    countWorkItems: vi.fn().mockResolvedValue(0),
    getProjectViewTable: vi.fn(),
    updateProjectItemField: vi.fn(),
    clearProjectItemField: vi.fn(),
    updateIssueBySlug: vi.fn(),
    updatePullRequestBySlug: vi.fn(),
    updateIssueTypeBySlug: vi.fn()
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

function makePRRefreshWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-pr-refresh',
    repoId: 'repo-1',
    path: '/repo/worktrees/pr-refresh',
    displayName: 'PR refresh',
    branch: 'feature/pr-refresh',
    head: 'head-oid',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

function installLinkedPRClearStub(
  store: ReturnType<typeof createTestStore>,
  args: {
    repoId: string
    repoPath: string
    branch: string
    worktree: Worktree
  }
) {
  const cacheKey = `${args.repoId}::${args.branch}`
  const updateWorktreeMeta = vi.fn(
    async (
      worktreeId: string,
      updates: Parameters<AppState['updateWorktreeMeta']>[1],
      options?: Parameters<AppState['updateWorktreeMeta']>[2]
    ) => {
      const currentWorktree = store
        .getState()
        .worktreesByRepo[args.repoId]?.find((worktree) => worktree.id === worktreeId)
      if (options?.shouldApply && !options.shouldApply(currentWorktree)) {
        return
      }
      store.setState((state) => {
        const nextWorktrees = {
          ...state.worktreesByRepo,
          [args.repoId]: (state.worktreesByRepo[args.repoId] ?? []).map((worktree) =>
            worktree.id === worktreeId ? { ...worktree, ...updates } : worktree
          )
        }
        const nextPRCache = { ...state.prCache }
        delete nextPRCache[cacheKey]
        return { worktreesByRepo: nextWorktrees, prCache: nextPRCache } as Partial<AppState>
      })
    }
  )
  store.setState({
    repos: [{ id: args.repoId, path: args.repoPath, name: 'repo', kind: 'git' }],
    worktreesByRepo: { [args.repoId]: [args.worktree] },
    updateWorktreeMeta
  } as unknown as Partial<AppState>)
  return updateWorktreeMeta
}

function githubSourceContext(
  hostId: TaskSourceContext['hostId'],
  repoId = 'source-repo-id'
): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'github',
    projectId: 'github:stablyai/orca',
    hostId,
    projectHostSetupId: 'setup-1',
    repoId,
    providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
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
      sources: { issues: null; prs: null; originCandidate: null; upstreamCandidate: null }
    }
    let resolveFirst: (value: WorkItemsEnvelope) => void = () => {}
    const firstRequest = new Promise<WorkItemsEnvelope>((resolve) => {
      resolveFirst = resolve
    })
    mockApi.gh.listWorkItems.mockReturnValueOnce(firstRequest).mockResolvedValueOnce({
      items: [],
      sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
    })

    const firstFetch = store.getState().fetchWorkItems('repo-1', '/repo/one', 20, '')
    await Promise.resolve()
    store.getState().evictGitHubRepoCaches('repo-1', '/repo/one')
    const secondFetch = store.getState().fetchWorkItems('repo-1', '/repo/one', 20, '')
    resolveFirst({
      items: [],
      sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
    })
    await firstFetch
    await secondFetch

    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(2)
  })

  it('does not let a stale pre-invalidation work-item response rewrite the cache', async () => {
    const store = createTestStore()
    const item = {
      type: 'pr',
      number: 42,
      title: 'Old origin PR',
      url: 'https://example.test/42',
      updatedAt: '2026-05-22T00:00:00Z'
    } as GitHubWorkItem
    let resolveFirst: (value: {
      items: GitHubWorkItem[]
      sources: {
        issues: null
        prs: { owner: 'fork'; repo: 'r' }
        originCandidate: { owner: 'fork'; repo: 'r' }
        upstreamCandidate: { owner: 'up'; repo: 'r' }
      }
    }) => void = () => {}
    mockApi.gh.listWorkItems.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )

    const firstFetch = store.getState().fetchWorkItems('repo-1', '/repo/one', 20, '')
    await Promise.resolve()
    store.setState((s) => ({ workItemsInvalidationNonce: s.workItemsInvalidationNonce + 1 }))
    resolveFirst({
      items: [item],
      sources: {
        issues: null,
        prs: { owner: 'fork', repo: 'r' },
        originCandidate: { owner: 'fork', repo: 'r' },
        upstreamCandidate: { owner: 'up', repo: 'r' }
      }
    })

    await expect(firstFetch).resolves.toEqual([{ ...item, repoId: 'repo-1' }])
    expect(store.getState().workItemsCache[workItemsCacheKey('repo-1', 20, '')]).toBeUndefined()
  })
})

describe('createGitHubSlice cache bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.issue.mockReset()
    mockApi.gh.refreshPRNow.mockReset()
    mockApi.hostedReview.forBranch.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('bounds restored PR and issue caches', async () => {
    const store = createTestStore()
    const pr = Object.fromEntries(
      Array.from({ length: 505 }, (_, index) => [
        `repo-id::branch-${index}`,
        { data: makePR({ number: index }), fetchedAt: index }
      ])
    )
    const issue = Object.fromEntries(
      Array.from({ length: 505 }, (_, index) => [
        `repo-id::${index}`,
        { data: { number: index } as never, fetchedAt: index }
      ])
    )
    mockApi.cache.getGitHub.mockResolvedValueOnce({ pr, issue })

    await store.getState().initGitHubCache()

    expect(Object.keys(store.getState().prCache)).toHaveLength(500)
    expect(Object.keys(store.getState().issueCache)).toHaveLength(500)
    expect(store.getState().prCache['repo-id::branch-0']).toBeUndefined()
    expect(store.getState().issueCache['repo-id::0']).toBeUndefined()
  })

  it('bounds PR and issue caches as fetches add entries', async () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    mockApi.gh.refreshPRNow.mockImplementation(({ candidate }) => ({
      kind: 'found',
      pr: makePR({ title: candidate.branch }),
      fetchedAt: Date.now()
    }))
    mockApi.gh.issue.mockImplementation(({ number }) => ({
      number,
      title: `Issue ${number}`,
      state: 'open',
      url: `https://example.com/issues/${number}`
    }))

    for (let index = 0; index < 505; index++) {
      vi.setSystemTime(index)
      await store.getState().fetchPRForBranch(repoPath, `branch-${index}`, {
        force: true,
        repoId
      })
      await store.getState().fetchIssue(repoPath, index, { repoId })
    }

    expect(Object.keys(store.getState().prCache)).toHaveLength(500)
    expect(Object.keys(store.getState().issueCache)).toHaveLength(500)
    expect(store.getState().prCache['repo-id::branch-0']).toBeUndefined()
    expect(store.getState().issueCache['repo-id::0']).toBeUndefined()

    await vi.runOnlyPendingTimersAsync()
  })

  it('routes runtime-owned issue fetches through the owning runtime when local is focused', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-issue-owner',
      ok: true,
      result: {
        number: 123,
        title: 'Runtime issue',
        state: 'open',
        url: 'https://example.com/issues/123'
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoPath = '/runtime/repo'
    store.setState({
      settings: null,
      repos: [
        {
          id: 'repo-runtime',
          path: repoPath,
          name: 'repo',
          kind: 'git',
          executionHostId: 'runtime:env-1'
        }
      ]
    } as unknown as Partial<AppState>)

    await expect(
      store.getState().fetchIssue(repoPath, 123, { repoId: 'repo-runtime' })
    ).resolves.toMatchObject({ number: 123, title: 'Runtime issue' })

    expect(mockApi.gh.issue).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.issue',
      params: { repo: 'repo-runtime', number: 123 },
      timeoutMs: 30_000
    })
    expect(
      store.getState().issueCache[
        issueCacheKey(repoPath, 'repo-runtime', 123, null, null, 'runtime:env-1')
      ]?.data
    ).toMatchObject({ number: 123 })
  })

  it('routes explicit source-context issue fetches through the source runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-source-issue',
      ok: true,
      result: {
        number: 19,
        title: 'Source issue',
        state: 'open',
        url: 'https://example.com/issues/19'
      },
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

    await expect(
      store.getState().fetchIssue(repoPath, 19, { repoId, sourceContext })
    ).resolves.toMatchObject({ number: 19, title: 'Source issue' })

    expect(mockApi.gh.issue).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'source-runtime',
      method: 'github.issue',
      params: { repo: 'runtime-repo-id', number: 19 },
      timeoutMs: 30_000
    })
    expect(
      store.getState().issueCache[`${getTaskSourceCacheScope(sourceContext)}::${repoId}::19`]?.data
    ).toMatchObject({ number: 19 })
  })

  it('routes SSH-owned issue fetches through local IPC when a runtime is focused', async () => {
    mockApi.gh.issue.mockResolvedValueOnce({
      number: 321,
      title: 'SSH issue',
      state: 'open',
      url: 'https://example.com/issues/321'
    })
    const store = createTestStore()
    const repoPath = '/ssh/repo'
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-focused' } as AppState['settings'],
      repos: [
        {
          id: 'repo-ssh',
          path: repoPath,
          name: 'repo',
          kind: 'git',
          connectionId: 'ssh-1',
          executionHostId: 'ssh:ssh-1'
        }
      ]
    } as unknown as Partial<AppState>)

    await expect(
      store.getState().fetchIssue(repoPath, 321, { repoId: 'repo-ssh' })
    ).resolves.toMatchObject({
      number: 321,
      title: 'SSH issue'
    })

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.issue).toHaveBeenCalledWith({ repoPath, repoId: 'repo-ssh', number: 321 })
    expect(
      store.getState().issueCache[
        issueCacheKey(repoPath, 'repo-ssh', 321, null, 'ssh-1', 'ssh:ssh-1')
      ]?.data
    ).toMatchObject({ number: 321 })
    expect(
      store.getState().issueCache[
        issueCacheKey(repoPath, 'repo-ssh', 321, {
          activeRuntimeEnvironmentId: 'env-focused'
        } as AppState['settings'])
      ]
    ).toBeUndefined()
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

  it('can scope patches to one GitHub task source when hosts share a repo id and work-item id', () => {
    const store = createTestStore()
    const firstSourceContext = githubSourceContext('runtime:first-host', 'repo-1')
    const secondSourceContext = githubSourceContext('runtime:second-host', 'repo-1')
    const firstItem = {
      id: 'pr:42',
      repoId: 'repo-1',
      type: 'pr',
      number: 42,
      title: 'First host PR'
    } as GitHubWorkItem
    const secondItem = {
      id: 'pr:42',
      repoId: 'repo-1',
      type: 'pr',
      number: 42,
      title: 'Second host PR'
    } as GitHubWorkItem

    store.setState({
      workItemsCache: {
        [workItemsCacheKey('repo-1', 20, '', getTaskSourceCacheScope(firstSourceContext))]: {
          data: [firstItem],
          fetchedAt: 1
        },
        [workItemsCacheKey('repo-1', 20, '', getTaskSourceCacheScope(secondSourceContext))]: {
          data: [secondItem],
          fetchedAt: 1
        }
      }
    })

    store.getState().patchWorkItem('pr:42', { reviewRequests: [] }, 'repo-1', {
      sourceContext: firstSourceContext
    })

    const state = store.getState()
    const firstPatched =
      state.workItemsCache[
        workItemsCacheKey('repo-1', 20, '', getTaskSourceCacheScope(firstSourceContext))
      ]?.data?.[0]
    const secondPatched =
      state.workItemsCache[
        workItemsCacheKey('repo-1', 20, '', getTaskSourceCacheScope(secondSourceContext))
      ]?.data?.[0]
    expect(firstPatched).toMatchObject({
      title: 'First host PR',
      reviewRequests: []
    })
    expect(secondPatched).toBe(secondItem)
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

  it('keeps known local repo comments on local cache keys when a runtime is focused', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)
    mockApi.gh.prComments.mockResolvedValueOnce([
      { id: 1, author: 'local', authorAvatarUrl: '', body: '', createdAt: '', url: '' }
    ])

    await store.getState().fetchPRComments(repoPath, 12, {
      force: true,
      repoId,
      prRepo: { owner: 'Acme', repo: 'Widgets' }
    })

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.prComments).toHaveBeenCalledWith({
      repoPath,
      repoId,
      prNumber: 12,
      prRepo: { owner: 'Acme', repo: 'Widgets' },
      noCache: true,
      sourceContext: undefined
    })
    expect(
      store.getState().commentsCache[`${repoId}::pr-comments::acme/widgets::12`]?.data?.[0].author
    ).toBe('local')
    expect(
      store.getState().commentsCache[`runtime:env-1::${repoId}::pr-comments::acme/widgets::12`]
    ).toBeUndefined()
  })

  it('routes explicit source-context PR comments through the source runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-source-comments',
      ok: true,
      result: [{ id: 1, author: 'source', authorAvatarUrl: '', body: '', createdAt: '', url: '' }],
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

    await store.getState().fetchPRComments(repoPath, 12, {
      force: true,
      repoId,
      sourceContext,
      prRepo: { owner: 'Acme', repo: 'Widgets' }
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'source-runtime',
      method: 'github.prComments',
      params: {
        repo: 'runtime-repo-id',
        prNumber: 12,
        prRepo: { owner: 'Acme', repo: 'Widgets' },
        noCache: true
      },
      timeoutMs: 30_000
    })
    expect(
      store.getState().commentsCache[
        `${getTaskSourceCacheScope(sourceContext)}::${repoId}::pr-comments::acme/widgets::12`
      ]?.data?.[0].author
    ).toBe('source')
    expect(mockApi.gh.prComments).not.toHaveBeenCalled()
  })

  it('bounds PR comment cache entries across many repos', async () => {
    vi.useFakeTimers()

    try {
      const store = createTestStore()
      mockApi.gh.prComments.mockResolvedValue([])

      for (let i = 0; i <= 500; i++) {
        vi.setSystemTime(1_000 + i)
        await store.getState().fetchPRComments(`/repo/${i}`, 12, {
          force: true,
          repoId: `repo-${i}`
        })
      }

      const cache = store.getState().commentsCache
      expect(Object.keys(cache)).toHaveLength(500)
      expect(cache[`repo-0::${prCommentsCacheSuffix(12)}`]).toBeUndefined()
      expect(cache[`repo-500::${prCommentsCacheSuffix(12)}`]).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
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

describe('createGitHubSlice PR comment mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.addIssueComment.mockResolvedValue({
      ok: true,
      comment: {
        id: 10,
        author: 'me',
        authorAvatarUrl: '',
        body: 'done',
        createdAt: '2026-03-28T00:00:00Z',
        url: ''
      }
    })
    mockApi.gh.addPRReviewCommentReply.mockResolvedValue({
      ok: true,
      comment: {
        id: 11,
        author: 'me',
        authorAvatarUrl: '',
        body: 'reply',
        createdAt: '2026-03-28T00:01:00Z',
        url: ''
      }
    })
  })

  it('deduplicates merged PR comments and preserves existing thread metadata', () => {
    expect(
      mergePRCommentIntoList(
        [
          {
            id: 4,
            author: 'reviewer',
            authorAvatarUrl: '',
            body: 'old',
            createdAt: '2026-03-28T00:00:00Z',
            url: '',
            threadId: 'PRRT_1',
            path: 'src/a.ts',
            line: 12,
            isResolved: false
          }
        ],
        {
          id: 4,
          author: 'reviewer',
          authorAvatarUrl: '',
          body: 'new',
          createdAt: '2026-03-28T00:02:00Z',
          url: ''
        }
      )
    ).toEqual([
      {
        id: 4,
        author: 'reviewer',
        authorAvatarUrl: '',
        body: 'new',
        createdAt: '2026-03-28T00:02:00Z',
        url: '',
        threadId: 'PRRT_1',
        path: 'src/a.ts',
        line: 12,
        isResolved: false
      }
    ])
  })

  it('posts top-level PR comments with the visible PR repo and pr invalidation type', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    await store.getState().addPRConversationComment(repoPath, 12, 'done', {
      repoId,
      prRepo: { owner: 'Acme', repo: 'Widgets' }
    })

    expect(mockApi.gh.addIssueComment).toHaveBeenCalledWith({
      repoPath,
      repoId,
      number: 12,
      body: 'done',
      type: 'pr',
      prRepo: { owner: 'Acme', repo: 'Widgets' }
    })
    expect(
      store.getState().commentsCache[`${repoId}::pr-comments::acme/widgets::12`]?.data?.[0].body
    ).toBe('done')
  })

  it('posts top-level PR comments with explicit local source context', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const sourceContext = githubSourceContext('local', repoId)
    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    await store.getState().addPRConversationComment(repoPath, 12, 'done', {
      repoId,
      sourceContext,
      prRepo: { owner: 'Acme', repo: 'Widgets' }
    })

    expect(mockApi.gh.addIssueComment).toHaveBeenCalledWith({
      repoPath,
      repoId,
      number: 12,
      body: 'done',
      type: 'pr',
      prRepo: { owner: 'Acme', repo: 'Widgets' },
      sourceContext
    })
    expect(
      store.getState().commentsCache[
        `${getTaskSourceCacheScope(sourceContext)}::${repoId}::pr-comments::acme/widgets::12`
      ]?.data?.[0].body
    ).toBe('done')
  })

  it('routes runtime PR review replies with prRepo and merges returned thread metadata', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-pr-reply',
      ok: true,
      result: {
        ok: true,
        comment: {
          id: 12,
          author: 'me',
          authorAvatarUrl: '',
          body: 'reply',
          createdAt: '2026-03-28T00:02:00Z',
          url: ''
        }
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

    await store.getState().addPRReviewCommentReply(repoPath, 12, 99, 'reply', {
      repoId,
      prRepo: { owner: 'Acme', repo: 'Widgets' },
      threadId: 'PRRT_1',
      path: 'src/a.ts',
      line: 8
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.addPRReviewCommentReply',
      params: {
        repo: repoId,
        prNumber: 12,
        commentId: 99,
        body: 'reply',
        threadId: 'PRRT_1',
        path: 'src/a.ts',
        line: 8,
        prRepo: { owner: 'Acme', repo: 'Widgets' }
      },
      timeoutMs: 30_000
    })
    expect(
      store.getState().commentsCache[`runtime:env-1::${repoId}::pr-comments::acme/widgets::12`]
        ?.data?.[0]
    ).toMatchObject({ body: 'reply', threadId: 'PRRT_1', path: 'src/a.ts', line: 8 })
  })

  it('does not mutate the PR comments cache when GitHub omits the comment payload', async () => {
    mockApi.gh.addIssueComment.mockResolvedValueOnce({ ok: true })
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    const result = await store.getState().addPRConversationComment(repoPath, 12, 'done', {
      repoId,
      prRepo: { owner: 'Acme', repo: 'Widgets' }
    })

    expect(result).toEqual({ ok: false, error: 'GitHub did not return the new comment.' })
    expect(
      store.getState().commentsCache[`${repoId}::pr-comments::acme/widgets::12`]
    ).toBeUndefined()
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
    _clearGitHubPRRefreshStartedEntriesForTest()
  })

  afterEach(() => {
    _clearGitHubPRRefreshStartedEntriesForTest()
    vi.useRealTimers()
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

  it('does not retain PR request generation keys after the active request settles', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/no-generation-leak'
    const beforeCount = _getGitHubPRRequestGenerationCountForTest()
    const refreshPRNow = mockApi.gh.refreshPRNow
    ;(mockApi.gh as unknown as { refreshPRNow?: typeof refreshPRNow }).refreshPRNow = undefined
    mockApi.gh.prForBranch.mockResolvedValueOnce(makePR({ number: 31 }))

    try {
      await expect(
        store.getState().fetchPRForBranch(repoPath, branch, { force: true })
      ).resolves.toMatchObject({ number: 31 })
      expect(_getGitHubPRRequestGenerationCountForTest()).toBe(beforeCount)
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

  it('ignores a direct exact linked PR refresh after the worktree was unlinked', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/unlinked-direct-pr'
    const worktreeId = 'wt-unlinked-direct-pr'
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    let resolveRefresh: (
      value: Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>
    ) => void = () => {}
    const refresh = new Promise<Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>>((resolve) => {
      resolveRefresh = resolve
    })
    mockApi.gh.refreshPRNow.mockReturnValueOnce(refresh)

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: {
        [repoId]: [
          {
            id: worktreeId,
            repoId,
            path: '/repo/worktrees/unlinked-direct-pr',
            branch,
            displayName: 'unlinked-direct-pr',
            isMainWorktree: false,
            isBare: false,
            isArchived: false,
            linkedPR: 12
          }
        ]
      }
    } as unknown as Partial<AppState>)

    const request = store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId,
      worktreeId,
      linkedPRNumber: 12
    })
    store.setState({
      worktreesByRepo: {
        [repoId]: [
          {
            id: worktreeId,
            repoId,
            path: '/repo/worktrees/unlinked-direct-pr',
            branch,
            displayName: 'unlinked-direct-pr',
            isMainWorktree: false,
            isBare: false,
            isArchived: false,
            linkedPR: null
          }
        ]
      },
      hostedReviewCache: {},
      prCache: {}
    } as unknown as Partial<AppState>)
    resolveRefresh({
      kind: 'found',
      pr: makePR({ number: 12, title: 'Stale exact linked PR' }),
      fetchedAt: Date.now()
    })

    await expect(request).resolves.toBeNull()
    expect(store.getState().prCache[`${repoId}::${branch}`]).toBeUndefined()
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toBeUndefined()
  })

  it('clears a linked merged PR when the resolved PR definitively diverged from the request head', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/new-work'
    const worktreeId = 'wt-diverged-linked-pr'
    const worktree = makePRRefreshWorktree({
      id: worktreeId,
      repoId,
      branch,
      head: 'current-head',
      linkedPR: 12
    })
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree
    })
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({
        number: 12,
        state: 'merged',
        headSha: 'merged-pr-head',
        headDivergedFromMergedPRAtOid: 'current-head'
      }),
      fetchedAt: 2
    })

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, {
        force: true,
        repoId,
        worktreeId,
        linkedPRNumber: 12
      })
    ).resolves.toMatchObject({ number: 12 })

    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      worktreeId,
      { linkedPR: null },
      { shouldApply: expect.any(Function) }
    )
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBeNull()
    expect(store.getState().prCache[`${repoId}::${branch}`]).toBeUndefined()
  })

  it('clears a linked merged PR on a fresh cache hit that already carries a head-scoped divergence signal', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/cached-diverged'
    const worktreeId = 'wt-cached-diverged'
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree: makePRRefreshWorktree({
        id: worktreeId,
        repoId,
        branch,
        head: 'current-head',
        linkedPR: 12
      })
    })
    store.setState({
      prCache: {
        [`${repoId}::${branch}`]: {
          data: makePR({
            number: 12,
            state: 'merged',
            headSha: 'merged-pr-head',
            headDivergedFromMergedPRAtOid: 'current-head'
          }),
          fetchedAt: Date.now()
        }
      }
    } as unknown as Partial<AppState>)

    const result = await store.getState().fetchPRForBranch(repoPath, branch, {
      repoId,
      worktreeId,
      linkedPRNumber: 12
    })

    expect(result).toMatchObject({ number: 12 })
    expect(mockApi.gh.refreshPRNow).not.toHaveBeenCalled()
    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      worktreeId,
      { linkedPR: null },
      { shouldApply: expect.any(Function) }
    )
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBeNull()
  })

  it('does not clear a linked merged PR when the request head equals the PR head', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/at-pr-head'
    const worktreeId = 'wt-at-pr-head'
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree: makePRRefreshWorktree({
        id: worktreeId,
        repoId,
        branch,
        head: 'same-head',
        linkedPR: 12
      })
    })
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({
        number: 12,
        state: 'merged',
        headSha: 'same-head',
        headDivergedFromMergedPRAtOid: 'same-head'
      }),
      fetchedAt: 2
    })

    await store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId,
      worktreeId,
      linkedPRNumber: 12
    })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBe(12)
  })

  it('does not clear a linked merged PR when the request head is confirmed contained', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/contained'
    const worktreeId = 'wt-contained'
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree: makePRRefreshWorktree({
        id: worktreeId,
        repoId,
        branch,
        head: 'contained-head',
        linkedPR: 12
      })
    })
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({
        number: 12,
        state: 'merged',
        headSha: 'merged-pr-head',
        confirmedContainedHeadOid: 'contained-head',
        headDivergedFromMergedPRAtOid: 'contained-head'
      }),
      fetchedAt: 2
    })

    await store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId,
      worktreeId,
      linkedPRNumber: 12
    })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBe(12)
  })

  it('does not clear a linked open PR even when a divergence bit is present', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/open-pr'
    const worktreeId = 'wt-open-pr'
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree: makePRRefreshWorktree({
        id: worktreeId,
        repoId,
        branch,
        head: 'current-head',
        linkedPR: 12
      })
    })
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({
        number: 12,
        state: 'open',
        headSha: 'pr-head',
        headDivergedFromMergedPRAtOid: 'current-head'
      }),
      fetchedAt: 2
    })

    await store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId,
      worktreeId,
      linkedPRNumber: 12
    })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('does not clear a linked PR on a null PR result', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/null-pr'
    const worktreeId = 'wt-null-pr'
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree: makePRRefreshWorktree({
        id: worktreeId,
        repoId,
        branch,
        head: 'current-head',
        linkedPR: 12
      })
    })
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({ kind: 'no-pr', fetchedAt: 2 })

    await store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId,
      worktreeId,
      linkedPRNumber: 12
    })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('does not clear when divergence is unset even if containment does not match the head', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/unknown-probe'
    const worktreeId = 'wt-unknown-probe'
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree: makePRRefreshWorktree({
        id: worktreeId,
        repoId,
        branch,
        head: 'current-head',
        linkedPR: 12
      })
    })
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({
        number: 12,
        state: 'merged',
        headSha: 'merged-pr-head',
        confirmedContainedHeadOid: 'other-head'
      }),
      fetchedAt: 2
    })

    await store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId,
      worktreeId,
      linkedPRNumber: 12
    })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBe(12)
  })

  it('does not clear when the linked PR number changed before the lookup completed', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/relinked'
    const worktreeId = 'wt-relinked'
    let resolveRefresh: (
      value: Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>
    ) => void = () => {}
    const refresh = new Promise<Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>>((resolve) => {
      resolveRefresh = resolve
    })
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree: makePRRefreshWorktree({
        id: worktreeId,
        repoId,
        branch,
        head: 'current-head',
        linkedPR: 12
      })
    })
    mockApi.gh.refreshPRNow.mockReturnValueOnce(refresh)

    const request = store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId,
      worktreeId,
      linkedPRNumber: 12
    })
    store.setState({
      worktreesByRepo: {
        [repoId]: [
          makePRRefreshWorktree({
            id: worktreeId,
            repoId,
            branch,
            head: 'current-head',
            linkedPR: 13
          })
        ]
      }
    } as unknown as Partial<AppState>)
    resolveRefresh({
      kind: 'found',
      pr: makePR({
        number: 12,
        state: 'merged',
        headSha: 'merged-pr-head',
        headDivergedFromMergedPRAtOid: 'current-head'
      }),
      fetchedAt: 2
    })

    await expect(request).resolves.toBeNull()
    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBe(13)
  })

  it('does not clear when the worktree head moved after the lookup started', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/head-moved'
    const worktreeId = 'wt-head-moved'
    let resolveRefresh: (
      value: Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>
    ) => void = () => {}
    const refresh = new Promise<Awaited<ReturnType<typeof mockApi.gh.refreshPRNow>>>((resolve) => {
      resolveRefresh = resolve
    })
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree: makePRRefreshWorktree({
        id: worktreeId,
        repoId,
        branch,
        head: 'request-head',
        linkedPR: 12
      })
    })
    mockApi.gh.refreshPRNow.mockReturnValueOnce(refresh)

    const request = store.getState().fetchPRForBranch(repoPath, branch, {
      force: true,
      repoId,
      worktreeId,
      linkedPRNumber: 12
    })
    store.setState({
      worktreesByRepo: {
        [repoId]: [
          makePRRefreshWorktree({
            id: worktreeId,
            repoId,
            branch,
            head: 'new-head',
            linkedPR: 12
          })
        ]
      }
    } as unknown as Partial<AppState>)
    resolveRefresh({
      kind: 'found',
      pr: makePR({
        number: 12,
        state: 'merged',
        headSha: 'merged-pr-head',
        headDivergedFromMergedPRAtOid: 'request-head'
      }),
      fetchedAt: 2
    })

    await expect(request).resolves.toMatchObject({ number: 12 })
    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      worktreeId,
      { linkedPR: null },
      { shouldApply: expect.any(Function) }
    )
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBe(12)
    expect(store.getState().prCache[`${repoId}::${branch}`]).toMatchObject({
      data: expect.objectContaining({ number: 12 })
    })
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

  it.each(['open', 'draft'] as const)(
    'clears visible cached %s PR data when a fallback refresh misses',
    async (state) => {
      const store = createTestStore()
      const repoPath = '/repo'
      const repoId = 'repo-1'
      const branch = 'feature/fallback-miss'
      const cachedPR = makePR({ number: 12, state, title: 'Visible cached PR' })
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
              state,
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
      ).resolves.toBeNull()
      expect(store.getState().prCache[`${repoId}::${branch}`]).toEqual({
        data: null,
        fetchedAt: 2
      })
      expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
        data: null,
        fetchedAt: 2,
        linkedReviewHintKey: 'github:12'
      })
    }
  )

  it('writes a merged fallback result over an open cached PR', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/fallback-found-merged'
    const cachedPR = makePR({ number: 12, title: 'Visible open PR', state: 'open' })
    const mergedPR = makePR({
      number: 12,
      title: 'Merged PR',
      state: 'merged',
      headSha: 'head-oid'
    })
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
            title: 'Visible open PR',
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
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'found',
      pr: mergedPR,
      fetchedAt: 2
    })

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, {
        force: true,
        repoId,
        fallbackPRNumber: 12
      })
    ).resolves.toEqual(mergedPR)
    expect(store.getState().prCache[`${repoId}::${branch}`]).toEqual({
      data: mergedPR,
      fetchedAt: 2
    })
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toMatchObject({
      data: expect.objectContaining({ provider: 'github', number: 12, state: 'merged' }),
      fetchedAt: 2,
      linkedReviewHintKey: 'github:12'
    })
  })

  it('preserves cached merged PR data when a forced no-PR refresh matches the worktree head', async () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/merged-pr-head-match'
    const worktreeId = 'wt-merged-direct-match'
    const cachedPR = makePR({
      number: 12,
      title: 'Merged PR still checked out',
      state: 'merged',
      headSha: 'merged-head'
    })

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: {
        [repoId]: [
          makePRRefreshWorktree({
            id: worktreeId,
            repoId,
            branch,
            head: 'merged-head'
          })
        ]
      },
      prCache: {
        [`${repoId}::${branch}`]: {
          data: cachedPR,
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({ kind: 'no-pr', fetchedAt: 2 })

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, {
        force: true,
        repoId,
        worktreeId
      })
    ).resolves.toEqual(cachedPR)
    expect(store.getState().prCache[`${repoId}::${branch}`]).toEqual({
      data: cachedPR,
      fetchedAt: 1
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockApi.cache.setGitHub).not.toHaveBeenCalled()
  })

  it('preserves cached merged PR data when the worktree head is a confirmed PR commit', async () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/merged-pr-behind-head'
    const worktreeId = 'wt-merged-behind-head'
    const cachedPR = makePR({
      number: 13,
      title: 'Merged PR with unpulled final head',
      state: 'merged',
      headSha: 'merged-final-head',
      confirmedContainedHeadOid: 'behind-head'
    })

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: {
        [repoId]: [
          makePRRefreshWorktree({
            id: worktreeId,
            repoId,
            branch,
            head: 'behind-head'
          })
        ]
      },
      prCache: {
        [`${repoId}::${branch}`]: {
          data: cachedPR,
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({ kind: 'no-pr', fetchedAt: 2 })

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, {
        force: true,
        repoId,
        worktreeId
      })
    ).resolves.toEqual(cachedPR)
    expect(store.getState().prCache[`${repoId}::${branch}`]).toEqual({
      data: cachedPR,
      fetchedAt: 1
    })
  })

  it.each([
    {
      name: 'worktree id is missing',
      worktreeId: undefined,
      linkedPRNumber: undefined,
      worktreesByRepo: {}
    },
    {
      name: 'worktree cannot be found',
      worktreeId: 'wt-missing',
      linkedPRNumber: undefined,
      worktreesByRepo: { 'repo-1': [] }
    },
    {
      name: 'worktree head is empty',
      worktreeId: 'wt-empty-head',
      linkedPRNumber: undefined,
      worktreesByRepo: {
        'repo-1': [
          makePRRefreshWorktree({
            id: 'wt-empty-head',
            branch: 'feature/merged-pr-stale-direct',
            head: ''
          })
        ]
      }
    },
    {
      name: 'cached PR head differs from worktree head',
      worktreeId: 'wt-moved-head',
      linkedPRNumber: undefined,
      worktreesByRepo: {
        'repo-1': [
          makePRRefreshWorktree({
            id: 'wt-moved-head',
            branch: 'feature/merged-pr-stale-direct',
            head: 'new-head'
          })
        ]
      }
    },
    {
      name: 'an explicit linked PR lookup misses',
      worktreeId: 'wt-linked-pr-miss',
      linkedPRNumber: 12,
      worktreesByRepo: {
        'repo-1': [
          makePRRefreshWorktree({
            id: 'wt-linked-pr-miss',
            branch: 'feature/merged-pr-stale-direct',
            head: 'merged-head',
            linkedPR: 12
          })
        ]
      }
    }
  ])('clears cached merged PR data on forced no-PR refresh when $name', async (testCase) => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/merged-pr-stale-direct'
    const cachedPR = makePR({
      number: 12,
      title: 'Stale merged PR',
      state: 'merged',
      headSha: 'merged-head'
    })

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: testCase.worktreesByRepo,
      prCache: {
        [`${repoId}::${branch}`]: {
          data: cachedPR,
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({ kind: 'no-pr', fetchedAt: 2 })

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, {
        force: true,
        repoId,
        worktreeId: testCase.worktreeId,
        linkedPRNumber: testCase.linkedPRNumber
      })
    ).resolves.toBeNull()
    expect(store.getState().prCache[`${repoId}::${branch}`]).toEqual({
      data: null,
      fetchedAt: 2
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

  it('clears a linked merged PR from a coordinator refresh event when the request head diverged', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/coordinator-diverged'
    const worktreeId = 'wt-coordinator-diverged'
    const cacheKey = `${repoId}::${branch}`
    const worktree = makePRRefreshWorktree({
      id: worktreeId,
      repoId,
      branch,
      head: 'current-head',
      linkedPR: 12
    })
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree
    })

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      reason: 'swr',
      aliases: [
        {
          cacheKey,
          repoPath,
          repoId,
          branch,
          worktreeId,
          linkedPRNumber: 12,
          currentHeadOid: 'current-head'
        }
      ],
      outcome: {
        kind: 'found',
        pr: makePR({
          number: 12,
          state: 'merged',
          headSha: 'merged-pr-head',
          headDivergedFromMergedPRAtOid: 'current-head'
        }),
        fetchedAt: 2
      }
    })

    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      worktreeId,
      { linkedPR: null },
      { shouldApply: expect.any(Function) }
    )
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBeNull()
  })

  it('does not clear a linked merged PR from a coordinator refresh event without a request head', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/coordinator-no-head'
    const worktreeId = 'wt-coordinator-no-head'
    const cacheKey = `${repoId}::${branch}`
    const updateWorktreeMeta = installLinkedPRClearStub(store, {
      repoId,
      repoPath,
      branch,
      worktree: makePRRefreshWorktree({
        id: worktreeId,
        repoId,
        branch,
        head: 'current-head',
        linkedPR: 12
      })
    })

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      reason: 'swr',
      aliases: [
        { cacheKey, repoPath, repoId, branch, worktreeId, linkedPRNumber: 12, currentHeadOid: null }
      ],
      outcome: {
        kind: 'found',
        pr: makePR({
          number: 12,
          state: 'merged',
          headSha: 'merged-pr-head',
          headDivergedFromMergedPRAtOid: 'current-head'
        }),
        fetchedAt: 2
      }
    })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo[repoId]?.[0]?.linkedPR).toBe(12)
  })

  it('clears only the diverged worktree when a PR-number-coalesced event fans out to sibling aliases', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const worktreeA = makePRRefreshWorktree({
      id: 'wt-a',
      repoId,
      branch: 'feature/a',
      head: 'head-a',
      linkedPR: 12
    })
    const worktreeB = makePRRefreshWorktree({
      id: 'wt-b',
      repoId,
      branch: 'feature/b',
      head: 'head-b',
      linkedPR: 12
    })
    const updateWorktreeMeta = vi.fn(
      async (
        worktreeId: string,
        updates: Parameters<AppState['updateWorktreeMeta']>[1],
        options?: Parameters<AppState['updateWorktreeMeta']>[2]
      ) => {
        const current = store
          .getState()
          .worktreesByRepo[repoId]?.find((worktree) => worktree.id === worktreeId)
        if (options?.shouldApply && !options.shouldApply(current)) {
          return
        }
        store.setState((state) => ({
          worktreesByRepo: {
            ...state.worktreesByRepo,
            [repoId]: (state.worktreesByRepo[repoId] ?? []).map((worktree) =>
              worktree.id === worktreeId ? { ...worktree, ...updates } : worktree
            )
          }
        }))
      }
    )
    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: { [repoId]: [worktreeA, worktreeB] },
      updateWorktreeMeta
    } as unknown as Partial<AppState>)

    // The coordinator coalesces linked PR refreshes by PR number, so one probe
    // (worktree A's head) is broadcast to both aliases. Only A actually diverged;
    // B is still on a contained commit and must keep its link.
    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      reason: 'swr',
      aliases: [
        {
          cacheKey: `${repoId}::feature/a`,
          repoPath,
          repoId,
          branch: 'feature/a',
          worktreeId: 'wt-a',
          linkedPRNumber: 12,
          currentHeadOid: 'head-a'
        },
        {
          cacheKey: `${repoId}::feature/b`,
          repoPath,
          repoId,
          branch: 'feature/b',
          worktreeId: 'wt-b',
          linkedPRNumber: 12,
          currentHeadOid: 'head-b'
        }
      ],
      outcome: {
        kind: 'found',
        pr: makePR({
          number: 12,
          state: 'merged',
          headSha: 'merged-pr-head',
          headDivergedFromMergedPRAtOid: 'head-a'
        }),
        fetchedAt: 2
      }
    })

    const worktrees = store.getState().worktreesByRepo[repoId] ?? []
    expect(worktrees.find((worktree) => worktree.id === 'wt-a')?.linkedPR).toBeNull()
    expect(worktrees.find((worktree) => worktree.id === 'wt-b')?.linkedPR).toBe(12)
  })

  it.each(['open', 'draft'] as const)(
    'clears visible cached %s PR data when a fallback refresh event misses',
    (state) => {
      const store = createTestStore()
      const repoPath = '/repo'
      const repoId = 'repo-1'
      const branch = 'feature/event-fallback-miss'
      const cacheKey = `${repoId}::${branch}`
      const cachedPR = makePR({ number: 12, state, title: 'Visible event PR' })
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
              state,
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

      expect(store.getState().prCache[cacheKey]).toEqual({ data: null, fetchedAt: 2 })
      expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toEqual({
        data: null,
        fetchedAt: 2,
        linkedReviewHintKey: 'github:12'
      })
    }
  )

  it('preserves cached merged PR data when a no-PR refresh event matches the worktree head', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/event-merged-pr-head-match'
    const cacheKey = `${repoId}::${branch}`
    const worktreeId = 'wt-merged-event-match'
    const cachedPR = makePR({
      number: 12,
      title: 'Merged event PR still checked out',
      state: 'merged',
      headSha: 'merged-head'
    })

    store.setState({
      worktreesByRepo: {
        [repoId]: [
          makePRRefreshWorktree({
            id: worktreeId,
            repoId,
            branch,
            head: 'merged-head'
          })
        ]
      },
      prCache: {
        [cacheKey]: {
          data: cachedPR,
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch, worktreeId }],
      reason: 'visible',
      outcome: { kind: 'no-pr', fetchedAt: 2 }
    })

    expect(store.getState().prCache[cacheKey]).toEqual({ data: cachedPR, fetchedAt: 1 })
    vi.advanceTimersByTime(1000)
    expect(mockApi.cache.setGitHub).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'worktree id is missing',
      worktreeId: undefined,
      linkedPRNumber: undefined,
      worktreesByRepo: {}
    },
    {
      name: 'worktree cannot be found',
      worktreeId: 'wt-missing-event',
      linkedPRNumber: undefined,
      worktreesByRepo: { 'repo-1': [] }
    },
    {
      name: 'worktree head is empty',
      worktreeId: 'wt-empty-event-head',
      linkedPRNumber: undefined,
      worktreesByRepo: {
        'repo-1': [
          makePRRefreshWorktree({
            id: 'wt-empty-event-head',
            branch: 'feature/event-merged-pr-stale',
            head: ''
          })
        ]
      }
    },
    {
      name: 'cached PR head differs from worktree head',
      worktreeId: 'wt-moved-event-head',
      linkedPRNumber: undefined,
      worktreesByRepo: {
        'repo-1': [
          makePRRefreshWorktree({
            id: 'wt-moved-event-head',
            branch: 'feature/event-merged-pr-stale',
            head: 'new-head'
          })
        ]
      }
    },
    {
      name: 'an explicit linked PR lookup misses',
      worktreeId: 'wt-linked-event-miss',
      linkedPRNumber: 12,
      worktreesByRepo: {
        'repo-1': [
          makePRRefreshWorktree({
            id: 'wt-linked-event-miss',
            branch: 'feature/event-merged-pr-stale',
            head: 'merged-head',
            linkedPR: 12
          })
        ]
      }
    }
  ])('clears cached merged PR data on no-PR refresh event when $name', (testCase) => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/event-merged-pr-stale'
    const cacheKey = `${repoId}::${branch}`
    const cachedPR = makePR({
      number: 12,
      title: 'Stale merged event PR',
      state: 'merged',
      headSha: 'merged-head'
    })

    store.setState({
      worktreesByRepo: testCase.worktreesByRepo,
      prCache: {
        [cacheKey]: {
          data: cachedPR,
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [
        {
          cacheKey,
          repoId,
          repoPath,
          branch,
          worktreeId: testCase.worktreeId,
          linkedPRNumber: testCase.linkedPRNumber
        }
      ],
      reason: 'visible',
      outcome: { kind: 'no-pr', fetchedAt: 2 }
    })

    expect(store.getState().prCache[cacheKey]).toEqual({ data: null, fetchedAt: 2 })
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

  it('ignores a queued exact linked PR refresh after the worktree was unlinked', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/unlinked-event-pr'
    const cacheKey = `${repoId}::${branch}`
    const worktreeId = 'wt-unlinked-event-pr'
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)

    store.setState({
      worktreesByRepo: {
        [repoId]: [
          {
            id: worktreeId,
            repoId,
            path: '/repo/worktrees/unlinked-event-pr',
            branch,
            displayName: 'unlinked-event-pr',
            isMainWorktree: false,
            isBare: false,
            isArchived: false,
            linkedPR: null
          }
        ]
      },
      hostedReviewCache: {},
      prCache: {}
    } as unknown as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch, worktreeId, linkedPRNumber: 12 }],
      reason: 'visible',
      requestStartedAt: Date.now() - 1_000,
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, title: 'Stale queued linked PR' }),
        fetchedAt: Date.now()
      }
    })

    expect(store.getState().prCache[cacheKey]).toBeUndefined()
    expect(store.getState().hostedReviewCache[hostedReviewCacheKey]).toBeUndefined()
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

  it('drops request-start hosted-review snapshots when refreshes pause before outcomes', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/rate-limit-pause'
    const cacheKey = `${repoId}::${branch}`
    const hostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)

    store.setState({
      hostedReviewCache: {
        [hostedReviewCacheKey]: {
          data: {
            provider: 'github',
            number: 12,
            title: 'Existing PR',
            state: 'open',
            url: 'https://github.com/acme/orca/pull/12',
            status: 'pending',
            updatedAt: '2026-03-28T00:00:00Z',
            mergeable: 'UNKNOWN'
          },
          fetchedAt: 100,
          linkedReviewHintKey: 'github:12'
        }
      }
    } as unknown as Partial<AppState>)

    for (let i = 0; i < 40; i += 1) {
      const inFlightSequence = i * 2 + 1
      store.getState().applyGitHubPRRefreshEvent({
        sequence: inFlightSequence,
        aliases: [{ cacheKey, repoId, repoPath, branch }],
        reason: 'visible',
        requestStartedAt: Date.now(),
        status: 'in-flight'
      })
      expect(_getGitHubPRRefreshStartedEntryCountForTest()).toBe(1)

      store.getState().applyGitHubPRRefreshEvent({
        sequence: inFlightSequence + 1,
        aliases: [{ cacheKey, repoId, repoPath, branch }],
        reason: 'visible',
        status: 'paused',
        pausedUntil: Date.now() + 60_000,
        skippedReason: 'rate-limit'
      })
      expect(_getGitHubPRRefreshStartedEntryCountForTest()).toBe(0)
    }
  })

  it('does not retain empty request-start entries for PR refreshes without a hosted-review cache entry', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/no-hosted-review'
    const cacheKey = `${repoId}::${branch}`

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      requestStartedAt: Date.now(),
      status: 'in-flight'
    })

    expect(_getGitHubPRRefreshStartedEntryCountForTest()).toBe(0)
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

  it('applies local GitHub PR refresh events without touching runtime-scoped cache', () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/runtime'
    const cacheKey = `${repoId}::${branch}`
    const settings = { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings']
    const runtimeHostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, settings, repoId)
    const localHostedReviewCacheKey = getHostedReviewCacheKey(repoPath, branch, null, repoId)
    const localChecksCacheKey = `${repoId}::${prChecksCacheSuffix(12, null, 'head-oid')}`
    const runtimeChecksCacheKey = `runtime:env-1::${repoId}::${prChecksCacheSuffix(
      12,
      null,
      'head-oid'
    )}`

    store.setState({
      settings,
      checksCache: {
        [localChecksCacheKey]: {
          data: [{ name: 'test', status: 'completed', conclusion: 'failure', url: null }],
          fetchedAt: 1,
          headSha: 'head-oid'
        },
        [runtimeChecksCacheKey]: {
          data: [{ name: 'test', status: 'completed', conclusion: 'success', url: null }],
          fetchedAt: 1,
          headSha: 'head-oid'
        }
      }
    } as Partial<AppState>)

    store.getState().applyGitHubPRRefreshEvent({
      sequence: 1,
      aliases: [{ cacheKey, repoId, repoPath, branch }],
      reason: 'visible',
      outcome: {
        kind: 'found',
        pr: makePR({ number: 12, title: 'Local PR status', checksStatus: 'pending' }),
        fetchedAt: 2
      }
    })

    expect(store.getState().prCache[cacheKey]?.data).toMatchObject({
      number: 12,
      title: 'Local PR status',
      checksStatus: 'failure'
    })
    expect(store.getState().prRefreshSequences[cacheKey]).toBe(1)
    expect(store.getState().hostedReviewCache[localHostedReviewCacheKey]?.data).toMatchObject({
      provider: 'github',
      number: 12
    })
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
      currentHeadOid: null,
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
      worktreeCardProperties: ['status', 'pr'],
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
        cachedPRState: 'open',
        cachedMergeable: 'UNKNOWN'
      }),
      reason: 'active',
      priority: 80
    })
  })

  it('does not direct-fetch when enqueue returns an automatic validation skip', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const worktreeId = 'wt-1'
    mockApi.gh.enqueuePRRefresh.mockResolvedValueOnce({
      kind: 'skipped',
      skippedReason: 'validation-denied'
    })

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
      }
    } as unknown as Partial<AppState>)

    store.getState().enqueueGitHubPRRefresh(worktreeId, 'active', 80)
    await Promise.resolve()

    expect(mockApi.gh.enqueuePRRefresh).toHaveBeenCalledTimes(1)
    expect(mockApi.gh.prForBranch).not.toHaveBeenCalled()
  })

  it('keeps a confirmed behind-head merged PR as the refresh fallback number', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-1'
    const branch = 'feature/merged-pr-behind-head'
    const worktreeId = 'wt-merged-behind-fallback'
    mockApi.gh.enqueuePRRefresh.mockResolvedValueOnce({ kind: 'queued' })

    store.setState({
      repos: [{ id: repoId, path: repoPath, name: 'repo', kind: 'git' }],
      worktreesByRepo: {
        [repoId]: [
          makePRRefreshWorktree({
            id: worktreeId,
            repoId,
            branch,
            head: 'behind-head'
          })
        ]
      },
      prCache: {
        [`${repoId}::${branch}`]: {
          data: makePR({
            number: 13,
            title: 'Merged PR with unpulled final head',
            state: 'merged',
            headSha: 'merged-final-head',
            confirmedContainedHeadOid: 'behind-head'
          }),
          fetchedAt: 1
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().enqueueGitHubPRRefresh(worktreeId, 'active', 80)
    await Promise.resolve()

    // Why 13: a merged PR confirmed to contain this worktree head is still the
    // branch's PR; losing the fallback number would blank the panel whenever
    // GitHub stops reporting the deleted head by branch name.
    expect(mockApi.gh.enqueuePRRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: expect.objectContaining({
          fallbackPRNumber: 13,
          // Why: main can only head-gate fallback preservation when the
          // candidate carries the worktree head it was built for.
          currentHeadOid: 'behind-head'
        })
      })
    )
  })

  it('direct-fetches when enqueue returns an explicit fallback result', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const worktreeId = 'wt-1'
    mockApi.gh.enqueuePRRefresh.mockResolvedValueOnce({ kind: 'fallback' })
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({ kind: 'no-pr', fetchedAt: 1 })

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
      }
    } as unknown as Partial<AppState>)

    store.getState().enqueueGitHubPRRefresh(worktreeId, 'active', 80)
    await Promise.resolve()
    await Promise.resolve()

    expect(mockApi.gh.enqueuePRRefresh).toHaveBeenCalledTimes(1)
    expect(mockApi.gh.refreshPRNow).toHaveBeenCalledTimes(1)
  })

  it('bounds rejected active PR refresh IPCs during worktree activation', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const worktreeId = 'wt-1'
    const error = new Error('Access denied: unknown repository path')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockApi.gh.enqueuePRRefresh.mockRejectedValueOnce(error)

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
      worktreeCardProperties: ['status', 'pr']
    } as unknown as Partial<AppState>)

    try {
      store.getState().refreshGitHubForWorktreeIfStale(worktreeId)

      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith('Failed to enqueue PR refresh:', error)
      )
    } finally {
      warn.mockRestore()
    }
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
      worktreeCardProperties: ['status', 'pr'],
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

  it('does not fetch linked issue details when the issue card section is hidden', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const worktreeId = 'wt-1'

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      groupBy: 'repo',
      worktreeCardProperties: ['comment'],
      rightSidebarOpen: false,
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
            isArchived: false,
            linkedIssue: 123
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktreeIfStale(worktreeId)
    await Promise.resolve()

    expect(mockApi.gh.issue).not.toHaveBeenCalled()
  })

  it('fetches linked issue details when the issue card section is visible', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const worktreeId = 'wt-1'

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      groupBy: 'repo',
      worktreeCardProperties: ['issue'],
      rightSidebarOpen: false,
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
            isArchived: false,
            linkedIssue: 123
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshGitHubForWorktreeIfStale(worktreeId)
    await Promise.resolve()

    expect(mockApi.gh.issue).toHaveBeenCalledWith({
      repoPath,
      repoId: 'repo-1',
      number: 123
    })
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
      activeWorktreeId: worktreeId,
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
      'repo-1',
      null,
      'runtime:env-1',
      true
    )

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'],
      repos: [
        {
          id: 'repo-1',
          path: repoPath,
          name: 'repo',
          kind: 'git',
          executionHostId: 'runtime:env-1'
        }
      ],
      groupBy: 'pr-status',
      worktreeCardProperties: ['status'],
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
      params: { repo: 'repo-1', branch, linkedPRNumber: 12, currentHeadOid: null },
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

  it('fetches PR through the owning runtime when local host is focused', async () => {
    resetRemoteRuntimeMocks()
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: makePR({ number: 23, title: 'Owner runtime PR' }),
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoPath = '/runtime/repo'
    const branch = 'feature/owner-runtime'

    store.setState({
      settings: null,
      repos: [
        {
          id: 'repo-runtime',
          path: repoPath,
          name: 'repo',
          kind: 'git',
          connectionId: null,
          executionHostId: 'runtime:env-1'
        }
      ]
    } as unknown as Partial<AppState>)

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, { repoId: 'repo-runtime' })
    ).resolves.toMatchObject({ number: 23 })

    expect(mockApi.gh.refreshPRNow).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.prForBranch',
      params: { repo: 'repo-runtime', branch, linkedPRNumber: null, currentHeadOid: null },
      timeoutMs: 30_000
    })
    expect(store.getState().prCache[`runtime:env-1::repo-runtime::${branch}`]?.data).toMatchObject({
      number: 23,
      title: 'Owner runtime PR'
    })
  })

  it('fetches SSH-owned PRs through local IPC when a runtime host is focused', async () => {
    mockApi.gh.refreshPRNow.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({ number: 34, title: 'SSH PR' }),
      fetchedAt: 10
    })
    const store = createTestStore()
    const repoPath = '/ssh/repo'
    const branch = 'feature/ssh-owner'

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-focused' } as AppState['settings'],
      repos: [
        {
          id: 'repo-ssh',
          path: repoPath,
          name: 'repo',
          kind: 'git',
          connectionId: 'ssh-1',
          executionHostId: 'ssh:ssh-1'
        }
      ]
    } as unknown as Partial<AppState>)

    await expect(
      store.getState().fetchPRForBranch(repoPath, branch, { repoId: 'repo-ssh' })
    ).resolves.toMatchObject({ number: 34 })

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.refreshPRNow).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        cacheKey: `ssh:ssh-1::repo-ssh::${branch}`,
        connectionId: 'ssh-1',
        executionHostId: 'ssh:ssh-1'
      })
    })
    expect(store.getState().prCache[`ssh:ssh-1::repo-ssh::${branch}`]?.data).toMatchObject({
      number: 34,
      title: 'SSH PR'
    })
    expect(store.getState().prCache[`runtime:env-focused::repo-ssh::${branch}`]).toBeUndefined()
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
      activeWorktreeId: 'wt-1',
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

  it('bounds rejected stale PR refresh IPCs', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const error = new Error('Access denied: unknown repository path')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockApi.gh.enqueuePRRefresh.mockRejectedValueOnce(error)

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      groupBy: 'repo',
      worktreeCardProperties: ['comment'],
      activeWorktreeId: 'wt-1',
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

    try {
      store.getState().refreshAllGitHub()

      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith('Failed to enqueue PR refresh:', error)
      )
    } finally {
      warn.mockRestore()
    }
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
      repos: [
        {
          id: 'repo-1',
          path: repoPath,
          name: 'repo',
          kind: 'git',
          executionHostId: 'runtime:env-1'
        }
      ],
      groupBy: 'repo',
      worktreeCardProperties: ['comment'],
      activeWorktreeId: 'wt-1',
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
      params: { repo: 'repo-1', branch, linkedPRNumber: null, currentHeadOid: null },
      timeoutMs: 30_000
    })
  })

  it('does not refresh stale linked issues when the issue card section is hidden', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      groupBy: 'repo',
      worktreeCardProperties: ['comment'],
      rightSidebarOpen: false,
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
            lastActivityAt: 1,
            linkedIssue: 123
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshAllGitHub()
    await Promise.resolve()

    expect(mockApi.gh.issue).not.toHaveBeenCalled()
  })

  it('refreshes stale linked issues when the issue card section is visible', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'

    store.setState({
      repos: [{ id: 'repo-1', path: repoPath, name: 'repo', kind: 'git' }],
      groupBy: 'repo',
      worktreeCardProperties: ['issue'],
      rightSidebarOpen: false,
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
            lastActivityAt: 1,
            linkedIssue: 123
          }
        ]
      }
    } as unknown as Partial<AppState>)

    store.getState().refreshAllGitHub()
    await Promise.resolve()

    expect(mockApi.gh.issue).toHaveBeenCalledWith({
      repoPath,
      repoId: 'repo-1',
      number: 123
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
      repos: [
        {
          id: 'repo-1',
          path: repoPath,
          name: 'repo',
          kind: 'git',
          executionHostId: 'runtime:env-1'
        }
      ],
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
      params: { repo: 'repo-1', branch, linkedPRNumber: null, currentHeadOid: null },
      timeoutMs: 30_000
    })
  })

  it('bounds rejected post-push PR refresh IPCs', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const worktreeId = 'wt-1'
    const error = new Error('Access denied: unknown repository path')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockApi.gh.enqueuePRRefresh.mockRejectedValueOnce(error)

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
      }
    } as unknown as Partial<AppState>)

    try {
      store.getState().refreshGitHubForWorktree(worktreeId)

      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith('Failed to enqueue PR refresh:', error)
      )
    } finally {
      warn.mockRestore()
    }
  })
})

describe('createGitHubSlice.fetchWorkItems source/error envelope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: {
        items: [],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      },
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
      sources: {
        issues: { owner: 'up', repo: 'r' },
        prs: { owner: 'fork', repo: 'r' },
        originCandidate: { owner: 'fork', repo: 'r' },
        upstreamCandidate: { owner: 'up', repo: 'r' }
      }
    })

    await store.getState().fetchWorkItems('repo-id', '/repo', 24, '')

    const result = store.getState().getWorkItemsSourcesAndError('repo-id', 24, '')
    expect(result.sources).toEqual({
      issues: { owner: 'up', repo: 'r' },
      prs: { owner: 'fork', repo: 'r' },
      originCandidate: { owner: 'fork', repo: 'r' },
      upstreamCandidate: { owner: 'up', repo: 'r' }
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
      sources: {
        issues: { owner: 'up', repo: 'r' },
        prs: { owner: 'fork', repo: 'r' },
        originCandidate: { owner: 'fork', repo: 'r' },
        upstreamCandidate: { owner: 'up', repo: 'r' }
      },
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
      sources: {
        issues: { owner: 'up', repo: 'r' },
        prs: { owner: 'fork', repo: 'r' },
        originCandidate: { owner: 'fork', repo: 'r' },
        upstreamCandidate: { owner: 'up', repo: 'r' }
      }
    })

    const initialFetch = store.getState().fetchWorkItems('repo-id', '/repo', 24, '')
    const forcedFetch = store.getState().fetchWorkItems('repo-id', '/repo', 24, '', { force: true })

    // Let the initial request settle with an error so the force path runs.
    resolveFailing({
      items: [],
      sources: {
        issues: { owner: 'up', repo: 'r' },
        prs: { owner: 'fork', repo: 'r' },
        originCandidate: { owner: 'fork', repo: 'r' },
        upstreamCandidate: { owner: 'up', repo: 'r' }
      },
      errors: { issues: { type: 'permission_denied', message: 'no access' } }
    })
    await initialFetch.catch(() => {})
    await forcedFetch

    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(2)
    const after = store.getState().getWorkItemsSourcesAndError('repo-id', 24, '')
    expect(after.error).toBeNull()
  })

  it('threads noCache only when explicitly requested for work-item fetches', async () => {
    const store = createTestStore()
    mockApi.gh.listWorkItems
      .mockResolvedValueOnce({
        items: [],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      })
      .mockResolvedValueOnce({
        items: [],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      })
      .mockResolvedValueOnce({
        items: [],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      })

    await store.getState().fetchWorkItems('repo-normal', '/repo/normal', 24, '')
    await store.getState().fetchWorkItems('repo-force', '/repo/force', 24, '', { force: true })
    await store.getState().fetchWorkItems('repo-fresh', '/repo/fresh', 24, '', {
      force: true,
      noCache: true
    })

    expect(mockApi.gh.listWorkItems).toHaveBeenNthCalledWith(1, {
      repoPath: '/repo/normal',
      repoId: 'repo-normal',
      limit: 24,
      query: undefined
    })
    expect(mockApi.gh.listWorkItems).toHaveBeenNthCalledWith(2, {
      repoPath: '/repo/force',
      repoId: 'repo-force',
      limit: 24,
      query: undefined
    })
    expect(mockApi.gh.listWorkItems).toHaveBeenNthCalledWith(3, {
      repoPath: '/repo/fresh',
      repoId: 'repo-fresh',
      limit: 24,
      query: undefined,
      noCache: true
    })
  })

  it('does not dedupe a no-cache forced fetch onto a cacheable forced request', async () => {
    const store = createTestStore()
    type WorkItemsEnvelope = {
      items: []
      sources: { issues: null; prs: null; originCandidate: null; upstreamCandidate: null }
    }
    let resolveCacheable: (value: WorkItemsEnvelope) => void = () => {}
    const cacheableRequest = new Promise<WorkItemsEnvelope>((resolve) => {
      resolveCacheable = resolve
    })
    mockApi.gh.listWorkItems.mockReturnValueOnce(cacheableRequest).mockResolvedValueOnce({
      items: [],
      sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
    })

    const landingProbe = store
      .getState()
      .fetchWorkItems('repo-id', '/repo', 24, '', { force: true })
    await Promise.resolve()
    const noCacheRefresh = store
      .getState()
      .fetchWorkItems('repo-id', '/repo', 24, '', { force: true, noCache: true })

    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(1)
    resolveCacheable({
      items: [],
      sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
    })
    await landingProbe
    await noCacheRefresh

    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(2)
    expect(mockApi.gh.listWorkItems).toHaveBeenNthCalledWith(2, {
      repoPath: '/repo',
      repoId: 'repo-id',
      limit: 24,
      query: undefined,
      noCache: true
    })
  })

  it('routes work item fetches through the active runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-work-items',
      ok: true,
      result: {
        items: [{ type: 'issue', number: 7, title: 'Server issue', url: 'https://example.test/7' }],
        sources: {
          issues: { owner: 'up', repo: 'r' },
          prs: { owner: 'up', repo: 'r' },
          originCandidate: { owner: 'up', repo: 'r' },
          upstreamCandidate: null
        }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      repos: [
        {
          id: 'runtime-repo-id',
          path: '/server/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1
        }
      ]
    } as Partial<AppState>)

    await store.getState().fetchWorkItems('caller-repo-id', '/server/repo', 24, 'is:open', {
      force: true,
      noCache: true
    })

    expect(mockApi.gh.listWorkItems).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.listWorkItems',
      params: {
        repo: 'runtime-repo-id',
        limit: 24,
        query: 'is:open',
        noCache: true
      },
      timeoutMs: 30_000
    })
    expect(
      store.getState().workItemsCache[
        workItemsCacheKey('caller-repo-id', 24, 'is:open', 'runtime:env-1')
      ].data?.[0]
    ).toMatchObject({
      repoId: 'caller-repo-id',
      number: 7
    })
  })

  it('routes work item fetches through the owning runtime when local is focused', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-work-items-owner',
      ok: true,
      result: {
        items: [
          { type: 'issue', number: 17, title: 'Owner issue', url: 'https://example.test/17' }
        ],
        sources: { issues: { owner: 'up', repo: 'r' }, prs: { owner: 'up', repo: 'r' } }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    store.setState({
      settings: null,
      repos: [
        {
          id: 'runtime-repo-id',
          path: '/server/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          executionHostId: 'runtime:env-1'
        }
      ]
    } as Partial<AppState>)

    await store.getState().fetchWorkItems('caller-repo-id', '/server/repo', 24, 'is:open')

    expect(mockApi.gh.listWorkItems).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.listWorkItems',
      params: {
        repo: 'runtime-repo-id',
        limit: 24,
        query: 'is:open'
      },
      timeoutMs: 30_000
    })
    expect(
      store.getState().workItemsCache[
        workItemsCacheKey('caller-repo-id', 24, 'is:open', 'runtime:env-1')
      ]?.data?.[0]
    ).toMatchObject({ repoId: 'caller-repo-id', number: 17 })
  })

  it('routes work item fetches through an explicit GitHub source context', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-work-items-source-context',
      ok: true,
      result: {
        items: [
          { type: 'issue', number: 19, title: 'Source issue', url: 'https://example.test/19' }
        ],
        sources: { issues: { owner: 'up', repo: 'r' }, prs: { owner: 'up', repo: 'r' } }
      },
      _meta: { runtimeId: 'source-runtime' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
      repos: [
        {
          id: 'local-repo-id',
          path: '/server/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1
        }
      ]
    } as Partial<AppState>)

    const sourceContext = {
      kind: 'task-source' as const,
      provider: 'github' as const,
      projectId: 'github:stablyai/orca',
      hostId: 'runtime:source-runtime' as const,
      projectHostSetupId: 'setup-1',
      repoId: 'source-runtime-repo-id',
      providerIdentity: { provider: 'github' as const, owner: 'stablyai', repo: 'orca' }
    }

    await store.getState().fetchWorkItems('caller-repo-id', '/server/repo', 24, 'is:open', {
      sourceContext
    })

    expect(mockApi.gh.listWorkItems).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'source-runtime',
      method: 'github.listWorkItems',
      params: {
        repo: 'source-runtime-repo-id',
        limit: 24,
        query: 'is:open'
      },
      timeoutMs: 30_000
    })
    expect(
      store.getState().workItemsCache[
        workItemsCacheKey('caller-repo-id', 24, 'is:open', getTaskSourceCacheScope(sourceContext))
      ]?.data?.[0]
    ).toMatchObject({ repoId: 'caller-repo-id', number: 19 })
    expect(
      store.getState().workItemsCache[
        workItemsCacheKey('caller-repo-id', 24, 'is:open', 'runtime:focused-runtime')
      ]
    ).toBeUndefined()
  })

  it('keeps explicit GitHub source identities in separate work-item cache buckets', async () => {
    const store = createTestStore()
    const firstSourceContext = {
      kind: 'task-source' as const,
      provider: 'github' as const,
      projectId: 'project-1',
      hostId: 'local' as const,
      projectHostSetupId: 'setup-1',
      repoId: 'repo-1',
      providerIdentity: { provider: 'github' as const, owner: 'acme', repo: 'orca' }
    }
    const secondSourceContext = {
      ...firstSourceContext,
      providerIdentity: { provider: 'github' as const, owner: 'stablyai', repo: 'orca' }
    }
    mockApi.gh.listWorkItems
      .mockResolvedValueOnce({
        items: [{ type: 'issue', number: 1, title: 'Acme', url: 'https://example.test/1' }],
        sources: { issues: { owner: 'acme', repo: 'orca' }, prs: { owner: 'acme', repo: 'orca' } }
      })
      .mockResolvedValueOnce({
        items: [{ type: 'issue', number: 2, title: 'Stably', url: 'https://example.test/2' }],
        sources: {
          issues: { owner: 'stablyai', repo: 'orca' },
          prs: { owner: 'stablyai', repo: 'orca' }
        }
      })

    await store.getState().fetchWorkItems('repo-1', '/repo', 24, '', {
      sourceContext: firstSourceContext
    })
    await store.getState().fetchWorkItems('repo-1', '/repo', 24, '', {
      sourceContext: secondSourceContext
    })

    expect(
      store.getState().workItemsCache[
        workItemsCacheKey('repo-1', 24, '', getTaskSourceCacheScope(firstSourceContext))
      ]?.data?.[0]?.number
    ).toBe(1)
    expect(
      store.getState().workItemsCache[
        workItemsCacheKey('repo-1', 24, '', getTaskSourceCacheScope(secondSourceContext))
      ]?.data?.[0]?.number
    ).toBe(2)
  })

  it('routes SSH-owned work item fetches through local IPC when a runtime is focused', async () => {
    const store = createTestStore()
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      items: [{ type: 'issue', number: 27, title: 'SSH issue', url: 'https://example.test/27' }],
      sources: { issues: { owner: 'up', repo: 'r' }, prs: { owner: 'up', repo: 'r' } }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-focused' } as AppState['settings'],
      repos: [
        {
          id: 'ssh-repo-id',
          path: '/ssh/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1',
          executionHostId: 'ssh:ssh-1'
        }
      ]
    } as Partial<AppState>)

    await store.getState().fetchWorkItems('ssh-repo-id', '/ssh/repo', 24, '')

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledWith({
      repoPath: '/ssh/repo',
      repoId: 'ssh-repo-id',
      limit: 24,
      query: undefined
    })
    expect(
      store.getState().workItemsCache[workItemsCacheKey('ssh-repo-id', 24, '', 'ssh:ssh-1')]
        ?.data?.[0]
    ).toMatchObject({ repoId: 'ssh-repo-id', number: 27 })
    expect(
      store.getState().workItemsCache[
        workItemsCacheKey('ssh-repo-id', 24, '', 'runtime:env-focused')
      ]
    ).toBeUndefined()
  })

  it('falls back to local work-item IPC when no runtime environment is active', async () => {
    const store = createTestStore()
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      items: [{ type: 'issue', number: 7, title: 'Local issue', url: 'https://example.test/7' }],
      sources: {
        issues: { owner: 'up', repo: 'r' },
        prs: { owner: 'up', repo: 'r' },
        originCandidate: { owner: 'up', repo: 'r' },
        upstreamCandidate: null
      }
    })

    await store.getState().fetchWorkItems('repo-id', '/local/repo', 24, '')

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledWith({
      repoPath: '/local/repo',
      repoId: 'repo-id',
      limit: 24,
      query: undefined
    })
  })

  it('falls back to local work-item IPC when the active runtime has no matching repo path', async () => {
    const store = createTestStore()
    const error = new Error('Access denied: unknown repository path')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      repos: [{ id: 'runtime-repo-id', path: '/server/known-repo', name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)
    mockApi.gh.listWorkItems.mockRejectedValueOnce(error)

    try {
      await expect(
        store.getState().fetchWorkItems('repo-id', '/server/missing-repo', 24, '')
      ).rejects.toThrow(error)
    } finally {
      consoleError.mockRestore()
    }

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledWith({
      repoPath: '/server/missing-repo',
      repoId: 'repo-id',
      limit: 24,
      query: undefined
    })
  })

  it('uses the request-start runtime repo snapshot and skips cache writes after a runtime switch', async () => {
    const store = createTestStore()
    type WorkItemsEnvelope = {
      items: GitHubWorkItem[]
      sources: { issues: null; prs: null; originCandidate: null; upstreamCandidate: null }
    }
    const blockingResolvers: ((value: WorkItemsEnvelope) => void)[] = []
    for (let i = 0; i < 8; i++) {
      mockApi.gh.listWorkItems.mockImplementationOnce(
        () =>
          new Promise<WorkItemsEnvelope>((resolve) => {
            blockingResolvers.push(resolve)
          })
      )
    }

    const blockers = Array.from({ length: 8 }, (_, i) =>
      store.getState().fetchWorkItems(`blocker-${i}`, `/local/blocker-${i}`, 24, '')
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(blockingResolvers).toHaveLength(8)

    const item = {
      type: 'issue',
      number: 42,
      title: 'Started before switch',
      url: 'https://example.test/42',
      updatedAt: '2026-05-22T00:00:00Z'
    } as GitHubWorkItem
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-work-items-started-before-switch',
      ok: true,
      result: {
        items: [item],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-start' },
      repos: [{ id: 'repo-start', path: '/server/repo', name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)
    const queued = store
      .getState()
      .fetchWorkItems('caller-repo-id', '/server/repo', 24, 'is:open', { force: true })

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-switched' },
      repos: [{ id: 'repo-switched', path: '/server/repo', name: 'repo', kind: 'git' }],
      workItemsCache: {}
    } as unknown as Partial<AppState>)
    for (const resolve of blockingResolvers) {
      resolve({
        items: [],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      })
    }

    const result = await queued
    await Promise.all(blockers)

    expect(result).toEqual([{ ...item, repoId: 'caller-repo-id' }])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-start',
      method: 'github.listWorkItems',
      params: {
        repo: 'repo-start',
        limit: 24,
        query: 'is:open'
      },
      timeoutMs: 30_000
    })
    expect(
      store.getState().workItemsCache[workItemsCacheKey('caller-repo-id', 24, 'is:open')]
    ).toBeUndefined()
  })

  it('does not reuse an old-runtime in-flight work-item fetch after a runtime switch', async () => {
    const store = createTestStore()
    type WorkItemsEnvelope = {
      items: GitHubWorkItem[]
      sources: { issues: null; prs: null; originCandidate: null; upstreamCandidate: null }
    }
    type WorkItemsRpcResponse = {
      id: string
      ok: true
      result: WorkItemsEnvelope
      _meta: { runtimeId: string }
    }
    let resolveOldRuntime: (value: WorkItemsRpcResponse) => void = () => {}
    let resolveNewRuntime: (value: WorkItemsRpcResponse) => void = () => {}
    runtimeEnvironmentCall
      .mockImplementationOnce(
        () =>
          new Promise<WorkItemsRpcResponse>((resolve) => {
            resolveOldRuntime = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<WorkItemsRpcResponse>((resolve) => {
            resolveNewRuntime = resolve
          })
      )

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-old' },
      repos: [{ id: 'repo-old-runtime', path: '/server/repo', name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)
    const oldFetch = store
      .getState()
      .fetchWorkItems('caller-repo-id', '/server/repo', 24, 'is:open')
    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))

    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-new' },
      repos: [{ id: 'repo-new-runtime', path: '/server/repo', name: 'repo', kind: 'git' }],
      workItemsCache: {}
    } as unknown as Partial<AppState>)
    const newFetch = store
      .getState()
      .fetchWorkItems('caller-repo-id', '/server/repo', 24, 'is:open')
    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2))

    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2)
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-old',
      method: 'github.listWorkItems',
      params: {
        repo: 'repo-old-runtime',
        limit: 24,
        query: 'is:open'
      },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-new',
      method: 'github.listWorkItems',
      params: {
        repo: 'repo-new-runtime',
        limit: 24,
        query: 'is:open'
      },
      timeoutMs: 30_000
    })

    const newRuntimeItem = {
      type: 'issue',
      number: 2,
      title: 'New runtime item',
      url: 'https://example.test/new',
      updatedAt: '2026-05-22T00:00:00Z'
    } as GitHubWorkItem
    resolveNewRuntime({
      id: 'rpc-new-work-items',
      ok: true,
      result: {
        items: [newRuntimeItem],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      },
      _meta: { runtimeId: 'new-runtime' }
    })
    await expect(newFetch).resolves.toEqual([{ ...newRuntimeItem, repoId: 'caller-repo-id' }])

    const oldRuntimeItem = {
      type: 'issue',
      number: 1,
      title: 'Old runtime item',
      url: 'https://example.test/old',
      updatedAt: '2026-05-21T00:00:00Z'
    } as GitHubWorkItem
    resolveOldRuntime({
      id: 'rpc-old-work-items',
      ok: true,
      result: {
        items: [oldRuntimeItem],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      },
      _meta: { runtimeId: 'old-runtime' }
    })
    await expect(oldFetch).resolves.toEqual([{ ...oldRuntimeItem, repoId: 'caller-repo-id' }])
    expect(
      store.getState().workItemsCache[
        workItemsCacheKey('caller-repo-id', 24, 'is:open', 'runtime:env-new')
      ]?.data
    ).toEqual([{ ...newRuntimeItem, repoId: 'caller-repo-id' }])
  })

  it('bounds work-item cache entries across many repos', async () => {
    vi.useFakeTimers()

    try {
      const store = createTestStore()
      mockApi.gh.listWorkItems.mockResolvedValue({
        items: [],
        sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
      })

      for (let i = 0; i <= 500; i++) {
        vi.setSystemTime(1_000 + i)
        await store.getState().fetchWorkItems(`repo-${i}`, `/repo/${i}`, 24, '')
      }

      const cache = store.getState().workItemsCache
      expect(Object.keys(cache)).toHaveLength(500)
      expect(cache[workItemsCacheKey('repo-0', 24, '')]).toBeUndefined()
      expect(cache[workItemsCacheKey('repo-500', 24, '')]).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
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
        sources: {
          issues: { owner: 'up', repo: 'r' },
          prs: { owner: 'up', repo: 'r' },
          originCandidate: { owner: 'up', repo: 'r' },
          upstreamCandidate: null
        }
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
        sources: {
          issues: { owner: 'up', repo: 'r' },
          prs: { owner: 'up', repo: 'r' },
          originCandidate: { owner: 'up', repo: 'r' },
          upstreamCandidate: null
        }
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

  it('routes work-item next-page fetches through the active runtime environment', async () => {
    const item = {
      type: 'pr',
      number: 9,
      title: 'Server PR',
      url: 'https://example.test/9',
      updatedAt: '2026-05-22T00:00:00Z'
    } as GitHubWorkItem
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-work-items-page',
      ok: true,
      result: {
        items: [item],
        sources: {
          issues: null,
          prs: { owner: 'up', repo: 'r' },
          originCandidate: { owner: 'up', repo: 'r' },
          upstreamCandidate: null
        }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      repos: [{ id: 'runtime-repo-id', path: '/server/repo', name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    const result = await store
      .getState()
      .fetchWorkItemsNextPage(
        [{ repoId: 'caller-repo-id', path: '/server/repo' }],
        24,
        100,
        'is:open',
        '2026-05-22T00:00:00Z'
      )

    expect(mockApi.gh.listWorkItems).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.listWorkItems',
      params: {
        repo: 'runtime-repo-id',
        limit: 24,
        query: 'is:open',
        before: '2026-05-22T00:00:00Z'
      },
      timeoutMs: 30_000
    })
    expect(result).toEqual({
      items: [{ ...item, repoId: 'caller-repo-id' }],
      failedCount: 0
    })
  })

  it('routes work-item counts through the active runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-work-items-count',
      ok: true,
      result: 12,
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      repos: [{ id: 'runtime-repo-id', path: '/server/repo', name: 'repo', kind: 'git' }]
    } as unknown as Partial<AppState>)

    const result = await store
      .getState()
      .countWorkItemsAcrossRepos([{ repoId: 'caller-repo-id', path: '/server/repo' }], 'is:open')

    expect(result).toBe(12)
    expect(mockApi.gh.countWorkItems).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.countWorkItems',
      params: {
        repo: 'runtime-repo-id',
        query: 'is:open'
      },
      timeoutMs: 30_000
    })
  })

  it('falls back to local IPC for work-item counts without an active runtime environment', async () => {
    const store = createTestStore()
    mockApi.gh.countWorkItems.mockResolvedValueOnce(7)

    const result = await store
      .getState()
      .countWorkItemsAcrossRepos([{ repoId: 'repo-id', path: '/local/repo' }], '')

    expect(result).toBe(7)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.countWorkItems).toHaveBeenCalledWith({
      repoPath: '/local/repo',
      repoId: 'repo-id',
      query: undefined
    })
  })

  it('rejects oversized work-item queries before cache keys or provider calls', async () => {
    const store = createTestStore()
    const secret = 'github-work-items-secret'
    const oversizedQuery = secret + 'x'.repeat(GITHUB_WORK_ITEMS_QUERY_MAX_BYTES)

    await expect(
      store.getState().fetchWorkItems('repo-id', '/local/repo', 24, oversizedQuery)
    ).resolves.toEqual([])
    await expect(
      store
        .getState()
        .fetchWorkItemsAcrossRepos(
          [{ repoId: 'repo-id', path: '/local/repo' }],
          24,
          24,
          oversizedQuery
        )
    ).resolves.toEqual({ items: [], failedCount: 0 })
    await expect(
      store
        .getState()
        .fetchWorkItemsNextPage(
          [{ repoId: 'repo-id', path: '/local/repo' }],
          24,
          24,
          oversizedQuery,
          'cursor'
        )
    ).resolves.toEqual({ items: [], failedCount: 0 })
    await expect(
      store
        .getState()
        .countWorkItemsAcrossRepos([{ repoId: 'repo-id', path: '/local/repo' }], oversizedQuery)
    ).resolves.toBe(0)
    store.getState().prefetchWorkItems('repo-id', '/local/repo', 24, oversizedQuery)

    expect(store.getState().getCachedWorkItems('repo-id', 24, oversizedQuery, '/local/repo')).toBe(
      null
    )
    expect(
      store.getState().getWorkItemsSourcesAndError('repo-id', 24, oversizedQuery, '/local/repo')
    ).toEqual({ sources: null, error: null })
    expect(mockApi.gh.listWorkItems).not.toHaveBeenCalled()
    expect(mockApi.gh.countWorkItems).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(JSON.stringify(store.getState().workItemsCache)).not.toContain(secret)
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

  it('keeps GitHub project view caches separate for runtime and local sources', async () => {
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
            id: 'project-remote',
            owner: 'acme',
            ownerType: 'organization',
            number: 1,
            title: 'Remote Roadmap',
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

    await store.getState().fetchProjectViewTable({
      owner: 'acme',
      ownerType: 'organization',
      projectNumber: 1,
      viewId: 'view-1'
    })

    store.setState({
      settings: { activeRuntimeEnvironmentId: null }
    } as Partial<AppState>)
    mockApi.gh.getProjectViewTable.mockResolvedValueOnce({
      ok: true,
      data: {
        project: {
          id: 'project-local',
          owner: 'acme',
          ownerType: 'organization',
          number: 1,
          title: 'Local Roadmap',
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
    })

    const localResult = await store.getState().fetchProjectViewTable({
      owner: 'acme',
      ownerType: 'organization',
      projectNumber: 1,
      viewId: 'view-1'
    })

    expect(localResult.ok).toBe(true)
    expect(mockApi.gh.getProjectViewTable).toHaveBeenCalledTimes(1)
    expect(
      store.getState().projectViewCache[
        projectViewCacheKey('organization', 'acme', 1, 'view-1', undefined, 'runtime:env-1')
      ]?.data?.project.id
    ).toBe('project-remote')
    expect(
      store.getState().projectViewCache[projectViewCacheKey('organization', 'acme', 1, 'view-1')]
        ?.data?.project.id
    ).toBe('project-local')
  })

  it('routes project field mutations through the source encoded in the cache key', async () => {
    const store = createTestStore()
    const cacheKey = projectViewCacheKey(
      'organization',
      'acme',
      1,
      'view-1',
      undefined,
      'runtime:env-project'
    )
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-focused' },
      projectViewCache: {
        [cacheKey]: {
          fetchedAt: 1,
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
              fields: [{ id: 'field-1', name: 'Notes', dataType: 'TEXT', kind: 'text' }],
              groupByFields: [],
              sortByFields: []
            },
            rows: [
              {
                id: 'row-1',
                itemType: 'ISSUE',
                content: {
                  repository: 'acme/repo',
                  number: 12,
                  title: 'Issue',
                  body: '',
                  url: 'https://github.com/acme/repo/issues/12',
                  state: 'OPEN',
                  labels: [],
                  assignees: [],
                  issueType: null,
                  parentIssue: null
                },
                fieldValuesByFieldId: {}
              }
            ],
            totalCount: 1,
            parentFieldDropped: false
          }
        }
      }
    } as unknown as Partial<AppState>)
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-field',
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'remote-runtime' }
    })

    const result = await store
      .getState()
      .updateProjectFieldValue(cacheKey, 'row-1', 'field-1', { kind: 'text', text: 'next' })

    expect(result).toEqual({ ok: true })
    expect(mockApi.gh.updateProjectItemField).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-project',
      method: 'github.project.updateItemField',
      params: {
        projectId: 'project-1',
        itemId: 'row-1',
        fieldId: 'field-1',
        value: { kind: 'text', text: 'next' }
      },
      timeoutMs: 30_000
    })
  })

  it('routes slug-only project row mutations through the source encoded in the cache key', async () => {
    const store = createTestStore()
    const cacheKey = projectViewCacheKey(
      'organization',
      'acme',
      1,
      'view-1',
      undefined,
      'runtime:env-project'
    )
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-focused' },
      repos: [],
      projectViewCache: {
        [cacheKey]: {
          fetchedAt: 1,
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
            rows: [
              {
                id: 'row-1',
                itemType: 'ISSUE',
                content: {
                  repository: 'acme/repo',
                  number: 12,
                  title: 'Issue',
                  body: '',
                  url: 'https://github.com/acme/repo/issues/12',
                  state: 'OPEN',
                  labels: [],
                  assignees: [],
                  issueType: null,
                  parentIssue: null
                },
                fieldValuesByFieldId: {}
              }
            ],
            totalCount: 1,
            parentFieldDropped: false
          }
        }
      }
    } as unknown as Partial<AppState>)
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-issue',
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'remote-runtime' }
    })

    const result = await store
      .getState()
      .patchProjectIssueOrPr(cacheKey, 'row-1', { addLabels: ['bug'] })

    expect(result).toEqual({ ok: true })
    expect(mockApi.gh.updateIssueBySlug).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-project',
      method: 'github.project.updateIssueBySlug',
      params: {
        owner: 'acme',
        repo: 'repo',
        number: 12,
        updates: { addLabels: ['bug'] }
      },
      timeoutMs: 30_000
    })
  })

  it('bounds project view table cache entries across many projects', async () => {
    vi.useFakeTimers()

    try {
      const store = createTestStore()
      mockApi.gh.getProjectViewTable.mockImplementation(
        async (args: Parameters<AppState['fetchProjectViewTable']>[0]) => ({
          ok: true,
          data: {
            project: {
              id: `project-${args.projectNumber}`,
              owner: args.owner,
              ownerType: args.ownerType,
              number: args.projectNumber,
              title: 'Roadmap',
              url: `https://github.com/orgs/${args.owner}/projects/${args.projectNumber}`
            },
            selectedView: {
              id: args.viewId ?? `view-${args.projectNumber}`,
              number: args.projectNumber,
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
        })
      )

      for (let i = 0; i <= 500; i++) {
        vi.setSystemTime(1_000 + i)
        await store.getState().fetchProjectViewTable(
          {
            owner: 'acme',
            ownerType: 'organization',
            projectNumber: i,
            viewId: `view-${i}`
          },
          { force: true }
        )
      }

      const cache = store.getState().projectViewCache
      expect(Object.keys(cache)).toHaveLength(500)
      expect(projectViewCacheKey('organization', 'acme', 0, 'view-0') in cache).toBe(false)
      expect(projectViewCacheKey('organization', 'acme', 500, 'view-500') in cache).toBe(true)
    } finally {
      vi.useRealTimers()
    }
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
