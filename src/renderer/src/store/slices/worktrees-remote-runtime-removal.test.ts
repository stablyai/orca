import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { RuntimeEnvironmentCallRequest } from '../../runtime/runtime-compatibility-test-fixture'
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

describe('worktree remote runtime mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
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

    const result = await store
      .getState()
      .removeWorktree({ id: wt.id, executionHostId: null }, false, {
        snapshotPruneBatchId: 'batch-1'
      })

    expect(result).toEqual({ ok: true })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'worktree.rm',
      params: {
        worktree: `id:${wt.id}`,
        hostId: 'runtime:env-1',
        force: false,
        allowUnverifiedPtyStop: false,
        runHooks: true
      },
      timeoutMs: 60_000,
      expectedEnvironmentPairingRevision: undefined,
      expectedRuntimeId: undefined
    })
    expect(mockApi.worktrees.remove).not.toHaveBeenCalled()
    expect(mockApi.workspaceCleanup.recordRemovalSnapshotPrune).toHaveBeenCalledExactlyOnceWith({
      batchId: 'batch-1',
      worktreeId: wt.id,
      executionHostId: 'runtime:env-1'
    })
    expect(store.getState().shutdownWorktreeTerminals).toHaveBeenCalledWith(wt.id, {
      shutdownReason: 'remove-worktree',
      backendOwnsPtyTeardown: true
    })
    expect(store.getState().worktreesByRepo.repo1).toEqual([])
  })

  it('does not clean up a hidden same-id VM owned by another host', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/shared',
      repoId: 'repo1',
      path: '/path/shared',
      hostId: 'ssh:runtime-ssh-a'
    })
    mockApi.ephemeralVm.listRuntimes.mockResolvedValue([
      {
        id: 'runtime-a',
        workspaceId: wt.id,
        sshTargetId: 'runtime-ssh-a',
        cleanupStatus: 'not_started'
      },
      {
        id: 'runtime-b',
        workspaceId: wt.id,
        sshTargetId: 'runtime-ssh-b',
        cleanupStatus: 'not_started'
      }
    ] as never)
    store.setState({ worktreesByRepo: { repo1: [wt] } } as Partial<AppState>)

    await expect(
      store.getState().removeWorktree({ id: wt.id, executionHostId: 'ssh:runtime-ssh-a' })
    ).resolves.toEqual({ ok: true })

    expect(mockApi.ephemeralVm.cleanup).toHaveBeenCalledTimes(1)
    expect(mockApi.ephemeralVm.cleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-a' })
  })

  it('removes a HUB-owned SSH worktree through its exact HUB transport owner', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo-ssh::/srv/nested-wt',
      repoId: 'repo-ssh',
      path: '/srv/nested-wt',
      hostId: 'ssh:hub-private-target',
      runtimeOwnerEnvironmentId: 'owner-hub'
    })
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'rpc-rm-nested',
        ok: true,
        result: {
          preservedBranch: { branchName: 'feature/nested', head: 'saved-head' }
        },
        _meta: { runtimeId: 'runtime-owner-hub' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-force-delete-branch',
        ok: true,
        result: { deleted: true },
        _meta: { runtimeId: 'runtime-owner-hub' }
      })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'different-hub' } as never,
      worktreesByRepo: { 'repo-ssh': [wt] }
    } as Partial<AppState>)

    const result = await store.getState().removeWorktree({ id: wt.id, executionHostId: null })

    expect(result).toEqual({
      ok: true,
      preservedBranch: {
        branchName: 'feature/nested',
        head: 'saved-head',
        hostId: 'ssh:hub-private-target',
        runtimeEnvironmentId: 'owner-hub'
      }
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'owner-hub',
      method: 'worktree.rm',
      params: {
        worktree: `id:${wt.id}`,
        hostId: 'ssh:hub-private-target',
        force: undefined,
        allowUnverifiedPtyStop: false,
        runHooks: true
      },
      timeoutMs: 60_000
    })
    expect(mockApi.worktrees.remove).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo['repo-ssh']).toEqual([])

    const forceResult = await store
      .getState()
      .forceDeletePreservedBranch(wt.id, 'feature/nested', 'saved-head')

    expect(forceResult).toEqual({ ok: true, deleted: true })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'owner-hub',
      method: 'worktree.forceDeleteBranch',
      params: {
        worktree: `id:${wt.id}`,
        branchName: 'feature/nested',
        expectedHead: 'saved-head',
        hostId: 'ssh:hub-private-target'
      },
      timeoutMs: 15_000
    })
  })

  it('retains separate preserved-branch cleanup routes for sequential same-id hosts', async () => {
    const store = createTestStore()
    const worktreeId = 'repo-shared::/same/path'
    const localWorktree = makeWorktree({
      id: worktreeId,
      repoId: 'repo-shared',
      path: '/same/path',
      hostId: 'local'
    })
    const remoteWorktree = makeWorktree({
      id: worktreeId,
      repoId: 'repo-shared',
      path: '/same/path',
      hostId: 'ssh:shared-target',
      runtimeOwnerEnvironmentId: 'shared-hub'
    })
    mockApi.worktrees.remove.mockResolvedValueOnce({
      preservedBranch: { branchName: 'feature/local', head: 'local-head' }
    })
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) =>
      Promise.resolve({
        id: `rpc-${method}`,
        ok: true,
        result:
          method === 'repo.hooksCheck'
            ? { hasHooks: false, hooks: null, mayNeedUpdate: false }
            : method === 'worktree.rm'
              ? {
                  preservedBranch: { branchName: 'feature/remote', head: 'remote-head' }
                }
              : { deleted: true },
        _meta: { runtimeId: 'runtime-shared-hub' }
      })
    )
    store.setState({
      worktreesByRepo: { 'repo-shared': [localWorktree] }
    } as Partial<AppState>)

    await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })
    store.setState({
      worktreesByRepo: { 'repo-shared': [remoteWorktree] }
    } as Partial<AppState>)
    await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })

    await store
      .getState()
      .forceDeletePreservedBranch(worktreeId, 'feature/local', 'local-head', { hostId: 'local' })
    await store.getState().forceDeletePreservedBranch(worktreeId, 'feature/remote', 'remote-head', {
      hostId: 'ssh:shared-target',
      runtimeEnvironmentId: 'shared-hub'
    })

    expect(mockApi.worktrees.forceDeletePreservedBranch).toHaveBeenCalledWith({
      worktreeId,
      branchName: 'feature/local',
      expectedHead: 'local-head',
      hostId: 'local'
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'shared-hub',
        method: 'worktree.forceDeleteBranch',
        params: {
          worktree: `id:${worktreeId}`,
          branchName: 'feature/remote',
          expectedHead: 'remote-head',
          hostId: 'ssh:shared-target'
        }
      })
    )
  })

  it('fails closed when several hosts preserved the same branch and no host is specified', async () => {
    const store = createTestStore()
    const worktreeId = 'repo-shared::/same/path'
    const localWorktree = makeWorktree({
      id: worktreeId,
      repoId: 'repo-shared',
      path: '/same/path',
      hostId: 'local'
    })
    const remoteWorktree = makeWorktree({
      id: worktreeId,
      repoId: 'repo-shared',
      path: '/same/path',
      hostId: 'ssh:shared-target',
      runtimeOwnerEnvironmentId: 'shared-hub'
    })
    mockApi.worktrees.remove.mockResolvedValueOnce({
      preservedBranch: { branchName: 'feature/shared', head: 'shared-head' }
    })
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) =>
      Promise.resolve({
        id: `rpc-${method}`,
        ok: true,
        result:
          method === 'repo.hooksCheck'
            ? { hasHooks: false, hooks: null, mayNeedUpdate: false }
            : method === 'worktree.rm'
              ? { preservedBranch: { branchName: 'feature/shared', head: 'shared-head' } }
              : { deleted: true },
        _meta: { runtimeId: 'runtime-shared-hub' }
      })
    )
    store.setState({
      worktreesByRepo: { 'repo-shared': [localWorktree] }
    } as Partial<AppState>)

    await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })
    store.setState({
      worktreesByRepo: { 'repo-shared': [remoteWorktree] }
    } as Partial<AppState>)
    await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })

    const result = await store
      .getState()
      .forceDeletePreservedBranch(worktreeId, 'feature/shared', 'shared-head', {
        suppressToast: true
      })

    // Routing to the active runtime could hit the wrong host's branch, so the delete fails closed.
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('Multiple preserved branch cleanups')
    })
    expect(mockApi.worktrees.forceDeletePreservedBranch).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'worktree.forceDeleteBranch' })
    )
  })

  it('fails HUB-owned SSH removal closed when the exact id has two HUB owners', async () => {
    const store = createTestStore()
    const worktreeId = 'repo-ssh::/srv/same-wt'
    store.setState({
      worktreesByRepo: {
        'repo-ssh': [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo-ssh',
            hostId: 'ssh:same-private-target',
            runtimeOwnerEnvironmentId: 'hub-a'
          }),
          makeWorktree({
            id: worktreeId,
            repoId: 'repo-ssh',
            hostId: 'ssh:same-private-target',
            runtimeOwnerEnvironmentId: 'hub-b'
          })
        ]
      }
    } as Partial<AppState>)

    const result = await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })

    expect(result).toEqual({
      ok: false,
      error: 'Workspace identity is ambiguous across hosts. Refresh projects and try again.'
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.worktrees.remove).not.toHaveBeenCalled()
  })

  it.each(['repo_not_found', 'selector_not_found'])(
    'forgets a mirrored row when the remote returns %s',
    async (errorCode) => {
      const store = createTestStore()
      const wt = makeWorktree({
        id: 'repo-gone::/path/stale',
        repoId: 'repo-gone',
        path: '/path/stale',
        hostId: 'runtime:env-1'
      })
      runtimeEnvironmentCall.mockResolvedValue({
        id: 'rpc-rm',
        ok: false,
        error: { code: errorCode, message: errorCode },
        _meta: { runtimeId: 'runtime-remote' }
      })
      store.setState({
        settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
        worktreesByRepo: { 'repo-gone': [wt] }
      } as Partial<AppState>)

      const result = await store.getState().removeWorktree({ id: wt.id, executionHostId: null })

      expect(result).toEqual({ ok: true })
      expect(mockApi.worktrees.forgetLocal).toHaveBeenCalledWith({
        worktreeId: wt.id,
        hostId: 'runtime:env-1'
      })
      expect(store.getState().worktreesByRepo['repo-gone']).toEqual([])
    }
  )

  it('does not forget a row that becomes ambiguous while remote removal is in flight', async () => {
    const store = createTestStore()
    const worktreeId = 'repo-shared::/path/stale'
    const original = makeWorktree({
      id: worktreeId,
      repoId: 'repo-shared',
      hostId: 'runtime:env-1'
    })
    const rival = makeWorktree({
      id: worktreeId,
      repoId: 'repo-shared',
      hostId: 'runtime:env-2'
    })
    runtimeEnvironmentCall.mockImplementationOnce(async () => {
      store.setState({ worktreesByRepo: { 'repo-shared': [original, rival] } })
      return {
        id: 'rpc-rm',
        ok: false,
        error: { code: 'selector_not_found', message: 'selector_not_found' },
        _meta: { runtimeId: 'runtime-remote' }
      }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      trustedOrcaHooks: { 'repo-shared': { all: { approvedAt: 1 } } },
      worktreesByRepo: { 'repo-shared': [original] }
    } as Partial<AppState>)

    const result = await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })

    expect(result).toEqual({
      ok: false,
      error: 'selector_not_found'
    })
    expect(mockApi.worktrees.forgetLocal).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo['repo-shared']).toEqual([original, rival])
  })

  it('refuses an unqualified forget-local when same-id rows exist on two hosts', async () => {
    const store = createTestStore()
    const worktreeId = 'repo-shared::/path/stale'
    const local = makeWorktree({
      id: worktreeId,
      repoId: 'repo-shared',
      hostId: 'local'
    })
    const remote = makeWorktree({
      id: worktreeId,
      repoId: 'repo-shared',
      hostId: 'runtime:env-1'
    })
    store.setState({
      worktreesByRepo: { 'repo-shared': [local, remote] }
    } as Partial<AppState>)

    const result = await store
      .getState()
      .removeWorktree({ id: worktreeId, executionHostId: null }, false, {
        mode: 'forget-local'
      })

    expect(result).toEqual({
      ok: false,
      error: 'Workspace identity is ambiguous across hosts. Refresh projects and try again.'
    })
    expect(mockApi.worktrees.forgetLocal).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo['repo-shared']).toEqual([local, remote])
  })

  it('does not forget a mirrored row when diagnostics merely mention a missing code', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      hostId: 'runtime:env-1'
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-rm',
      ok: false,
      error: {
        code: 'permission_denied',
        message: 'Access denied while checking a prior repo_not_found diagnostic.'
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    const result = await store.getState().removeWorktree({ id: wt.id, executionHostId: null })

    expect(result).toEqual({
      ok: false,
      error: 'Access denied while checking a prior repo_not_found diagnostic.'
    })
    expect(mockApi.worktrees.forgetLocal).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo.repo1).toEqual([wt])
  })

  // Why (#11960): the store is where `force` and the PTY-stop waiver could most
  // easily be collapsed back into one flag. The ordinary delete confirmation
  // passes force:true, so that alone must never reach the gate as a waiver.
  it('sends force without the PTY-stop waiver unless a caller asks for it', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/w/one', repoId: 'repo1', path: '/w/one' })
    store.setState({ worktreesByRepo: { repo1: [wt] } } as Partial<AppState>)

    await store.getState().removeWorktree({ id: wt.id, executionHostId: null }, true)
    expect(mockApi.worktrees.remove).toHaveBeenLastCalledWith(
      expect.objectContaining({ force: true, allowUnverifiedPtyStop: false })
    )

    // Re-seed: the first removal dropped the row, and a second call for a missing
    // worktree never reaches the API — which would silently re-read the call above.
    const retry = makeWorktree({ id: 'repo1::/w/two', repoId: 'repo1', path: '/w/two' })
    store.setState({ worktreesByRepo: { repo1: [retry] } } as Partial<AppState>)

    await store.getState().removeWorktree({ id: retry.id, executionHostId: null }, true, {
      allowUnverifiedPtyStop: true
    })
    expect(mockApi.worktrees.remove).toHaveBeenLastCalledWith(
      expect.objectContaining({ force: true, allowUnverifiedPtyStop: true })
    )
  })

  it('removes SSH-owned worktrees through local IPC even when a runtime is focused', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo-ssh::/home/orca/wt1',
      repoId: 'repo-ssh',
      path: '/home/orca/wt1'
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
      ],
      worktreesByRepo: { 'repo-ssh': [wt] }
    } as Partial<AppState>)

    const result = await store.getState().removeWorktree({ id: wt.id, executionHostId: null })

    expect(result).toEqual({ ok: true })
    expect(mockApi.worktrees.remove).toHaveBeenCalledWith({
      worktreeId: wt.id,
      hostId: 'ssh:ssh-1',
      force: undefined,
      // Why (#11960): an ordinary remove never waives the PTY-stop proof.
      allowUnverifiedPtyStop: false,
      skipArchive: false
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo['repo-ssh']).toEqual([])
  })

  it('fails closed before deleting an exact worktree id owned by multiple hosts', async () => {
    const store = createTestStore()
    const worktreeId = 'repo-shared::/same/path'
    store.setState({
      repos: [
        { id: 'repo-shared', path: '/local', displayName: 'Local', badgeColor: '#000', addedAt: 0 },
        {
          id: 'repo-shared',
          path: '/remote',
          displayName: 'SSH',
          badgeColor: '#111',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      worktreesByRepo: {
        'repo-shared': [
          makeWorktree({ id: worktreeId, repoId: 'repo-shared', hostId: 'local' }),
          makeWorktree({ id: worktreeId, repoId: 'repo-shared', hostId: 'ssh:ssh-1' })
        ]
      }
    } as Partial<AppState>)

    const result = await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })

    expect(result).toEqual({
      ok: false,
      error: 'Workspace identity is ambiguous across hosts. Refresh projects and try again.'
    })
    expect(mockApi.worktrees.remove).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})
