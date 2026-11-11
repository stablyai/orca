import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetTerminalPaneRecoveryForTests,
  requestTerminalPaneRecovery
} from './terminal-pane-recovery'
import { requestAndSettle } from './terminal-recovery-ledger-test-driver'
import {
  recoveryLedgerMocks as mocks,
  resetRecoveryLedgerStore,
  setTerminalTabs,
  terminalTabs
} from './terminal-recovery-ledger-test-store'
import { isTerminalInputQuarantined } from '../../input/terminal-input-quarantine'

const { notifyTerminalInputNotSent } = vi.hoisted(() => ({ notifyTerminalInputNotSent: vi.fn() }))
vi.mock('../../input/terminal-input-not-sent-notice', () => ({ notifyTerminalInputNotSent }))

vi.mock('@/store/index', async () => {
  const store = await import('./terminal-recovery-ledger-test-store')
  return { useAppStore: { getState: () => store.recoveryLedgerStoreState() } }
})

vi.mock('@/diagnostics/crash-reporting/crash-breadcrumb-recorder', async () => {
  const store = await import('./terminal-recovery-ledger-test-store')
  return { recordRendererCrashBreadcrumb: store.recoveryLedgerMocks.recordRendererCrashBreadcrumb }
})

beforeEach(() => {
  _resetTerminalPaneRecoveryForTests()
  notifyTerminalInputNotSent.mockReset()
  resetRecoveryLedgerStore()
  setTerminalTabs([{ id: 'tab-1' }, { id: 'tab-ssh' }])
  vi.stubGlobal('window', {
    api: { pty: { hasPty: mocks.hasPty } }
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('requestTerminalPaneRecovery', () => {
  it('records a breadcrumb when the tab cannot be remounted, without consuming budget', async () => {
    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-gone',
      ptyId: 'pty-1',
      reason: 'restore-blocked'
    })

    expect(result).toBe(false)
    expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      'terminal_pane_recovery_remount_unavailable',
      { tabId: 'tab-gone', reason: 'restore-blocked' }
    )
    // Budget untouched: a later request for the same tab may still remount.
    setTerminalTabs([...terminalTabs(), { id: 'tab-gone' }])
    expect(
      await requestTerminalPaneRecovery({
        tabId: 'tab-gone',
        ptyId: 'pty-1',
        reason: 'restore-blocked'
      })
    ).toBe(true)
  })

  it('reopens a settled failure when the row moves to a new generation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    await requestAndSettle(
      { tabId: 'tab-ssh', ptyId: 'ssh:target@@pty-1', reason: 'reattach-unverifiable' },
      'failed'
    )
    vi.setSystemTime(60_000)
    expect(
      await requestTerminalPaneRecovery({
        tabId: 'tab-ssh',
        ptyId: 'ssh:target@@pty-1',
        reason: 'reattach-unverifiable'
      })
    ).toBe(false)

    // An SSH authority rotation / activation respawn bumps tab.generation.
    setTerminalTabs(
      terminalTabs().map((tab) =>
        tab.id === 'tab-ssh' ? { ...tab, generation: (tab.generation ?? 0) + 1 } : tab
      )
    )
    expect(
      await requestTerminalPaneRecovery({
        tabId: 'tab-ssh',
        ptyId: 'ssh:target@@pty-1',
        reason: 'reattach-unverifiable'
      })
    ).toBe(true)
  })

  it('does not reopen a settled failure when a host rebuild drops generation', async () => {
    // Snapshot omission of generation is not a new recovery trigger; otherwise each republication restores allowance.
    vi.useFakeTimers()
    vi.setSystemTime(0)
    await requestAndSettle(
      { tabId: 'tab-ssh', ptyId: 'ssh:target@@pty-1', reason: 'reattach-unverifiable' },
      'failed'
    )
    const rebuilt = terminalTabs().map((tab) =>
      tab.id === 'tab-ssh' ? { id: tab.id, recovery: tab.recovery } : tab
    )
    setTerminalTabs(rebuilt)

    vi.setSystemTime(60_000)
    expect(
      await requestTerminalPaneRecovery({
        tabId: 'tab-ssh',
        ptyId: 'ssh:target@@pty-1',
        reason: 'reattach-unverifiable'
      })
    ).toBe(false)
  })

  it('recovers input-undeliverable panes when the PTY is alive', async () => {
    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'input-undeliverable'
    })

    expect(result).toBe(true)
    expect(mocks.hasPty).toHaveBeenCalledWith('pty-1')
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-1')
  })

  it('proceeds when PTY liveness is unknown (probe threw)', async () => {
    mocks.hasPty.mockRejectedValue(new Error('ipc down'))

    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'input-undeliverable'
    })

    expect(result).toBe(true)
  })

  it('recovers a remote pane when liveness is authoritative true', async () => {
    mocks.hasPty.mockResolvedValue(true)

    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'remote:pty-1',
      reason: 'input-undeliverable',
      requireAuthoritativeLiveness: true
    })

    expect(result).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-1')
  })

  // Local hasPty cannot speak for remote: IDs; none of its answers is owner liveness evidence (STA-2830).

  it('never throws when the store surface is partial (timer/callback contexts)', async () => {
    // Timer/write-callback recovery with partial store state must return false, never throw.
    mocks.remountTerminalTabForRecovery.mockImplementation(() => {
      throw new TypeError('remountTerminalTabForRecovery is not a function')
    })

    await expect(
      requestTerminalPaneRecovery({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'write-stalled' })
    ).resolves.toBe(false)
    // Breadcrumb failures because unconsumed budgets permit otherwise invisible cooldown retry loops.
    expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      'terminal_pane_recovery_failed',
      { tabId: 'tab-1', reason: 'write-stalled' }
    )
  })

  // Same-shell recovery cannot quarantine legitimate typing; only possible endpoint replacement may arm it (#10065).
  describe('input quarantine arming', () => {
    it('arms after a replaced endpoint so the mangled line cannot be submitted', async () => {
      const result = await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'input-undeliverable',
        endpointReplaced: true
      })

      expect(result).toBe(true)
      expect(isTerminalInputQuarantined('tab-1')).toBe(true)
    })

    it('warns that input the host never applied is gone with the old shell', async () => {
      const result = await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'input-rejected-by-host',
        endpointReplaced: true,
        hasUndeliveredInput: () => true
      })

      expect(result).toBe(true)
      expect(notifyTerminalInputNotSent).toHaveBeenCalledWith('tab-1')
    })

    it('does not arm when the same live shell is reattached', async () => {
      const result = await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'input-undeliverable'
      })

      expect(result).toBe(true)
      expect(isTerminalInputQuarantined('tab-1')).toBe(false)
    })

    it('does not arm for a stalled write pipeline', async () => {
      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'write-stalled'
      })

      expect(isTerminalInputQuarantined('tab-1')).toBe(false)
    })

    it('does not arm when the remount never happened', async () => {
      const result = await requestTerminalPaneRecovery({
        tabId: 'tab-gone',
        ptyId: 'pty-1',
        reason: 'input-undeliverable',
        endpointReplaced: true
      })

      expect(result).toBe(false)
      expect(isTerminalInputQuarantined('tab-gone')).toBe(false)
    })
  })

  // Crash b5cfc6ca admitted thousands of remounts because disposal erased a module budget through a divergent tab index. Fresh epochs cannot bound this loop; durable row-ledger failure evidence must.
})
