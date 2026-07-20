import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { createGitHubSlice } from './github'
import { createHostedReviewSlice } from './hosted-review'
import type { AppState } from '../types'
import type { PRInfo, Repo, Worktree } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()
const enqueuePRRefresh = vi.fn().mockResolvedValue(undefined)

const mockApi = {
  gh: {
    prForBranch: vi.fn().mockResolvedValue(null),
    prChecks: vi.fn().mockResolvedValue([]),
    prComments: vi.fn().mockResolvedValue([]),
    refreshPRNow: vi.fn().mockResolvedValue({ kind: 'no-pr', fetchedAt: 1 }),
    enqueuePRRefresh,
    issue: vi.fn().mockResolvedValue(null)
  },
  hostedReview: { forBranch: vi.fn().mockResolvedValue(null) },
  runtimeEnvironments: { call: runtimeEnvironmentTransportCall },
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

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'path'>): Repo {
  return {
    displayName: overrides.id,
    badgeColor: 'blue',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

function makeRuntimeWorktree(repoId: string, branch: string): Worktree {
  return {
    id: 'wt-runtime',
    repoId,
    path: '/runtime/repo/worktrees/feature',
    head: 'head-oid',
    branch,
    displayName: branch,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedLinearIssueWorkspaceId: null,
    linkedLinearIssueOrganizationUrlKey: null,
    isMainWorktree: false,
    isBare: false,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    hostId: 'runtime:env-1'
  }
}

function seed(
  store: ReturnType<typeof createTestStore>,
  state: Pick<AppState, 'repos' | 'worktreesByRepo'> & Partial<AppState>
): void {
  store.setState({
    settings: { activeRuntimeEnvironmentId: null } as AppState['settings'],
    groupBy: 'pr-status',
    worktreeCardProperties: ['status'],
    prCache: {},
    issueCache: {},
    hostedReviewCache: {},
    commentsCache: {},
    sshConnectionStates: new Map(),
    ...state
  } as unknown as Partial<AppState>)
}

describe('GitHub PR refresh owner consistency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
    })
  })

  it('refreshes stale runtime PR data even when the same-id local cache is fresh', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: makePR({ number: 31 }),
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoId = 'repo-paired'
    const branch = 'feature/runtime-stale'
    const fetchPRForBranch = store.getState().fetchPRForBranch
    const fetchPRForBranchSpy = vi.fn((...args: Parameters<typeof fetchPRForBranch>) =>
      fetchPRForBranch(...args)
    )
    store.setState({ fetchPRForBranch: fetchPRForBranchSpy })
    seed(store, {
      repos: [
        makeRepo({ id: repoId, path: '/local/repo' }),
        makeRepo({
          id: repoId,
          path: '/runtime/repo',
          executionHostId: 'runtime:env-1'
        })
      ],
      worktreesByRepo: { [repoId]: [makeRuntimeWorktree(repoId, branch)] },
      prCache: {
        [`${repoId}::${branch}`]: {
          data: makePR({ number: 7 }),
          fetchedAt: Date.now()
        }
      }
    })

    store.getState().refreshAllGitHub()

    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))
    expect(fetchPRForBranchSpy).toHaveBeenCalledWith('/runtime/repo', branch, {
      repoId,
      hostId: 'runtime:env-1',
      worktreeId: 'wt-runtime',
      linkedPRNumber: null,
      fallbackPRNumber: null,
      fallbackPRSource: null
    })
    expect(enqueuePRRefresh).not.toHaveBeenCalled()
    expect(store.getState().prCache[`runtime:env-1::${repoId}::${branch}`]?.data).toMatchObject({
      number: 31
    })
  })

  it('does not dispatch a refresh when the owner cache is fresh', () => {
    const store = createTestStore()
    const repoId = 'repo-paired'
    const branch = 'feature/runtime-fresh'
    const fetchPRForBranchSpy = vi.fn(store.getState().fetchPRForBranch)
    store.setState({ fetchPRForBranch: fetchPRForBranchSpy })
    seed(store, {
      repos: [
        makeRepo({ id: repoId, path: '/local/repo' }),
        makeRepo({
          id: repoId,
          path: '/runtime/repo',
          executionHostId: 'runtime:env-1'
        })
      ],
      worktreesByRepo: { [repoId]: [makeRuntimeWorktree(repoId, branch)] },
      prCache: {
        [`runtime:env-1::${repoId}::${branch}`]: {
          data: makePR({ number: 32 }),
          fetchedAt: Date.now()
        }
      }
    })

    store.getState().refreshAllGitHub()

    expect(fetchPRForBranchSpy).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(enqueuePRRefresh).not.toHaveBeenCalled()
  })

  it('does not stale the paired local cache when refreshing after a runtime push', async () => {
    let resolveRuntimeCall: (response: unknown) => void = () => {}
    runtimeEnvironmentCall.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRuntimeCall = resolve
        })
    )
    const store = createTestStore()
    const repoId = 'repo-paired'
    const branch = 'feature/runtime-push'
    const fetchedAt = Date.now()
    const runtimeWorktree = makeRuntimeWorktree(repoId, branch)
    const localWorktree: Worktree = {
      ...runtimeWorktree,
      id: 'wt-local',
      path: '/local/repo/worktrees/feature',
      hostId: 'local'
    }
    seed(store, {
      repos: [
        makeRepo({ id: repoId, path: '/local/repo' }),
        makeRepo({
          id: repoId,
          path: '/runtime/repo',
          executionHostId: 'runtime:env-1'
        })
      ],
      worktreesByRepo: { [repoId]: [localWorktree, runtimeWorktree] },
      prCache: {
        [`${repoId}::${branch}`]: {
          data: makePR({ number: 7 }),
          fetchedAt
        },
        [`runtime:env-1::${repoId}::${branch}`]: {
          data: makePR({ number: 34 }),
          fetchedAt
        }
      }
    })

    store.getState().refreshGitHubForWorktree('wt-runtime')
    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))
    expect(store.getState().prCache[`${repoId}::${branch}`]?.fetchedAt).toBe(fetchedAt)
    expect(store.getState().prCache[`runtime:env-1::${repoId}::${branch}`]?.fetchedAt).toBe(0)

    store.getState().refreshAllGitHub()

    expect(enqueuePRRefresh).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)

    resolveRuntimeCall({
      id: 'rpc-1',
      ok: true,
      result: makePR({ number: 35 }),
      _meta: { runtimeId: 'remote-runtime' }
    })
    await vi.waitFor(() =>
      expect(store.getState().prCache[`runtime:env-1::${repoId}::${branch}`]?.data?.number).toBe(35)
    )
  })

  it('routes paired-host checks and comments through the runtime path owner', async () => {
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'rpc-checks',
        ok: true,
        result: [{ name: 'build', status: 'completed', conclusion: 'success', url: null }],
        _meta: { runtimeId: 'remote-runtime' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-comments',
        ok: true,
        result: [],
        _meta: { runtimeId: 'remote-runtime' }
      })
    const store = createTestStore()
    const repoId = 'repo-paired'
    const branch = 'feature/runtime-details'
    seed(store, {
      repos: [
        makeRepo({ id: repoId, path: '/local/repo' }),
        makeRepo({
          id: repoId,
          path: '/runtime/repo',
          executionHostId: 'runtime:env-1'
        })
      ],
      worktreesByRepo: { [repoId]: [makeRuntimeWorktree(repoId, branch)] }
    })

    await store.getState().fetchPRChecks('/runtime/repo', 42, branch, 'head-oid', null, {
      force: true,
      repoId
    })
    await store.getState().fetchPRComments('/runtime/repo', 42, {
      force: true,
      repoId
    })

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'github.prChecks',
      params: {
        repo: repoId,
        prNumber: 42,
        headSha: 'head-oid',
        prRepo: null,
        noCache: true
      },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'github.prComments',
      params: { repo: repoId, prNumber: 42, prRepo: null, noCache: true },
      timeoutMs: 30_000
    })
    expect(mockApi.gh.prChecks).not.toHaveBeenCalled()
    expect(mockApi.gh.prComments).not.toHaveBeenCalled()
    expect(
      store.getState().checksCache[`runtime:env-1::${repoId}::pr-checks::42::head::head-oid`]?.data
    ).toHaveLength(1)
    expect(
      store.getState().commentsCache[`runtime:env-1::${repoId}::pr-comments::42`]?.data
    ).toEqual([])
  })

  it('drops an in-flight result when the explicit owner path changes', async () => {
    let resolveRuntimeCall: (response: unknown) => void = () => {}
    runtimeEnvironmentCall.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRuntimeCall = resolve
        })
    )
    const store = createTestStore()
    const repoId = 'repo-paired'
    const branch = 'feature/owner-moved'
    seed(store, {
      repos: [
        makeRepo({
          id: repoId,
          path: '/runtime/repo',
          executionHostId: 'runtime:env-1'
        })
      ],
      worktreesByRepo: { [repoId]: [makeRuntimeWorktree(repoId, branch)] }
    })

    const request = store.getState().fetchPRForBranch('/runtime/repo', branch, {
      force: true,
      repoId,
      hostId: 'runtime:env-1',
      worktreeId: 'wt-runtime'
    })
    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))
    store.setState({
      repos: [
        makeRepo({
          id: repoId,
          path: '/runtime/repo-moved',
          executionHostId: 'runtime:env-1'
        })
      ]
    })
    resolveRuntimeCall({
      id: 'rpc-1',
      ok: true,
      result: makePR({ number: 33 }),
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(request).resolves.toBeNull()
    expect(store.getState().prCache[`runtime:env-1::${repoId}::${branch}`]).toBeUndefined()
    expect(store.getState().hostedReviewCache).toEqual({})
  })
})
