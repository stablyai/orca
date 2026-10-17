import { afterEach, expect, it, vi } from 'vitest'
import {
  clearFileExplorerUndoHistory,
  commitFileExplorerOp,
  fileExplorerHasRedo,
  fileExplorerHasUndo,
  redoFileExplorer,
  undoFileExplorer
} from './fileExplorerUndoRedo'

function operation() {
  return {
    undo: vi.fn().mockResolvedValue(undefined),
    redo: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined)
  }
}

afterEach(async () => {
  clearFileExplorerUndoHistory()
  await Promise.resolve()
})

it('keeps resources through undo and redo and releases both stacks on clear', async () => {
  const first = operation()
  const second = operation()
  commitFileExplorerOp(first)
  commitFileExplorerOp(second)
  await undoFileExplorer()
  await redoFileExplorer()
  await undoFileExplorer()
  expect(first.dispose).not.toHaveBeenCalled()
  expect(second.dispose).not.toHaveBeenCalled()
  clearFileExplorerUndoHistory()
  await Promise.resolve()
  expect(first.dispose).toHaveBeenCalledOnce()
  expect(second.dispose).toHaveBeenCalledOnce()
  expect(fileExplorerHasUndo()).toBe(false)
  expect(fileExplorerHasRedo()).toBe(false)
})

it('releases redo resources on a new mutation and old resources at the history limit', async () => {
  const discarded = operation()
  commitFileExplorerOp(discarded)
  await undoFileExplorer()
  const oldest = operation()
  commitFileExplorerOp(oldest)
  for (let index = 0; index < 50; index += 1) {
    commitFileExplorerOp(operation())
  }
  await Promise.resolve()
  expect(discarded.dispose).toHaveBeenCalledOnce()
  expect(oldest.dispose).toHaveBeenCalledOnce()
  expect(fileExplorerHasRedo()).toBe(false)
})

it('keeps failed undo and redo steps available for retry', async () => {
  const op = operation()
  op.undo.mockRejectedValueOnce(new Error('offline'))
  op.redo.mockRejectedValueOnce(new Error('permission denied'))
  commitFileExplorerOp(op)
  await expect(undoFileExplorer()).rejects.toThrow('offline')
  expect(fileExplorerHasUndo()).toBe(true)
  await undoFileExplorer()
  await expect(redoFileExplorer()).rejects.toThrow('permission denied')
  expect(fileExplorerHasRedo()).toBe(true)
  await redoFileExplorer()
  expect(fileExplorerHasUndo()).toBe(true)
  expect(op.dispose).not.toHaveBeenCalled()
})

it('serializes shortcuts and defers cleanup when history clears during an operation', async () => {
  let finish = () => {}
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const previous = operation()
  const active = operation()
  active.undo.mockReturnValue(pending)
  commitFileExplorerOp(previous)
  commitFileExplorerOp(active)
  const undo = undoFileExplorer()
  expect(await undoFileExplorer()).toBe(false)
  expect(previous.undo).not.toHaveBeenCalled()
  clearFileExplorerUndoHistory()
  await Promise.resolve()
  expect(active.dispose).not.toHaveBeenCalled()
  finish()
  await undo
  await Promise.resolve()
  expect(active.dispose).toHaveBeenCalledOnce()
  expect(fileExplorerHasRedo()).toBe(false)
})
