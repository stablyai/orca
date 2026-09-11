import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetTerminalPaneRecoveryForTests,
  captureTerminalPaneRecoveryGeneration,
  requestTerminalPaneRecovery
} from './terminal-pane-recovery'
import { bumpTabGeneration, settleCurrentRecovery } from './terminal-recovery-ledger-test-driver'
import {
  recoveryLedgerMocks as mocks,
  resetRecoveryLedgerStore,
  setTerminalTabs
} from './terminal-recovery-ledger-test-store'

/**
 * The deliberate softening, stressed.
 *
 * An aged-out `pending` is NOT read as an observed failure. That is a choice:
 * `spawn-left-pane-unbound` mounts a pane with no PTY binding, so a remount
 * that succeeds goes down the fresh-spawn path, which reaches no reattach
 * handler and therefore reports no `success`. Treating the timeout as failure
 * would refuse that reason forever on the one pane kind that cannot report.
 *
 * What bounds it instead is the cooldown and the window cap. These tests pin
 * that bound, the breadcrumb it leaves, and — the part that matters most —
 * which triggers can still move a tab whose pane never reports anything.
 */

vi.mock('@/store', async () => {
  const store = await import('./terminal-recovery-ledger-test-store')
  return { useAppStore: { getState: () => store.recoveryLedgerStoreState() } }
})

vi.mock('@/lib/crash-breadcrumb-recorder', async () => {
  const store = await import('./terminal-recovery-ledger-test-store')
  return { recordRendererCrashBreadcrumb: store.recoveryLedgerMocks.recordRendererCrashBreadcrumb }
})

/** The one reason with no `success` settle path, and the one this bound exists for. */
const NEVER_SETTLES = {
  tabId: 'tab-1',
  ptyId: null,
  reason: 'spawn-left-pane-unbound'
} as const

beforeEach(() => {
  _resetTerminalPaneRecoveryForTests()
  resetRecoveryLedgerStore()
  setTerminalTabs([{ id: 'tab-1' }])
  vi.stubGlobal('window', { api: { pty: { hasPty: mocks.hasPty } } })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('a pane that never reports an outcome', () => {
  it('bounds a never-settling tab at three remounts per window and says so', async () => {
    // t=0 admits: no ledger yet.
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(true)

    // Inside the settlement bound, past the cooldown: only the unsettled
    // attempt refuses this, and nothing has been observed to justify a retry.
    vi.setSystemTime(16_000)
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(false)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(1)

    // Past 31s the pending ages out. NOT an observed failure — it falls
    // through to the cooldown, which has elapsed, so a second remount lands.
    vi.setSystemTime(31_000)
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(true)
    vi.setSystemTime(62_000)
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(3)

    // The backstop. Every further ask inside the window is refused, loudly.
    for (const now of [93_000, 124_000, 200_000, 299_000]) {
      vi.setSystemTime(now)
      expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(false)
    }
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(3)
    expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      'terminal_pane_recovery_window_cap',
      { tabId: 'tab-1', reason: 'spawn-left-pane-unbound' }
    )

    // And it is a rolling window, not a permanent stop: once the first attempt
    // ages out of it the tab may heal again.
    vi.setSystemTime(301_000)
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(4)
  })

  it('lets the user reopen an unsettled attempt the automatic path is holding', async () => {
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(true)
    vi.setSystemTime(16_000)
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(false)

    // Retry in the error toast: the user asking IS the new evidence, so it
    // clears the unsettled refusal AND the cooldown.
    expect(await requestTerminalPaneRecovery({ ...NEVER_SETTLES, trigger: 'user' })).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
  })

  it('lets a PTY rebind reopen it the moment the pane finally reports', async () => {
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(true)
    vi.setSystemTime(16_000)
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(false)

    // An authoritative attach lands: reattach-result-handler settles 'success'.
    settleCurrentRecovery('tab-1', 'success')
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
  })

  it('lets an authority change supersede an attempt still sitting pending', async () => {
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(true)
    vi.setSystemTime(16_000)
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(false)

    // SSH authority rotation / activation respawn bumps tab.generation.
    bumpTabGeneration('tab-1')
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
  })

  it('keeps the cap above every trigger but the external lifecycle remount', async () => {
    for (const now of [0, 31_000, 62_000]) {
      vi.setSystemTime(now)
      expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(true)
    }
    vi.setSystemTime(93_000)

    // The backstop is deliberately unconditional: a user Retry and an authority
    // rotation both still hit it, or anything bumping generation each cycle
    // would lift the ceiling along with it.
    expect(await requestTerminalPaneRecovery({ ...NEVER_SETTLES, trigger: 'user' })).toBe(false)
    bumpTabGeneration('tab-1')
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(false)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(3)

    // Host hydration remounts every live pane and writes no ledger, so it is
    // the one trigger above the cap — and it cannot itself loop, because it
    // only fires on a lifecycle event.
    const external = captureTerminalPaneRecoveryGeneration('tab-1')
    expect(external).toBeGreaterThan(0)
    expect(await requestTerminalPaneRecovery({ ...NEVER_SETTLES, trigger: 'external' })).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(4)
  })
})
