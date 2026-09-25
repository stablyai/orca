import type { TerminalExitRecord } from '../../../../shared/terminal-surface-exit'
import type { TerminalSlice, TerminalStoreSet } from './terminal-state'

export function createTerminalExitRecordActions(
  set: TerminalStoreSet
): Pick<
  TerminalSlice,
  'replaceTerminalExitRecords' | 'requestExitedTerminalRestart' | 'consumeExitedTerminalRestart'
> {
  return {
    replaceTerminalExitRecords: (records: TerminalExitRecord[]) => {
      set((s) => {
        const terminalExitRecordsByLeafId = Object.fromEntries(
          records.map((record) => [record.leafId, record] as const)
        )
        // Why: a restart asked for a leaf that no longer has a record has already happened.
        const pendingExitedTerminalRestartLeafIds = Object.fromEntries(
          Object.keys(s.pendingExitedTerminalRestartLeafIds)
            .filter((leafId) => terminalExitRecordsByLeafId[leafId])
            .map((leafId) => [leafId, true] as const)
        )
        return { terminalExitRecordsByLeafId, pendingExitedTerminalRestartLeafIds }
      })
    },
    requestExitedTerminalRestart: (leafId) => {
      set((s) =>
        s.terminalExitRecordsByLeafId[leafId]
          ? {
              pendingExitedTerminalRestartLeafIds: {
                ...s.pendingExitedTerminalRestartLeafIds,
                [leafId]: true
              }
            }
          : s
      )
    },
    consumeExitedTerminalRestart: (leafId) => {
      let wasRequested = false
      set((s) => {
        if (!s.pendingExitedTerminalRestartLeafIds[leafId]) {
          return s
        }
        wasRequested = true
        const next = { ...s.pendingExitedTerminalRestartLeafIds }
        delete next[leafId]
        return { pendingExitedTerminalRestartLeafIds: next }
      })
      return wasRequested
    }
  }
}
