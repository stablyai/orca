import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultSettings } from '../../../../shared/constants'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'
import {
  applySleepRuntimeRpcDefault,
  createStoreCascadesMockApi
} from './store-cascades-test-harness'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreCascadesMockApi()

// Sleep must clear live/retained status or mid-turn agents remain working until the 30-minute TTL.
describe('shutdownWorktreeTerminals (sleep) — agent status hygiene', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    mockApi.pty.kill.mockResolvedValue(undefined)
    mockUnregisterPtyDataHandlers.mockReturnValue([])
    applySleepRuntimeRpcDefault(mockApi)
    shutdownBufferCaptures.clear()
  })

  it('does not stop the active runtime when sleeping an SSH-owned worktree', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      repos: [
        {
          id: 'repo1',
          path: '/repo1',
          displayName: 'Repo 1',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-1'
        }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1', hostId: 'ssh:ssh-1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, ptyId: 'ssh:ssh-1@@pty-1' })]
      },
      ptyIdsByTabId: { 'tab-1': ['ssh:ssh-1@@pty-1'] }
    })

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    expect(mockApi.runtimeEnvironments.call).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.stop' })
    )
    expect(mockApi.runtimeEnvironments.call).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.sleep' })
    )
    expect(mockApi.pty.kill).toHaveBeenCalledWith('ssh:ssh-1@@pty-1', { keepHistory: true })
  })

  it('rolls back renderer teardown when a local physical PTY kill rejects', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const handlerSnapshots = [{ ptyId: 'pty-1', dataHandler: vi.fn() }]
    mockUnregisterPtyDataHandlers.mockReturnValueOnce(handlerSnapshots)
    mockApi.pty.kill.mockRejectedValueOnce(new Error('physical stop failed'))
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: { [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })] },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })
    store.getState().setAgentStatus('tab-1:leaf-1', {
      state: 'working',
      prompt: 'still live',
      agentType: 'codex'
    })

    await expect(
      store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })
    ).rejects.toThrow('physical stop failed')

    expect(mockRestorePtyDataHandlersAfterFailedShutdown).toHaveBeenCalledWith(handlerSnapshots)
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual(['pty-1'])
    expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']).toBeDefined()
    expect(store.getState().suppressedPtyExitIds['pty-1']).toBeUndefined()
  })

  it('waits for sibling local PTY kills before rolling back a failed shutdown', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    let resolveSlowKill = (): void => {}
    const slowKill = new Promise<void>((resolve) => {
      resolveSlowKill = resolve
    })
    const handlerSnapshots = [
      { ptyId: 'pty-fails', dataHandler: vi.fn() },
      { ptyId: 'pty-slow', dataHandler: vi.fn() }
    ]
    mockUnregisterPtyDataHandlers.mockReturnValueOnce(handlerSnapshots)
    mockApi.pty.kill.mockImplementation((ptyId: string) =>
      ptyId === 'pty-fails' ? Promise.reject(new Error('physical stop failed')) : slowKill
    )
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: { [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })] },
      ptyIdsByTabId: { 'tab-1': ['pty-fails', 'pty-slow'] }
    })

    const shutdown = store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })
    const rejection = expect(shutdown).rejects.toThrow('physical stop failed')
    await vi.waitFor(() => expect(mockApi.pty.kill).toHaveBeenCalledTimes(2))
    expect(mockRestorePtyDataHandlersAfterFailedShutdown).not.toHaveBeenCalled()
    expect(store.getState().pendingPtyShutdownIds['pty-slow']).toBe(1)

    resolveSlowKill()
    await rejection

    expect(mockRestorePtyDataHandlersAfterFailedShutdown).toHaveBeenCalledWith([
      handlerSnapshots[0]
    ])
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual(['pty-fails'])
    expect(store.getState().suppressedPtyExitIds['pty-slow']).toBe(true)
    expect(store.getState().suppressedPtyExitIds['pty-fails']).toBeUndefined()
    expect(store.getState().pendingPtyShutdownIds['pty-slow']).toBeUndefined()
  })
})
