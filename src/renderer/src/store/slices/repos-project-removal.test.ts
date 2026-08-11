import { describe, expect, it, vi } from 'vitest'
import { createTestStore, makeWorktree } from './store-test-helpers'
import {
  installReposRuntimeRoutingHarness,
  localRepo,
  ptyKill,
  remoteRepo,
  reposRemove,
  runtimeCall,
  runtimeEnvironmentCall
} from './repos-runtime-routing-fixture'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))

installReposRuntimeRoutingHarness()

describe('project terminal removal', () => {
  it('routes local removal through the authoritative runtime', async () => {
    const store = createTestStore()
    store.setState({ repos: [localRepo] })

    await store.getState().removeProject(localRepo.id)

    expect(runtimeCall).toHaveBeenCalledWith({
      method: 'repo.rm',
      params: { repo: localRepo.id, hostId: 'local' }
    })
    expect(reposRemove).not.toHaveBeenCalled()
  })

  it('stops remote terminals without following stale or remote ids through local IPC', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-remote',
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    const worktreeId = `${remoteRepo.id}::/remote/wt`
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [remoteRepo],
      worktreesByRepo: {
        [remoteRepo.id]: [makeWorktree({ id: worktreeId, repoId: remoteRepo.id })]
      },
      tabsByWorktree: {
        [worktreeId]: [{ id: 'tab-1', worktreeId, ptyId: 'pty-current' } as never]
      },
      ptyIdsByTabId: {
        'tab-1': ['remote:term-1', 'pty-local-stale', 'pty-current']
      },
      lastKnownRelayPtyIdByTabId: { 'tab-1': 'pty-last-known-relay' }
    })

    await store.getState().removeProject(remoteRepo.id)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.stop',
      params: { worktree: `id:${worktreeId}` },
      timeoutMs: 15_000
    })
    expect(ptyKill).toHaveBeenCalledWith('pty-local-stale')
    expect(ptyKill).toHaveBeenCalledWith('pty-current')
    expect(ptyKill).toHaveBeenCalledWith('pty-last-known-relay')
    expect(ptyKill).not.toHaveBeenCalledWith('remote:term-1')
    expect(ptyKill).toHaveBeenCalledTimes(3)
  })

  it('stops remote terminals before removing the project from its runtime', async () => {
    const callOrder: string[] = []
    let settleStop: (() => void) | undefined
    const stopSettled = new Promise<void>((resolve) => (settleStop = resolve))
    runtimeEnvironmentCall.mockImplementation(async (args) => {
      callOrder.push(args.method)
      if (args.method === 'terminal.stop') {
        await stopSettled
      }
      return {
        id: `rpc-${args.method}`,
        ok: true,
        result: args.method === 'repo.rm' ? { removed: true } : { ok: true },
        _meta: { runtimeId: 'runtime-remote' }
      }
    })
    const store = createTestStore()
    const worktreeId = `${remoteRepo.id}::/remote/wt`
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [remoteRepo],
      worktreesByRepo: {
        [remoteRepo.id]: [makeWorktree({ id: worktreeId, repoId: remoteRepo.id })]
      }
    })

    const removal = store.getState().removeProject(remoteRepo.id)
    await vi.waitFor(() => expect(callOrder).toEqual(['terminal.stop']))
    settleStop?.()
    await removal

    expect(callOrder).toEqual(['terminal.stop', 'repo.rm'])
  })

  it('keeps removal retryable when terminal stop is unavailable', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    runtimeEnvironmentCall.mockImplementation(async (args) => {
      if (args.method === 'terminal.stop') {
        throw new Error('remote transport unavailable')
      }
      return {
        id: 'rpc-remove',
        ok: true,
        result: { removed: true },
        _meta: { runtimeId: 'runtime-remote' }
      }
    })
    const store = createTestStore()
    const worktreeId = `${remoteRepo.id}::/remote/wt`
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [remoteRepo],
      worktreesByRepo: {
        [remoteRepo.id]: [makeWorktree({ id: worktreeId, repoId: remoteRepo.id })]
      }
    })

    await store.getState().removeProject(remoteRepo.id)

    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'repo.rm' })
    )
    expect(store.getState().repos).toContainEqual(remoteRepo)
    consoleError.mockRestore()
  })
})
