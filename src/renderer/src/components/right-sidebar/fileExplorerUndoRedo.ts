/**
 * Linear undo/redo for file explorer mutations (delete, create, rename).
 * Uses in-memory closures so each step carries the exact paths/content needed
 * to reverse or replay the operation without relying on OS trash restore
 * (which is not exposed in a portable way here).
 */
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
