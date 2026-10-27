import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const store: Record<string, unknown> = {}
  return {
    createWorktree: vi.fn(),
    resolvePrBase: vi.fn(),
    checkRuntimeHooks: vi.fn(),
    callRuntimeRpc: vi.fn(),
    ensureHooksConfirmed: vi.fn(),
    store
  }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.store } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))
vi.mock('@/lib/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: mocks.ensureHooksConfirmed
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/runtime/runtime-hooks-client', () => ({ checkRuntimeHooks: mocks.checkRuntimeHooks }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), tuiAgentToAgentKind: (a: string) => a }))

import { launchWorkItemDirect } from './launch-work-item-direct'

// Why: preflight, the PR start point and `git worktree add` must agree on one host per launch.
describe('launchWorkItemDirect owner row', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ensureHooksConfirmed.mockResolvedValue('run')
    vi.stubGlobal('window', { api: { worktrees: { resolvePrBase: mocks.resolvePrBase } } })
    mocks.checkRuntimeHooks.mockResolvedValue({
      hasHooks: false,
      hooks: null,
      mayNeedUpdate: false
    })
    // Why: stop after create; the agent launch that follows is covered elsewhere.
    mocks.createWorktree.mockRejectedValue(new Error('stop after create'))
    mocks.store = {
      repos: [],
      worktreesByRepo: {},
      sshConnectionStates: new Map(),
      sshStateByEnvironment: new Map(),
      // Why: a launch stops before creating anything on a server that has not reported its OS.
      runtimeStatusByEnvironmentId: new Map([
        ['env-b', { checkedAt: 1, status: { hostPlatform: 'linux' } }]
      ]),
      settings: {},
      ensureDetectedAgents: vi.fn().mockResolvedValue([]),
      ensureRemoteDetectedAgents: vi.fn().mockResolvedValue([]),
      ensureRuntimeDetectedAgents: vi.fn().mockResolvedValue([]),
      createWorktree: mocks.createWorktree
    }
  })

  it('runs setup preflight, the PR start point and createWorktree on the one owner row', async () => {
    mocks.store.settings = { activeRuntimeEnvironmentId: 'env-a' }
    mocks.store.repos = [
      {
        id: 'repo-1',
        path: '/srv/repo',
        displayName: 'Repo',
        badgeColor: '#000',
        addedAt: 1,
        executionHostId: 'runtime:env-b'
      }
    ]
    mocks.callRuntimeRpc.mockResolvedValue({ baseBranch: 'abc123', headSha: 'abc123' })

    await launchWorkItemDirect({
      repoId: 'repo-1',
      launchSource: 'task_page',
      telemetrySource: 'sidebar',
      openModalFallback: vi.fn(),
      item: { type: 'pr', number: 7, title: 'Fix', url: 'https://github.com/o/r/pull/7' }
    })

    expect(mocks.checkRuntimeHooks).toHaveBeenCalledWith('runtime:env-b', 'repo-1')
    expect(mocks.ensureHooksConfirmed).toHaveBeenCalledWith(
      expect.anything(),
      'repo-1',
      'setup',
      'runtime:env-b'
    )
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-b' },
      'worktree.resolvePrBase',
      expect.objectContaining({ repo: 'repo-1', prNumber: 7 }),
      expect.anything()
    )
    expect(mocks.resolvePrBase).not.toHaveBeenCalled()
    expect(mocks.createWorktree.mock.calls[0]?.at(-1)).toEqual({ executionHostId: 'runtime:env-b' })
    // Wait for the created workspace to ask its server for agents; never probe this client instead (#29599).
    expect(mocks.store.ensureRuntimeDetectedAgents).not.toHaveBeenCalled()
    expect(mocks.store.ensureDetectedAgents).not.toHaveBeenCalled()
  })

  it('asks the user instead of tie-breaking by focus when two hosts share the repo id', async () => {
    mocks.store.settings = { activeRuntimeEnvironmentId: 'env-b' }
    mocks.store.repos = [
      {
        id: 'repo-1',
        path: '/srv/a',
        displayName: 'Repo',
        badgeColor: '#000',
        addedAt: 1,
        executionHostId: 'runtime:env-a'
      },
      {
        id: 'repo-1',
        path: '/srv/b',
        displayName: 'Repo',
        badgeColor: '#000',
        addedAt: 1,
        executionHostId: 'runtime:env-b'
      }
    ]
    const openModalFallback = vi.fn()

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        telemetrySource: 'sidebar',
        openModalFallback,
        item: { type: 'pr', number: 7, title: 'Fix', url: 'https://github.com/o/r/pull/7' }
      })
    ).resolves.toBe(false)

    expect(openModalFallback).toHaveBeenCalled()
    expect(mocks.checkRuntimeHooks).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(mocks.createWorktree).not.toHaveBeenCalled()
  })
})
