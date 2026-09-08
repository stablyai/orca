import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recoverParkedPanes } from './terminal-parked-pane-recovery'
import {
  _resetTerminalPaneRecoveryForTests,
  requestTerminalPaneRecovery
} from './terminal-pane-recovery'

const state = vi.hoisted(() => ({
  ptyIdsByTabId: { 'tab-split': ['pty-a', 'pty-b'], 'tab-other': ['pty-c'] },
  getTab: () => ({}),
  remountTerminalTabForRecovery: vi.fn(() => true)
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({ recordRendererCrashBreadcrumb: vi.fn() }))

describe('parked pane recovery ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetTerminalPaneRecoveryForTests()
    state.remountTerminalTabForRecovery.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    _resetTerminalPaneRecoveryForTests()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('remounts each owning tab once without a delayed remount for its repaired split', async () => {
    await recoverParkedPanes(['pty-a', 'pty-b', 'pty-c'])
    expect(state.remountTerminalTabForRecovery.mock.calls).toEqual([['tab-split'], ['tab-other']])
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(state.remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
  })

  it('requires fresh parked evidence after a cooldown instead of remounting a recovered pane', async () => {
    await requestTerminalPaneRecovery({
      tabId: 'tab-split',
      ptyId: 'pty-a',
      reason: 'write-stalled'
    })
    await recoverParkedPanes(['pty-a'])
    // The pane binds during cooldown; the watchdog supplies no further parked evidence.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(state.remountTerminalTabForRecovery).toHaveBeenCalledTimes(1)

    await recoverParkedPanes(['pty-a'])
    expect(state.remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
  })
})
