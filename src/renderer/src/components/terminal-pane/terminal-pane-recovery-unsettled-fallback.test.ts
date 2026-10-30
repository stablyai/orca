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

/** Aged pending is not observed failure: fresh-spawn recovery cannot report reattach success. Cooldown/window cap bound silent panes, while new evidence can reopen admission. */

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
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(true)

    // Cooldown elapsed, but the unsettled attempt has no new evidence permitting retry.
    vi.setSystemTime(16_000)
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(false)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(1)

    // After settlement timeout, pending expires without counting as failure and cooldown permits another remount.
    vi.setSystemTime(31_000)
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(true)
    vi.setSystemTime(62_000)
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(3)

    for (const now of [93_000, 124_000, 200_000, 299_000]) {
      vi.setSystemTime(now)
      expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(false)
    }
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(3)
    expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      'terminal_pane_recovery_window_cap',
      { tabId: 'tab-1', reason: 'spawn-left-pane-unbound' }
    )

    // Rolling expiry eventually permits recovery again; cap cannot become permanent.
    vi.setSystemTime(301_000)
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(4)
  })

  it('lets the user reopen an unsettled attempt the automatic path is holding', async () => {
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(true)
    vi.setSystemTime(16_000)
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(false)

    // Explicit Retry is new evidence and clears unsettled/cooldown refusal.
    expect(await requestTerminalPaneRecovery({ ...NEVER_SETTLES, trigger: 'user' })).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
  })

  it('lets a PTY rebind reopen it the moment the pane finally reports', async () => {
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(true)
    vi.setSystemTime(16_000)
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(false)

    settleCurrentRecovery('tab-1', 'success')
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
  })

  it('lets an authority change supersede an attempt still sitting pending', async () => {
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(true)
    vi.setSystemTime(16_000)
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(false)

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

    // User Retry and generation changes must still hit the unconditional cap or a self-bumping loop escapes it.
    expect(await requestTerminalPaneRecovery({ ...NEVER_SETTLES, trigger: 'user' })).toBe(false)
    bumpTabGeneration('tab-1')
    expect(await requestTerminalPaneRecovery(NEVER_SETTLES)).toBe(false)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(3)

    // Host hydration bypasses the ledger/cap but fires only on lifecycle events, preventing a self-sustaining loop.
    const external = captureTerminalPaneRecoveryGeneration('tab-1')
    expect(external).toBeGreaterThan(0)
    expect(await requestTerminalPaneRecovery({ ...NEVER_SETTLES, trigger: 'external' })).toBe(true)
    expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(4)
  })
})
