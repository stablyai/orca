import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'
import { useAppStore } from '../../store'
import type { AppState } from '../../store/types'
import { resolveDetachedTerminalInput } from '../../store/terminals/detached-terminal-input'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '../../store/workspace-record-selectors'

// Why: only these slices change a pane's input facts; other store updates must not re-resolve them.
function terminalInputSlices(state: AppState): readonly unknown[] {
  return [
    state.detachedTerminalByTabId,
    state.tabsByWorktree,
    state.terminalLayoutsByTabId,
    state.repos,
    selectWorktreesByRepo(state),
    selectDetectedWorktreesByRepo(state),
    selectFolderWorkspaces(state),
    state.projectGroups,
    state.settings,
    state.sshConnectionStates,
    state.sshStateByEnvironment,
    state.runtimeStatusByEnvironmentId,
    state.restoredRuntimeHostIdByWorkspaceSessionKey,
    state.runtimeEnvironments,
    state.runtimeEnvironmentCatalogHydrated,
    state.removedRuntimeEnvironmentIds,
    state.paneForegroundAgentByPaneKey,
    state.agentStatusByPaneKey,
    state.agentLaunchConfigByPaneKey
  ]
}

/** Keeps each companion window's input facts current as the pane's agent or host changes. */
export function publishDetachedTerminalInputs(
  setTerminalInput: (tabId: string, terminalInput: DashboardCardTerminalInput | null) => unknown
): () => void {
  const published = new Map<string, string>()
  return useAppStore.subscribe((state, previous) => {
    const previousSlices = terminalInputSlices(previous)
    if (terminalInputSlices(state).every((slice, index) => slice === previousSlices[index])) {
      return
    }
    for (const tabId of published.keys()) {
      if (!(tabId in state.detachedTerminalByTabId)) {
        published.delete(tabId)
      }
    }
    for (const [tabId, { ptyId }] of Object.entries(state.detachedTerminalByTabId)) {
      const terminalInput = resolveDetachedTerminalInput(state, tabId, ptyId)
      const key = JSON.stringify(terminalInput)
      if (published.get(tabId) !== key) {
        published.set(tabId, key)
        void setTerminalInput(tabId, terminalInput)
      }
    }
  })
}

export function registerDetachedTerminalIpcBridge(unsubs: (() => void)[]): void {
  const subscribe = window.api.detachedTerminal?.onClosed
  if (typeof subscribe !== 'function') {
    return
  }
  unsubs.push(
    subscribe((tabId) => {
      useAppStore.getState().redockDetachedTerminalTab(tabId)
    })
  )
  const setTerminalInput = window.api.detachedTerminal.setTerminalInput
  if (typeof setTerminalInput === 'function') {
    unsubs.push(publishDetachedTerminalInputs(setTerminalInput))
  }
}
