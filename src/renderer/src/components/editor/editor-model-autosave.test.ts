import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { requestEditorFileSave } from './editor-autosave'
import { registerEditorModelContentCheckpoint } from './editor-model-content-checkpoint'
import { createCheckpointModelFixture } from './editor-model-checkpoint-test-fixture'
import {
  createEditorStore,
  stubEditorWindowWithDisk
} from './editor-autosave-controller-test-fixture'

vi.mock('@/lib/editor-recovery-checkpoints', () => ({
  resolveEditorRecovery: vi.fn(async () => {})
}))

const cleanups: (() => void)[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function fixture(autoSave = true) {
  const disk = stubEditorWindowWithDisk()
  const store = createEditorStore()
  const settings = store.getState().settings
  if (!settings) {
    throw new Error('Missing editor settings')
  }
  store.setState({ settings: { ...settings, editorAutoSave: autoSave } })
  store.getState().openFile({
    filePath: '/repo/note.txt',
    relativePath: 'note.txt',
    worktreeId: 'wt-1',
    mode: 'edit',
    language: 'plaintext'
  })
  const file = store.getState().openFiles[0]
  if (!file) {
    throw new Error('Missing open file')
  }
  const model = createCheckpointModelFixture()
  cleanups.push(
    registerEditorModelContentCheckpoint(model.model, {
      fileId: file.id,
      publish: (content) => {
        store.getState().setEditorDraft(file.id, content)
        store.getState().markFileDirty(file.id, content !== 'baseline')
      },
      onPending: () => store.getState().markFileDirty(file.id, true)
    }),
    attachEditorAutosaveController(store)
  )
  return { disk, store, file, model }
}

describe('autosave with deferred model text', () => {
  it('starts from the first input and preserves the delay when a checkpoint publishes text', async () => {
    const f = fixture()
    f.model.edit('first')
    expect(f.store.getState().openFiles[0]?.isDirty).toBe(true)
    expect(f.store.getState().editorDrafts[f.file.id]).toBeUndefined()
    expect(f.model.model.getValue).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(999)
    expect(f.disk.fs.writeFile).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.disk.files.get(f.file.filePath)).toBe('first')
    expect(f.store.getState().openFiles[0]?.isDirty).toBe(false)
  })

  it('resets autosave on later input even while the dirty flag and stored body are unchanged', async () => {
    const f = fixture()
    f.model.edit('first')
    await vi.advanceTimersByTimeAsync(900)
    f.model.edit('second')
    await vi.advanceTimersByTimeAsync(999)
    expect(f.disk.fs.writeFile).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.disk.files.get(f.file.filePath)).toBe('second')
    expect(f.disk.fs.writeFile).toHaveBeenCalledOnce()
  })

  it('flushes an explicit save immediately and keeps input made while the disk write is pending', async () => {
    const f = fixture(false)
    let finish: (() => void) | undefined
    f.disk.fs.writeFile.mockImplementationOnce(
      ({ filePath, content }) =>
        new Promise<void>((resolve) => {
          finish = () => {
            f.disk.files.set(filePath, content)
            resolve()
          }
        })
    )
    f.model.edit('saved first body')
    const save = requestEditorFileSave({ fileId: f.file.id })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.disk.fs.writeFile).toHaveBeenCalledOnce()
    f.model.edit('newer body during write')
    expect(f.store.getState().editorDrafts[f.file.id]).toBe('saved first body')
    if (!finish) {
      throw new Error('Disk write was not started')
    }
    finish()
    await save
    expect(f.disk.files.get(f.file.filePath)).toBe('saved first body')
    expect(f.store.getState().editorDrafts[f.file.id]).toBe('newer body during write')
    expect(f.store.getState().openFiles[0]?.isDirty).toBe(true)
    expect(f.model.model.getValue).toHaveBeenCalledTimes(2)
  })

  it('keeps an undo to the old baseline dirty when the in-flight write saves a different body', async () => {
    const f = fixture(false)
    let finish: (() => void) | undefined
    f.disk.fs.writeFile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    f.model.edit('new saved baseline')
    const save = requestEditorFileSave({ fileId: f.file.id })
    await vi.advanceTimersByTimeAsync(0)
    f.model.edit('baseline')
    if (!finish) {
      throw new Error('Disk write was not started')
    }
    finish()
    await save
    expect(f.store.getState().editorDrafts[f.file.id]).toBe('baseline')
    expect(f.store.getState().openFiles[0]?.isDirty).toBe(true)
  })
})
