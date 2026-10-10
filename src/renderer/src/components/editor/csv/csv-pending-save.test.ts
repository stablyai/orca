import { afterEach, expect, it, vi } from 'vitest'
import { createEditorSaveQueue } from '../editor-save-queue'
import { registerPendingEditorFlush } from '../editor-pending-flush'
import {
  createEditorStore,
  stubEditorWindowWithDisk
} from '../editor-autosave-controller-test-fixture'

afterEach(() => vi.unstubAllGlobals())

function setup() {
  const disk = stubEditorWindowWithDisk()
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
  const queue = createEditorSaveQueue(store)
  return { disk, store, file, queue }
}

it('autosave flushes a legacy editor and reads its updated draft before writing', async () => {
  const { disk, store, file, queue } = setup()
  const unregister = registerPendingEditorFlush(file.id, () =>
    store.getState().setEditorDraft(file.id, 'header\nlatest')
  )
  try {
    await queue.queueSave(file, 'header\nstale', 'autosave')
    expect(disk.files.get(file.filePath)).toBe('header\nlatest')
    expect(store.getState().openFiles[0]?.isDirty).toBe(false)
  } finally {
    unregister()
    queue.dispose()
  }
})

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

it('a suspended autosave does not flush a pending cell or write the file', async () => {
  const { disk, store, file, queue } = setup()
  store.getState().setExternalMutation(file.id, 'changed')
  const flush = vi.fn()
  const unregister = registerPendingEditorFlush(file.id, flush)
  try {
    await queue.queueSave(file, 'fallback', 'autosave')
    expect(flush).not.toHaveBeenCalled()
    expect(disk.fs.writeFile).not.toHaveBeenCalled()
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

it.each([false, true])(
  'autosave leaves an active CSV input alone (changed: %s)',
  async (changed) => {
    const { disk, store, file, queue } = setup()
    const flush = vi.fn(() => {
      throw new Error('rejected cell')
    })
    const unregister = registerPendingEditorFlush(file.id, flush, () => changed)
    try {
      await queue.queueSave(file, 'fallback', 'autosave')
      expect(flush).not.toHaveBeenCalled()
      expect(disk.files.get(file.filePath)).toBe('header\nprevious')
      expect(store.getState().openFiles[0]?.isDirty).toBe(changed)
      if (changed) {
        await queue.queueSave(file, 'fallback', 'autosave')
        expect(disk.fs.writeFile).toHaveBeenCalledTimes(1)
      }
    } finally {
      unregister()
      queue.dispose()
    }
  }
)
