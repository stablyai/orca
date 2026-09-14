import { vi, type Mock } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { DetectedWorktreeListResult, Worktree } from '../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type {
  ForgetRemovedWorktreesForExecutionHostArgs,
  ForgetRemovedWorktreesForExecutionHostResult,
  HostQualifiedDetectedWorktreeResult,
  HostQualifiedKnownWorktreeResult,
  ListKnownWorktreesForExecutionHostArgs,
  ListDetectedWorktreesArgs
} from '../../../../shared/detected-worktree-provider-contract'
import {
  createWorktreeSlice,
  resetAuthoritativelyRemovedWorktreeMemoryForTests,
  resetHostedReviewLinkMutationGenerationForTests
} from './worktrees'
import {
  makeDetectedResult,
  qualifyDetectedResult,
  TEST_SSH_AUTHORITY
} from './worktrees-detected-listing-fixtures'
import { makeWorktree } from './worktrees-slice-test-fixtures'

/** Bare `vi.fn()` infers @vitest/spy's un-nameable `Procedure`, which breaks declaration emit. */
export type StubMock<TArgs extends unknown[] = never[]> = Mock<(...args: TArgs) => unknown>

function stubMock<TArgs extends unknown[] = never[]>(): StubMock<TArgs> {
  return vi.fn()
}

export const runtimeEnvironmentCall: Mock<(args: RuntimeEnvironmentCallRequest) => unknown> =
  vi.fn()
export const runtimeEnvironmentTransportCall: Mock<
  (args: RuntimeEnvironmentCallRequest) => unknown
> = vi.fn()
export const worktreeListMock: Mock<(args: { repoId: string }) => Promise<Worktree[]>> = vi
  .fn()
  .mockResolvedValue([])

export const listDetectedMock = vi.fn<
  (
    args: ListDetectedWorktreesArgs
  ) => Promise<DetectedWorktreeListResult | HostQualifiedDetectedWorktreeResult>
>(async (args) => {
  const result = makeDetectedResult(args.repoId, await worktreeListMock({ repoId: args.repoId }))
  return qualifyDetectedResult(args, result)
})

export const listKnownForExecutionHostMock = vi.fn<
  (args: ListKnownWorktreesForExecutionHostArgs) => Promise<HostQualifiedKnownWorktreeResult>
>(async (args) => ({ status: 'rejected', ...args }))

export const forgetRemovedForExecutionHostMock = vi.fn<
  (
    args: ForgetRemovedWorktreesForExecutionHostArgs
  ) => Promise<ForgetRemovedWorktreesForExecutionHostResult>
>(async () => ({ forgottenWorktreeIds: [] }))

export const mockApi = {
  worktrees: {
    create: stubMock(),
    adoptProvisionedRoot: stubMock(),
    prefetchCreateBase: stubMock().mockResolvedValue(undefined),
    list: worktreeListMock,
    listDetected: listDetectedMock,
    listKnownForExecutionHost: listKnownForExecutionHostMock,
    forgetRemovedForExecutionHost: forgetRemovedForExecutionHostMock,
    cancelListDetected: stubMock().mockResolvedValue(undefined),
    listLineage: stubMock().mockResolvedValue({}),
    remove: stubMock().mockResolvedValue(undefined),
    forgetLocal: stubMock().mockResolvedValue({}),
    forceDeletePreservedBranch: stubMock().mockResolvedValue({ deleted: true }),
    resolvePrBase: stubMock(),
    resolveMrBase: stubMock(),
    updateMeta:
      stubMock<[{ worktreeId: string; updates: Partial<WorktreeMeta> }]>().mockResolvedValue(
        undefined
      ),
    updateLineage: stubMock().mockResolvedValue(null)
  },
  pty: {
    kill: stubMock().mockResolvedValue(undefined)
  },
  hooks: {
    check: stubMock().mockResolvedValue({ hasHooks: false, hooks: null, mayNeedUpdate: false })
  },
  workspaceCleanup: {
    recordRemovalSnapshotPrune: stubMock().mockResolvedValue(undefined)
  },
  runtimeEnvironments: {
    call: runtimeEnvironmentTransportCall
  },
  runtime: {
    call: stubMock().mockResolvedValue({
      id: 'runtime-call',
      ok: true,
      result: { stoppedWorktreeIds: [] }
    })
  },
  ephemeralVm: {
    cancelProvision: stubMock().mockResolvedValue({ cancelled: true }),
    cleanup: stubMock().mockResolvedValue({}),
    listRuntimes: stubMock().mockResolvedValue([])
  }
}

