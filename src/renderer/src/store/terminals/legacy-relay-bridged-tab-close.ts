/**
 * A closed tab stops the shells an older Orca's relay still runs for it, as closing any other
 * terminal tab ends its shell. COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import {
  collectPtyIdsForTab,
  type TerminalTabRetirementPlan,
  type TerminalTabRetirementState
} from '../slices/terminal-tab-retirement'

/** `state` is read before the close prunes the tab, so its own PTYs are still listed. */
export async function stopLegacyRelayBridgedShellsForTab(
  state: TerminalTabRetirementState,
  tabId: string,
  plan: TerminalTabRetirementPlan
): Promise<void> {
  const api = window.api?.legacyRelayBridge
  if (!api) {
    return
  }
  // Loaded lazily: the module subscribes to main's pane list on import.
  const { legacyRelayBridgedPanesListed, legacyRelayBridgedPtyIdsForClosingTab } =
    await import('@/components/terminal-pane/legacy-relay-bridge-panes')
  await legacyRelayBridgedPanesListed()
  // Why: a pane moved to another tab keeps its shell, and main's lease list can lag the move.
  const keep = new Set(plan.sharedPtyIds)
  for (const tabs of Object.values(state.tabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.id !== tabId) {
        collectPtyIdsForTab(state, tab.id, tab.ptyId).forEach((ptyId) => keep.add(ptyId))
      }
    }
  }
  const ptyIds = legacyRelayBridgedPtyIdsForClosingTab(tabId, plan.ptyIds).filter(
    (ptyId) => !keep.has(ptyId)
  )
  await Promise.allSettled(ptyIds.map((ptyId) => api.close({ ptyId })))
}
