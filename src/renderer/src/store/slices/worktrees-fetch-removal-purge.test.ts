import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import {
  beginHugeRepoWarningProbe,
  clearHugeRepoWarningDismissalsForTests,
  hasDismissedHugeRepoWarning,
  markHugeRepoWarningDismissed
} from '@/lib/source-control-huge-repo-warning-dismissals'
import { getHostedReviewLinkMutationGenerationForTests } from './worktrees'
import { makeDetectedResult, qualifyDetectedResult } from './worktrees-detected-listing-fixtures'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

describe('fetchWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    clearHugeRepoWarningDismissalsForTests()
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
        [removed.id]: 'search' as never,
        [surviving.id]: 'checks'
      },
      rightSidebarExplorerViewByWorktree: {
        [removed.id]: 'search',
        [surviving.id]: 'files'
      }
    } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([surviving])
    expect(store.getState().rightSidebarTabByWorktree).toEqual({ [surviving.id]: 'checks' })
    expect(store.getState().rightSidebarExplorerViewByWorktree).toEqual({
      [surviving.id]: 'files'
    })
    expect(store.getState().sortEpoch).toBe(8)
  })

  it('keeps pr-checks and plugin panel tabs for surviving worktrees after an authoritative purge', async () => {
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
        [removed.id]: 'search' as never,
        [surviving.id]: 'pr-checks' as never
      },
      rightSidebarExplorerViewByWorktree: {
        [removed.id]: 'search',
        [surviving.id]: 'files'
      }
    } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    // pr-checks is not dropped like unknown values; it survives the purge.
    expect(store.getState().rightSidebarTabByWorktree).toEqual({ [surviving.id]: 'pr-checks' })

    // A shape-valid plugin panel tab also survives the purge.
    store.setState({
      rightSidebarTabByWorktree: {
        [surviving.id]: 'plugin:orca-samples.my-plugin/dashboard' as never
      }
    } as Partial<AppState>)
    await store.getState().fetchWorktrees('repo1')
    expect(store.getState().rightSidebarTabByWorktree).toEqual({
      [surviving.id]: 'plugin:orca-samples.my-plugin/dashboard'
    })
  })

  it('purges hosted review link mutation bookkeeping for worktrees removed by refresh', async () => {
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
    store.setState({ worktreesByRepo: { repo1: [removed, surviving] } } as Partial<AppState>)
    await store.getState().updateWorktreeMeta(removed.id, { linkedBitbucketPR: 101 })
    await store.getState().updateWorktreeMeta(surviving.id, { linkedAzureDevOpsPR: 202 })

    expect(getHostedReviewLinkMutationGenerationForTests(removed.id)).toBeGreaterThan(0)
    expect(getHostedReviewLinkMutationGenerationForTests(surviving.id)).toBeGreaterThan(0)

    await store.getState().fetchWorktrees('repo1')

    expect(getHostedReviewLinkMutationGenerationForTests(removed.id)).toBe(0)
    expect(getHostedReviewLinkMutationGenerationForTests(surviving.id)).toBeGreaterThan(0)
  })

  it('retains hidden state until an authoritative refresh removes the worktree', async () => {
    const store = createTestStore()
    const visible = makeWorktree({
      id: 'repo1::/path/visible',
      repoId: 'repo1',
      path: '/path/visible'
    })
    const hidden = makeWorktree({
      id: 'repo1::/path/hidden',
      instanceId: 'persisted-hidden-instance',
      repoId: 'repo1',
      path: '/path/hidden'
    })
    const previousDetected = makeDetectedResult('repo1', [visible, hidden])
    previousDetected.worktrees[1] = {
      ...previousDetected.worktrees[1],
      ownership: 'external',
      visible: false
    }
    mockApi.worktrees.listDetected
      .mockResolvedValueOnce(previousDetected)
      .mockResolvedValueOnce(makeDetectedResult('repo1', [visible]))
    store.setState({
      worktreesByRepo: { repo1: [visible] },
      detectedWorktreesByRepo: { repo1: previousDetected },
      sortEpoch: 7,
      rightSidebarTabByWorktree: {
        [visible.id]: 'checks',
        [hidden.id]: 'search' as never
      },
      rightSidebarExplorerViewByWorktree: {
        [visible.id]: 'files',
        [hidden.id]: 'search'
      },
      tabsByWorktree: {
        [hidden.id]: [{ id: 'tab-hidden', worktreeId: hidden.id }]
      }
    } as unknown as Partial<AppState>)
    markHugeRepoWarningDismissed(beginHugeRepoWarningProbe(hidden))

    await store.getState().fetchWorktrees('repo1')

    expect(hasDismissedHugeRepoWarning(beginHugeRepoWarningProbe(hidden))).toBe(true)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([visible])
    expect(store.getState().rightSidebarTabByWorktree).toEqual({ [visible.id]: 'checks' })
    expect(store.getState().rightSidebarExplorerViewByWorktree).toEqual({ [visible.id]: 'files' })
    expect(store.getState().tabsByWorktree[hidden.id]).toBeUndefined()
    expect(store.getState().sortEpoch).toBe(7)
    expect(hasDismissedHugeRepoWarning(beginHugeRepoWarningProbe(hidden))).toBe(false)
  })

  it('awaits missing-worktree terminal teardown before purging renderer state', async () => {
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
    let finishTeardown!: () => void
    mockApi.runtime.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishTeardown = () =>
            resolve({
              id: 'teardown',
              ok: true,
              result: { stoppedWorktreeIds: [deleted.id] }
            })
        })
    )
    mockApi.worktrees.listDetected.mockImplementationOnce(async (args) =>
      qualifyDetectedResult(args, makeDetectedResult('repo1', [surviving]))
    )
    store.setState({
      repos: [
        {
          id: 'repo1',
          path: '/path/repo1',
          displayName: 'Repo 1',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-1'
        }
      ],
      worktreesByRepo: { repo1: [deleted, surviving] },
      detectedWorktreesByRepo: {
        repo1: makeDetectedResult('repo1', [deleted, surviving])
      },
      tabsByWorktree: {
        [deleted.id]: [{ id: 'tab-deleted', worktreeId: deleted.id }]
      }
    } as unknown as Partial<AppState>)

    const refresh = store.getState().fetchWorktrees('repo1')
    await vi.waitFor(() => expect(mockApi.runtime.call).toHaveBeenCalledTimes(1))

    expect(mockApi.runtime.call).toHaveBeenCalledWith({
      method: 'worktree.teardownMissingTerminals',
      params: { repo: 'repo1', worktreeIds: [deleted.id], connectionId: 'ssh-1' }
    })
    expect(store.getState().tabsByWorktree[deleted.id]).toBeDefined()

    finishTeardown()
    await refresh

    expect(store.getState().tabsByWorktree[deleted.id]).toBeUndefined()
  })

  it('clears a hidden dismissal across hydrated fetch-all delete and recreation', async () => {
    const store = createTestStore()
    const visible = makeWorktree({
      id: 'repo1::/path/visible',
      repoId: 'repo1',
      path: '/path/visible'
    })
    const hidden = makeWorktree({
      id: 'repo1::/path/reused',
      instanceId: 'persisted-reused-instance',
      repoId: 'repo1',
      path: '/path/reused'
    })
    const hiddenDetected = makeDetectedResult('repo1', [visible, hidden])
    hiddenDetected.worktrees[1] = {
      ...hiddenDetected.worktrees[1],
      ownership: 'external',
      visible: false
    }
    const recreatedDetected = makeDetectedResult('repo1', [visible, hidden])
    mockApi.worktrees.listDetected
      .mockResolvedValueOnce(hiddenDetected)
      .mockResolvedValueOnce(makeDetectedResult('repo1', [visible]))
      .mockResolvedValueOnce(recreatedDetected)
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      hasHydratedWorktreePurge: true,
      worktreesByRepo: { repo1: [visible] },
      detectedWorktreesByRepo: { repo1: hiddenDetected }
    } as Partial<AppState>)
    markHugeRepoWarningDismissed(beginHugeRepoWarningProbe(hidden))

    await store.getState().fetchAllWorktrees()
    expect(hasDismissedHugeRepoWarning(beginHugeRepoWarningProbe(hidden))).toBe(true)

    await store.getState().fetchAllWorktrees()
    await store.getState().fetchAllWorktrees()

    // The backend can reuse persisted instance metadata for the same path.
    expect(hasDismissedHugeRepoWarning(beginHugeRepoWarningProbe(hidden))).toBe(false)
  })

  it('refreshes only repos owned by the changed visibility-default host', async () => {
    const store = createTestStore()
    mockApi.worktrees.listDetected.mockImplementationOnce(async (args) =>
      qualifyDetectedResult(args, makeDetectedResult(args.repoId, []))
    )
    store.setState({
      repos: [
        {
          id: 'local-repo',
          path: '/local',
          displayName: 'Local',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: 'local'
        },
        {
          id: 'runtime-repo',
          path: '/remote',
          displayName: 'Remote',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: 'runtime:env-1'
        }
      ],
      hasHydratedWorktreePurge: true
    } as Partial<AppState>)

    await store.getState().fetchAllWorktrees({ visibilityOwnerHostId: 'local' })

    expect(mockApi.worktrees.listDetected).toHaveBeenCalledOnce()
    expect(mockApi.worktrees.listDetected).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'local-repo', executionHostId: 'local' })
    )
    expect(mockApi.runtime.call).not.toHaveBeenCalled()
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

    mockApi.worktrees.listDetected.mockImplementationOnce(async (args) =>
      qualifyDetectedResult(args, makeDetectedResult('repo1', [surviving]))
    )
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
        [missingFromFallback.id]: 'search' as never,
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
    expect(mockApi.runtime.call).not.toHaveBeenCalled()
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
      rightSidebarTabByWorktree: { [existing.id]: 'search' as never }
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
})
