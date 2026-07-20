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
const reportVisiblePRRefreshCandidates = vi.fn().mockResolvedValue(true)

const mockApi = {
  gh: {
    prForBranch: vi.fn().mockResolvedValue(null),
    refreshPRNow: vi.fn().mockResolvedValue({ kind: 'no-pr', fetchedAt: 1 }),
    enqueuePRRefresh,
    reportVisiblePRRefreshCandidates,
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

function resetRuntimeMocks(): void {
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

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'path'>): Repo {
  return {
    displayName: overrides.id,
    badgeColor: 'blue',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

function makeWorktree(repoId: string, branch: string, id = `${repoId}-wt`): Worktree {
  return {
    id,
    repoId,
    path: `/worktrees/${id}`,
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
    lastActivityAt: 1
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

describe('GitHub PR refresh owner-host routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRuntimeMocks()
  })

  it('routes explicit PR refresh for a runtime-owned repo to its owner while Local desktop is active', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: makePR({ number: 23 }),
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoPath = '/runtime/repo'
    const branch = 'feature/runtime-owner'
    seed(store, {
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings'],
      repos: [
        makeRepo({
          id: 'repo-runtime',
          path: repoPath,
          executionHostId: 'runtime:env-1'
        })
      ],
      worktreesByRepo: {
        'repo-runtime': [makeWorktree('repo-runtime', branch, 'wt-runtime')]
      }
    })

    store.getState().enqueueGitHubPRRefresh('wt-runtime', 'active', 80)

    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))
    expect(enqueuePRRefresh).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.prForBranch',
      params: { repo: 'repo-runtime', branch, linkedPRNumber: null, currentHeadOid: 'head-oid' },
      timeoutMs: 30_000
    })
  })

  it('keeps connected SSH PR refresh on the local coordinator even when a runtime is focused', () => {
    const store = createTestStore()
    const repoPath = '/ssh/repo'
    const branch = 'feature/ssh'
    seed(store, {
      settings: { activeRuntimeEnvironmentId: 'env-focused' } as AppState['settings'],
      repos: [
        makeRepo({
          id: 'repo-ssh',
          path: repoPath,
          connectionId: 'ssh-1',
          executionHostId: 'ssh:ssh-1'
        })
      ],
      sshConnectionStates: new Map([
        ['ssh-1', { targetId: 'ssh-1', status: 'connected', error: null, reconnectAttempt: 0 }]
      ]),
      worktreesByRepo: {
        'repo-ssh': [makeWorktree('repo-ssh', branch, 'wt-ssh')]
      }
    })

    store.getState().refreshGitHubForWorktreeIfStale('wt-ssh')

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(enqueuePRRefresh).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        repoId: 'repo-ssh',
        repoPath,
        branch,
        connectionId: 'ssh-1',
        connectionState: 'connected'
      }),
      reason: 'active',
      priority: 80
    })
  })

  it('routes post-push refresh for a runtime-owned repo to its owner while Local desktop is active', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: makePR({ number: 24 }),
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoPath = '/runtime/repo'
    const branch = 'feature/post-push'
    seed(store, {
      repos: [
        makeRepo({
          id: 'repo-runtime',
          path: repoPath,
          executionHostId: 'runtime:env-1'
        })
      ],
      worktreesByRepo: {
        'repo-runtime': [makeWorktree('repo-runtime', branch, 'wt-runtime')]
      }
    })

    store.getState().refreshGitHubForWorktree('wt-runtime')

    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))
    expect(enqueuePRRefresh).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.prForBranch',
      params: { repo: 'repo-runtime', branch, linkedPRNumber: null, currentHeadOid: 'head-oid' },
      timeoutMs: 30_000
    })
  })

  it('splits visible candidates between local coordinator and runtime owner', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: makePR({ number: 25 }),
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    seed(store, {
      repos: [
        makeRepo({ id: 'repo-local', path: '/local/repo' }),
        makeRepo({
          id: 'repo-runtime',
          path: '/runtime/repo',
          executionHostId: 'runtime:env-1'
        })
      ],
      worktreesByRepo: {
        'repo-local': [makeWorktree('repo-local', 'feature/local', 'wt-local')],
        'repo-runtime': [makeWorktree('repo-runtime', 'feature/runtime', 'wt-runtime')]
      }
    })

    store.getState().reportVisibleGitHubPRRefreshCandidates(['wt-local', 'wt-runtime'], 123)

    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))
    expect(reportVisiblePRRefreshCandidates).toHaveBeenCalledWith({
      candidates: [
        expect.objectContaining({
          repoId: 'repo-local',
          repoPath: '/local/repo',
          branch: 'feature/local'
        })
      ],
      generation: 123
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.prForBranch',
      params: {
        repo: 'repo-runtime',
        branch: 'feature/runtime',
        linkedPRNumber: null,
        currentHeadOid: 'head-oid'
      },
      timeoutMs: 30_000
    })
  })

  it('routes a paired-host visible refresh through the runtime repo owner', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: makePR({ number: 26 }),
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoId = 'repo-paired'
    const branch = 'feature/paired-visible'
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
      worktreesByRepo: {
        [repoId]: [
          {
            ...makeWorktree(repoId, branch, 'wt-runtime'),
            hostId: 'runtime:env-1'
          }
        ]
      }
    })

    store.getState().reportVisibleGitHubPRRefreshCandidates(['wt-runtime'], 124)

    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))
    expect(fetchPRForBranchSpy).toHaveBeenCalledWith('/runtime/repo', branch, {
      repoId,
      hostId: 'runtime:env-1',
      worktreeId: 'wt-runtime',
      linkedPRNumber: null,
      fallbackPRNumber: null,
      fallbackPRSource: null
    })
    expect(reportVisiblePRRefreshCandidates).toHaveBeenCalledWith({
      candidates: [],
      generation: 124
    })
    expect(mockApi.gh.refreshPRNow).not.toHaveBeenCalled()
    expect(store.getState().prCache[`runtime:env-1::${repoId}::${branch}`]?.data).toMatchObject({
      number: 26
    })
  })

  it('does not re-resolve an exact runtime path to the first same-id repo', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: makePR({ number: 28 }),
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoId = 'repo-paired'
    const branch = 'feature/exact-runtime-path'
    seed(store, {
      repos: [
        makeRepo({ id: repoId, path: '/local/repo' }),
        makeRepo({
          id: repoId,
          path: '/runtime/repo',
          executionHostId: 'runtime:env-1'
        })
      ],
      worktreesByRepo: {}
    })

    await store.getState().fetchPRForBranch('/runtime/repo', branch, { repoId })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.prForBranch',
      params: { repo: repoId, branch, linkedPRNumber: null, currentHeadOid: null },
      timeoutMs: 30_000
    })
    expect(mockApi.gh.refreshPRNow).not.toHaveBeenCalled()
    expect(store.getState().prCache[`runtime:env-1::${repoId}::${branch}`]?.data).toMatchObject({
      number: 28
    })
  })

  it('routes a paired-host active refresh through the runtime repo owner', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: makePR({ number: 27 }),
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    const repoId = 'repo-paired'
    const branch = 'feature/paired-active'
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
      worktreesByRepo: {
        [repoId]: [
          {
            ...makeWorktree(repoId, branch, 'wt-runtime'),
            hostId: 'runtime:env-1'
          }
        ]
      }
    })

    store.getState().refreshGitHubForWorktreeIfStale('wt-runtime')

    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))
    expect(fetchPRForBranchSpy).toHaveBeenCalledWith('/runtime/repo', branch, {
      force: true,
      repoId,
      hostId: 'runtime:env-1',
      worktreeId: 'wt-runtime',
      linkedPRNumber: null,
      fallbackPRNumber: null,
      fallbackPRSource: null
    })
    expect(enqueuePRRefresh).not.toHaveBeenCalled()
    expect(mockApi.gh.refreshPRNow).not.toHaveBeenCalled()
    expect(store.getState().prCache[`runtime:env-1::${repoId}::${branch}`]?.data).toMatchObject({
      number: 27
    })
  })

  it('keeps the focused-host fallback for legacy worktrees without host identity', () => {
    const store = createTestStore()
    const repoId = 'repo-paired'
    const branch = 'feature/legacy-local'
    seed(store, {
      repos: [
        makeRepo({ id: repoId, path: '/local/repo' }),
        makeRepo({
          id: repoId,
          path: '/runtime/repo',
          executionHostId: 'runtime:env-1'
        })
      ],
      worktreesByRepo: {
        [repoId]: [makeWorktree(repoId, branch, 'wt-legacy')]
      }
    })

    store.getState().refreshGitHubForWorktreeIfStale('wt-legacy')

    expect(enqueuePRRefresh).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        repoId,
        repoPath: '/local/repo',
        cacheKey: `${repoId}::${branch}`
      }),
      reason: 'active',
      priority: 80
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('fails closed when a legacy worktree has duplicate owners on its focused host', () => {
    const store = createTestStore()
    const repoId = 'repo-ambiguous'
    seed(store, {
      repos: [
        makeRepo({ id: repoId, path: '/local/repo-a' }),
        makeRepo({ id: repoId, path: '/local/repo-b' })
      ],
      worktreesByRepo: {
        [repoId]: [makeWorktree(repoId, 'feature/ambiguous', 'wt-ambiguous')]
      }
    })

    store.getState().refreshGitHubForWorktreeIfStale('wt-ambiguous')

    expect(enqueuePRRefresh).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})
