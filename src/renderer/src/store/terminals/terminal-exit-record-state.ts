import type { TerminalExitRecord } from '../../../../shared/terminal-surface-exit'
import type { TerminalSlice, TerminalStoreSet } from './terminal-state'

// Why: a record is written once per exit, so the process it names and the time identify it.
function isSameExitRecord(left: TerminalExitRecord, right: TerminalExitRecord): boolean {
  return (
    left.worktreeId === right.worktreeId &&
    left.ptyId === right.ptyId &&
    left.incarnationId === right.incarnationId &&
    left.exitedAt === right.exitedAt
  )
}

function hasSameExitRecords(
  current: Record<string, TerminalExitRecord>,
  records: readonly TerminalExitRecord[]
): boolean {
  if (Object.keys(current).length !== records.length) {
    return false
  }
  return records.every((record) => {
    const held = current[record.leafId]
    return held !== undefined && isSameExitRecord(held, record)
  })
}

export function createTerminalExitRecordActions(
  set: TerminalStoreSet
): Pick<
  TerminalSlice,
  'replaceTerminalExitRecords' | 'requestExitedTerminalRestart' | 'consumeExitedTerminalRestart'
> {
  return {
    replaceTerminalExitRecords: (records: TerminalExitRecord[]) => {
      set((s) => {
        // Why: every store publication visits every pane's listeners, so a push that changes
        // nothing must publish nothing.
        const terminalExitRecordsByLeafId = hasSameExitRecords(
          s.terminalExitRecordsByLeafId,
          records
        )
          ? s.terminalExitRecordsByLeafId
          : Object.fromEntries(records.map((record) => [record.leafId, record] as const))
        const pendingLeafIds = Object.keys(s.pendingExitedTerminalRestartLeafIds)
        // Why: a restart asked for a leaf that no longer has a record has already happened.
        const keptPendingLeafIds = pendingLeafIds.filter(
          (leafId) => terminalExitRecordsByLeafId[leafId]
        )
        const pendingExitedTerminalRestartLeafIds =
          keptPendingLeafIds.length === pendingLeafIds.length
            ? s.pendingExitedTerminalRestartLeafIds
            : Object.fromEntries(keptPendingLeafIds.map((leafId) => [leafId, true] as const))
        if (
          terminalExitRecordsByLeafId === s.terminalExitRecordsByLeafId &&
          pendingExitedTerminalRestartLeafIds === s.pendingExitedTerminalRestartLeafIds
        ) {
          return s
        }
        return { terminalExitRecordsByLeafId, pendingExitedTerminalRestartLeafIds }
      })
    },
    requestExitedTerminalRestart: (leafId) => {
      set((s) =>
        s.terminalExitRecordsByLeafId[leafId] && !s.pendingExitedTerminalRestartLeafIds[leafId]
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
