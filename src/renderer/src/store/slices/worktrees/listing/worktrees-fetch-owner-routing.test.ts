import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import 'sonner'
import type { ListDetectedWorktreesArgs } from '../../../../../../shared/detected-worktree-provider-contract'
import type { SshProviderEpoch } from '../../../../../../shared/ssh-types'
import { clearHugeRepoWarningDismissalsForTests } from '@/lib/source-control/warnings/source-control-huge-repo-warning-dismissals'
import { useAppStore } from '@/store/index'
import {
  TEST_SSH_AUTHORITY,
  makeDetectedResult,
  qualifyDetectedResult
} from './worktrees-detected-listing-fixtures'
import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
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

  it('rejects a missing-owner SSH result after the provider reconnects', async () => {
    const store = createTestStore()
    const remote = makeWorktree({
      id: 'repo-missing::/ssh/wt',
      repoId: 'repo-missing',
      path: '/ssh/wt'
    })
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      mockApi.worktrees.listDetected.mockImplementationOnce(
        async (args: ListDetectedWorktreesArgs) => {
          resolve()
          await new Promise<void>((resume) => {
            release = resume
          })
          return qualifyDetectedResult(args, makeDetectedResult('repo-missing', [remote]))
        }
      )
    })

    const refresh = store.getState().fetchWorktrees('repo-missing', {
      executionHostId: 'ssh:ssh-1',
      requireAuthoritative: true
    })
    await started
    store.setState({
      sshConnectionStates: new Map([
        [
          TEST_SSH_AUTHORITY.targetId,
          {
            targetId: TEST_SSH_AUTHORITY.targetId,
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            providerEpoch: 'provider-ssh-2' as SshProviderEpoch,
            connectionGeneration: TEST_SSH_AUTHORITY.connectionGeneration + 1
          }
        ]
      ])
    })
    release()

    await expect(refresh).resolves.toBe(false)
    expect(store.getState().worktreesByRepo['repo-missing']).toBeUndefined()
  })

  it('rejects a pre-reconnect runtime listing after a newer generation publishes', async () => {
    const store = createTestStore()
    const stale = makeWorktree({
      id: 'repo-remote::/remote/stale',
      repoId: 'repo-remote',
      path: '/remote/stale',
      hostId: 'local'
    })
    const fresh = makeWorktree({
      id: 'repo-remote::/remote/fresh',
      repoId: 'repo-remote',
      path: '/remote/fresh',
      hostId: 'local'
    })
    let resolveStale!: (value: unknown) => void
    let resolveFresh!: (value: unknown) => void
    const staleResponse = new Promise((resolve) => {
      resolveStale = resolve
    })
    const freshResponse = new Promise((resolve) => {
      resolveFresh = resolve
    })
    runtimeEnvironmentCall.mockReturnValueOnce(staleResponse).mockReturnValueOnce(freshResponse)
    store.setState({
      repos: [
        {
          id: 'repo-remote',
          path: '/remote',
          displayName: 'Remote',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: 'runtime:env-1'
        }
      ]
    } as Partial<AppState>)

    const staleRefresh = store.getState().fetchWorktrees('repo-remote')
    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))
    useAppStore.getState().markEnvironmentSshStateStale('env-1')
    const freshRefresh = store.getState().fetchWorktrees('repo-remote')
    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2))
    resolveFresh({
      id: 'fresh',
      ok: true,
      result: makeDetectedResult('repo-remote', [fresh]),
      _meta: { runtimeId: 'runtime-fresh' }
    })
    await expect(freshRefresh).resolves.toBe(true)
    resolveStale({
      id: 'stale',
      ok: true,
      result: makeDetectedResult('repo-remote', [stale]),
      _meta: { runtimeId: 'runtime-stale' }
    })

    await expect(staleRefresh).resolves.toBe(false)
    expect(store.getState().worktreesByRepo['repo-remote']).toEqual([
      { ...fresh, hostId: 'runtime:env-1', runtimeOwnerEnvironmentId: 'env-1' }
    ])
    expect(mockApi.worktrees.listDetected).not.toHaveBeenCalled()
  })
})
