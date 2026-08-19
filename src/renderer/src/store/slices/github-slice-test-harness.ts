import { vi, type Mock } from 'vitest'
import { create } from 'zustand'
import { createGitHubSlice } from './github'
import { createHostedReviewSlice } from './hosted-review'
import type { AppState } from '../types'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type {
  GitHubPRRefreshCandidate,
  GitHubPRRefreshReason
} from '../../../../shared/github/pull-request-refresh-types'

/** Bare `vi.fn()` infers @vitest/spy's un-nameable `Procedure`, which breaks declaration emit. */
export type StubMock<TArgs extends unknown[] = never[]> = Mock<(...args: TArgs) => unknown>

function stubMock<TArgs extends unknown[] = never[]>(): StubMock<TArgs> {
  return vi.fn()
}

export type RuntimeEnvironmentSubscribeHandlers = {
  onResponse: (response: unknown) => void
  onError: (error: { message: string }) => void
}

export const runtimeEnvironmentCall: Mock<(args: RuntimeEnvironmentCallRequest) => unknown> =
  vi.fn()
export const runtimeEnvironmentTransportCall: Mock<
  (args: RuntimeEnvironmentCallRequest) => unknown
> = vi.fn()
export const runtimeEnvironmentSubscribe: Mock<
  (args: RuntimeEnvironmentCallRequest, handlers: RuntimeEnvironmentSubscribeHandlers) => unknown
> = vi.fn()

export const mockApi = {
  gh: {
    prForBranch: stubMock().mockResolvedValue(null),
    refreshPRNow: stubMock<[{ candidate: GitHubPRRefreshCandidate }]>(),
    enqueuePRRefresh:
      stubMock<
        [{ candidate: GitHubPRRefreshCandidate; reason: GitHubPRRefreshReason; priority?: number }]
      >().mockResolvedValue(undefined),
    issue:
      stubMock<[{ repoPath: string; repoId: string; number: number }]>().mockResolvedValue(null),
    prChecks: stubMock().mockResolvedValue([]),
    prCheckDetails: stubMock().mockResolvedValue(null),
    prComments: stubMock().mockResolvedValue([]),
    addIssueComment: stubMock(),
    addPRReviewCommentReply: stubMock(),
    setPRCommentReaction: stubMock(),
    resolveReviewThread: stubMock(),
    listWorkItems: stubMock(),
    countWorkItems: stubMock().mockResolvedValue(0),
    getProjectViewTable: stubMock(),
    updateProjectItemField: stubMock(),
    clearProjectItemField: stubMock(),
    updateIssueBySlug: stubMock(),
    updatePullRequestBySlug: stubMock(),
    updateIssueTypeBySlug: stubMock()
  },
  hostedReview: {
    forBranch: stubMock().mockResolvedValue(null),
    getCreationEligibility: stubMock(),
    create: stubMock()
  },
  runtimeEnvironments: {
    call: runtimeEnvironmentTransportCall,
    subscribe: runtimeEnvironmentSubscribe
  },
  cache: {
    getGitHub: stubMock().mockResolvedValue(null),
    setGitHub: stubMock().mockResolvedValue(undefined)
  }
}

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

export function resetRemoteRuntimeMocks() {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentSubscribe.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  runtimeEnvironmentSubscribe.mockImplementation(
    async (
      args: RuntimeEnvironmentCallRequest,
      handlers: {
        onResponse: (response: unknown) => void
        onError: (error: { message: string }) => void
      }
    ) => {
      let active = true
      void Promise.resolve(runtimeEnvironmentCall(args)).then(
        (response) => active && handlers.onResponse(response),
        (error) => active && handlers.onError({ message: String(error) })
      )
      return {
        unsubscribe: () => {
          active = false
        }
      }
    }
  )
}

export function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        ...createGitHubSlice(...a),
        ...createHostedReviewSlice(...a)
      }) as AppState
  )
}

export function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
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

export function makePRRefreshWorktree(overrides: Partial<Worktree> = {}): Worktree {
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

export function installLinkedPRClearStub(
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

export function githubSourceContext(
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
