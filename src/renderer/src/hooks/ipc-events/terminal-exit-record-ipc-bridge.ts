import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/sync-runtime-graph'
import { useAppStore } from '../../store'

/** Mirrors main's exit records for kept leaves and runs the restarts main routes to this window. */
export function registerTerminalExitRecordIpcBridge(unsubs: (() => void)[]): void {
  let changedSinceList = false
  unsubs.push(
    window.api.ui.onTerminalExitRecordsChanged((records) => {
      changedSinceList = true
      useAppStore.getState().replaceTerminalExitRecords(records)
    })
  )
  void window.api.ui
    .listTerminalExitRecords()
    .then((records) => {
      // Why: a push that landed first is newer than this reply.
      if (!changedSinceList) {
        useAppStore.getState().replaceTerminalExitRecords(records)
      }
    })
    .catch((error) => console.error('Failed to read terminal exit records:', error))

  unsubs.push(
    window.api.ui.onRestartExitedTerminal(({ tabId, worktreeId, leafId }) => {
      useAppStore.getState().requestExitedTerminalRestart(leafId)
      // Why: only a mounted pane can restart; an unmounted one consumes the request when it mounts.
      if (!hasRegisteredRuntimeTerminalTab(tabId, worktreeId)) {
        requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tabId] })
      }
    })
  )
}
