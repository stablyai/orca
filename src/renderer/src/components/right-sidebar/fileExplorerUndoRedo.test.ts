import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearFileExplorerUndoHistory,
  commitFileExplorerOp,
  FILE_EXPLORER_UNDO_MAX_ENTRY_BYTES,
  fileExplorerHasUndo,
  getFileExplorerUndoRetainedBytesForTests,
  undoFileExplorer
} from './fileExplorerUndoRedo'

beforeEach(() => {
  clearFileExplorerUndoHistory()
})

describe('file explorer undo retention', () => {
  it('rejects an operation whose captured payload exceeds the per-entry budget', () => {
    expect(
      commitFileExplorerOp({
        retainedBytes: FILE_EXPLORER_UNDO_MAX_ENTRY_BYTES + 1,
        undo: vi.fn(),
        redo: vi.fn()
      })
    ).toBe(false)
    expect(fileExplorerHasUndo()).toBe(false)
  })

  it('evicts the oldest operation to stay within the aggregate budget', async () => {
    const oldestUndo = vi.fn()
    const retainedPerOperation = 12 * 1024 * 1024
    commitFileExplorerOp({
      retainedBytes: retainedPerOperation,
      undo: oldestUndo,
      redo: vi.fn()
    })
    for (let index = 0; index < 2; index += 1) {
      commitFileExplorerOp({
        retainedBytes: retainedPerOperation,
        undo: vi.fn(),
        redo: vi.fn()
      })
    }

    expect(getFileExplorerUndoRetainedBytesForTests()).toBe(retainedPerOperation * 2)
    await undoFileExplorer()
    await undoFileExplorer()
    expect(oldestUndo).not.toHaveBeenCalled()
  })
})
