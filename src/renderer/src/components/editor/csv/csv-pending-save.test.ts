import { afterEach, expect, it, vi } from 'vitest'
import { createEditorSaveQueue } from '../save/queue/editor-save-queue'
import { registerPendingEditorFlush } from '../save/flush/editor-pending-flush'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk,
  withLoadedBaselines
} from '../autosave/editor-autosave-controller-test-fixture'

afterEach(() => vi.unstubAllGlobals())

function setup() {
  const disk = stubEditorWindowWithDisk(createFakeEditorDisk({ '/repo/data.csv': 'header\nold' }))
  const store = createEditorStore()
  store.getState().openFile({
    filePath: '/repo/data.csv',
    relativePath: 'data.csv',
    worktreeId: 'wt-1',
    mode: 'edit',
    language: 'plaintext'
  })
  const file = store.getState().openFiles[0]!
  store.getState().setEditorDraft(file.id, 'header\nprevious')
  store.getState().markFileDirty(file.id, true)
  const queue = createEditorSaveQueue(withLoadedBaselines(store, disk))
  return { disk, store, file, queue }
}

it('a failed pending edit prevents the write and keeps the existing dirty draft', async () => {
  const { disk, store, file, queue } = setup()
  const unregister = registerPendingEditorFlush(file.id, () => {
    throw new Error('invalid pending cell')
  })
  try {
    await expect(queue.queueSave(file, 'fallback')).rejects.toThrow('invalid pending cell')
    expect(disk.fs.writeFile).not.toHaveBeenCalled()
    expect(store.getState().editorDrafts[file.id]).toBe('header\nprevious')
    expect(store.getState().openFiles[0]?.isDirty).toBe(true)
  } finally {
    unregister()
    queue.dispose()
  }
})

it('keeps a newer pending cell dirty when an earlier remote save completes', async () => {
  const { disk, store, file, queue } = setup()
  let releaseWrite: () => void = () => {
    throw new Error('write not started')
  }
  disk.fs.writeFile.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releaseWrite = resolve
      })
  )
  let pending = false
  const unregister = registerPendingEditorFlush(
    file.id,
    () => {},
    () => pending
  )
  try {
    const saving = queue.queueSave(file, 'fallback')
    await vi.waitFor(() => expect(disk.fs.writeFile).toHaveBeenCalledTimes(1))
    pending = true
    releaseWrite()
    await saving
    expect(store.getState().openFiles[0]?.isDirty).toBe(true)
    expect(store.getState().editorDrafts[file.id]).toBe('header\nprevious')
  } finally {
    unregister()
    queue.dispose()
  }
})
