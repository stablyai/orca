import { afterEach, expect, it, vi } from 'vitest'
import { createEditorSaveQueue } from './editor-save-queue'
import { registerPendingEditorFlush } from '../flush/editor-pending-flush'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk,
  withLoadedBaselines
} from '../../autosave/editor-autosave-controller-test-fixture'

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
