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
): Pick<TerminalSlice, 'replaceTerminalExitRecords'> {
  return {
    replaceTerminalExitRecords: (records: TerminalExitRecord[]) => {
      // Why: every store publication visits every pane's listeners, so a push that changes
      // nothing must publish nothing.
      set((s) =>
        hasSameExitRecords(s.terminalExitRecordsByLeafId, records)
          ? s
          : {
              terminalExitRecordsByLeafId: Object.fromEntries(
                records.map((record) => [record.leafId, record] as const)
              )
            }
      )
    }
  }
}
