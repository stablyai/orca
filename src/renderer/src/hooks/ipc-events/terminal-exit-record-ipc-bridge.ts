import { useAppStore } from '../../store'

/** Mirrors main's exit records for kept leaves. */
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
}
