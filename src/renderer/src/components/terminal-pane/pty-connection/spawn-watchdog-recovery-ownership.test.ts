import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetTerminalPaneRecoveryForTests,
  captureTerminalPaneRecoveryGeneration,
  registerTerminalPaneRecoveryInstance,
  requestTerminalPaneRecovery
} from '../terminal-pane-recovery'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import {
  pendingSpawnByPaneKey,
  pendingSpawnGenerationByPaneKey,
  SPAWN_SETTLEMENT_WATCHDOG_MS
} from './pty-connect-limits'
import { observeSpawnSettlement } from './unbound-pane-spawn-recovery'

const mocks = vi.hoisted(() => ({ remount: vi.fn(() => true) }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ remountTerminalTabForRecovery: mocks.remount }) }
}))
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({ recordRendererCrashBreadcrumb: vi.fn() }))

function startSpawn(key = 'pane-key') {
  const session = {
    deps: { tabId: 'tab-1', worktreeId: 'wt-1' },
    pane: { id: 1, leafId: 'leaf-1' },
    terminalRecoveryGeneration: captureTerminalPaneRecoveryGeneration('tab-1'),
    terminalRecoveryInstance: registerTerminalPaneRecoveryInstance('tab-1'),
    disposed: false,
    pendingSpawnKey: key,
    transport: { getPtyId: () => null }
  } as unknown as ConnectPanePtySession
  const promise = new Promise<string | null>(() => {})
  pendingSpawnByPaneKey.set(key, promise)
  observeSpawnSettlement(session, promise)
  return session
}

describe('spawn watchdog recovery ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    pendingSpawnByPaneKey.clear()
    pendingSpawnGenerationByPaneKey.clear()
    _resetTerminalPaneRecoveryForTests()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    _resetTerminalPaneRecoveryForTests()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('does not let a disposed spawn remount a tab that already recovered', async () => {
    const session = startSpawn()
    await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-sibling',
      reason: 'write-stalled',
      terminalRecoveryGeneration: session.terminalRecoveryGeneration
    })
    session.disposed = true
    session.terminalRecoveryInstance.unregister()
    expect(mocks.remount).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(SPAWN_SETTLEMENT_WATCHDOG_MS)

    expect(pendingSpawnByPaneKey.has('pane-key')).toBe(false)
    expect(mocks.remount).toHaveBeenCalledTimes(1)
  })

  it('does not remount a newer pending spawn in the same pane generation', async () => {
    startSpawn()
    await vi.advanceTimersByTimeAsync(1_000)
    startSpawn()

    await vi.advanceTimersByTimeAsync(SPAWN_SETTLEMENT_WATCHDOG_MS - 1_000)
    expect(mocks.remount).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.remount).toHaveBeenCalledTimes(1)
  })

  it('still recovers an adopter in the original recovery generation', async () => {
    const session = startSpawn()
    session.disposed = true
    session.terminalRecoveryInstance.unregister()
    registerTerminalPaneRecoveryInstance('tab-1')

    await vi.advanceTimersByTimeAsync(SPAWN_SETTLEMENT_WATCHDOG_MS)

    expect(mocks.remount).toHaveBeenCalledExactlyOnceWith('tab-1')
  })
})
