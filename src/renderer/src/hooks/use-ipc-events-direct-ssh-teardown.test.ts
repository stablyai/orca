import { describe, expect, it, vi } from 'vitest'
import { createHarnessStoreState, loadIpcEventsHarness } from './ipc-events-test-harness'

describe('useIpcEvents direct SSH hydration teardown', () => {
  it('drops wake ownership before target-sync stop settlement', async () => {
    const wake = vi.fn()
    const resume = vi.fn()
    const destructiveDedupe = vi.fn()
    let disposed = false
    const dispatcher = {
      request: vi.fn(),
      requestActivation: vi.fn(() => true),
      remotePullStarted: vi.fn(),
      remotePullSettled: vi.fn((_targetId: string) => {
        if (!disposed) {
          wake()
          resume()
          destructiveDedupe()
        }
      }),
      dispose: vi.fn(() => {
        disposed = true
      })
    }
    const targetSync = {
      syncAfterConnect: vi.fn(async () => {}),
      applyUnsolicitedSnapshot: vi.fn(async () => {}),
      stop: vi.fn(() => dispatcher.remotePullSettled('target-a'))
    }
    vi.doMock('@/lib/wake-sleeping-agents-in-background', () => ({
      createBackgroundSleepingAgentWakeDispatcher: () => dispatcher
    }))
    vi.doMock('./remote-workspace-target-sync', () => ({
      createRemoteWorkspaceTargetSync: () => targetSync,
      isDirectSshRemoteWorkspaceApplyInProgress: () => false
    }))

    const harness = await loadIpcEventsHarness(createHarnessStoreState({ tabsByWorktree: {} }))
    harness.useIpcEvents()
    harness.cleanup()

    expect(dispatcher.dispose).toHaveBeenCalledOnce()
    expect(targetSync.stop).toHaveBeenCalledOnce()
    expect(wake).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    expect(destructiveDedupe).not.toHaveBeenCalled()
  })
})
