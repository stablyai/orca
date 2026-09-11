import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemountTerminalTabForRecovery,
  createSettleTerminalTabRecovery
} from '@/store/slices/worktrees/session/worktree-slice-lookups'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  _resetTerminalPaneRecoveryForTests,
  captureTerminalPaneRecoveryGeneration,
  registerTerminalPaneRecoveryInstance,
  requestTerminalPaneRecovery,
  settleTerminalPaneRecovery
} from './terminal-pane-recovery'
import { isTerminalInputQuarantined } from './terminal-input-quarantine'

type StoredTerminalTab = Pick<TerminalTab, 'id' | 'viewMode' | 'generation' | 'recovery'>

const WORKTREE_ID = 'repo1::/path/wt1'

// The store actions here are the REAL ones, driven over a minimal state bag.
// The recovery budget is a field on the tab row now, so a fake that only
// answered booleans could no longer express what this module reads.
const mocks = vi.hoisted(() => ({
  state: {
    tabsByWorktree: {} as Record<string, unknown[]>,
    terminalLayoutsByTabId: {} as Record<string, unknown>,
    pendingStartupByTabId: {} as Record<string, unknown>
  },
  // Records tabIds the store ACTUALLY remounted, so every assertion below keeps
  // meaning "a remount happened" rather than "a remount was asked for".
  remountTerminalTabForRecovery: vi.fn<(tabId: string) => void>(),
  getTab: vi.fn<() => { viewMode?: 'terminal' | 'chat' } | null>(() => ({})),
  recordRendererCrashBreadcrumb: vi.fn(),
  hasPty: vi.fn<(id: string) => Promise<boolean | null>>(async () => true)
}))

const storeSet = (updater: unknown): void => {
  const patch =
    typeof updater === 'function'
      ? (updater as (state: unknown) => object)(mocks.state)
      : (updater as object)
  Object.assign(mocks.state, patch)
}
const storeGet = (): unknown => mocks.state
const realRemount = createRemountTerminalTabForRecovery(storeSet as never, storeGet as never)
const realSettle = createSettleTerminalTabRecovery(storeSet as never, storeGet as never)

const remountTerminalTabForRecovery: typeof realRemount = (tabId, request) => {
  const result = realRemount(tabId, request)
  if (result.remounted) {
    mocks.remountTerminalTabForRecovery(tabId)
  }
  return result
}

function terminalTabs(): StoredTerminalTab[] {
  return (mocks.state.tabsByWorktree[WORKTREE_ID] ?? []) as StoredTerminalTab[]
}

function setTerminalTabs(tabs: StoredTerminalTab[]): void {
  mocks.state.tabsByWorktree = { [WORKTREE_ID]: tabs }
}

/** What a mounted pane reports for the tab's current recovery attempt. */
function settleCurrentRecovery(tabId: string, outcome: 'success' | 'failed' | 'timed-out'): void {
  settleTerminalPaneRecovery(tabId, captureTerminalPaneRecoveryGeneration(tabId), outcome)
}

/** A full cycle: request, then the pane the remount mounted reports back.
 *  Recovery gates on an observed outcome, so a caller that never reports is
 *  refused — these are the callers that DO report. */
async function requestAndSettle(
  request: Parameters<typeof requestTerminalPaneRecovery>[0],
  outcome: 'success' | 'failed' | 'timed-out' = 'success'
): Promise<boolean> {
  const recovered = await requestTerminalPaneRecovery(request)
  if (recovered) {
    settleCurrentRecovery(request.tabId, outcome)
  }
  return recovered
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      ...mocks.state,
      remountTerminalTabForRecovery,
      settleTerminalTabRecovery: realSettle,
      getTab: mocks.getTab
    })
  }
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: mocks.recordRendererCrashBreadcrumb
}))

