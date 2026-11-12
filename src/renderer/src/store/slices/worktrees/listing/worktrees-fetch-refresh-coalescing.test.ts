import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import type { ListDetectedWorktreesArgs } from '../../../../../../shared/detected-worktree-provider-contract'
import { clearHugeRepoWarningDismissalsForTests } from '@/lib/source-control/warnings/source-control-huge-repo-warning-dismissals'
import { makeDetectedResult, qualifyDetectedResult } from './worktrees-detected-listing-fixtures'
import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from '../worktrees-slice-test-harness'

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

  // Coalesced scans share IO, but each caller’s known-ID snapshot still needs teardown or it purges state while stranding live PTYs (#10562).
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

  // Unreachable SSH cannot prove worktree deletion; neither purge nor kill without authoritative scan (#10562).
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
})
