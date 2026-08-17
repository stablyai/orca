import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { toast } from 'sonner'
import type { RuntimeEnvironmentCallRequest } from '../../runtime/runtime-compatibility-test-fixture'
import type { ListDetectedWorktreesArgs } from '../../../../shared/detected-worktree-provider-contract'
import type { SshProviderEpoch } from '../../../../shared/ssh-types'
import { clearHugeRepoWarningDismissalsForTests } from '@/lib/source-control-huge-repo-warning-dismissals'
import { useAppStore } from '@/store'
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
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
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

  it('pins the list fetch to the local host when forceLocalOwner is set', async () => {
    // Regression: a local `worktrees:changed` event for an unbound
    // repo while a remote runtime is active must refresh against the local
    // host, not the runtime — otherwise CLI-created local worktrees stay
    // invisible in the sidebar until an app restart.
    const store = createTestStore()
    const local = makeWorktree({
      id: 'repo1::/local/wt1',
      repoId: 'repo1',
      path: '/local/wt1',
      branch: 'refs/heads/local'
    })
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })
    mockApi.worktrees.listDetected.mockResolvedValueOnce(makeDetectedResult('repo1', [local]))

    await store.getState().fetchWorktrees('repo1', { forceLocalOwner: true })

    expect(store.getState().worktreesByRepo.repo1).toEqual([local])
    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('pins a duplicate repo id to its local owner without replacing runtime worktrees', async () => {
    const store = createTestStore()
    const local = makeWorktree({
      id: 'same-repo::/local/wt',
      repoId: 'same-repo',
      path: '/local/wt',
      hostId: 'local'
    })
    const remote = makeWorktree({
      id: 'same-repo::/remote/wt',
      repoId: 'same-repo',
      path: '/remote/wt',
      hostId: 'runtime:env-1'
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [
        {
          id: 'same-repo',
          path: '/repos/local',
          displayName: 'local',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: 'local'
        },
        {
          id: 'same-repo',
          path: '/repos/remote',
          displayName: 'remote',
          badgeColor: '#111',
          addedAt: 1,
          executionHostId: 'runtime:env-1'
        }
      ],
      worktreesByRepo: { 'same-repo': [remote] },
      detectedWorktreesByRepo: {
        'same-repo': makeDetectedResult('same-repo', [remote])
      }
    } as Partial<AppState>)
    mockApi.worktrees.listDetected.mockResolvedValueOnce(makeDetectedResult('same-repo', [local]))

    await store.getState().fetchWorktrees('same-repo', { forceLocalOwner: true })

    expect(mockApi.worktrees.listDetected).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'same-repo',
        executionHostId: 'local'
      })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo['same-repo']).toEqual([remote, local])
    expect(store.getState().detectedWorktreesByRepo['same-repo']?.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: remote.id, hostId: 'runtime:env-1' }),
        expect.objectContaining({ id: local.id, hostId: 'local' })
      ])
    )
  })

  it('fetches SSH repo worktrees through local IPC even when a runtime is focused', async () => {
    const store = createTestStore()
    const sshWorktree = makeWorktree({
      id: 'repo-ssh::/home/orca/wt1',
      repoId: 'repo-ssh',
      path: '/home/orca/wt1',
      branch: 'refs/heads/ssh'
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
    mockApi.worktrees.listDetected.mockImplementationOnce(async (args: ListDetectedWorktreesArgs) =>
      qualifyDetectedResult(args, makeDetectedResult('repo-ssh', [sshWorktree], { source: 'git' }))
    )

    await store.getState().fetchWorktrees('repo-ssh', { forceLocalOwner: true })

    expect(mockApi.worktrees.listDetected).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'repo-ssh',
        executionHostId: 'ssh:ssh-1',
        expectedAuthority: TEST_SSH_AUTHORITY
      })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    // Why: SSH worktrees are fetched via local IPC but belong to the SSH host, so they carry the repo's ssh host id.
    expect(store.getState().worktreesByRepo['repo-ssh']).toEqual([
      { ...sshWorktree, hostId: 'ssh:ssh-1' }
    ])
  })

  it('fetches the requested host when duplicate repo ids exist', async () => {
    const store = createTestStore()
    const localWorktree = makeWorktree({
      id: 'same-repo::/local/wt',
      repoId: 'same-repo',
      path: '/local/wt'
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [
        {
          id: 'same-repo',
          path: '/local/repo',
          displayName: 'Local',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: 'local'
        },
        {
          id: 'same-repo',
          path: '/remote/repo',
          displayName: 'Runtime',
          badgeColor: '#111',
          addedAt: 1,
          executionHostId: 'runtime:env-1'
        }
      ]
    } as Partial<AppState>)
    mockApi.worktrees.listDetected.mockResolvedValueOnce(
      makeDetectedResult('same-repo', [localWorktree])
    )

    await store.getState().fetchWorktrees('same-repo', { executionHostId: 'local' })

    expect(mockApi.worktrees.listDetected).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'same-repo',
        executionHostId: 'local'
      })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo['same-repo']).toEqual([localWorktree])
  })

  it('honors an explicit runtime owner before the repo catalog is hydrated', async () => {
    const store = createTestStore()
    const remote = makeWorktree({
      id: 'repo-missing::/runtime/wt',
      repoId: 'repo-missing',
      path: '/runtime/wt',
      hostId: 'local'
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: null } as never,
      repos: []
    } as Partial<AppState>)
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-missing-repo',
      ok: true,
      result: makeDetectedResult('repo-missing', [remote]),
      _meta: { runtimeId: 'runtime-remote' }
    })

    await store.getState().fetchWorktrees('repo-missing', {
      executionHostId: 'runtime:env-1',
      requireAuthoritative: true
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'worktree.detectedList',
      params: { repo: 'repo-missing' },
      timeoutMs: 15_000
    })
    expect(mockApi.worktrees.listDetected).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo['repo-missing']).toEqual([
      { ...remote, hostId: 'runtime:env-1', runtimeOwnerEnvironmentId: 'env-1' }
    ])
  })

  it('honors an explicit SSH owner before the repo catalog is hydrated', async () => {
    const store = createTestStore()
    const remote = makeWorktree({
      id: 'repo-missing::/ssh/wt',
      repoId: 'repo-missing',
      path: '/ssh/wt',
      hostId: 'local'
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-ambient' } as never,
      repos: []
    } as Partial<AppState>)
    mockApi.worktrees.listDetected.mockImplementationOnce(async (args: ListDetectedWorktreesArgs) =>
      qualifyDetectedResult(args, makeDetectedResult('repo-missing', [remote]))
    )

    await store.getState().fetchWorktrees('repo-missing', {
      executionHostId: 'ssh:ssh-1',
      requireAuthoritative: true
    })

    expect(mockApi.worktrees.listDetected).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'repo-missing',
        executionHostId: 'ssh:ssh-1',
        expectedAuthority: TEST_SSH_AUTHORITY
      })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo['repo-missing']).toEqual([
      { ...remote, hostId: 'ssh:ssh-1' }
    ])
  })

  it('rejects a missing-owner SSH result after the repo catalog changes', async () => {
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
    store.setState({ repos: [] })
    release()

    await expect(refresh).resolves.toBe(false)
    expect(store.getState().worktreesByRepo['repo-missing']).toBeUndefined()
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

  it('stamps remote runtime worktrees with the owning repo runtime host', async () => {
    const store = createTestStore()
    // Why: a remote runtime returns worktrees from its own perspective, so their hostId arrives as the default "local".
    const remote = makeWorktree({
      id: 'repo-remote::/remote/wt1',
      repoId: 'repo-remote',
      path: '/remote/wt1',
      branch: 'refs/heads/remote',
      hostId: 'local'
    })
    store.setState({
      repos: [
        {
          id: 'repo-remote',
          path: '/home/dvic/src/omarchy-dotfiles',
          displayName: 'omarchy-dotfiles',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: 'runtime:env-1'
        }
      ]
    } as Partial<AppState>)
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: makeDetectedResult('repo-remote', [remote]),
      _meta: { runtimeId: 'runtime-remote' }
    })

    await store.getState().fetchWorktrees('repo-remote', { forceLocalOwner: true })

    expect(store.getState().worktreesByRepo['repo-remote']).toEqual([
      { ...remote, hostId: 'runtime:env-1', runtimeOwnerEnvironmentId: 'env-1' }
    ])
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

  it('stamps runtime worktrees with the owning project host setup', async () => {
    const store = createTestStore()
    const remote = makeWorktree({
      id: 'repo-remote::/vercel/sandbox/orca',
      repoId: 'repo-remote',
      path: '/vercel/sandbox/orca',
      branch: 'refs/heads/Jinwoo-H/vm-improve-2',
      hostId: 'local'
    })
    store.setState({
      repos: [
        {
          id: 'repo-remote',
          path: '/vercel/sandbox/orca',
          displayName: 'orca',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: 'runtime:env-1'
        }
      ],
      projectHostSetups: [
        {
          id: 'repo-remote',
          projectId: 'github:stablyai/orca',
          hostId: 'runtime:env-1',
          repoId: 'repo-remote',
          path: '/vercel/sandbox/orca',
          displayName: 'orca',
          setupState: 'ready',
          setupMethod: 'imported-existing-folder',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    } as Partial<AppState>)
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-runtime-worktree',
      ok: true,
      result: makeDetectedResult('repo-remote', [remote]),
      _meta: { runtimeId: 'runtime-remote' }
    })

    await store.getState().fetchWorktrees('repo-remote')

    expect(store.getState().worktreesByRepo['repo-remote']).toEqual([
      {
        ...remote,
        hostId: 'runtime:env-1',
        runtimeOwnerEnvironmentId: 'env-1',
        projectId: 'github:stablyai/orca',
        projectHostSetupId: 'repo-remote'
      }
    ])
    expect(store.getState().detectedWorktreesByRepo['repo-remote']?.worktrees).toEqual([
      expect.objectContaining({
        id: remote.id,
        hostId: 'runtime:env-1',
        runtimeOwnerEnvironmentId: 'env-1',
        projectId: 'github:stablyai/orca',
        projectHostSetupId: 'repo-remote'
      })
    ])
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

  it('surfaces one deduped scope-mismatch toast when a mobile pairing forbids worktree RPCs', async () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [
        { id: 'repo1', path: '/r1', displayName: 'R1', badgeColor: '#000', addedAt: 0 },
        { id: 'repo2', path: '/r2', displayName: 'R2', badgeColor: '#000', addedAt: 0 }
      ]
    } as Partial<AppState>)
    // Why: a mobile-scope device token is denied non-allowlisted runtime RPCs.
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: false,
      error: {
        code: 'forbidden',
        message: "Method 'worktree.detectedList' is not available to mobile clients"
      },
      _meta: { runtimeId: 'runtime-remote' }
    })

    const repo1Result = await store.getState().fetchWorktrees('repo1')
    const repo2Result = await store.getState().fetchWorktrees('repo2')
    await store.getState().fetchDetectedWorktrees('repo1')

    expect(repo1Result).toBe(false)
    expect(repo2Result).toBe(false)
    expect(store.getState().worktreesByRepo.repo1).toBeUndefined()
    // Why: per-repo failures must collapse to a single stable-id toast, not spam.
    expect(toast.error).toHaveBeenCalledTimes(3)
    for (const call of (toast.error as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).toMatchObject({ id: 'runtime-scope-forbidden' })
    }
  })
})
