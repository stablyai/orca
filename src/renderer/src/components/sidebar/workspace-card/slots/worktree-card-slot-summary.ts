import type { SlotException } from './worktree-card-slot-signal'

/** Flat so `useShallow` can compare it across store updates; one field per exception. */
export type LineageSlotRecord = {
  needs: number
  failed: boolean
  unread: boolean
  unreadAt: number | null
  working: boolean
  workingAt: number | null
  monitoring: boolean
}

export function toLineageSlotRecord(exceptions: readonly SlotException[]): LineageSlotRecord {
  const record: LineageSlotRecord = {
    needs: 0,
    failed: false,
    unread: false,
    unreadAt: null,
    working: false,
    workingAt: null,
    monitoring: false
  }
  for (const exception of exceptions) {
    switch (exception.kind) {
      case 'needs':
        record.needs = exception.count
        break
      case 'failed':
        record.failed = true
        break
      case 'unread':
        record.unread = true
        record.unreadAt = exception.at
        break
      case 'working':
        record.working = true
        record.workingAt = exception.at
        record.monitoring = exception.monitoring === true
        break
    }
  }
  return record
}

export function fromLineageSlotRecord(record: LineageSlotRecord): SlotException[] {
  const exceptions: SlotException[] = []
  if (record.needs > 0) {
    exceptions.push({ kind: 'needs', count: record.needs })
  }
  if (record.failed) {
    exceptions.push({ kind: 'failed' })
  }
  if (record.unread) {
    exceptions.push({ kind: 'unread', at: record.unreadAt, manual: false })
  }
  if (record.working) {
    exceptions.push({ kind: 'working', at: record.workingAt, monitoring: record.monitoring })
  }
  return exceptions
}

export function mergeRecord(into: LineageSlotRecord, from: LineageSlotRecord): void {
  into.needs += from.needs
  into.failed ||= from.failed
  into.unread ||= from.unread
  into.unreadAt = Math.max(into.unreadAt ?? 0, from.unreadAt ?? 0) || null
  const monitoring = (!into.working || into.monitoring) && (!from.working || from.monitoring)
  into.working ||= from.working
  into.workingAt = Math.max(into.workingAt ?? 0, from.workingAt ?? 0) || null
  into.monitoring = into.working && monitoring
}
