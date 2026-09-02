import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type {
  HostQualifiedDetectedWorktreeResult,
  ListDetectedWorktreesArgs
} from '../../../../shared/detected-worktree-provider-contract'
import { clearHugeRepoWarningDismissalsForTests } from '@/lib/source-control-huge-repo-warning-dismissals'
import { acquireDirectSshDetectedWorktreeRefresh } from './worktrees'
import {
  TEST_SSH_AUTHORITY,
  makeDetectedResult,
  qualifyDetectedResult
} from './worktrees-detected-listing-fixtures'
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

  it('coalesces concurrent duplicate refreshes for the same repo and host', async () => {
    const store = createTestStore()
    const refreshed = makeWorktree({
      id: 'repo1::/path/refreshed',
      repoId: 'repo1',
      path: '/path/refreshed'
    })
    let releaseScan!: () => void
    const scanStarted = new Promise<void>((resolve) => {
      mockApi.worktrees.listDetected.mockImplementationOnce(
        async ({ repoId }: { repoId: string }) => {
          resolve()
          await new Promise<void>((release) => {
            releaseScan = release
          })
          return makeDetectedResult(repoId, [refreshed])
        }
      )
    })

    const requests = Array.from({ length: 8 }, () => store.getState().fetchWorktrees('repo1'))
    await scanStarted

    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(1)

    releaseScan()
    await expect(Promise.all(requests)).resolves.toEqual(Array(8).fill(true))
    expect(store.getState().worktreesByRepo.repo1).toEqual([refreshed])
    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(1)
  })

  // Why (#10562): the scan coalesces but each caller carries its own known-id
  // snapshot, so a caller that joined an in-flight scan must still request
  // teardown — otherwise it purges renderer state and strands live PTYs.
  it('stops terminals for a caller that coalesced onto an in-flight scan', async () => {
    const store = createTestStore()
    const deleted = makeWorktree({ id: 'repo1::/p/deleted', repoId: 'repo1', path: '/p/deleted' })
    const surviving = makeWorktree({ id: 'repo1::/p/surv', repoId: 'repo1', path: '/p/surv' })

    // Caller A starts before hydration, so its known-id snapshot is empty.
    store.setState({
      repos: [{ id: 'repo1', path: '/p/repo1', displayName: 'R', badgeColor: '#000', addedAt: 0 }],
      worktreesByRepo: {},
      detectedWorktreesByRepo: {},
      tabsByWorktree: {}
    } as unknown as Partial<AppState>)

    let releaseScan!: () => void
    const scanStarted = new Promise<void>((resolve) => {
      mockApi.worktrees.listDetected.mockImplementationOnce(async ({ repoId }) => {
        resolve()
        await new Promise<void>((release) => {
          releaseScan = release
        })
        return makeDetectedResult(repoId, [surviving])
      })
    })

    const callerA = store.getState().fetchDetectedWorktrees('repo1')
    await scanStarted

    // Hydration lands mid-scan: the renderer now owns `deleted` and its tabs.
    store.setState({
      worktreesByRepo: { repo1: [deleted, surviving] },
      detectedWorktreesByRepo: { repo1: makeDetectedResult('repo1', [deleted, surviving]) },
      tabsByWorktree: { [deleted.id]: [{ id: 'tab-d', worktreeId: deleted.id }] }
    } as unknown as Partial<AppState>)

    const callerB = store.getState().fetchWorktrees('repo1')
    releaseScan()
    await Promise.all([callerA, callerB])

    // One shared scan, but the coalesced caller still asked the host to sweep.
    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(1)
    expect(mockApi.runtime.call).toHaveBeenCalledWith({
      method: 'worktree.teardownMissingTerminals',
      params: { repo: 'repo1', worktreeIds: [deleted.id], connectionId: null }
    })
    expect(store.getState().tabsByWorktree[deleted.id]).toBeUndefined()
  })

  // Why: teardown rides outside the scan coalescer, so identical fan-out requests
  // must share one host sweep instead of re-scanning the host per caller.
  it('shares one teardown sweep across identical concurrent refreshes', async () => {
    const store = createTestStore()
    const deleted = makeWorktree({ id: 'repo1::/p/deleted', repoId: 'repo1', path: '/p/deleted' })
    const surviving = makeWorktree({ id: 'repo1::/p/surv', repoId: 'repo1', path: '/p/surv' })

    store.setState({
      repos: [{ id: 'repo1', path: '/p/repo1', displayName: 'R', badgeColor: '#000', addedAt: 0 }],
      worktreesByRepo: { repo1: [deleted, surviving] },
      detectedWorktreesByRepo: { repo1: makeDetectedResult('repo1', [deleted, surviving]) },
      tabsByWorktree: { [deleted.id]: [{ id: 'tab-d', worktreeId: deleted.id }] }
    } as unknown as Partial<AppState>)

    mockApi.worktrees.listDetected.mockImplementationOnce(async (args) =>
      qualifyDetectedResult(args, makeDetectedResult('repo1', [surviving]))
    )

    await Promise.all([
      store.getState().fetchWorktrees('repo1'),
      store.getState().fetchDetectedWorktrees('repo1'),
      store.getState().fetchWorktrees('repo1')
    ])

    expect(mockApi.runtime.call).toHaveBeenCalledTimes(1)
    expect(store.getState().tabsByWorktree[deleted.id]).toBeUndefined()
  })

  // Why (#10562): "I can't reach the host" must never be read as "the worktree is
  // gone". A disconnected SSH target has no authoritative scan, so it must not
  // purge and must not kill anything on the far side.
  it('never stops terminals for a disconnected SSH target', async () => {
    const store = createTestStore()
    const deleted = makeWorktree({ id: 'repo1::/p/deleted', repoId: 'repo1', path: '/p/deleted' })
    const surviving = makeWorktree({ id: 'repo1::/p/surv', repoId: 'repo1', path: '/p/surv' })

    store.setState({
      repos: [
        {
          id: 'repo1',
          path: '/p/repo1',
          displayName: 'R',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: TEST_SSH_AUTHORITY.targetId
        }
      ],
      // Why: the target dropped — no connected authority for this host.
      sshConnectionStates: new Map([
        [
          TEST_SSH_AUTHORITY.targetId,
          {
            targetId: TEST_SSH_AUTHORITY.targetId,
            status: 'disconnected',
            error: null,
            reconnectAttempt: 1
          }
        ]
      ]),
      worktreesByRepo: { repo1: [deleted, surviving] },
      detectedWorktreesByRepo: { repo1: makeDetectedResult('repo1', [deleted, surviving]) },
      tabsByWorktree: { [deleted.id]: [{ id: 'tab-d', worktreeId: deleted.id }] }
    } as unknown as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(mockApi.runtime.call).not.toHaveBeenCalled()
    expect(store.getState().tabsByWorktree[deleted.id]).toBeDefined()
  })

  it('coalesces fetchDetectedWorktrees with a matching fetchWorktrees refresh', async () => {
    const store = createTestStore()
    const refreshed = makeWorktree({
      id: 'repo1::/path/refreshed',
      repoId: 'repo1',
      path: '/path/refreshed'
    })
    let releaseScan!: () => void
    const scanStarted = new Promise<void>((resolve) => {
      mockApi.worktrees.listDetected.mockImplementationOnce(
        async ({ repoId }: { repoId: string }) => {
          resolve()
          await new Promise<void>((release) => {
            releaseScan = release
          })
          return makeDetectedResult(repoId, [refreshed])
        }
      )
    })

    const detectedRequest = store.getState().fetchDetectedWorktrees('repo1')
    const visibleRequest = store.getState().fetchWorktrees('repo1')
    await scanStarted

    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(1)

    releaseScan()
    await expect(Promise.all([detectedRequest, visibleRequest])).resolves.toEqual([
      makeDetectedResult('repo1', [refreshed]),
      true
    ])
    expect(store.getState().worktreesByRepo.repo1).toEqual([refreshed])
    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(1)
  })

  it('keeps authoritative refreshes separate from non-authoritative in-flight results', async () => {
    const store = createTestStore()
    const fallback = makeWorktree({
      id: 'repo1::/path/fallback',
      repoId: 'repo1',
      path: '/path/fallback'
    })
    const authoritative = makeWorktree({
      id: 'repo1::/path/authoritative',
      repoId: 'repo1',
      path: '/path/authoritative'
    })
    let releaseFallback!: () => void
    let releaseAuthoritative!: () => void
    const fallbackStarted = new Promise<void>((resolve) => {
      mockApi.worktrees.listDetected.mockImplementationOnce(
        async ({ repoId }: { repoId: string }) => {
          resolve()
          await new Promise<void>((release) => {
            releaseFallback = release
          })
          return makeDetectedResult(repoId, [fallback], {
            authoritative: false,
            source: 'metadata-fallback'
          })
        }
      )
    })
    const authoritativeStarted = new Promise<void>((resolve) => {
      mockApi.worktrees.listDetected.mockImplementationOnce(
        async ({ repoId }: { repoId: string }) => {
          resolve()
          await new Promise<void>((release) => {
            releaseAuthoritative = release
          })
          return makeDetectedResult(repoId, [authoritative])
        }
      )
    })

    const bestEffortRequest = store.getState().fetchWorktrees('repo1')
    await fallbackStarted
    const authoritativeRequest = store
      .getState()
      .fetchWorktrees('repo1', { requireAuthoritative: true })
    await authoritativeStarted

    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(2)

    releaseFallback()
    await expect(bestEffortRequest).resolves.toBe(false)
    releaseAuthoritative()
    await expect(authoritativeRequest).resolves.toBe(true)

    expect(store.getState().worktreesByRepo.repo1).toEqual([authoritative])
    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(2)
  })

  it('keeps same-repo refreshes separate for different execution hosts', async () => {
    const store = createTestStore()
    const localWorktree = makeWorktree({
      id: 'repo1::/local/wt1',
      repoId: 'repo1',
      path: '/local/wt1'
    })
    const sshWorktree = makeWorktree({
      id: 'repo1::/ssh/wt1',
      repoId: 'repo1',
      path: '/home/orca/wt1'
    })
    let releaseLocal!: () => void
    let releaseSsh!: () => void
    const localStarted = new Promise<void>((resolve) => {
      mockApi.worktrees.listDetected.mockImplementationOnce(
        async (args: ListDetectedWorktreesArgs) => {
          resolve()
          await new Promise<void>((release) => {
            releaseLocal = release
          })
          return qualifyDetectedResult(args, makeDetectedResult(args.repoId, [localWorktree]))
        }
      )
    })
    const sshStarted = new Promise<void>((resolve) => {
      mockApi.worktrees.listDetected.mockImplementationOnce(
        async (args: ListDetectedWorktreesArgs) => {
          resolve()
          await new Promise<void>((release) => {
            releaseSsh = release
          })
          return qualifyDetectedResult(args, makeDetectedResult(args.repoId, [sshWorktree]))
        }
      )
    })
    store.setState({
      hasHydratedWorktreePurge: true,
      repos: [
        {
          id: 'repo1',
          path: '/local/repo1',
          displayName: 'Repo One',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: 'local'
        },
        {
          id: 'repo1',
          path: '/home/orca/repo1',
          displayName: 'Repo One SSH',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-1'
        }
      ]
    } as Partial<AppState>)

    const refresh = store.getState().fetchAllWorktrees()
    await Promise.all([localStarted, sshStarted])

    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(2)

    releaseLocal()
    releaseSsh()
    await refresh

    expect(store.getState().worktreesByRepo.repo1).toEqual([
      localWorktree,
      { ...sshWorktree, hostId: 'ssh:ssh-1' }
    ])
    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(2)
  })

  it('preserves SSH host identity when detected and visible refreshes overlap', async () => {
    const store = createTestStore()
    const sshWorktree = makeWorktree({
      id: 'repo-ssh::/home/orca/wt1',
      repoId: 'repo-ssh',
      path: '/home/orca/wt1'
    })
    let releaseScan!: () => void
    const scanStarted = new Promise<void>((resolve) => {
      mockApi.worktrees.listDetected.mockImplementationOnce(
        async (args: ListDetectedWorktreesArgs) => {
          resolve()
          await new Promise<void>((release) => {
            releaseScan = release
          })
          return qualifyDetectedResult(args, makeDetectedResult(args.repoId, [sshWorktree]))
        }
      )
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [
        {
          id: 'repo-ssh',
          path: '/home/orca/repo',
          displayName: 'SSH Repo',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-1'
        }
      ]
    } as Partial<AppState>)

    const detectedRequest = store.getState().fetchDetectedWorktrees('repo-ssh')
    const visibleRequest = store.getState().fetchWorktrees('repo-ssh')
    await scanStarted

    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(1)

    releaseScan()
    const [, visibleResult] = await Promise.all([detectedRequest, visibleRequest])

    expect(visibleResult).toBe(true)
    expect(store.getState().worktreesByRepo['repo-ssh']).toEqual([
      { ...sshWorktree, hostId: 'ssh:ssh-1' }
    ])
    expect(store.getState().detectedWorktreesByRepo['repo-ssh']?.worktrees).toEqual([
      expect.objectContaining({ id: sshWorktree.id, hostId: 'ssh:ssh-1' })
    ])
    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(1)
  })

  it('preserves SSH host identity when visible refresh starts before detected refresh', async () => {
    const store = createTestStore()
    const sshWorktree = makeWorktree({
      id: 'repo-ssh::/home/orca/wt1',
      repoId: 'repo-ssh',
      path: '/home/orca/wt1'
    })
    let releaseScan!: () => void
    const scanStarted = new Promise<void>((resolve) => {
      mockApi.worktrees.listDetected.mockImplementationOnce(
        async (args: ListDetectedWorktreesArgs) => {
          resolve()
          await new Promise<void>((release) => {
            releaseScan = release
          })
          return qualifyDetectedResult(args, makeDetectedResult(args.repoId, [sshWorktree]))
        }
      )
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [
        {
          id: 'repo-ssh',
          path: '/home/orca/repo',
          displayName: 'SSH Repo',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-1'
        }
      ]
    } as Partial<AppState>)

    const visibleRequest = store.getState().fetchWorktrees('repo-ssh')
    const detectedRequest = store.getState().fetchDetectedWorktrees('repo-ssh')
    await scanStarted

    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(1)

    releaseScan()
    const [visibleResult] = await Promise.all([visibleRequest, detectedRequest])

    expect(visibleResult).toBe(true)
    expect(store.getState().worktreesByRepo['repo-ssh']).toEqual([
      { ...sshWorktree, hostId: 'ssh:ssh-1' }
    ])
    expect(store.getState().detectedWorktreesByRepo['repo-ssh']?.worktrees).toEqual([
      expect.objectContaining({ id: sshWorktree.id, hostId: 'ssh:ssh-1' })
    ])
    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(1)
  })

  it('exposes shared direct leases and reports cancellation only for the last waiter', async () => {
    const store = createTestStore()
    let request!: ListDetectedWorktreesArgs
    let resolveProvider!: (result: HostQualifiedDetectedWorktreeResult) => void
    const provider = new Promise<HostQualifiedDetectedWorktreeResult>((resolve) => {
      resolveProvider = resolve
    })
    mockApi.worktrees.listDetected.mockImplementationOnce(
      async (args: ListDetectedWorktreesArgs) => {
        request = args
        return provider
      }
    )

    const input = {
      repoId: 'repo-ssh',
      executionHostId: 'ssh:ssh-1' as const,
      authority: TEST_SSH_AUTHORITY
    }
    const first = acquireDirectSshDetectedWorktreeRefresh(store, input)
    const second = acquireDirectSshDetectedWorktreeRefresh(store, input)

    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(1)
    expect(first.providerRequestId).toBe(second.providerRequestId)
    expect(first.waiterLeaseId).not.toBe(second.waiterLeaseId)
    expect(first.release('superseded')).toBe('retained')
    expect(mockApi.worktrees.cancelListDetected).not.toHaveBeenCalled()
    expect(second.release('invalidated')).toBe('cancel-started')
    expect(second.release('stopped')).toBe('already-settled')
    expect(mockApi.worktrees.cancelListDetected).toHaveBeenCalledWith({
      providerRequestId: first.providerRequestId
    })

    resolveProvider(qualifyDetectedResult(request, makeDetectedResult('repo-ssh', [])))
    await provider
    await Promise.resolve()
  })

  it('merges one exact direct provider result once without a second scan', async () => {
    const store = createTestStore()
    const worktree = makeWorktree({
      id: 'repo-ssh::/home/orca/feature',
      repoId: 'repo-ssh',
      path: '/home/orca/feature'
    })
    store.setState({
      repos: [
        {
          id: 'repo-ssh',
          path: '/home/orca/repo',
          displayName: 'SSH Repo',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-1'
        }
      ]
    } as Partial<AppState>)
    mockApi.worktrees.listDetected.mockImplementationOnce(async (args: ListDetectedWorktreesArgs) =>
      qualifyDetectedResult(args, makeDetectedResult(args.repoId, [worktree]))
    )
    const subscriber = vi.fn()
    const unsubscribe = store.subscribe(subscriber)

    const lease = acquireDirectSshDetectedWorktreeRefresh(store, {
      repoId: 'repo-ssh',
      executionHostId: 'ssh:ssh-1',
      authority: TEST_SSH_AUTHORITY
    })
    const providerResult = await lease.result
    const firstMerge = lease.merge(providerResult)
    const secondMerge = lease.merge(providerResult)

    expect(firstMerge).toBe(providerResult)
    expect(secondMerge).toBe(providerResult)
    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(1)
    expect(subscriber).toHaveBeenCalledTimes(1)
    expect(store.getState().worktreesByRepo['repo-ssh']).toEqual([
      { ...worktree, hostId: 'ssh:ssh-1' }
    ])
    unsubscribe()
  })

  it('rejects a late duplicate exact-host owner with zero mutation publications', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo-ssh::/home/orca/existing',
      repoId: 'repo-ssh',
      path: '/home/orca/existing',
      branch: 'refs/heads/old',
      hostId: 'ssh:ssh-1'
    })
    store.setState({
      repos: [
        {
          id: 'repo-ssh',
          path: '/home/orca/repo',
          displayName: 'SSH Repo',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-1'
        }
      ],
      worktreesByRepo: { 'repo-ssh': [existing] },
      detectedWorktreesByRepo: {
        'repo-ssh': makeDetectedResult('repo-ssh', [existing])
      }
    } as Partial<AppState>)
    let request!: ListDetectedWorktreesArgs
    let resolveProvider!: (result: HostQualifiedDetectedWorktreeResult) => void
    mockApi.worktrees.listDetected.mockImplementationOnce(
      (args: ListDetectedWorktreesArgs) =>
        new Promise<HostQualifiedDetectedWorktreeResult>((resolve) => {
          request = args
          resolveProvider = resolve
        })
    )
    const lease = acquireDirectSshDetectedWorktreeRefresh(store, {
      repoId: 'repo-ssh',
      executionHostId: 'ssh:ssh-1',
      authority: TEST_SSH_AUTHORITY
    })

    store.setState((state) => ({
      repos: [
        ...state.repos,
        {
          id: 'repo-ssh',
          path: '/home/orca/duplicate',
          displayName: 'Duplicate SSH Repo',
          badgeColor: '#111',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }))
    const beforeWorktrees = store.getState().worktreesByRepo
    const beforeDetected = store.getState().detectedWorktreesByRepo
    const subscriber = vi.fn()
    const unsubscribe = store.subscribe(subscriber)
    resolveProvider(
      qualifyDetectedResult(
        request,
        makeDetectedResult('repo-ssh', [
          {
            ...existing,
            branch: 'refs/heads/new'
          }
        ])
      )
    )

    expect(lease.merge(await lease.result)).toMatchObject({ status: 'stale' })
    expect(store.getState().worktreesByRepo).toBe(beforeWorktrees)
    expect(store.getState().detectedWorktreesByRepo).toBe(beforeDetected)
    expect(subscriber).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('fails closed before provider acquisition when direct authority is partial', async () => {
    const store = createTestStore()
    const worktreesByRepo = store.getState().worktreesByRepo
    const detectedWorktreesByRepo = store.getState().detectedWorktreesByRepo
    store.setState({
      repos: [
        {
          id: 'repo-ssh',
          path: '/home/orca/repo',
          displayName: 'SSH Repo',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-1'
        }
      ],
      sshConnectionStates: new Map([
        [
          'ssh-1',
          {
            targetId: 'ssh-1',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            providerEpoch: TEST_SSH_AUTHORITY.providerEpoch
          }
        ]
      ])
    } as Partial<AppState>)

    await expect(store.getState().fetchWorktrees('repo-ssh')).resolves.toBe(false)
    expect(mockApi.worktrees.listDetected).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo).toBe(worktreesByRepo)
    expect(store.getState().detectedWorktreesByRepo).toBe(detectedWorktreesByRepo)
  })
})
