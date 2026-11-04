import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { AutomationRunPaneTarget } from './automation-run-open-target'

export function buildAutomationRunOpenLayout({
  target,
  currentLayout
}: {
  target: AutomationRunPaneTarget
  currentLayout: TerminalLayoutSnapshot
}): TerminalLayoutSnapshot {
  return {
    ...currentLayout,
    activeLeafId: target.leafId,
    expandedLeafId: currentLayout.expandedLeafId === target.leafId ? target.leafId : null,
    ptyIdsByLeafId: target.ptyId
      ? { ...currentLayout.ptyIdsByLeafId, [target.leafId]: target.ptyId }
      : currentLayout.ptyIdsByLeafId
  }
}
