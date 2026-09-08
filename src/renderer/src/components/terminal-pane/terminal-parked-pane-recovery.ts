/**
 * Ownership and remount for PTYs whose bytes have been parked across the watchdog's
 * stall streak. Wired into the watchdog as a dep by `pty-dispatcher.ts` rather than imported
 * by it: the watchdog is on the freeze-report path and must stay clear of the app store.
 */
import { useAppStore } from '@/store'
import {
  captureTerminalPaneRecoveryGeneration,
  requestTerminalPaneRecovery
} from './terminal-pane-recovery'

/** Remount owned panes without inferring PTY liveness or changing producer flow control.
 * Recovery's budget/cooldown bounds churn; unowned bytes remain in the bounded buffer. */
export async function recoverParkedPanes(ptyIds: string[]): Promise<void> {
  // Bounded: this scan runs only for ids stalled across two ticks, never per render.
  const ptyIdsByTabId = useAppStore.getState().ptyIdsByTabId ?? {}
  const requestsByTabId = new Map<string, { ptyId: string; terminalRecoveryGeneration: number }>()
  for (const ptyId of ptyIds) {
    const tabId = Object.keys(ptyIdsByTabId).find((candidate) =>
      ptyIdsByTabId[candidate]?.includes(ptyId)
    )
    if (tabId === undefined || requestsByTabId.has(tabId)) {
      continue
    }
    requestsByTabId.set(tabId, {
      ptyId,
      terminalRecoveryGeneration: captureTerminalPaneRecoveryGeneration(tabId)
    })
  }
  // A tab remount replaces every split; capture ownership before any request changes it.
  for (const [tabId, request] of requestsByTabId) {
    await requestTerminalPaneRecovery({
      tabId,
      reason: 'delivery-parked',
      ...request
    })
  }
}
