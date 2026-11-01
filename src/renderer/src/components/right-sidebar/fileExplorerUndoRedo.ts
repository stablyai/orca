/** Keep exact mutation paths/content in memory; OS trash restore has no portable API here. */
import { FileWriteRefusedError } from '../../../../shared/file-write-disk-precondition'

const MAX_STEPS = 50

type ExplorerOp = {
  undo: () => Promise<void>
  redo: () => Promise<void>
}

const past: ExplorerOp[] = []
const future: ExplorerOp[] = []

export function commitFileExplorerOp(op: ExplorerOp): void {
  past.push(op)
  if (past.length > MAX_STEPS) {
    past.shift()
  }
  future.length = 0
}

export function clearFileExplorerUndoHistory(): void {
  past.length = 0
  future.length = 0
}

export async function undoFileExplorer(): Promise<boolean> {
  const op = past.pop()
  if (!op) {
    return false
  }
  try {
    await op.undo()
  } catch (error) {
    // Only refusals guarantee no write and can retry; timeouts may have applied, so replay could overwrite newer changes.
    if (error instanceof FileWriteRefusedError) {
      past.push(op)
    }
    throw error
  }
  future.push(op)
  return true
}

export async function redoFileExplorer(): Promise<boolean> {
  const op = future.pop()
  if (!op) {
    return false
  }
  try {
    await op.redo()
  } catch (error) {
    if (error instanceof FileWriteRefusedError) {
      future.push(op)
    }
    throw error
  }
  past.push(op)
  return true
}

export function fileExplorerHasUndo(): boolean {
  return past.length > 0
}

export function fileExplorerHasRedo(): boolean {
  return future.length > 0
}
