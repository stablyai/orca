/** Builds the stateful per-tab cold-park candidate list. */
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TerminalTabColdParkCandidate } from './terminal-hidden-view-parking'
import type { TerminalTabActivationOrder } from './terminal-tab-activation-order'

export function buildTerminalTabColdParkCandidates(args: {
  terminalTabs: readonly TerminalTab[]
  assignments: ReadonlyMap<string, { isActiveInGroup: boolean }>
  isWorktreeActive: boolean
  activeTerminalTabId: string | null
  portalTabIds: ReadonlySet<string>
  shouldMeasureHiddenWorktree: boolean
  hiddenSinceByTabId: Map<string, number>
  activationOrder: TerminalTabActivationOrder
  nowMs: number
}): TerminalTabColdParkCandidate[] {
  args.activationOrder.recordActiveTabId(args.isWorktreeActive ? args.activeTerminalTabId : null)
  const visibleTabIds = new Set<string>()
  for (const terminalTab of args.terminalTabs) {
    if (args.isWorktreeActive && args.assignments.get(terminalTab.id)?.isActiveInGroup === true) {
      visibleTabIds.add(terminalTab.id)
    }
  }
  return args.terminalTabs.map((terminalTab) => {
    const isVisible = visibleTabIds.has(terminalTab.id)
    const hasActivityTerminalPortal = args.portalTabIds.has(terminalTab.id)
    // Why: measure probes need mounted panes without restarting the park clock.
    if (isVisible || hasActivityTerminalPortal) {
      args.hiddenSinceByTabId.delete(terminalTab.id)
    } else if (!args.shouldMeasureHiddenWorktree && !args.hiddenSinceByTabId.has(terminalTab.id)) {
      args.hiddenSinceByTabId.set(terminalTab.id, args.nowMs)
    }
    return {
      id: terminalTab.id,
      ptyId: terminalTab.ptyId,
      pendingActivationSpawn: terminalTab.pendingActivationSpawn,
      isVisible,
      hasActivityTerminalPortal,
      hiddenSinceMs: args.hiddenSinceByTabId.get(terminalTab.id) ?? null,
      lastActivatedSeq: args.activationOrder.getActivationSeq(terminalTab.id)
    }
  })
}
