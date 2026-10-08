import {
  captureTerminalPaneRecoveryGeneration,
  requestTerminalPaneRecovery,
  settleTerminalPaneRecovery
} from './terminal-pane-recovery'
import { setTerminalTabs, terminalTabs } from './terminal-recovery-ledger-test-store'

// One request/settle cycle over the real recovery module, for suites driving
// the ledger through terminal-recovery-ledger-test-store's fake store. Separate
// from that module because the `@/store` mock factory imports it, and a factory
// that reached back into the module under test would deadlock.

/** What a mounted pane reports for the tab's current recovery attempt. */
export function settleCurrentRecovery(
  tabId: string,
  outcome: 'success' | 'failed' | 'timed-out'
): void {
  settleTerminalPaneRecovery(tabId, captureTerminalPaneRecoveryGeneration(tabId), outcome)
}

/** A full cycle: request, then the pane the remount mounted reports back.
 *  Recovery gates on an observed outcome, so a caller that never reports is
 *  refused — these are the callers that DO report. */
export async function requestAndSettle(
  request: Parameters<typeof requestTerminalPaneRecovery>[0],
  outcome: 'success' | 'failed' | 'timed-out' = 'success'
): Promise<boolean> {
  const recovered = await requestTerminalPaneRecovery(request)
  if (recovered) {
    settleCurrentRecovery(request.tabId, outcome)
  }
  return recovered
}

/** The new trigger an SSH authority rotation or activation respawn supplies. */
export function bumpTabGeneration(tabId: string): void {
  setTerminalTabs(
    terminalTabs().map((tab) =>
      tab.id === tabId ? { ...tab, generation: (tab.generation ?? 0) + 1 } : tab
    )
  )
}
