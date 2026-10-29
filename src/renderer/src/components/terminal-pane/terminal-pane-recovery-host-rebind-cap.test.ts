import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  _resetTerminalPaneRecoveryForTests,
  captureTerminalPaneRecoveryGeneration
} from './terminal-pane-recovery'
import { requestAndSettle } from './terminal-recovery-ledger-test-driver'
import {
  recoveryLedgerMocks as mocks,
  resetRecoveryLedgerStore,
  setTerminalTabs
} from './terminal-recovery-ledger-test-store'

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
  resetRecoveryLedgerStore()
  setTerminalTabs([{ id: 'tab-1' }])
})

afterEach(() => {
  vi.useRealTimers()
})

it('stops re-binding at the window cap when the host keeps contradicting its exit record', async () => {
  vi.useFakeTimers()
  const rebind = () =>
    requestAndSettle(
      {
        tabId: 'tab-1',
        ptyId: 'remote:env@@terminal-1',
        reason: 'host-rebound-exited-pane',
        trigger: 'host-evidence',
        terminalRecoveryGeneration: captureTerminalPaneRecoveryGeneration('tab-1')
      },
      // Each remounted pane is settled as exited again by the same contradicting host.
      'failed'
    )

  const outcomes: boolean[] = []
  for (let attempt = 0; attempt < 5; attempt += 1) {
    vi.setSystemTime(attempt * 20_000)
    outcomes.push(await rebind())
  }

  expect(outcomes).toEqual([true, true, true, false, false])
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(mocks.remountTerminalTabForRecovery).toHaveBeenCalledTimes(3)
})
