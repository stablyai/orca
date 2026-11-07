import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import '../../../../shared/constants'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore, seedStore } from '../testing/app-store-test-fixture'
import { makeTab } from './terminal-tab.test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'
import { shutdownBufferCaptures } from '@/components/terminal-pane/snapshots/shutdown-buffer-captures'
import { applySleepRuntimeRpcDefault } from './terminal-sleep-rpc.test-fixture'
import { createStoreCascadesMockApi } from '../testing/app-store-cascade-api.test-fixture'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
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
