/* eslint-disable max-lines --
 * Why: this slice test keeps the worktree store scenarios in one file so the
 * shared mock store setup stays consistent across closely related behaviors.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type {
  DetectedWorktreeListResult,
  LocalBaseRefRefreshResult,
  Worktree,
  WorktreeLineage
} from '../../../../shared/types'
import { toast } from 'sonner'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn()
  }
}))

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()
const worktreeListMock = vi.fn().mockResolvedValue([])

function makeDetectedResult(
  repoId: string,
  worktrees: Worktree[],
  overrides: Partial<DetectedWorktreeListResult> = {}
): DetectedWorktreeListResult {
  return {
    repoId,
    authoritative: true,
    source: 'git',
    ...overrides,
    worktrees: worktrees.map((worktree) => ({
      ...worktree,
      ownership: 'orca-managed' as const,
      selectedCheckout: false,
      visible: true
    }))
  }
}

const mockApi = {
  worktrees: {
    create: vi.fn(),
    prefetchCreateBase: vi.fn().mockResolvedValue(undefined),
    list: worktreeListMock,
    listDetected: vi.fn(async ({ repoId }: { repoId: string }) =>
      makeDetectedResult(repoId, await worktreeListMock({ repoId }))
    ),
    listLineage: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    forceDeletePreservedBranch: vi.fn().mockResolvedValue({ deleted: true }),
    resolvePrBase: vi.fn(),
    updateMeta: vi.fn().mockResolvedValue(undefined),
    updateLineage: vi.fn().mockResolvedValue(null)
  },
  pty: {
    kill: vi.fn().mockResolvedValue(undefined)
  },
  hooks: {
    check: vi.fn().mockResolvedValue({ hasHooks: false, hooks: null, mayNeedUpdate: false })
  },
  runtimeEnvironments: {
    call: runtimeEnvironmentTransportCall
  }
}

// @ts-expect-error -- test shim
globalThis.window = { api: mockApi }

import { createWorktreeSlice } from './worktrees'
import { getHostedReviewCacheKey } from './hosted-review'
import { getGitHubPRCacheKey, getLegacyGitHubPRCacheKey } from './github-cache-key'
import {
  registerPersistentWebview,
  unregisterPersistentWebview
} from '../../components/browser-pane/webview-registry'

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
        // Why: this test isolates the worktree slice, so it only provides the
        // state surface that `createWorktreeSlice` reads and writes.
        ...createWorktreeSlice(...a),
        trustedOrcaHooks: {},
        repos: [],
        openModal: vi.fn(),
        shutdownWorktreeTerminals: vi.fn().mockResolvedValue(undefined),
        shutdownWorktreeBrowsers: vi.fn().mockResolvedValue(undefined),
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
        editorViewMode: {},
        showDotfilesByWorktree: {},
        expandedDirs: {},
        gitStatusByWorktree: {},
        gitIgnoredPathsByWorktree: {},
        gitConflictOperationByWorktree: {},
        trackedConflictPathsByWorktree: {},
        gitBranchChangesByWorktree: {},
        gitBranchCompareSummaryByWorktree: {},
        gitBranchCompareRequestKeyByWorktree: {},
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

function makeWorktree(overrides: Partial<Worktree> & { id: string; repoId: string }): Worktree {
  return {
    path: '/tmp/wt',
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function createWebview(overrides: Partial<Electron.WebviewTag> = {}): Electron.WebviewTag {
  return {
    style: {},
    blur: vi.fn(),
    remove: vi.fn(),
    contains: vi.fn(() => false),
    ...overrides
  } as unknown as Electron.WebviewTag
}

function makeLineage(overrides: Partial<WorktreeLineage> = {}): WorktreeLineage {
  return {
    worktreeId: 'repo1::/path/child',
    worktreeInstanceId: 'child-instance',
    parentWorktreeId: 'repo1::/path/parent',
    parentWorktreeInstanceId: 'parent-instance',
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1,
    ...overrides
  }
}

describe('setActiveWorktree focus handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('moves focus out of a registered webview before switching worktrees', () => {
    const store = createTestStore()
    const current = makeWorktree({ id: 'repo1::/path/current', repoId: 'repo1' })
    const next = makeWorktree({ id: 'repo1::/path/next', repoId: 'repo1' })
    const webview = createWebview()
    const focusRenderer = vi.fn(() => {
      expect(store.getState().activeWorktreeId).toBe(current.id)
    })
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const testWindow = globalThis.window as unknown as { focus?: () => void }
    const previousFocus = testWindow.focus

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { activeElement: webview }
    })
    testWindow.focus = focusRenderer
    registerPersistentWebview('page-1', webview)

    try {
      store.setState({
        worktreesByRepo: { repo1: [current, next] },
        activeWorktreeId: current.id,
        reconcileWorktreeTabModel: vi.fn(() => ({
          activeRenderableTabId: null,
          renderableTabCount: 0
        })),
        refreshGitHubForWorktreeIfStale: vi.fn()
      } as unknown as Partial<AppState>)

      store.getState().setActiveWorktree(next.id)

      expect(webview.blur).toHaveBeenCalledTimes(1)
      expect(focusRenderer).toHaveBeenCalledTimes(1)
      expect(store.getState().activeWorktreeId).toBe(next.id)
    } finally {
      unregisterPersistentWebview('page-1')
      if (previousDocument) {
        Object.defineProperty(globalThis, 'document', previousDocument)
      } else {
        delete (globalThis as unknown as { document?: unknown }).document
      }
      if (previousFocus) {
        testWindow.focus = previousFocus
      } else {
        delete testWindow.focus
      }
    }
  })
})

describe('fetchWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('does not notify subscribers when the fetched payload is unchanged', async () => {
    const store = createTestStore()
    const existing = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    const subscriber = vi.fn()
    const detected = makeDetectedResult('repo1', [existing])

    mockApi.worktrees.listDetected.mockResolvedValueOnce(detected)
    store.setState({
      worktreesByRepo: { repo1: [existing] },
      detectedWorktreesByRepo: { repo1: detected },
      sortEpoch: 7
    } as Partial<AppState>)

    const unsubscribe = store.subscribe(subscriber)
    const result = await store.getState().fetchWorktrees('repo1')
    unsubscribe()

    expect(store.getState().worktreesByRepo.repo1).toEqual([existing])
    expect(store.getState().sortEpoch).toBe(7)
    expect(subscriber).not.toHaveBeenCalled()
    expect(result).toBe(true)
  })

  it('updates the repo entry and bumps sortEpoch when git reports a branch change', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature-one',
      displayName: 'feature-one'
    })
    const refreshed = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature-two',
      head: 'def456',
      displayName: 'feature-two'
    })

    mockApi.worktrees.list.mockResolvedValue([refreshed])
    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 7 } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([refreshed])
    expect(store.getState().sortEpoch).toBe(8)
  })

  it('updates the repo entry when only the persisted base ref changes', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      baseRef: 'origin/main'
    })
    const refreshed = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      baseRef: 'upstream/release'
    })

    mockApi.worktrees.list.mockResolvedValue([refreshed])
    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 7 } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([refreshed])
    expect(store.getState().sortEpoch).toBe(8)
  })

  it('keeps the last known worktree list when a refresh transiently returns empty', async () => {
    const store = createTestStore()
    const existing = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    mockApi.worktrees.listDetected.mockResolvedValueOnce(
      makeDetectedResult('repo1', [], {
        authoritative: false,
        source: 'metadata-fallback'
      })
    )
    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 7 } as Partial<AppState>)

    const result = await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([existing])
    expect(store.getState().sortEpoch).toBe(7)
    expect(result).toBe(false)
  })

  it('reports unchanged non-authoritative refreshes as not fully refreshed', async () => {
    const store = createTestStore()
    const existing = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    mockApi.worktrees.listDetected.mockResolvedValueOnce(
      makeDetectedResult('repo1', [existing], {
        authoritative: false,
        source: 'metadata-fallback'
      })
    )
    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 7 } as Partial<AppState>)

    const result = await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([existing])
    expect(store.getState().sortEpoch).toBe(7)
    expect(result).toBe(false)
  })

  it('does not publish non-authoritative rows when an authoritative refresh is required', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/existing',
      repoId: 'repo1',
      path: '/path/existing'
    })
    const fallback = makeWorktree({
      id: 'repo1::/path/fallback',
      repoId: 'repo1',
      path: '/path/fallback'
    })

    mockApi.worktrees.listDetected.mockResolvedValueOnce(
      makeDetectedResult('repo1', [fallback], {
        authoritative: false,
        source: 'metadata-fallback'
      })
    )
    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 7 } as Partial<AppState>)

    const result = await store.getState().fetchWorktrees('repo1', { requireAuthoritative: true })

    expect(store.getState().worktreesByRepo.repo1).toEqual([existing])
    expect(store.getState().detectedWorktreesByRepo.repo1).toBeUndefined()
    expect(store.getState().sortEpoch).toBe(7)
    expect(result).toBe(false)
  })

  it('purges remembered right sidebar tabs for worktrees removed by a committed refresh', async () => {
    const store = createTestStore()
    const removed = makeWorktree({
      id: 'repo1::/path/removed',
      repoId: 'repo1',
      path: '/path/removed'
    })
    const surviving = makeWorktree({
      id: 'repo1::/path/surviving',
      repoId: 'repo1',
      path: '/path/surviving'
    })

    mockApi.worktrees.list.mockResolvedValue([surviving])
    store.setState({
      worktreesByRepo: { repo1: [removed, surviving] },
      sortEpoch: 7,
      rightSidebarTabByWorktree: {
        [removed.id]: 'search',
        [surviving.id]: 'checks'
      }
    } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([surviving])
    expect(store.getState().rightSidebarTabByWorktree).toEqual({ [surviving.id]: 'checks' })
    expect(store.getState().sortEpoch).toBe(8)
  })

  it('purges remembered state for hidden worktrees removed by an authoritative refresh', async () => {
    const store = createTestStore()
    const visible = makeWorktree({
      id: 'repo1::/path/visible',
      repoId: 'repo1',
      path: '/path/visible'
    })
    const hidden = makeWorktree({
      id: 'repo1::/path/hidden',
      repoId: 'repo1',
      path: '/path/hidden'
    })
    const previousDetected = makeDetectedResult('repo1', [visible, hidden])
    previousDetected.worktrees[1] = {
      ...previousDetected.worktrees[1],
      ownership: 'external',
      visible: false
    }
    mockApi.worktrees.listDetected.mockResolvedValueOnce(makeDetectedResult('repo1', [visible]))
    store.setState({
      worktreesByRepo: { repo1: [visible] },
      detectedWorktreesByRepo: { repo1: previousDetected },
      sortEpoch: 7,
      rightSidebarTabByWorktree: {
        [visible.id]: 'checks',
        [hidden.id]: 'search'
      },
      tabsByWorktree: {
        [hidden.id]: [{ id: 'tab-hidden', worktreeId: hidden.id }]
      }
    } as unknown as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([visible])
    expect(store.getState().rightSidebarTabByWorktree).toEqual({ [visible.id]: 'checks' })
    expect(store.getState().tabsByWorktree[hidden.id]).toBeUndefined()
    expect(store.getState().sortEpoch).toBe(7)
  })

  it('purges session-only tab keys after an authoritative refresh', async () => {
    const store = createTestStore()
    const deleted = makeWorktree({
      id: 'repo1::/path/deleted',
      repoId: 'repo1',
      path: '/path/deleted'
    })
    const surviving = makeWorktree({
      id: 'repo1::/path/surviving',
      repoId: 'repo1',
      path: '/path/surviving'
    })

    mockApi.worktrees.listDetected.mockResolvedValueOnce(makeDetectedResult('repo1', [surviving]))
    store.setState({
      worktreesByRepo: { repo1: [] },
      detectedWorktreesByRepo: {
        repo1: makeDetectedResult('repo1', [], {
          authoritative: false,
          source: 'metadata-fallback'
        })
      },
      tabsByWorktree: {
        [deleted.id]: [{ id: 'tab-deleted', worktreeId: deleted.id }],
        [surviving.id]: [{ id: 'tab-surviving', worktreeId: surviving.id }]
      },
      terminalLayoutsByTabId: {
        'tab-deleted': { root: null, activeLeafId: null, expandedLeafId: null },
        'tab-surviving': { root: null, activeLeafId: null, expandedLeafId: null }
      },
      activeWorktreeId: deleted.id,
      activeTabId: 'tab-deleted',
      sortEpoch: 7
    } as unknown as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([surviving])
    expect(store.getState().tabsByWorktree).toEqual({
      [surviving.id]: [{ id: 'tab-surviving', worktreeId: surviving.id }]
    })
    expect(store.getState().terminalLayoutsByTabId).toEqual({
      'tab-surviving': { root: null, activeLeafId: null, expandedLeafId: null }
    })
    expect(store.getState().activeWorktreeId).toBeNull()
    expect(store.getState().activeTabId).toBeNull()
    expect(store.getState().sortEpoch).toBe(8)
  })

  it('does not purge remembered state from a non-authoritative partial refresh', async () => {
    const store = createTestStore()
    const missingFromFallback = makeWorktree({
      id: 'repo1::/path/missing-from-fallback',
      repoId: 'repo1',
      path: '/path/missing-from-fallback'
    })
    const fallback = makeWorktree({
      id: 'repo1::/path/fallback',
      repoId: 'repo1',
      path: '/path/fallback'
    })

    mockApi.worktrees.listDetected.mockResolvedValueOnce(
      makeDetectedResult('repo1', [fallback], {
        authoritative: false,
        source: 'metadata-fallback'
      })
    )
    store.setState({
      worktreesByRepo: { repo1: [missingFromFallback, fallback] },
      sortEpoch: 7,
      rightSidebarTabByWorktree: {
        [missingFromFallback.id]: 'search',
        [fallback.id]: 'checks'
      },
      tabsByWorktree: {
        [missingFromFallback.id]: [{ id: 'tab-missing', worktreeId: missingFromFallback.id }]
      }
    } as unknown as Partial<AppState>)

    const result = await store.getState().fetchWorktrees('repo1')

    expect(store.getState().rightSidebarTabByWorktree).toEqual({
      [missingFromFallback.id]: 'search',
      [fallback.id]: 'checks'
    })
    expect(store.getState().tabsByWorktree[missingFromFallback.id]).toEqual([
      { id: 'tab-missing', worktreeId: missingFromFallback.id }
    ])
    expect(store.getState().worktreesByRepo.repo1).toEqual([fallback])
    expect(store.getState().sortEpoch).toBe(8)
    expect(result).toBe(false)
  })

  it('does not purge remembered right sidebar tabs on a transient empty refresh', async () => {
    const store = createTestStore()
    const existing = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    mockApi.worktrees.listDetected.mockResolvedValueOnce(
      makeDetectedResult('repo1', [], {
        authoritative: false,
        source: 'metadata-fallback'
      })
    )
    store.setState({
      worktreesByRepo: { repo1: [existing] },
      sortEpoch: 7,
      rightSidebarTabByWorktree: { [existing.id]: 'search' }
    } as Partial<AppState>)

    const result = await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([existing])
    expect(store.getState().rightSidebarTabByWorktree).toEqual({ [existing.id]: 'search' })
    expect(store.getState().sortEpoch).toBe(7)
    expect(result).toBe(false)
  })

  it('accepts an empty refresh when the repo had no cached worktrees', async () => {
    const store = createTestStore()

    mockApi.worktrees.list.mockResolvedValue([])
    store.setState({ worktreesByRepo: {}, sortEpoch: 7 } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([])
    expect(store.getState().sortEpoch).toBe(8)
  })

  it('fetches worktrees from the active remote runtime environment', async () => {
    const store = createTestStore()
    const remote = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote'
    })
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: makeDetectedResult('repo1', [remote]),
      _meta: { runtimeId: 'runtime-remote' }
    })

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([remote])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'worktree.detectedList',
      params: { repo: 'repo1' },
      timeoutMs: 15_000
    })
    expect(mockApi.worktrees.listDetected).not.toHaveBeenCalled()
  })

  it('falls back to legacy remote worktree.list when detectedList is unavailable', async () => {
    const store = createTestStore()
    const remote = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote'
    })
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) =>
      Promise.resolve(
        method === 'worktree.detectedList'
          ? {
              id: 'rpc-1',
              ok: false,
              error: {
                code: 'method_not_found',
                message: 'Unknown method: worktree.detectedList'
              },
              _meta: { runtimeId: 'runtime-remote' }
            }
          : {
              id: 'rpc-2',
              ok: true,
              result: { worktrees: [remote], totalCount: 1, truncated: false },
              _meta: { runtimeId: 'runtime-remote' }
            }
      )
    )

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([remote])
    expect(store.getState().detectedWorktreesByRepo.repo1).toMatchObject({
      repoId: 'repo1',
      authoritative: true,
      source: 'session-fallback',
      worktrees: [{ id: remote.id, ownership: 'orca-managed', visible: true }]
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'worktree.detectedList',
      params: { repo: 'repo1' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'worktree.list',
      params: { repo: 'repo1', limit: 10_000 },
      timeoutMs: 15_000
    })
  })

  it('updates remote worktree records when only lineage changes', async () => {
    const store = createTestStore()
    const initial = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote'
    })
    const lineage = makeLineage({ worktreeId: initial.id })
    const refreshed = { ...initial, lineage }
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [initial] },
      sortEpoch: 7
    } as Partial<AppState>)
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      const result =
        method === 'worktree.lineageList'
          ? { lineage: { [lineage.worktreeId]: lineage } }
          : makeDetectedResult('repo1', [refreshed])
      return Promise.resolve({
        id: 'rpc-1',
        ok: true,
        result,
        _meta: { runtimeId: 'runtime-remote' }
      })
    })

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([refreshed])
    expect(store.getState().worktreeLineageById).toEqual({ [lineage.worktreeId]: lineage })
    expect(store.getState().sortEpoch).toBe(8)
  })

  it('updates worktree records when only GitLab link metadata changes', async () => {
    const store = createTestStore()
    const initial = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature'
    })
    const refreshed = { ...initial, linkedGitLabIssue: 321 }
    mockApi.worktrees.list.mockResolvedValue([refreshed])
    store.setState({
      worktreesByRepo: { repo1: [initial] },
      sortEpoch: 7
    } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([refreshed])
    expect(store.getState().sortEpoch).toBe(8)
  })

  it('refreshes remote lineage when the worktree payload is otherwise unchanged', async () => {
    const store = createTestStore()
    const worktree = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote'
    })
    const staleLineage = makeLineage({
      worktreeId: worktree.id,
      parentWorktreeId: 'repo1::/remote/old-parent'
    })
    const freshLineage = makeLineage({
      worktreeId: worktree.id,
      parentWorktreeId: 'repo1::/remote/new-parent'
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [worktree] },
      worktreeLineageById: { [worktree.id]: staleLineage },
      sortEpoch: 7
    } as Partial<AppState>)
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      const result =
        method === 'worktree.lineageList'
          ? { lineage: { [freshLineage.worktreeId]: freshLineage } }
          : makeDetectedResult('repo1', [worktree])
      return Promise.resolve({
        id: 'rpc-1',
        ok: true,
        result,
        _meta: { runtimeId: 'runtime-remote' }
      })
    })

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([worktree])
    expect(store.getState().worktreeLineageById).toEqual({
      [freshLineage.worktreeId]: freshLineage
    })
    expect(store.getState().sortEpoch).toBe(7)
  })

  it('keeps a successful remote worktree refresh when lineage refresh fails', async () => {
    const store = createTestStore()
    const refreshed = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      branch: 'refs/heads/remote'
    })
    const staleLineage = makeLineage({ worktreeId: refreshed.id })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: {},
      worktreeLineageById: { [staleLineage.worktreeId]: staleLineage },
      sortEpoch: 7
    } as Partial<AppState>)
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      if (method === 'worktree.lineageList') {
        return Promise.reject(new Error('lineage timeout'))
      }
      return Promise.resolve({
        id: 'rpc-1',
        ok: true,
        result: makeDetectedResult('repo1', [refreshed]),
        _meta: { runtimeId: 'runtime-remote' }
      })
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([refreshed])
    expect(store.getState().worktreeLineageById).toEqual({
      [staleLineage.worktreeId]: staleLineage
    })
    expect(store.getState().sortEpoch).toBe(8)
  })
})

describe('worktree lineage state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('fetches persisted lineage into the renderer store', async () => {
    const store = createTestStore()
    const lineage = makeLineage()
    mockApi.worktrees.listLineage.mockResolvedValue({ [lineage.worktreeId]: lineage })

    await store.getState().fetchWorktreeLineage()

    expect(mockApi.worktrees.listLineage).toHaveBeenCalled()
    expect(store.getState().worktreeLineageById).toEqual({ [lineage.worktreeId]: lineage })
  })

  it('updates a child lineage entry and bumps sortEpoch', async () => {
    const store = createTestStore()
    const lineage = makeLineage()
    mockApi.worktrees.updateLineage.mockResolvedValue(lineage)
    store.setState({ sortEpoch: 3 } as Partial<AppState>)

    await store.getState().updateWorktreeLineage(lineage.worktreeId, {
      parentWorktreeId: lineage.parentWorktreeId
    })

    expect(mockApi.worktrees.updateLineage).toHaveBeenCalledWith({
      worktreeId: lineage.worktreeId,
      parentWorktreeId: lineage.parentWorktreeId
    })
    expect(store.getState().worktreeLineageById).toEqual({ [lineage.worktreeId]: lineage })
    expect(store.getState().sortEpoch).toBe(4)
  })

  it('removes a child lineage entry when the backend clears the parent link', async () => {
    const store = createTestStore()
    const lineage = makeLineage()
    mockApi.worktrees.updateLineage.mockResolvedValue(null)
    store.setState({
      worktreeLineageById: { [lineage.worktreeId]: lineage },
      sortEpoch: 3
    } as Partial<AppState>)

    await store.getState().updateWorktreeLineage(lineage.worktreeId, { noParent: true })

    expect(store.getState().worktreeLineageById).toEqual({})
    expect(store.getState().sortEpoch).toBe(4)
  })

  it('refetches lineage after an update failure', async () => {
    const store = createTestStore()
    const lineage = makeLineage()
    mockApi.worktrees.updateLineage.mockRejectedValueOnce(new Error('stale parent'))
    mockApi.worktrees.listLineage.mockResolvedValue({ [lineage.worktreeId]: lineage })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await store.getState().updateWorktreeLineage(lineage.worktreeId, {
      parentWorktreeId: lineage.parentWorktreeId
    })

    expect(mockApi.worktrees.listLineage).toHaveBeenCalled()
    expect(store.getState().worktreeLineageById).toEqual({ [lineage.worktreeId]: lineage })
  })

  it('fetches raw lineage from the active remote runtime environment', async () => {
    const store = createTestStore()
    const lineage = makeLineage()
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-lineage-list',
      ok: true,
      result: { lineage: { [lineage.worktreeId]: lineage } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: {}
    } as Partial<AppState>)

    await store.getState().fetchWorktreeLineage()

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'worktree.lineageList',
      params: undefined,
      timeoutMs: 15_000
    })
    expect(mockApi.worktrees.listLineage).not.toHaveBeenCalled()
    expect(store.getState().worktreeLineageById).toEqual({ [lineage.worktreeId]: lineage })
  })

  it('updates lineage through the active remote runtime environment', async () => {
    const store = createTestStore()
    const lineage = makeLineage()
    const child = makeWorktree({
      id: lineage.worktreeId,
      repoId: 'repo1',
      path: '/remote/child'
    })
    const updatedChild = { ...child, lineage }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-set-lineage',
      ok: true,
      result: { worktree: updatedChild },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [child] },
      sortEpoch: 3
    } as Partial<AppState>)

    await store.getState().updateWorktreeLineage(lineage.worktreeId, {
      parentWorktreeId: lineage.parentWorktreeId
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'worktree.set',
      params: {
        worktree: `id:${lineage.worktreeId}`,
        parentWorktree: `id:${lineage.parentWorktreeId}`
      },
      timeoutMs: 15_000
    })
    expect(mockApi.worktrees.updateLineage).not.toHaveBeenCalled()
    expect(store.getState().worktreeLineageById).toEqual({ [lineage.worktreeId]: lineage })
    expect(store.getState().worktreesByRepo.repo1?.[0]).toEqual(updatedChild)
    expect(store.getState().sortEpoch).toBe(4)
  })

  it('clears lineage through the active remote runtime environment', async () => {
    const store = createTestStore()
    const lineage = makeLineage()
    const child = makeWorktree({
      id: lineage.worktreeId,
      repoId: 'repo1',
      path: '/remote/child',
      lineage
    } as Partial<Worktree> & { id: string; repoId: string })
    const updatedChild = { ...child, lineage: null }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-clear-lineage',
      ok: true,
      result: { worktree: updatedChild },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [child] },
      worktreeLineageById: { [lineage.worktreeId]: lineage },
      sortEpoch: 3
    } as Partial<AppState>)

    await store.getState().updateWorktreeLineage(lineage.worktreeId, { noParent: true })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'worktree.set',
      params: { worktree: `id:${lineage.worktreeId}`, noParent: true },
      timeoutMs: 15_000
    })
    expect(store.getState().worktreeLineageById).toEqual({})
    expect(store.getState().worktreesByRepo.repo1?.[0]).toEqual(updatedChild)
  })
})

describe('updateWorktreeGitIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('updates branch identity from git status without fetching worktrees', () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      head: 'old-head',
      branch: 'refs/heads/main'
    })

    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 3 } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      head: 'new-head',
      branch: 'refs/heads/feature'
    })

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      head: 'new-head',
      branch: 'refs/heads/feature'
    })
    expect(store.getState().sortEpoch).toBe(4)
    expect(mockApi.worktrees.list).not.toHaveBeenCalled()
    expect(mockApi.worktrees.listDetected).not.toHaveBeenCalled()
  })

  it('follows the new branch in the title when displayName was auto-derived from the branch', () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature',
      displayName: 'feature'
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      branch: 'refs/heads/main'
    })

    expect(store.getState().worktreesByRepo.repo1[0].displayName).toBe('main')
  })

  it('preserves a custom title when displayName differs from the branch', () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature',
      displayName: 'My Cool Work'
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      branch: 'refs/heads/main'
    })

    expect(store.getState().worktreesByRepo.repo1[0].displayName).toBe('My Cool Work')
  })

  it('clears stale branch identity for detached HEAD updates', () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      head: 'old-head',
      branch: 'refs/heads/review-branch',
      displayName: 'Restore PR review'
    })

    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 3 } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      head: 'new-head',
      branch: null
    })

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      head: 'new-head',
      branch: '',
      displayName: 'Restore PR review'
    })
    expect(store.getState().sortEpoch).toBe(4)
  })

  it('keeps an auto-derived title when detached HEAD clears the branch', () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      head: 'old-head',
      branch: 'refs/heads/review-branch',
      displayName: 'review-branch'
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      head: 'new-head',
      branch: null
    })

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: '',
      displayName: 'review-branch'
    })
  })

  it('resumes following branch names after an auto-derived title crosses detached HEAD', () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      head: 'old-head',
      branch: 'refs/heads/review-branch',
      displayName: 'review-branch'
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      head: 'detached-head',
      branch: null
    })
    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      head: 'reattached-head',
      branch: 'refs/heads/main'
    })

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: 'refs/heads/main',
      displayName: 'main'
    })
  })

  it('preserves custom detached titles when a branch returns', () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      head: 'detached-head',
      branch: '',
      displayName: 'Restore PR review'
    })

    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      head: 'reattached-head',
      branch: 'refs/heads/main'
    })

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: 'refs/heads/main',
      displayName: 'Restore PR review'
    })
  })
})

describe('createWorktree base status merge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('prefetches create base through desktop IPC on the local runtime target', async () => {
    const store = createTestStore()

    await store.getState().prefetchWorktreeCreateBase('repo1', 'origin/main')

    expect(mockApi.worktrees.prefetchCreateBase).toHaveBeenCalledWith({
      repoId: 'repo1',
      baseBranch: 'origin/main'
    })
    expect(runtimeEnvironmentTransportCall).not.toHaveBeenCalled()
  })

  it('prefetches create base through runtime RPC for remote runtime targets', async () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'remote-runtime' }
    } as Partial<AppState>)
    runtimeEnvironmentCall.mockResolvedValue({ id: 'req', ok: true, result: null })

    await store.getState().prefetchWorktreeCreateBase('repo1')

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'remote-runtime',
      method: 'worktree.prefetchCreateBase',
      params: { repo: 'repo1' },
      timeoutMs: 30_000
    })
    expect(mockApi.worktrees.prefetchCreateBase).not.toHaveBeenCalled()
  })

  it('passes linked work item and creation agent metadata through the create IPC payload', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      linkedIssue: 123,
      linkedPR: 456,
      createdWithAgent: 'codex',
      linkedLinearIssue: 'ENG-123',
      workspaceStatus: 'in-review',
      pendingFirstAgentMessageRename: true
    })
    mockApi.worktrees.create.mockResolvedValue({ worktree: wt })

    await store
      .getState()
      .createWorktree(
        'repo1',
        'feature',
        'origin/main',
        'inherit',
        undefined,
        'sidebar',
        'Feature Title',
        123,
        456,
        undefined,
        'codex',
        'ENG-123',
        undefined,
        'in-review',
        undefined,
        undefined,
        undefined,
        true
      )

    expect(mockApi.worktrees.create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'repo1',
        name: 'feature',
        linkedIssue: 123,
        linkedPR: 456,
        createdWithAgent: 'codex',
        linkedLinearIssue: 'ENG-123',
        workspaceStatus: 'in-review',
        pendingFirstAgentMessageRename: true
      })
    )
    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      linkedIssue: 123,
      linkedPR: 456,
      createdWithAgent: 'codex',
      linkedLinearIssue: 'ENG-123',
      workspaceStatus: 'in-review',
      pendingFirstAgentMessageRename: true
    })
  })

  it.each([
    {
      status: 'skipped_dirty_worktree',
      expectedReason: 'uncommitted changes'
    },
    {
      status: 'skipped_not_fast_forward',
      expectedReason: 'cannot be fast-forwarded cleanly'
    },
    {
      status: 'skipped_error',
      expectedReason: 'Git returned an error'
    }
  ] satisfies {
    status: LocalBaseRefRefreshResult['status']
    expectedReason: string
  }[])('warns when local base ref refresh returns $status', async ({ status, expectedReason }) => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1'
    })
    mockApi.worktrees.create.mockResolvedValue({
      worktree: wt,
      localBaseRefRefresh: {
        status,
        baseRef: 'origin/main',
        localBranch: 'main',
        ownerWorktreePath: '/repo'
      }
    })

    await store.getState().createWorktree('repo1', 'feature', 'origin/main')

    expect(toast.warning).toHaveBeenCalledWith('Local main was not refreshed', {
      description: expect.stringContaining(expectedReason)
    })
    const description = vi.mocked(toast.warning).mock.calls.at(-1)?.[1]?.description
    expect(description).not.toContain('AI tools')
    expect(description).not.toContain('git diff')
  })

  it('does not warn when the local base ref refresh succeeds', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1'
    })
    mockApi.worktrees.create.mockResolvedValue({
      worktree: wt,
      localBaseRefRefresh: {
        status: 'updated',
        baseRef: 'origin/main',
        localBranch: 'main'
      }
    })

    await store.getState().createWorktree('repo1', 'feature', 'origin/main')

    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('stamps manualOrder on create while Manual sort is active', async () => {
    const store = createTestStore()
    store.setState({ sortBy: 'manual' } as Partial<AppState>)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123_456)
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      manualOrder: 123_456
    })
    mockApi.worktrees.create.mockResolvedValue({ worktree: wt })

    try {
      await store.getState().createWorktree('repo1', 'feature')
    } finally {
      nowSpy.mockRestore()
    }

    expect(mockApi.worktrees.create).toHaveBeenCalledWith(
      expect.objectContaining({
        manualOrder: 123_456
      })
    )
    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      manualOrder: 123_456
    })
  })

  it('passes branchNameOverride through the local create IPC payload', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/feature-something',
      repoId: 'repo1',
      path: '/path/feature-something',
      branch: 'feature/something'
    })
    mockApi.worktrees.create.mockResolvedValue({ worktree: wt })

    await store
      .getState()
      .createWorktree(
        'repo1',
        'feature/something',
        'origin/main',
        'inherit',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'feature/something'
      )

    expect(mockApi.worktrees.create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'repo1',
        name: 'feature/something',
        baseBranch: 'origin/main',
        branchNameOverride: 'feature/something'
      })
    )
  })

  it('does not suffix branchNameOverride when local IPC reports a branch conflict', async () => {
    const store = createTestStore()
    const error = new Error(
      'Branch "feature/something" already exists. Pick a different worktree name.'
    )
    mockApi.worktrees.create.mockRejectedValueOnce(error)

    await expect(
      store
        .getState()
        .createWorktree(
          'repo1',
          'feature/something',
          'origin/main',
          'inherit',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          'feature/something'
        )
    ).rejects.toThrow(error.message)

    expect(mockApi.worktrees.create).toHaveBeenCalledTimes(1)
    expect(mockApi.worktrees.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'feature/something',
        branchNameOverride: 'feature/something'
      })
    )
  })

  it('does not overwrite a newer reconcile status with the initial checking status', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    mockApi.worktrees.create.mockImplementation(async () => {
      store.getState().updateWorktreeBaseStatus({
        repoId: 'repo1',
        worktreeId: wt.id,
        status: 'drift',
        base: 'origin/main',
        remote: 'origin',
        behind: 2,
        recentSubjects: ['new base commit']
      })
      return {
        worktree: wt,
        initialBaseStatus: {
          repoId: 'repo1',
          worktreeId: wt.id,
          status: 'checking',
          base: 'origin/main',
          remote: 'origin'
        }
      }
    })

    await store.getState().createWorktree('repo1', 'feature')

    expect(store.getState().baseStatusByWorktreeId[wt.id]).toMatchObject({
      status: 'drift',
      behind: 2
    })
  })
})

describe('removeWorktree state cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('cleans up editorDrafts for files in the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      openFiles: [
        {
          id: 'file-1',
          worktreeId: 'repo1::/path/wt1',
          filePath: '/path/wt1/file.ts',
          relativePath: 'file.ts',
          language: 'typescript',
          isDirty: true,
          isPreview: false,
          mode: 'edit' as const
        }
      ],
      editorDrafts: {
        'file-1': 'draft content for wt1',
        'file-2': 'draft content for another worktree'
      }
    } as unknown as Partial<AppState>)

    const result = await store.getState().removeWorktree('repo1::/path/wt1')

    expect(result).toEqual({ ok: true })
    // Draft for file-1 should be removed, draft for file-2 should remain
    expect(store.getState().editorDrafts).toEqual({
      'file-2': 'draft content for another worktree'
    })
  })

  it('cleans up the removed worktree lineage entry', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    const childLineage = makeLineage({ worktreeId: wt.id })
    const siblingLineage = makeLineage({
      worktreeId: 'repo1::/path/wt2',
      worktreeInstanceId: 'sibling-instance'
    })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      worktreeLineageById: {
        [wt.id]: childLineage,
        'repo1::/path/wt2': siblingLineage
      }
    } as Partial<AppState>)

    await store.getState().removeWorktree(wt.id)

    expect(store.getState().worktreeLineageById).toEqual({
      'repo1::/path/wt2': siblingLineage
    })
  })

  it('cleans up markdownViewMode for files in the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      openFiles: [
        {
          id: 'file-1',
          worktreeId: 'repo1::/path/wt1',
          filePath: '/path/wt1/readme.md',
          relativePath: 'readme.md',
          language: 'markdown',
          isDirty: false,
          isPreview: false,
          mode: 'edit' as const
        }
      ],
      markdownViewMode: {
        'file-1': 'rich' as const,
        'file-2': 'source' as const
      }
    } as unknown as Partial<AppState>)

    await store.getState().removeWorktree('repo1::/path/wt1')

    expect(store.getState().markdownViewMode).toEqual({ 'file-2': 'source' })
  })

  it('cleans up editorViewMode for files in the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      openFiles: [
        {
          id: 'file-1',
          worktreeId: 'repo1::/path/wt1',
          filePath: '/path/wt1/app.ts',
          relativePath: 'app.ts',
          language: 'typescript',
          isDirty: false,
          isPreview: false,
          mode: 'edit' as const
        }
      ],
      editorViewMode: {
        'file-1': 'changes' as const,
        'file-2': 'changes' as const
      }
    } as unknown as Partial<AppState>)

    await store.getState().removeWorktree('repo1::/path/wt1')

    expect(store.getState().editorViewMode).toEqual({ 'file-2': 'changes' })
  })

  it('records the sidebar scroll anchor in the same tick it removes the worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    store.setState({ worktreesByRepo: { repo1: [wt] } } as Partial<AppState>)

    const sidebar = new EventTarget()
    let worktreePresentWhenRecorded: boolean | null = null
    sidebar.addEventListener('orca-record-virtualized-scroll-anchor', () => {
      worktreePresentWhenRecorded =
        store.getState().worktreesByRepo.repo1?.some((w) => w.id === wt.id) ?? false
    })
    const globalWithDocument = globalThis as { document?: unknown }
    const originalDocument = globalWithDocument.document
    globalWithDocument.document = {
      querySelector: (selector: string) => (selector === '[data-worktree-sidebar]' ? sidebar : null)
    }

    try {
      await store.getState().removeWorktree(wt.id)
    } finally {
      globalWithDocument.document = originalDocument
    }

    // The anchor must be captured while the row still exists so the post-delete
    // restore pins the pre-removal position instead of the already-shifted list.
    expect(worktreePresentWhenRecorded).toBe(true)
    expect(store.getState().worktreesByRepo.repo1).toEqual([])
  })

  it('cleans up expandedDirs for the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      expandedDirs: {
        'repo1::/path/wt1': new Set(['src', 'src/lib']),
        'repo1::/path/wt2': new Set(['test'])
      }
    } as Partial<AppState>)

    await store.getState().removeWorktree('repo1::/path/wt1')

    expect(store.getState().expandedDirs).toEqual({
      'repo1::/path/wt2': new Set(['test'])
    })
  })

  it('cleans up dotfile visibility for the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      showDotfilesByWorktree: {
        'repo1::/path/wt1': false,
        'repo1::/path/wt2': false
      }
    } as Partial<AppState>)

    await store.getState().removeWorktree('repo1::/path/wt1')

    expect(store.getState().showDotfilesByWorktree).toEqual({
      'repo1::/path/wt2': false
    })
  })

  it('cleans up activeTabIdByWorktree for the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      activeTabIdByWorktree: {
        'repo1::/path/wt1': 'tab-1',
        'repo1::/path/wt2': 'tab-2'
      }
    } as Partial<AppState>)

    await store.getState().removeWorktree('repo1::/path/wt1')

    expect(store.getState().activeTabIdByWorktree).toEqual({
      'repo1::/path/wt2': 'tab-2'
    })
  })

  it('cleans up tabBarOrderByWorktree for the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      tabBarOrderByWorktree: {
        'repo1::/path/wt1': ['tab-1', 'file-1', 'browser-1'],
        'repo1::/path/wt2': ['tab-2']
      }
    } as Partial<AppState>)

    await store.getState().removeWorktree('repo1::/path/wt1')

    expect(store.getState().tabBarOrderByWorktree).toEqual({
      'repo1::/path/wt2': ['tab-2']
    })
  })

  it('cleans up split-tab model state for the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      pendingReconnectTabByWorktree: {
        'repo1::/path/wt1': ['tab-1'],
        'repo1::/path/wt2': ['tab-2']
      },
      unifiedTabsByWorktree: {
        'repo1::/path/wt1': [{ id: 'tab-1', worktreeId: 'repo1::/path/wt1' }],
        'repo1::/path/wt2': [{ id: 'tab-2', worktreeId: 'repo1::/path/wt2' }]
      },
      groupsByWorktree: {
        'repo1::/path/wt1': [
          { id: 'group-1', worktreeId: 'repo1::/path/wt1', activeTabId: 'tab-1' }
        ],
        'repo1::/path/wt2': [
          { id: 'group-2', worktreeId: 'repo1::/path/wt2', activeTabId: 'tab-2' }
        ]
      },
      activeGroupIdByWorktree: {
        'repo1::/path/wt1': 'group-1',
        'repo1::/path/wt2': 'group-2'
      },
      layoutByWorktree: {
        'repo1::/path/wt1': { type: 'leaf', groupId: 'group-1' },
        'repo1::/path/wt2': { type: 'leaf', groupId: 'group-2' }
      }
    } as unknown as Partial<AppState>)

    await store.getState().removeWorktree('repo1::/path/wt1')

    expect(store.getState().pendingReconnectTabByWorktree).toEqual({
      'repo1::/path/wt2': ['tab-2']
    })
    expect(store.getState().unifiedTabsByWorktree).toEqual({
      'repo1::/path/wt2': [{ id: 'tab-2', worktreeId: 'repo1::/path/wt2' }]
    })
    expect(store.getState().groupsByWorktree).toEqual({
      'repo1::/path/wt2': [{ id: 'group-2', worktreeId: 'repo1::/path/wt2', activeTabId: 'tab-2' }]
    })
    expect(store.getState().activeGroupIdByWorktree).toEqual({
      'repo1::/path/wt2': 'group-2'
    })
    expect(store.getState().layoutByWorktree).toEqual({
      'repo1::/path/wt2': { type: 'leaf', groupId: 'group-2' }
    })
  })

  it('cleans up git caches for the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      gitStatusByWorktree: {
        'repo1::/path/wt1': [{ path: 'a.ts' }],
        'repo1::/path/wt2': [{ path: 'b.ts' }]
      },
      gitIgnoredPathsByWorktree: {
        'repo1::/path/wt1': ['dist/'],
        'repo1::/path/wt2': ['coverage/']
      },
      gitConflictOperationByWorktree: {
        'repo1::/path/wt1': 'merge',
        'repo1::/path/wt2': 'unknown'
      },
      trackedConflictPathsByWorktree: {
        'repo1::/path/wt1': { 'a.ts': 'both_modified' },
        'repo1::/path/wt2': { 'b.ts': 'both_modified' }
      },
      gitBranchChangesByWorktree: {
        'repo1::/path/wt1': [{ path: 'a.ts' }],
        'repo1::/path/wt2': [{ path: 'b.ts' }]
      },
      gitBranchCompareSummaryByWorktree: {
        'repo1::/path/wt1': { status: 'ready' },
        'repo1::/path/wt2': { status: 'loading' }
      },
      gitBranchCompareRequestKeyByWorktree: {
        'repo1::/path/wt1': 'req-1',
        'repo1::/path/wt2': 'req-2'
      }
    } as unknown as Partial<AppState>)

    await store.getState().removeWorktree('repo1::/path/wt1')

    expect(store.getState().gitStatusByWorktree).toEqual({
      'repo1::/path/wt2': [{ path: 'b.ts' }]
    })
    expect(store.getState().gitIgnoredPathsByWorktree).toEqual({
      'repo1::/path/wt2': ['coverage/']
    })
    expect(store.getState().gitConflictOperationByWorktree).toEqual({
      'repo1::/path/wt2': 'unknown'
    })
    expect(store.getState().trackedConflictPathsByWorktree).toEqual({
      'repo1::/path/wt2': { 'b.ts': 'both_modified' }
    })
    expect(store.getState().gitBranchChangesByWorktree).toEqual({
      'repo1::/path/wt2': [{ path: 'b.ts' }]
    })
    expect(store.getState().gitBranchCompareSummaryByWorktree).toEqual({
      'repo1::/path/wt2': { status: 'loading' }
    })
    expect(store.getState().gitBranchCompareRequestKeyByWorktree).toEqual({
      'repo1::/path/wt2': 'req-2'
    })
  })

  it('clears recentlyClosedBrowserTabsByWorktree for the removed worktree', async () => {
    // Why: closeBrowserTab (which shutdownWorktreeBrowsers delegates to) pushes
    // each closed workspace into recentlyClosedBrowserTabsByWorktree for the
    // Cmd+Shift+T undo path. When the owning worktree is deleted those
    // snapshots reference entities that can never be restored — removeWorktree
    // must clear the worktree key symmetrically with browserTabsByWorktree
    // (design §1.1).
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      recentlyClosedBrowserTabsByWorktree: {
        'repo1::/path/wt1': [{ workspace: { id: 'workspace-1' }, pages: [] }],
        'repo1::/path/wt2': [{ workspace: { id: 'workspace-2' }, pages: [] }]
      }
    } as unknown as Partial<AppState>)

    await store.getState().removeWorktree('repo1::/path/wt1')

    expect(store.getState().recentlyClosedBrowserTabsByWorktree).toEqual({
      'repo1::/path/wt2': [{ workspace: { id: 'workspace-2' }, pages: [] }]
    })
  })

  it('skips editorDrafts shallow copy when no files belong to the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    const drafts = { 'file-2': 'some content' }
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      openFiles: [],
      editorDrafts: drafts
    } as Partial<AppState>)

    await store.getState().removeWorktree('repo1::/path/wt1')

    // The same reference should be returned (no unnecessary shallow copy)
    expect(store.getState().editorDrafts).toBe(drafts)
  })
})

describe('worktree remote runtime mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('creates worktrees through the active remote runtime environment', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/feature',
      repoId: 'repo1',
      path: '/path/feature'
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-create',
      ok: true,
      result: { worktree: wt },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [] }
    } as Partial<AppState>)

    const result = await store
      .getState()
      .createWorktree(
        'repo1',
        'feature',
        'origin/main',
        'skip',
        { directories: ['src'], presetId: 'preset-1' },
        'sidebar',
        'Feature title',
        123,
        456,
        { remoteName: 'fork', branchName: 'feature' }
      )

    expect(result).toEqual({ worktree: wt })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'worktree.create',
      params: {
        repo: 'repo1',
        name: 'feature',
        baseBranch: 'origin/main',
        setupDecision: 'skip',
        sparseCheckout: { directories: ['src'], presetId: 'preset-1' },
        telemetrySource: 'sidebar',
        displayName: 'Feature title',
        linkedIssue: 123,
        linkedPR: 456,
        pushTarget: { remoteName: 'fork', branchName: 'feature' }
      },
      timeoutMs: 10 * 60_000
    })
    expect(mockApi.worktrees.create).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo.repo1).toEqual([wt])
  })

  it('passes startup commands through remote runtime worktree creation', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/agent-startup',
      repoId: 'repo1',
      path: '/path/agent-startup'
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-create',
      ok: true,
      result: { worktree: wt },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [] }
    } as Partial<AppState>)

    await store
      .getState()
      .createWorktree(
        'repo1',
        'agent-startup',
        undefined,
        'skip',
        undefined,
        'sidebar',
        'Launch agent',
        undefined,
        undefined,
        undefined,
        'codex',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          command: "codex 'summarize repo'",
          env: { ORCA_AGENT_MODE: 'direct' }
        }
      )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'worktree.create',
        params: expect.objectContaining({
          repo: 'repo1',
          name: 'agent-startup',
          setupDecision: 'skip',
          telemetrySource: 'sidebar',
          displayName: 'Launch agent',
          createdWithAgent: 'codex',
          startupCommand: "codex 'summarize repo'",
          startupEnv: { ORCA_AGENT_MODE: 'direct' },
          activate: true
        })
      })
    )
  })

  it('does not suffix branchNameOverride when runtime create reports a branch conflict', async () => {
    const store = createTestStore()
    runtimeEnvironmentCall.mockRejectedValueOnce(new Error('Branch already exists on a remote'))
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [] }
    } as Partial<AppState>)

    await expect(
      store
        .getState()
        .createWorktree(
          'repo1',
          'feature/something',
          'origin/main',
          'skip',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          'feature/something'
        )
    ).rejects.toThrow('Branch already exists on a remote')

    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          name: 'feature/something',
          branchNameOverride: 'feature/something'
        })
      })
    )
  })

  it('removes worktrees through the active remote runtime environment', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-rm',
      ok: true,
      result: { removed: true },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    const result = await store.getState().removeWorktree(wt.id)

    expect(result).toEqual({ ok: true })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'worktree.rm',
      params: { worktree: wt.id, force: undefined, runHooks: true },
      timeoutMs: 60_000
    })
    expect(mockApi.worktrees.remove).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo.repo1).toEqual([])
  })

  it('persists worktree metadata through the active remote runtime environment', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-set',
      ok: true,
      result: { worktree: { ...wt, comment: 'remote note' } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    await store.getState().updateWorktreeMeta(wt.id, { comment: 'remote note' })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'worktree.set',
      params: expect.objectContaining({ worktree: `id:${wt.id}`, comment: 'remote note' }),
      timeoutMs: 15_000
    })
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo.repo1[0]?.comment).toBe('remote note')
  })

  it('clears pending first-agent rename when the title is updated', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      displayName: 'Nautilus',
      pendingFirstAgentMessageRename: true
    })
    store.setState({
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    await store.getState().updateWorktreeMeta(wt.id, { displayName: 'Fix auth' })

    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      updates: { displayName: 'Fix auth', pendingFirstAgentMessageRename: false }
    })
    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      displayName: 'Fix auth',
      pendingFirstAgentMessageRename: false
    })
  })

  it('resolves and persists a push target when manually linking a GitHub PR', async () => {
    const store = createTestStore()
    const pushTarget = { remoteName: 'origin', branchName: 'bot/pr-bug-scan-2504' }
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    mockApi.worktrees.resolvePrBase.mockResolvedValueOnce({
      baseBranch: 'origin/bot/pr-bug-scan-2504',
      pushTarget
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    await store.getState().updateWorktreeMeta(wt.id, { linkedPR: 2548 })

    expect(mockApi.worktrees.resolvePrBase).toHaveBeenCalledWith({
      repoId: 'repo1',
      prNumber: 2548
    })
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      updates: { linkedPR: 2548, pushTarget }
    })
    expect(store.getState().worktreesByRepo.repo1[0]?.pushTarget).toEqual(pushTarget)
  })

  it('does not resolve a push target when re-saving the same linked GitHub PR', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      linkedPR: 2548
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    await store.getState().updateWorktreeMeta(wt.id, { linkedPR: 2548 })

    expect(mockApi.worktrees.resolvePrBase).not.toHaveBeenCalled()
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      updates: { linkedPR: 2548 }
    })
  })

  it('waits for branch confirmation before linking a terminal PR URL for a known push target', async () => {
    const store = createTestStore()
    const fetchPRForBranch = vi.fn().mockResolvedValue({ number: 42 })
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/worktrees/orca',
      branch: 'refs/heads/feature/pr-link',
      pushTarget: {
        remoteName: 'origin',
        branchName: 'feature/pr-link',
        remoteUrl: 'https://github.com/acme/orca.git'
      }
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repos/orca', displayName: 'orca', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] },
      fetchPRForBranch
    } as unknown as Partial<AppState>)

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/42',
      slug: { owner: 'acme', repo: 'orca' },
      number: 42
    })

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBeNull()
    expect(mockApi.worktrees.resolvePrBase).not.toHaveBeenCalled()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
    expect(fetchPRForBranch).toHaveBeenCalledWith('/repos/orca', 'feature/pr-link', {
      force: true,
      repoId: 'repo1',
      linkedPRNumber: null,
      fallbackPRNumber: null,
      fallbackPRSource: 'explicit'
    })
    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
    }

    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      updates: { linkedPR: 42 }
    })
  })

  it('waits for branch confirmation before linking a same-repo terminal PR URL', async () => {
    const store = createTestStore()
    const fetchPRForBranch = vi.fn().mockResolvedValue({ number: 42 })
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/worktrees/orca',
      branch: 'refs/heads/feature/pr-link',
      pushTarget: {
        remoteName: 'origin',
        branchName: 'feature/pr-link'
      }
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repos/orca', displayName: 'orca', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] },
      fetchPRForBranch
    } as unknown as Partial<AppState>)

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/42',
      slug: { owner: 'acme', repo: 'orca' },
      number: 42
    })

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBeNull()
    expect(fetchPRForBranch).toHaveBeenCalledWith('/repos/orca', 'feature/pr-link', {
      force: true,
      repoId: 'repo1',
      linkedPRNumber: null,
      fallbackPRNumber: null,
      fallbackPRSource: 'explicit'
    })
    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
    }

    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      updates: { linkedPR: 42 }
    })
  })

  it('does not persist a terminal PR URL when the linked PR changes before branch confirmation resolves', async () => {
    const store = createTestStore()
    let resolveLookup: (value: { number: number } | null) => void = () => {}
    const fetchPRForBranch = vi.fn(
      () =>
        new Promise<{ number: number } | null>((resolve) => {
          resolveLookup = resolve
        })
    )
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/worktrees/orca',
      branch: 'refs/heads/feature/pr-link',
      pushTarget: {
        remoteName: 'origin',
        branchName: 'feature/pr-link'
      }
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repos/orca', displayName: 'orca', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] },
      fetchPRForBranch
    } as unknown as Partial<AppState>)

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/42',
      slug: { owner: 'acme', repo: 'orca' },
      number: 42
    })
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()

    store.setState({
      worktreesByRepo: { repo1: [{ ...wt, linkedPR: 7 }] }
    } as Partial<AppState>)

    resolveLookup({ number: 42 })
    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
    }

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBe(7)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('does not persist a terminal PR URL when the linked PR changes while push target lookup resolves', async () => {
    const store = createTestStore()
    const fetchPRForBranch = vi.fn().mockResolvedValue({ number: 42 })
    let resolvePushTarget: (value: {
      baseBranch: string
      pushTarget: { remoteName: string; branchName: string }
    }) => void = () => {}
    mockApi.worktrees.resolvePrBase.mockImplementationOnce(
      () =>
        new Promise<{
          baseBranch: string
          pushTarget: { remoteName: string; branchName: string }
        }>((resolve) => {
          resolvePushTarget = resolve
        })
    )
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/worktrees/orca',
      branch: 'refs/heads/feature/pr-link'
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repos/orca', displayName: 'orca', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] },
      fetchPRForBranch
    } as unknown as Partial<AppState>)

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/42',
      slug: { owner: 'acme', repo: 'orca' },
      number: 42
    })

    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
    }

    expect(mockApi.worktrees.resolvePrBase).toHaveBeenCalledWith({
      repoId: 'repo1',
      prNumber: 42
    })

    store.setState({
      worktreesByRepo: { repo1: [{ ...wt, linkedPR: 7 }] }
    } as Partial<AppState>)

    resolvePushTarget({
      baseBranch: 'main',
      pushTarget: { remoteName: 'origin', branchName: 'feature/pr-link' }
    })
    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
    }

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBe(7)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('does not link an arbitrary same-repo terminal PR URL for a known push target when lookup misses', async () => {
    const store = createTestStore()
    const fetchPRForBranch = vi.fn().mockResolvedValue(null)
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/worktrees/orca',
      branch: 'refs/heads/feature/pr-link',
      pushTarget: {
        remoteName: 'origin',
        branchName: 'feature/pr-link',
        remoteUrl: 'https://github.com/acme/orca.git'
      }
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repos/orca', displayName: 'orca', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] },
      fetchPRForBranch
    } as unknown as Partial<AppState>)

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/orca/pull/1',
      slug: { owner: 'acme', repo: 'orca' },
      number: 1
    })

    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
    }

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBeNull()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalledWith({
      worktreeId: wt.id,
      updates: { linkedPR: 1 }
    })
  })

  it('uses branch confirmation before linking a differently named terminal PR URL', async () => {
    const store = createTestStore()
    const fetchPRForBranch = vi.fn().mockResolvedValue({ number: 42 })
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/worktrees/orca',
      branch: 'refs/heads/feature/pr-link'
    })
    mockApi.worktrees.resolvePrBase.mockResolvedValueOnce({ baseBranch: 'main' })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repos/orca', displayName: 'orca', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] },
      fetchPRForBranch
    } as unknown as Partial<AppState>)

    store.getState().observeTerminalGitHubPullRequestLink(wt.id, {
      url: 'https://github.com/acme/docs/pull/42',
      slug: { owner: 'acme', repo: 'docs' },
      number: 42
    })

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBeNull()
    expect(fetchPRForBranch).toHaveBeenCalledWith('/repos/orca', 'feature/pr-link', {
      force: true,
      repoId: 'repo1',
      linkedPRNumber: null,
      fallbackPRNumber: null,
      fallbackPRSource: 'explicit'
    })

    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
    }

    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      updates: { linkedPR: 42 }
    })
  })

  it('does not surface remote selector misses while persisting activity timestamps', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-set',
      ok: false,
      error: { code: 'selector_not_found', message: 'selector_not_found' },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    try {
      store.getState().bumpWorktreeActivity(wt.id)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'worktree.set',
        params: expect.objectContaining({
          worktree: `id:${wt.id}`,
          lastActivityAt: expect.any(Number)
        }),
        timeoutMs: 15_000
      })
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('does not persist activity for a missing worktree', async () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [] }
    } as Partial<AppState>)

    store.getState().bumpWorktreeActivity('repo1::/missing')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('persists activity for hidden detected worktrees', async () => {
    const store = createTestStore()
    const hidden = makeWorktree({
      id: 'repo1::/path/hidden',
      repoId: 'repo1',
      path: '/path/hidden'
    })
    const detected = makeDetectedResult('repo1', [hidden])
    detected.worktrees[0] = { ...detected.worktrees[0], ownership: 'external', visible: false }
    store.setState({
      worktreesByRepo: { repo1: [] },
      detectedWorktreesByRepo: { repo1: detected }
    } as Partial<AppState>)

    store.getState().bumpWorktreeActivity(hidden.id)

    expect(
      store.getState().detectedWorktreesByRepo.repo1.worktrees[0].lastActivityAt
    ).toBeGreaterThan(hidden.lastActivityAt)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: hidden.id,
        updates: expect.objectContaining({ lastActivityAt: expect.any(Number) })
      })
    )
  })

  it('clears stale hosted review cache and force-refetches when removing linked PR metadata', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/pr-branch',
      linkedPR: 456
    })
    const fetchHostedReviewForBranch = vi.fn().mockResolvedValue(null)
    const cacheKey = getHostedReviewCacheKey('/repo1', 'pr-branch', undefined, 'repo1')
    const prCacheKey = getGitHubPRCacheKey('/repo1', 'repo1', 'pr-branch')
    const legacyRepoPRCacheKey = getLegacyGitHubPRCacheKey('/repo1', 'repo1', 'pr-branch')
    const legacyPathPRCacheKey = getLegacyGitHubPRCacheKey('/repo1', undefined, 'pr-branch')
    const prData = {
      number: 456,
      title: 'Linked PR',
      state: 'open' as const,
      url: 'https://github.com/acme/repo/pull/456',
      checksStatus: 'success' as const,
      updatedAt: '2026-05-15T00:00:00.000Z',
      mergeable: 'MERGEABLE' as const
    }
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] },
      hostedReviewCache: {
        [cacheKey]: {
          data: {
            provider: 'github',
            number: 456,
            title: 'Linked PR',
            state: 'open',
            url: 'https://github.com/acme/repo/pull/456',
            status: 'success',
            updatedAt: '2026-05-15T00:00:00.000Z',
            mergeable: 'MERGEABLE'
          },
          fetchedAt: Date.now()
        }
      },
      prCache: {
        [prCacheKey]: {
          data: prData,
          fetchedAt: Date.now()
        },
        [legacyRepoPRCacheKey]: {
          data: { ...prData, title: 'Legacy repo-scoped PR' },
          fetchedAt: Date.now()
        },
        [legacyPathPRCacheKey]: {
          data: { ...prData, title: 'Legacy path-scoped PR' },
          fetchedAt: Date.now()
        }
      },
      fetchHostedReviewForBranch
    } as Partial<AppState>)

    await store.getState().updateWorktreeMeta(wt.id, { linkedPR: null })

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBeNull()
    expect(store.getState().hostedReviewCache[cacheKey]).toBeUndefined()
    expect(store.getState().prCache[prCacheKey]).toBeUndefined()
    expect(store.getState().prCache[legacyRepoPRCacheKey]).toBeUndefined()
    expect(store.getState().prCache[legacyPathPRCacheKey]).toBeUndefined()
    expect(fetchHostedReviewForBranch).toHaveBeenCalledWith('/repo1', 'pr-branch', {
      repoId: 'repo1',
      linkedGitHubPR: null,
      linkedGitLabMR: null,
      force: true
    })
  })

  it('preserves linked GitLab MR fallback when removing linked GitHub PR metadata', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/review-branch',
      linkedPR: 456,
      linkedGitLabMR: 789
    })
    const fetchHostedReviewForBranch = vi.fn().mockResolvedValue(null)
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] },
      fetchHostedReviewForBranch
    } as Partial<AppState>)

    await store.getState().updateWorktreeMeta(wt.id, { linkedPR: null })

    expect(fetchHostedReviewForBranch).toHaveBeenCalledWith('/repo1', 'review-branch', {
      repoId: 'repo1',
      linkedGitHubPR: null,
      linkedGitLabMR: 789,
      force: true
    })
  })

  it('applies batch metadata updates in one store transition', async () => {
    const store = createTestStore()
    const first = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    const second = makeWorktree({ id: 'repo1::/path/wt2', repoId: 'repo1', path: '/path/wt2' })
    const subscriber = vi.fn()
    store.setState({
      worktreesByRepo: { repo1: [first, second] },
      sortEpoch: 7
    } as Partial<AppState>)

    const unsubscribe = store.subscribe(subscriber)
    await store.getState().updateWorktreesMeta(
      new Map([
        [first.id, { workspaceStatus: 'in-review' }],
        [second.id, { workspaceStatus: 'completed' }]
      ])
    )
    unsubscribe()

    expect(store.getState().worktreesByRepo.repo1.map((w) => w.workspaceStatus)).toEqual([
      'in-review',
      'completed'
    ])
    expect(store.getState().sortEpoch).toBe(8)
    expect(subscriber).toHaveBeenCalledTimes(1)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledTimes(2)
  })
})

// Why: ghostty "show until interact" model — BEL must raise the sidebar dot
// even on the active worktree, and only clearWorktreeUnread (called from the
// terminal pane on keystroke / pointerdown) dismisses it. Pins both halves
// of that contract.
describe('worktree unread (show-until-interact)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('markWorktreeUnread sets isUnread even when the worktree is active', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      activeWorktreeId: wt.id
    } as Partial<AppState>)

    store.getState().markWorktreeUnread(wt.id)

    const after = store.getState().worktreesByRepo.repo1[0]
    expect(after.isUnread).toBe(true)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: wt.id,
        updates: expect.objectContaining({ isUnread: true })
      })
    )
  })

  it('clearWorktreeUnread clears isUnread and persists the change', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      isUnread: true
    })
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      activeWorktreeId: wt.id
    } as Partial<AppState>)

    store.getState().clearWorktreeUnread(wt.id)

    const after = store.getState().worktreesByRepo.repo1[0]
    expect(after.isUnread).toBe(false)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: wt.id,
        updates: { isUnread: false }
      })
    )
  })

  it('clearWorktreeUnread is a no-op when already cleared', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    const initial = { repo1: [wt] }
    store.setState({ worktreesByRepo: initial } as Partial<AppState>)

    store.getState().clearWorktreeUnread(wt.id)

    expect(store.getState().worktreesByRepo).toBe(initial)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('updates unread state for hidden detected worktrees', () => {
    const store = createTestStore()
    const hidden = makeWorktree({
      id: 'repo1::/path/hidden',
      repoId: 'repo1',
      path: '/path/hidden'
    })
    const detected = makeDetectedResult('repo1', [hidden])
    detected.worktrees[0] = { ...detected.worktrees[0], ownership: 'external', visible: false }
    store.setState({
      worktreesByRepo: { repo1: [] },
      detectedWorktreesByRepo: { repo1: detected }
    } as Partial<AppState>)

    store.getState().markWorktreeUnread(hidden.id)
    expect(store.getState().detectedWorktreesByRepo.repo1.worktrees[0].isUnread).toBe(true)

    store.getState().clearWorktreeUnread(hidden.id)
    expect(store.getState().detectedWorktreesByRepo.repo1.worktrees[0].isUnread).toBe(false)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledTimes(2)
  })

  it('clears unread state when activating a hidden detected worktree', () => {
    const store = createTestStore()
    const hidden = makeWorktree({
      id: 'repo1::/path/hidden',
      repoId: 'repo1',
      path: '/path/hidden',
      isUnread: true
    })
    const detected = makeDetectedResult('repo1', [hidden])
    detected.worktrees[0] = { ...detected.worktrees[0], ownership: 'external', visible: false }
    store.setState({
      worktreesByRepo: { repo1: [] },
      detectedWorktreesByRepo: { repo1: detected }
    } as Partial<AppState>)

    store.getState().setActiveWorktree(hidden.id)

    expect(store.getState().activeWorktreeId).toBe(hidden.id)
    expect(store.getState().detectedWorktreesByRepo.repo1.worktrees[0].isUnread).toBe(false)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: hidden.id,
        updates: { isUnread: false }
      })
    )
  })
})

// Why: design §4.4 — the hydration-time purge must be gated behind a
// per-repo success check (F1 regression) so a transient git error on one
// repo cannot silently wipe every persisted tabsByWorktree entry for that
// repo. An empty-but-successful fetch from a newly-cloned sibling repo is
// also unsafe to treat as authoritative on its own. Pins both halves of
// that contract plus the happy-path purge.
describe('fetchAllWorktrees hydration-time purge (design §4.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  const repoA = {
    id: 'repoA',
    path: '/repos/a',
    displayName: 'a',
    badgeColor: '#000',
    addedAt: 0
  }
  const repoB = {
    id: 'repoB',
    path: '/repos/b',
    displayName: 'b',
    badgeColor: '#111',
    addedAt: 0
  }

  it('defers the purge when a sibling repo fetch fails (F1 regression)', async () => {
    const store = createTestStore()
    const wtA = makeWorktree({ id: 'repoA::/a/wt1', repoId: 'repoA', path: '/a/wt1' })
    const wtB = makeWorktree({ id: 'repoB::/b/wt1', repoId: 'repoB', path: '/b/wt1' })

    // Stub: repoA succeeds; repoB throws. Stale tabsByWorktree entry for
    // repoA::/a/stale must NOT be purged while any repo fetch is degraded.
    mockApi.worktrees.list.mockImplementation(async ({ repoId }: { repoId: string }) => {
      if (repoId === 'repoA') {
        return [wtA]
      }
      throw new Error('git error')
    })

    store.setState({
      repos: [repoA, repoB],
      worktreesByRepo: { repoB: [wtB] },
      tabsByWorktree: {
        'repoA::/a/stale': [{ id: 'tab-A-stale', worktreeId: 'repoA::/a/stale' }],
        'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }]
      }
    } as unknown as Partial<AppState>)

    await store.getState().fetchAllWorktrees()

    expect(store.getState().hasHydratedWorktreePurge).toBe(false)
    expect(store.getState().tabsByWorktree).toEqual({
      'repoA::/a/stale': [{ id: 'tab-A-stale', worktreeId: 'repoA::/a/stale' }],
      'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }]
    })

    // After repoB recovers, the deferred purge fires for genuinely stale ids.
    mockApi.worktrees.list.mockImplementation(async ({ repoId }: { repoId: string }) => {
      if (repoId === 'repoA') {
        return [wtA]
      }
      return [wtB]
    })

    await store.getState().fetchAllWorktrees()

    expect(store.getState().hasHydratedWorktreePurge).toBe(true)
    expect(store.getState().tabsByWorktree).toEqual({
      'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }]
    })
  })

  it('defers the purge when every repo succeeds but none returns worktrees (empty-sibling safety)', async () => {
    const store = createTestStore()

    // Both repos succeed but legitimately return empty (newly-cloned). The
    // union of valid ids would be empty — declaring that authoritative
    // would wipe every persisted tabsByWorktree entry. Must defer instead.
    mockApi.worktrees.list.mockResolvedValue([])

    store.setState({
      repos: [repoA, repoB],
      tabsByWorktree: {
        'repoA::/a/wt1': [{ id: 'tab-A', worktreeId: 'repoA::/a/wt1' }]
      }
    } as unknown as Partial<AppState>)

    await store.getState().fetchAllWorktrees()

    expect(store.getState().hasHydratedWorktreePurge).toBe(false)
    expect(store.getState().tabsByWorktree).toEqual({
      'repoA::/a/wt1': [{ id: 'tab-A', worktreeId: 'repoA::/a/wt1' }]
    })
  })

  it('fires the purge once when every repo returns successfully with ≥1 worktree', async () => {
    const store = createTestStore()
    const wtA = makeWorktree({ id: 'repoA::/a/wt1', repoId: 'repoA', path: '/a/wt1' })
    const wtB = makeWorktree({ id: 'repoB::/b/wt1', repoId: 'repoB', path: '/b/wt1' })

    mockApi.worktrees.list.mockImplementation(async ({ repoId }: { repoId: string }) =>
      repoId === 'repoA' ? [wtA] : [wtB]
    )

    store.setState({
      repos: [repoA, repoB],
      tabsByWorktree: {
        'repoA::/a/wt1': [{ id: 'tab-A', worktreeId: 'repoA::/a/wt1' }],
        'repoA::/a/zombie': [{ id: 'tab-zombie', worktreeId: 'repoA::/a/zombie' }],
        'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }]
      },
      gitIgnoredPathsByWorktree: {
        'repoA::/a/wt1': ['dist/'],
        'repoA::/a/zombie': ['coverage/'],
        'repoB::/b/wt1': ['build/']
      }
    } as unknown as Partial<AppState>)

    await store.getState().fetchAllWorktrees()

    expect(store.getState().hasHydratedWorktreePurge).toBe(true)
    expect(mockApi.worktrees.list).toHaveBeenCalledTimes(2)
    expect(store.getState().tabsByWorktree).toEqual({
      'repoA::/a/wt1': [{ id: 'tab-A', worktreeId: 'repoA::/a/wt1' }],
      'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }]
    })
    expect(store.getState().gitIgnoredPathsByWorktree).toEqual({
      'repoA::/a/wt1': ['dist/'],
      'repoB::/b/wt1': ['build/']
    })

    // Second call must not re-run the purge even if new stale ids appear.
    store.setState({
      tabsByWorktree: {
        ...store.getState().tabsByWorktree,
        'repoA::/a/new-zombie': [{ id: 'tab-new-zombie', worktreeId: 'repoA::/a/new-zombie' }]
      }
    } as unknown as Partial<AppState>)

    await store.getState().fetchAllWorktrees()

    expect(mockApi.worktrees.list).toHaveBeenCalledTimes(4)
    expect(store.getState().tabsByWorktree['repoA::/a/new-zombie']).toBeDefined()
  })
})

// Why: design §4.4 — purgeWorktreeTerminalState wipes every worktree-scoped
// map symmetrically so a single removed-worktree event cannot leave
// per-worktree entries stranded. The full cascade is already covered by
// removeWorktree tests above; this block exercises the action directly to
// confirm cross-map coverage (worktree key, tab id, file id, and top-level
// actives).
describe('purgeWorktreeTerminalState direct (design §4.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('wipes tab-id-keyed maps (terminalLayoutsByTabId, ptyIdsByTabId) and clears actives', () => {
    const store = createTestStore()

    store.setState({
      tabsByWorktree: {
        'repoA::/a/wt1': [
          { id: 'tab-1', worktreeId: 'repoA::/a/wt1' },
          { id: 'tab-2', worktreeId: 'repoA::/a/wt1' }
        ],
        'repoA::/a/wt2': [{ id: 'tab-3', worktreeId: 'repoA::/a/wt2' }]
      },
      terminalLayoutsByTabId: {
        'tab-1': { panes: [] },
        'tab-2': { panes: [] },
        'tab-3': { panes: [] }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'], 'tab-2': ['pty-2'], 'tab-3': ['pty-3'] },
      runtimePaneTitlesByTabId: { 'tab-1': 'claude', 'tab-3': 'bash' },
      openFiles: [
        {
          id: 'file-1',
          worktreeId: 'repoA::/a/wt1',
          filePath: '/a/wt1/a.ts',
          relativePath: 'a.ts',
          language: 'typescript',
          isDirty: false,
          isPreview: false,
          mode: 'edit' as const
        }
      ],
      editorDrafts: { 'file-1': 'draft', 'file-99': 'other' },
      gitIgnoredPathsByWorktree: {
        'repoA::/a/wt1': ['dist/'],
        'repoA::/a/wt2': ['coverage/']
      },
      rightSidebarTabByWorktree: {
        'repoA::/a/wt1': 'search',
        'repoA::/a/wt2': 'checks'
      },
      activeWorktreeId: 'repoA::/a/wt1',
      worktreeLineageById: {
        'repoA::/a/wt1': makeLineage({ worktreeId: 'repoA::/a/wt1' }),
        'repoA::/a/wt2': makeLineage({ worktreeId: 'repoA::/a/wt2' })
      },
      activeFileId: 'file-1',
      activeTabId: 'tab-1',
      activeTabType: 'editor' as const
    } as unknown as Partial<AppState>)

    store.getState().purgeWorktreeTerminalState(['repoA::/a/wt1'])

    const s = store.getState()
    expect(s.tabsByWorktree).toEqual({
      'repoA::/a/wt2': [{ id: 'tab-3', worktreeId: 'repoA::/a/wt2' }]
    })
    expect(s.worktreeLineageById).toEqual({
      'repoA::/a/wt2': makeLineage({ worktreeId: 'repoA::/a/wt2' })
    })
    expect(s.terminalLayoutsByTabId).toEqual({ 'tab-3': { panes: [] } })
    expect(s.ptyIdsByTabId).toEqual({ 'tab-3': ['pty-3'] })
    expect(s.runtimePaneTitlesByTabId).toEqual({ 'tab-3': 'bash' })
    expect(s.openFiles).toEqual([])
    expect(s.editorDrafts).toEqual({ 'file-99': 'other' })
    expect(s.gitIgnoredPathsByWorktree).toEqual({ 'repoA::/a/wt2': ['coverage/'] })
    expect(s.rightSidebarTabByWorktree).toEqual({ 'repoA::/a/wt2': 'checks' })
    expect(s.activeWorktreeId).toBeNull()
    expect(s.activeFileId).toBeNull()
    expect(s.activeTabId).toBeNull()
    expect(s.activeTabType).toBe('terminal')
  })

  it('is a no-op when the id list is empty', () => {
    const store = createTestStore()
    const before = {
      'repoA::/a/wt1': [{ id: 'tab-1', worktreeId: 'repoA::/a/wt1' }]
    }
    store.setState({ tabsByWorktree: before } as unknown as Partial<AppState>)

    store.getState().purgeWorktreeTerminalState([])

    expect(store.getState().tabsByWorktree).toBe(before)
  })
})

describe('markWorktreeVisited', () => {
  it('is monotonic: an older timestamp does not regress the stored value', () => {
    const store = createTestStore()
    store.getState().markWorktreeVisited('wt-1', 1000)
    expect(store.getState().lastVisitedAtByWorktreeId['wt-1']).toBe(1000)

    store.getState().markWorktreeVisited('wt-1', 500)
    expect(store.getState().lastVisitedAtByWorktreeId['wt-1']).toBe(1000)

    store.getState().markWorktreeVisited('wt-1', 1000)
    expect(store.getState().lastVisitedAtByWorktreeId['wt-1']).toBe(1000)

    store.getState().markWorktreeVisited('wt-1', 2000)
    expect(store.getState().lastVisitedAtByWorktreeId['wt-1']).toBe(2000)
  })

  it('seedActiveWorktreeLastVisitedIfMissing seeds only when missing', () => {
    const store = createTestStore()
    store.setState({
      activeWorktreeId: 'wt-1',
      lastVisitedAtByWorktreeId: {}
    } as Partial<AppState>)
    store.getState().seedActiveWorktreeLastVisitedIfMissing()
    expect(store.getState().lastVisitedAtByWorktreeId['wt-1']).toBeTypeOf('number')

    const existing = store.getState().lastVisitedAtByWorktreeId['wt-1']
    store.getState().seedActiveWorktreeLastVisitedIfMissing()
    expect(store.getState().lastVisitedAtByWorktreeId['wt-1']).toBe(existing)
  })

  it('pruneLastVisitedTimestamps drops entries for unknown worktree IDs within hydrated repos', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/a', repoId: 'repo1', path: '/a' })
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      lastVisitedAtByWorktreeId: { 'repo1::/a': 100, 'repo1::/gone': 200 }
    } as Partial<AppState>)
    store.getState().pruneLastVisitedTimestamps()
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({ 'repo1::/a': 100 })
  })

  it('pruneLastVisitedTimestamps preserves entries for not-yet-hydrated repos (e.g. SSH pre-connect)', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/a', repoId: 'repo1', path: '/a' })
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      lastVisitedAtByWorktreeId: { 'repo1::/a': 100, 'ssh-repo::/b': 200 }
    } as Partial<AppState>)
    store.getState().pruneLastVisitedTimestamps()
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({
      'repo1::/a': 100,
      'ssh-repo::/b': 200
    })
  })

  it('pruneLastVisitedTimestamps defers when the detected list is non-authoritative', () => {
    const store = createTestStore()
    store.setState({
      worktreesByRepo: { repo1: [] },
      detectedWorktreesByRepo: {
        repo1: makeDetectedResult('repo1', [], {
          authoritative: false,
          source: 'metadata-fallback'
        })
      },
      lastVisitedAtByWorktreeId: { 'repo1::/hidden': 100 }
    } as Partial<AppState>)

    store.getState().pruneLastVisitedTimestamps()

    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({ 'repo1::/hidden': 100 })
  })
})
