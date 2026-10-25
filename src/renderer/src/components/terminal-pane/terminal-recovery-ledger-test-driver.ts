import {
  captureTerminalPaneRecoveryGeneration,
  requestTerminalPaneRecovery,
  settleTerminalPaneRecovery
} from './terminal-pane-recovery'
import { setTerminalTabs, terminalTabs } from './terminal-recovery-ledger-test-store'

// Keep request/settle outside the fake store: its mock factory imports that store, and importing recovery back would deadlock.

/** What a mounted pane reports for the tab's current recovery attempt. */
export function settleCurrentRecovery(
  tabId: string,
  outcome: 'success' | 'failed' | 'timed-out'
): void {
  settleTerminalPaneRecovery(tabId, captureTerminalPaneRecoveryGeneration(tabId), outcome)
}

/** Request then report the remounted pane’s outcome; these callers exercise settled evidence rather than the silent-pending path. */
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
