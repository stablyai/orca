import { terminalPtyMembership } from './terminal-pty-membership'
/**
 * A closed tab stops the shells an older Orca's relay still runs for it, as closing any other
 * terminal tab ends its shell. COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import type {
  TerminalTabRetirementPlan,
  TerminalTabRetirementState
} from './terminal-tab-retirement'

/** Check current ownership after listing; a moved pane may outlive its closing source tab. */
export async function stopLegacyRelayBridgedShellsForTab(
  getState: () => TerminalTabRetirementState,
  tabId: string,
  plan: TerminalTabRetirementPlan
): Promise<void> {
  const api = window.api?.legacyRelayBridge
  if (!api) {
    return
  }
  // Loaded lazily: the module subscribes to main's pane list on import.
  const { legacyRelayBridgedPanesListed, legacyRelayBridgedPtyIdsForClosingTab } =
    await import('@/components/terminal-pane/pty-transport/legacy-relay/legacy-relay-bridge-panes')
  await legacyRelayBridgedPanesListed()
  // Why: a pane moved to another tab keeps its shell, and main's lease list can lag the move.
  const shared = new Set(plan.sharedPtyIds)
  const pending: Promise<unknown>[] = []
  for (const ptyId of legacyRelayBridgedPtyIdsForClosingTab(tabId, plan.ptyIds)) {
    if (shared.has(ptyId) || terminalPtyMembership(getState()).hasRawOwnerOutside(ptyId, tabId)) {
      continue
    }
    pending.push(api.close({ ptyId }))
  }
  await Promise.allSettled(pending)
}
