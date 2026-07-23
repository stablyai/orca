/**
 * Linear undo/redo for file explorer mutations (delete, create, rename).
 * Uses in-memory closures so each step carries the exact paths/content needed
 * to reverse or replay the operation without relying on OS trash restore
 * (which is not exposed in a portable way here).
 */
const MAX_STEPS = 50
export const FILE_EXPLORER_UNDO_MAX_ENTRY_BYTES = 16 * 1024 * 1024
export const FILE_EXPLORER_UNDO_MAX_AGGREGATE_BYTES = 32 * 1024 * 1024

type ExplorerOp = {
  undo: () => Promise<void>
  redo: () => Promise<void>
  retainedBytes?: number
}

const past: ExplorerOp[] = []
const future: ExplorerOp[] = []
let retainedBytes = 0

export function commitFileExplorerOp(op: ExplorerOp): boolean {
  const opBytes = Math.max(0, op.retainedBytes ?? 0)
  if (opBytes > FILE_EXPLORER_UNDO_MAX_ENTRY_BYTES) {
    return false
  }
  for (const futureOp of future) {
    retainedBytes -= Math.max(0, futureOp.retainedBytes ?? 0)
  }
  future.length = 0
  while (past.length > 0 && retainedBytes + opBytes > FILE_EXPLORER_UNDO_MAX_AGGREGATE_BYTES) {
    const expired = past.shift()
    retainedBytes -= Math.max(0, expired?.retainedBytes ?? 0)
  }
  past.push(op)
  retainedBytes += opBytes
  if (past.length > MAX_STEPS) {
    const expired = past.shift()
    retainedBytes -= Math.max(0, expired?.retainedBytes ?? 0)
  }
  return true
}

export function clearFileExplorerUndoHistory(): void {
  past.length = 0
  future.length = 0
  retainedBytes = 0
}

export async function undoFileExplorer(): Promise<boolean> {
  const op = past.pop()
  if (!op) {
    return false
  }
  await op.undo()
  future.push(op)
  return true
}

export async function redoFileExplorer(): Promise<boolean> {
  const op = future.pop()
  if (!op) {
    return false
  }
  await op.redo()
  past.push(op)
  return true
}

export function fileExplorerHasUndo(): boolean {
  return past.length > 0
}

export function fileExplorerHasRedo(): boolean {
  return future.length > 0
}

export function getFileExplorerUndoRetainedBytesForTests(): number {
  return retainedBytes
}