beforeEach(() => {
  _resetTerminalPaneRecoveryForTests()
  mocks.remountTerminalTabForRecovery.mockReset()
  mocks.getTab.mockClear()
  mocks.getTab.mockReturnValue({})
  mocks.state.terminalLayoutsByTabId = {}
  mocks.state.pendingStartupByTabId = {}
  setTerminalTabs([{ id: 'tab-1' }, { id: 'tab-ssh' }])
  mocks.recordRendererCrashBreadcrumb.mockClear()
  mocks.hasPty.mockClear()
  mocks.hasPty.mockResolvedValue(true)
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
  it('does not remount a terminal surface hidden behind native chat', async () => {
    setTerminalTabs([{ id: 'tab-1', viewMode: 'chat' }])

    await expect(
      requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'input-undeliverable'
      })
    ).resolves.toBe(false)
    expect(mocks.remountTerminalTabForRecovery).not.toHaveBeenCalled()
    expect(mocks.hasPty).not.toHaveBeenCalled()
  })

  it('does not remount a chat-owned tab the unified tab index has dropped', async () => {
    // The drift crash b5cfc6ca documents: present in tabsByWorktree, gone from
    // unifiedTabsByWorktree. getTab answers null, and the guard reads the row.
    mocks.getTab.mockReturnValue(null)
    setTerminalTabs([{ id: 'tab-1', viewMode: 'chat' }])

    await expect(
      requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'input-undeliverable'
      })
    ).resolves.toBe(false)
    expect(mocks.remountTerminalTabForRecovery).not.toHaveBeenCalled()
    expect(mocks.hasPty).not.toHaveBeenCalled()
  })

  it('reads chat ownership from the row alone, not from the unified tab', async () => {
    // The local viewMode toggles now patch the row in the same set(), so the
    // unified tab is never the tie-breaker — a stale one cannot veto a heal.
    mocks.getTab.mockReturnValue({ viewMode: 'chat' })
    setTerminalTabs([{ id: 'tab-1', viewMode: 'terminal' }])

    await expect(
      requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'write-stalled'
      })
    ).resolves.toBe(true)
  })

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
    // A remote-runtime snapshot rebuilds the row without `generation`. That is a
    // field going missing, not a new trigger — reading it as one would restore
    // the tab's allowance on every republication.
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

    // Disposing the pane must NOT release anything: that release is what erased
    // every consumed remount and let the cap lapse (crash b5cfc6ca).
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

    // Cap-declined: without a retry this pane is a permanent zombie — its
    // certified-dead xterm no longer produces write signals to re-request.
    vi.setSystemTime(60_000)
    expect(
      await requestTerminalPaneRecovery({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'write-stalled' })
    ).toBe(false)
    expect(
      await requestTerminalPaneRecovery({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'replay-wedged' })
    ).toBe(false)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(3)

    // One retry (deduped across the two declines) fires once the first
    // attempt ages out of the window, and remounts.
    await vi.advanceTimersByTimeAsync(250_000)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(400_000)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(4)
  })

  it('does not restart an unverifiable SSH reattach chain after its incident cap', async () => {
    vi.useFakeTimers()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      vi.setSystemTime(attempt * 20_000)
      // Each remounted pane attaches, then wedges again minutes later: the
      // window cap, not the outcome gate, is what this test is about.
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

    // Cold parking, SSH reconnect, and ordinary remounts dispose the binding
    // without changing the recovery epoch; disposal owns timer invalidation.
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

  // A `remote:` id has no entry in main's registry, so pty:hasPty routes it to
  // the local provider. Every answer that path can produce blocked the remount
  // this signal exists to trigger (STA-2830); none of them is evidence.
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
    // Regression: recovery fires from stall-watch timers and write callbacks;
    // an environment with a partial store (mocked suites, teardown races) must
    // get a false return, not an unhandled TypeError.
    mocks.remountTerminalTabForRecovery.mockImplementation(() => {
      throw new TypeError('remountTerminalTabForRecovery is not a function')
    })

    await expect(
      requestTerminalPaneRecovery({ tabId: 'tab-1', ptyId: 'pty-1', reason: 'write-stalled' })
    ).resolves.toBe(false)
    // The failure must leave a trace — it is the only forensic signal for a
    // production remount-failure loop (budget unconsumed → cooldown retries).
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
    // Not silent anymore: the missing-tab outcome is breadcrumbed (see the
    // dedicated test above), but no remount breadcrumb may fire.
    expect(mocks.recordRendererCrashBreadcrumb).not.toHaveBeenCalledWith(
      'terminal_pane_recovery_remount',
      expect.anything()
    )
  })

  // Why: quarantine suppresses real keystrokes, so arming it on a recovery that
  // kept the same shell would eat a legitimate command (#10065 follow-up).
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

  // Crash b5cfc6ca (1.4.198, Windows): 8878 'terminal_pane_recovery_remount'
  // breadcrumbs, every one reason='reattach-unverifiable', across 8 tabs in
  // 122.4s (median gap 10ms) — ~1110 per tab against a cap of 3 per 5min. The
  // renderer then died allocating a 512x512 SkBitmap.
  //
  // The trigger was two tab indices: the budget lived in a module Map keyed by
  // tabId, and the pane-disposal release erased it whenever getTab (which reads
  // unifiedTabsByWorktree) could not see a tab remountTerminalTabForRecovery
  // (which reads tabsByWorktree) still held. The mechanism is what mattered:
  // each remount mounted a pane that captured a FRESH epoch, so the epoch check
  // could never refuse its request, and a counting budget was the only thing
  // between the failure and its own repetition.
  describe('unverifiable reattach remount storm (crash b5cfc6ca)', () => {
    const STORM_CYCLES = 200
    const OBSERVED_MEDIAN_GAP_MS = 10

    // One production reattach cycle: connect-pane-pty captures the epoch and
    // registers the xterm (connect-pane-pty.ts), the reattach answers
    // unverifiable, recoverUnverifiableDirectSshReattach settles this pane's
    // attempt 'failed' and re-requests, and the remount disposes that xterm —
    // session-reconcile-dispose unregisters the instance.
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
      // The reported run produced ~1110 remounts on this tab. One remount is
      // admitted; after its pane reports the same reason failed, every later
      // request is refused on evidence — not on a count, and not on a timer.
      await driveStorm('tab-ssh')

      expect(mocks.remountTerminalTabForRecovery.mock.calls.length).toBe(1)
    })

    it('stops a slow failure chain the cooldown would have waved through', async () => {
      // Gaps wider than the cooldown: counting would allow the cap's worth of
      // remounts before noticing. Evidence stops it at the first observed
      // failure — the chain never gets a second identical attempt.
      for (let cycle = 0; cycle < 10; cycle += 1) {
        vi.setSystemTime(cycle * 20_000)
        await driveUnverifiableReattachCycle('tab-ssh')
      }

      expect(mocks.remountTerminalTabForRecovery.mock.calls.length).toBe(1)
    })

    it('stays capped for a tab the unified index cannot see', async () => {
      // The pre-#19745 trigger: present in tabsByWorktree, absent from
      // unifiedTabsByWorktree. Nothing reads the unified index for budget or
      // existence any more, so the drift has no expression at all.
      mocks.getTab.mockReturnValue(null)

      await driveStorm('tab-ssh')

      expect(mocks.remountTerminalTabForRecovery.mock.calls.length).toBe(1)
    })

    it('still refuses when every cycle also disposes and re-registers its xterm', async () => {
      // The disposal path is the one that used to release the budget. It now
      // releases nothing that a remount wrote, so a 200-cycle dispose storm
      // cannot restore the tab's allowance.
      await driveStorm('tab-ssh')
      const ledger = terminalTabs().find((tab) => tab.id === 'tab-ssh')?.recovery

      expect(ledger?.attemptedAt).toHaveLength(1)
      expect(ledger?.outcome).toBe('failed')
    })
  })
})
