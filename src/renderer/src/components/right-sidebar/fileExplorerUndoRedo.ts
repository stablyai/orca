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
  dispose?: () => Promise<unknown> | void
}

const past: ExplorerOp[] = []
const future: ExplorerOp[] = []
let running = false
let revision = 0

function dispose(op: ExplorerOp | undefined): void {
  if (op?.dispose) {
    void Promise.resolve()
      .then(op.dispose)
      .catch((error) => {
        console.error('Failed to release file explorer undo resources:', error)
      })
  }
}

export function commitFileExplorerOp(op: ExplorerOp): void {
  revision += 1
  past.push(op)
  if (past.length > MAX_STEPS) {
    dispose(past.shift())
  }
  future.forEach(dispose)
  future.length = 0
}

export function clearFileExplorerUndoHistory(): void {
  revision += 1
  past.forEach(dispose)
  future.forEach(dispose)
  past.length = 0
  future.length = 0
}

async function runOperation(
  source: ExplorerOp[],
  destination: ExplorerOp[],
  action: 'undo' | 'redo'
): Promise<boolean> {
  if (running) {
    return false
  }
  const op = source.pop()
  if (!op) {
    return false
  }
  running = true
  const startedAt = revision
  try {
    await op[action]()
    if (revision === startedAt) {
      destination.push(op)
    } else {
      dispose(op)
    }
    return true
  } catch (error) {
    if (revision === startedAt) {
      source.push(op)
    } else {
      dispose(op)
    }
    throw error
  } finally {
    running = false
  }
}

export function undoFileExplorer(): Promise<boolean> {
  return runOperation(past, future, 'undo')
}

export function redoFileExplorer(): Promise<boolean> {
  return runOperation(future, past, 'redo')
}

export function fileExplorerHasUndo(): boolean {
  return past.length > 0
}

export function fileExplorerHasRedo(): boolean {
  return future.length > 0
}
