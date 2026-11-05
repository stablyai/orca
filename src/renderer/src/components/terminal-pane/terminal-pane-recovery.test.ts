import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetTerminalPaneRecoveryForTests,
  captureTerminalPaneRecoveryGeneration,
  registerTerminalPaneRecoveryInstance,
  requestTerminalPaneRecovery,
  settleTerminalPaneRecovery
} from './terminal-pane-recovery'
import { requestAndSettle, settleCurrentRecovery } from './terminal-recovery-ledger-test-driver'
import {
  recoveryLedgerMocks as mocks,
  resetRecoveryLedgerStore,
  setTerminalTabs,
  terminalTabs
} from './terminal-recovery-ledger-test-store'
import { isTerminalInputQuarantined } from './terminal-input-quarantine'

const { notifyTerminalInputNotSent } = vi.hoisted(() => ({ notifyTerminalInputNotSent: vi.fn() }))
vi.mock('./terminal-input-not-sent-notice', () => ({ notifyTerminalInputNotSent }))

vi.mock('@/store', async () => {
  const store = await import('./terminal-recovery-ledger-test-store')
  return { useAppStore: { getState: () => store.recoveryLedgerStoreState() } }
})

vi.mock('@/lib/crash-breadcrumb-recorder', async () => {
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
  it('remounts the tab and records a breadcrumb for a certified-dead pipeline', async () => {
    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'write-stalled'
    })

    expect(result).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-1')
    expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      'terminal_pane_recovery_remount',
      { tabId: 'tab-1', reason: 'write-stalled' }
    )
    // Pipeline-death reasons are already probe-certified — no liveness gate.
    expect(mocks.hasPty).not.toHaveBeenCalled()
  })

  it('remounts an unverifiable reattach without requiring host-death evidence', async () => {
    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-ssh',
      ptyId: 'ssh:target@@pty-1',
      reason: 'reattach-unverifiable'
    })

    expect(result).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-ssh')
    expect(mocks.hasPty).not.toHaveBeenCalled()
    expect(isTerminalInputQuarantined('tab-ssh')).toBe(false)
  })

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

  it('coalesces repeat requests inside the cooldown window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    expect(
      await requestAndSettle({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'write-stalled' })
    ).toBe(true)
    expect(
      await requestTerminalPaneRecovery({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'replay-wedged' })
    ).toBe(false)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(1)

    vi.setSystemTime(16_000)
    expect(
      await requestTerminalPaneRecovery({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'replay-wedged' })
    ).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
  })

  it('refuses a second request while the last remount has reported nothing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    expect(
      await requestTerminalPaneRecovery({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'write-stalled' })
    ).toBe(true)
    // Past the cooldown, inside the cap — only the unsettled attempt refuses it.
    vi.setSystemTime(16_000)
    expect(
      await requestTerminalPaneRecovery({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'replay-wedged' })
    ).toBe(false)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(1)

    settleCurrentRecovery('tab-1', 'success')
    expect(
      await requestTerminalPaneRecovery({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'replay-wedged' })
    ).toBe(true)
  })

  it('refuses the same reason again once a pane reported it failed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    expect(
      await requestAndSettle(
        { tabId: 'tab-ssh', ptyId: 'ssh:target@@pty-1', reason: 'reattach-unverifiable' },
        'failed'
      )
    ).toBe(true)

    // Far past every window: counting would have healed, evidence has not.
    for (const now of [16_000, 60_000, 600_000]) {
      vi.setSystemTime(now)
      expect(
        await requestTerminalPaneRecovery({
          tabId: 'tab-ssh',
          ptyId: 'ssh:target@@pty-1',
          reason: 'reattach-unverifiable'
        })
      ).toBe(false)
    }
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(1)

    // The user pressing Retry is the new trigger the refusal waits for.
    expect(
      await requestTerminalPaneRecovery({
        tabId: 'tab-ssh',
        ptyId: 'ssh:target@@pty-1',
        reason: 'reattach-unverifiable',
        trigger: 'user'
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

  it('caps recoveries per window to prevent remount storms', async () => {
    vi.useFakeTimers()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      vi.setSystemTime(attempt * 20_000)
      await requestAndSettle({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'write-stalled'
      })
    }
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(3)
    expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      'terminal_pane_recovery_window_cap',
      { tabId: 'tab-1', reason: 'write-stalled' }
    )
  })

  it('drops the budget with the row the tab closure removes', async () => {
    vi.useFakeTimers()
    const instance = registerTerminalPaneRecoveryInstance('tab-1')
    for (let attempt = 0; attempt < 4; attempt += 1) {
      vi.setSystemTime(attempt * 20_000)
      await requestAndSettle({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'write-stalled'
      })
    }
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(1)

    // Pane disposal cannot erase consumed remounts or the cap lapses (crash b5cfc6ca).
    instance.unregister()
    expect(captureTerminalPaneRecoveryGeneration('tab-1')).toBe(3)
    expect(
      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'write-stalled'
      })
    ).toBe(false)

    // Closing the tab drops the row, and the budget with it — same object.
    setTerminalTabs([{ id: 'tab-1' }])
    expect(captureTerminalPaneRecoveryGeneration('tab-1')).toBe(0)
    expect(
      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'write-stalled'
      })
    ).toBe(true)
  })

  it('a window-cap decline schedules a retry that heals when the window reopens', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      vi.setSystemTime(attempt * 20_000)
      await requestAndSettle({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'write-stalled'
      })
    }
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(3)

    // A cap-declined dead xterm emits no further signals; schedule one retry instead of stranding it.
    vi.setSystemTime(60_000)
    expect(
      await requestTerminalPaneRecovery({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'write-stalled' })
    ).toBe(false)
    expect(
      await requestTerminalPaneRecovery({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'replay-wedged' })
    ).toBe(false)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(3)

    // Deduplicate declines into one retry when the first attempt ages out.
    await vi.advanceTimersByTimeAsync(250_000)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(400_000)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(4)
  })

  it('does not restart an unverifiable SSH reattach chain after its incident cap', async () => {
    vi.useFakeTimers()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      vi.setSystemTime(attempt * 20_000)
      // Each remount succeeds then wedges later; isolate the window cap from outcome refusal.
      await requestAndSettle({
        tabId: 'tab-ssh',
        ptyId: 'ssh:target@@pty-1',
        reason: 'reattach-unverifiable',
        terminalRecoveryGeneration: captureTerminalPaneRecoveryGeneration('tab-ssh')
      })
    }
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(600_000)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(3)
  })

  it('does not retry a cooldown decline from the xterm replaced by the remount', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const replacedGeneration = captureTerminalPaneRecoveryGeneration('tab-1')
    await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'write-stalled',
      terminalRecoveryGeneration: replacedGeneration
    })
    expect(
      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'replay-wedged',
        terminalRecoveryGeneration: replacedGeneration
      })
    ).toBe(false)

    await vi.advanceTimersByTimeAsync(600_000)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(1)
  })

  it('retries a fresh replacement xterm that wedges during the cooldown', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    await requestAndSettle({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'write-stalled',
      terminalRecoveryGeneration: captureTerminalPaneRecoveryGeneration('tab-1')
    })
    const replacementGeneration = captureTerminalPaneRecoveryGeneration('tab-1')

    expect(
      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'replay-wedged',
        terminalRecoveryGeneration: replacementGeneration
      })
    ).toBe(false)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
  })

  it('does not let an awaited scheduled retry remount a newer generation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    await requestAndSettle({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'write-stalled',
      terminalRecoveryGeneration: captureTerminalPaneRecoveryGeneration('tab-1')
    })
    const replacementGeneration = captureTerminalPaneRecoveryGeneration('tab-1')
    let resolveLiveness: ((live: boolean) => void) | undefined
    mocks.hasPty.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveLiveness = resolve
        })
    )
    await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'input-undeliverable',
      terminalRecoveryGeneration: replacementGeneration
    })

    await vi.advanceTimersByTimeAsync(15_000)
    expect(mocks.hasPty).toHaveBeenCalledTimes(1)
    expect(
      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'write-stalled',
        terminalRecoveryGeneration: replacementGeneration
      })
    ).toBe(true)
    resolveLiveness?.(true)
    // Drain the resumed probe here, or its remount lands in the next test.
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
  })

  it('cancels a retry when a non-recovery lifecycle replaces its xterm', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const originalInstance = registerTerminalPaneRecoveryInstance('tab-1')
    await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'write-stalled',
      terminalRecoveryGeneration: captureTerminalPaneRecoveryGeneration('tab-1'),
      terminalRecoveryInstanceId: originalInstance.id
    })
    originalInstance.unregister()

    const wedgedReplacement = registerTerminalPaneRecoveryInstance('tab-1')
    await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'replay-wedged',
      terminalRecoveryGeneration: captureTerminalPaneRecoveryGeneration('tab-1'),
      terminalRecoveryInstanceId: wedgedReplacement.id
    })
    expect(vi.getTimerCount()).toBe(1)

    // Cold park/reconnect/remount disposal invalidates delayed work even without an epoch change.
    wedgedReplacement.unregister()
    const healthySuccessor = registerTerminalPaneRecoveryInstance('tab-1')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(600_000)

    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(1)
    healthySuccessor.unregister()
  })

  it('keeps a sibling pane retry when the first requesting split is disposed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    await requestAndSettle({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'write-stalled'
    })
    const recoveryGeneration = captureTerminalPaneRecoveryGeneration('tab-1')
    const firstSplit = registerTerminalPaneRecoveryInstance('tab-1')
    const secondSplit = registerTerminalPaneRecoveryInstance('tab-1')
    for (const instance of [firstSplit, secondSplit]) {
      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: `pty-${instance.id}`,
        reason: 'replay-wedged',
        terminalRecoveryGeneration: recoveryGeneration,
        terminalRecoveryInstanceId: instance.id
      })
    }

    firstSplit.unregister()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(15_000)

    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
    secondSplit.unregister()
  })

  it('does not abandon a certified sibling behind a failed liveness retry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    await requestAndSettle({
      tabId: 'tab-1',
      ptyId: 'pty-initial',
      reason: 'write-stalled'
    })
    const recoveryGeneration = captureTerminalPaneRecoveryGeneration('tab-1')
    const livenessSplit = registerTerminalPaneRecoveryInstance('tab-1')
    const certifiedSplit = registerTerminalPaneRecoveryInstance('tab-1')
    mocks.hasPty.mockResolvedValue(false)

    await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-not-live',
      reason: 'input-undeliverable',
      terminalRecoveryGeneration: recoveryGeneration,
      terminalRecoveryInstanceId: livenessSplit.id,
      requireAuthoritativeLiveness: true
    })
    await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-certified-dead',
      reason: 'write-stalled',
      terminalRecoveryGeneration: recoveryGeneration,
      terminalRecoveryInstanceId: certifiedSplit.id
    })

    await vi.advanceTimersByTimeAsync(15_000)

    expect(mocks.hasPty).toHaveBeenCalledWith('pty-not-live')
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
    expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenLastCalledWith(
      'terminal_pane_recovery_remount',
      { tabId: 'tab-1', reason: 'write-stalled' }
    )
    livenessSplit.unregister()
    certifiedSplit.unregister()
  })

  it('budgets tabs independently', async () => {
    setTerminalTabs([...terminalTabs(), { id: 'tab-2' }])
    expect(
      await requestTerminalPaneRecovery({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'write-stalled' })
    ).toBe(true)
    expect(
      await requestTerminalPaneRecovery({ tabId: 'tab-2', ptyId: 'pty-2', reason: 'write-stalled' })
    ).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
  })

  it('skips input-undeliverable recovery when the PTY is confirmed dead', async () => {
    mocks.hasPty.mockResolvedValue(false)

    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      reason: 'input-undeliverable'
    })

    expect(result).toBe(false)
    expect(mocks.remountTerminalTabForRecovery).not.toHaveBeenCalled()
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

  it('requires a ptyId for input-undeliverable recovery', async () => {
    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: null,
      reason: 'input-undeliverable'
    })

    expect(result).toBe(false)
    expect(mocks.remountTerminalTabForRecovery).not.toHaveBeenCalled()
  })

  it('requires authoritative liveness for remote panes (null hasPty blocks recovery)', async () => {
    mocks.hasPty.mockResolvedValue(null)

    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'remote:pty-1',
      reason: 'input-undeliverable',
      requireAuthoritativeLiveness: true
    })

    expect(result).toBe(false)
    expect(mocks.remountTerminalTabForRecovery).not.toHaveBeenCalled()
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

  it('blocks remote recovery when the liveness probe throws', async () => {
    mocks.hasPty.mockRejectedValue(new Error('runtime unreachable'))

    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-1',
      ptyId: 'remote:pty-1',
      reason: 'input-undeliverable',
      requireAuthoritativeLiveness: true
    })

    expect(result).toBe(false)
    expect(mocks.remountTerminalTabForRecovery).not.toHaveBeenCalled()
  })

  // Local hasPty cannot speak for remote: IDs; none of its answers is owner liveness evidence (STA-2830).
  describe('host-rejected input', () => {
    for (const [label, liveness] of [
      ['a fabricated dead answer', async () => false],
      ['an explicit unknown', async () => null],
      [
        'a failed probe',
        async () => {
          throw new Error('ipc down')
        }
      ]
    ] as [string, () => Promise<boolean | null>][]) {
      it(`recovers even though the local probe would give ${label}`, async () => {
        mocks.hasPty.mockImplementation(liveness)

        const result = await requestTerminalPaneRecovery({
          tabId: 'tab-1',
          ptyId: 'remote:env-1@@terminal-1',
          reason: 'input-rejected-by-host',
          requireAuthoritativeLiveness: true,
          endpointReplaced: true
        })

        expect(result).toBe(true)
        expect(mocks.hasPty).not.toHaveBeenCalled()
        expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-1')
      })
    }

    it('still coalesces under the shared cooldown', async () => {
      expect(
        await requestTerminalPaneRecovery({
          tabId: 'tab-1',
          ptyId: 'remote:env-1@@terminal-1',
          reason: 'input-rejected-by-host'
        })
      ).toBe(true)
      expect(
        await requestTerminalPaneRecovery({
          tabId: 'tab-1',
          ptyId: 'remote:env-1@@terminal-1',
          reason: 'input-rejected-by-host'
        })
      ).toBe(false)
      expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(1)
    })
  })

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

  it('does not consume budget when the tab no longer exists', async () => {
    const result = await requestTerminalPaneRecovery({
      tabId: 'tab-gone',
      ptyId: 'pty-1',
      reason: 'write-stalled'
    })

    expect(result).toBe(false)
    // Missing tabs report unavailability without claiming a remount occurred.
    expect(mocks.recordRendererCrashBreadcrumb).not.toHaveBeenCalledWith(
      'terminal_pane_recovery_remount',
      expect.anything()
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

    it('stays quiet when no pane held undelivered input', async () => {
      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'input-rejected-by-host',
        endpointReplaced: true,
        hasUndeliveredInput: () => false
      })

      expect(notifyTerminalInputNotSent).not.toHaveBeenCalled()
    })

    it('reads undelivered input when the remount is admitted, not when it was requested', async () => {
      // Read held input after the async probe; request-time capture misses typing that remount would discard.
      let typedSinceRequest = false
      mocks.hasPty.mockImplementationOnce(async () => {
        typedSinceRequest = true
        return true
      })
      await requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'input-undeliverable',
        endpointReplaced: true,
        hasUndeliveredInput: () => typedSinceRequest
      })

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
  describe('unverifiable reattach remount storm (crash b5cfc6ca)', () => {
    const STORM_CYCLES = 200
    const OBSERVED_MEDIAN_GAP_MS = 10

    // Model capture/register → unverifiable attach → failed outcome/re-request → remount/dispose unregister.
    async function driveUnverifiableReattachCycle(tabId: string): Promise<void> {
      const terminalRecoveryGeneration = captureTerminalPaneRecoveryGeneration(tabId)
      const instance = registerTerminalPaneRecoveryInstance(tabId)
      settleTerminalPaneRecovery(tabId, terminalRecoveryGeneration, 'failed')
      await requestTerminalPaneRecovery({
        tabId,
        ptyId: 'ssh:target@@pty-1',
        reason: 'reattach-unverifiable',
        terminalRecoveryGeneration,
        terminalRecoveryInstanceId: instance.id
      })
      instance.unregister()
    }

    async function driveStorm(tabId: string): Promise<void> {
      for (let cycle = 0; cycle < STORM_CYCLES; cycle += 1) {
        vi.setSystemTime(cycle * OBSERVED_MEDIAN_GAP_MS)
        await driveUnverifiableReattachCycle(tabId)
      }
    }

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
    })

    it('collapses the reported storm to a single remount', async () => {
      // One observed same-reason failure must stop further requests regardless of elapsed cooldown.
      await driveStorm('tab-ssh')

      expect(mocks.remountTerminalTabForRecovery.mock.calls.length).toBe(1)
    })

    it('stops a slow failure chain the cooldown would have waved through', async () => {
      // Widen gaps beyond cooldown to prove outcome evidence, rather than counting, stops repetition.
      for (let cycle = 0; cycle < 10; cycle += 1) {
        vi.setSystemTime(cycle * 20_000)
        await driveUnverifiableReattachCycle('tab-ssh')
      }

      expect(mocks.remountTerminalTabForRecovery.mock.calls.length).toBe(1)
    })

    it('stays capped for a tab the unified index cannot see', async () => {
      // Budget/existence use tabsByWorktree even when unifiedTabsByWorktree drifts (#19745).
      mocks.getTab.mockReturnValue(null)

      await driveStorm('tab-ssh')

      expect(mocks.remountTerminalTabForRecovery.mock.calls.length).toBe(1)
    })

    it('still refuses when every cycle also disposes and re-registers its xterm', async () => {
      // Repeated disposal cannot restore consumed allowance from the durable row ledger.
      await driveStorm('tab-ssh')
      const ledger = terminalTabs().find((tab) => tab.id === 'tab-ssh')?.recovery

      expect(ledger?.attemptedAt).toHaveLength(1)
      expect(ledger?.outcome).toBe('failed')
    })
  })
})
