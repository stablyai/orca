import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '../../store'
import { capturedPanesByTabId } from './terminal-parked-watcher-registry'
type TerminalParkingAssignment = {
  groupId: string
  isActiveInGroup: boolean
}

export function getTerminalParkingInputsKey(terminalTabs: readonly TerminalTab[]): string {
  return JSON.stringify(terminalTabs.map((tab) => [tab.id, tab.ptyId, tab.pendingActivationSpawn]))
}

export function getTerminalParkingAssignmentsKey(
  assignments: ReadonlyMap<string, TerminalParkingAssignment>
): string {
  return JSON.stringify(
    Array.from(assignments, ([tabId, assignment]) => [
      tabId,
      assignment.groupId,
      assignment.isActiveInGroup
    ])
  )
}

export function getWatcherReconciliationKey(tabs: readonly TerminalTab[]): string {
  const state = useAppStore.getState()
  return JSON.stringify(
    tabs.map((tab) => {
      const layout = state.terminalLayoutsByTabId[tab.id]
      const titles = state.runtimePaneTitlesByTabId[tab.id]
      const capture = capturedPanesByTabId.get(tab.id)
      return [
        tab.id,
        state.ptyIdsByTabId[tab.id] ?? [],
        layout?.root ?? null,
        layout?.activeLeafId ?? null,
        layout?.ptyIdsByLeafId ?? null,
        titles ? Object.keys(titles) : [],
        capture?.worktreeId ?? null,
        capture?.panes.map((pane) => [pane.ptyId, pane.paneId, pane.leafId, pane.drivesTabTitle]) ??
          []
      ]
    })
  )
}

export function haveSameTerminalTabIds(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>
): boolean {
  if (left.size !== right.size) {
    return false
  }
  for (const id of left) {
    if (!right.has(id)) {
      return false
    }
  }
  return true
}