// @ts-expect-error -- test shim
globalThis.window = { api: mockApi }

export function resetRemoteRuntimeMocks() {
  clearRuntimeCompatibilityCacheForTests()
  resetHostedReviewLinkMutationGenerationForTests()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
}

export function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        // Why: this test isolates the worktree slice, so it provides only the state surface createWorktreeSlice touches.
        ...createWorktreeSlice(...a),
        trustedOrcaHooks: {},
        sshConnectionStates: new Map([
          [
            TEST_SSH_AUTHORITY.targetId,
            {
              targetId: TEST_SSH_AUTHORITY.targetId,
              status: 'connected',
              error: null,
              reconnectAttempt: 0,
              providerEpoch: TEST_SSH_AUTHORITY.providerEpoch,
              connectionGeneration: TEST_SSH_AUTHORITY.connectionGeneration
            }
          ]
        ]),
        repos: [],
        projectHostSetups: [],
        deleteProjectHostSetup: vi.fn().mockResolvedValue(null),
        updateFolderWorkspace: vi.fn().mockResolvedValue(true),
        updateSettings: vi.fn().mockResolvedValue(undefined),
        openModal: vi.fn(),
        shutdownWorktreeTerminals: vi.fn().mockResolvedValue(undefined),
        shutdownWorktreeBrowsers: vi.fn().mockResolvedValue(undefined),
        ptyIdsByTabId: {},
        tabsByWorktree: {},
        tabBarOrderByWorktree: {},
        pendingReconnectTabByWorktree: {},
        activeTabIdByWorktree: {},
        unifiedTabsByWorktree: {},
        groupsByWorktree: {},
        activeGroupIdByWorktree: {},
        layoutByWorktree: {},
        openFiles: [],
        editorDrafts: {},
        markdownViewMode: {},
        markdownRichModeSizeOverride: {},
        editorViewMode: {},
        showDotfilesByWorktree: {},
        expandedDirs: {},
        gitStatusByWorktree: {},
        gitStatusHeadByWorktree: {},
        gitIgnoredPathsByWorktree: {},
        gitConflictOperationByWorktree: {},
        trackedConflictPathsByWorktree: {},
        gitBranchChangesByWorktree: {},
        gitBranchCompareSummaryByWorktree: {},
        gitBranchCompareRequestKeyByWorktree: {},
        gitBranchCompareRequestStatusHeadByWorktree: {},
        activeFileIdByWorktree: {},
        activeBrowserTabIdByWorktree: {},
        browserTabsByWorktree: {},
        recentlyClosedBrowserTabsByWorktree: {},
        activeTabTypeByWorktree: {},
        rightSidebarTab: 'explorer' as const,
        rightSidebarTabByWorktree: {},
        activeWorktreeId: null,
        activeTabId: null,
        activeFileId: null,
        activeBrowserTabId: null,
        activeTabType: 'terminal' as const,
        reconcileWorktreeTabModel: vi.fn(() => ({
          activeRenderableTabId: null,
          renderableTabCount: 0
        })),
        refreshGitHubForWorktreeIfStale: vi.fn()
      }) as unknown as AppState
  )
}

export function createLocalLineageTestStore(lineage: WorktreeLineage) {
  const store = createTestStore()
  store.setState({
    worktreesByRepo: {
      repo1: [
        makeWorktree({
          id: lineage.worktreeId,
          repoId: 'repo1',
          hostId: LOCAL_EXECUTION_HOST_ID
        })
      ]
    }
  } as Partial<AppState>)
  return store
}

// Why: both the metadata fallback and removeWorktree write this module-level memory, so a leaked entry from an
// earlier describe would silently suppress a row here. Reset for every case, not just the fetch suites.
export function resetWorktreeSliceModuleMemory() {
  resetAuthoritativelyRemovedWorktreeMemoryForTests()
  mockApi.worktrees.create.mockReset()
  mockApi.worktrees.adoptProvisionedRoot.mockReset()
}
