import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_EDITOR_SAVE_AND_CLOSE_EVENT } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { createEditorStore, stubEditorWindow } from './editor-autosave-controller-test-fixture'
import { registerPendingEditorFlush } from './editor-pending-flush'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'

const mocks = vi.hoisted(() => ({ getConnectionIdForFile: vi.fn() }))

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: mocks.getConnectionIdForFile
}))

const fileId = '/repo/file.ts'

function createSaveAndCloseFixture() {
  const writeFile = stubEditorWindow()
  const store = createEditorStore()
  const settings = store.getState().settings
  if (!settings) {
    throw new Error('Editor fixture must provide settings')
  }
  store.setState({
    settings: { ...settings, editorAutoSave: false },
    browserTabsByWorktree: {},
    tabsByWorktree: {}
  })
  store.getState().openFile({
    filePath: fileId,
    relativePath: 'file.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit'
  })
  store.getState().setEditorDraft(fileId, 'before close')
  store.getState().markFileDirty(fileId, true)
  return { store, writeFile, cleanup: attachEditorAutosaveController(store) }
}

function requestSaveAndClose(): void {
  window.dispatchEvent(new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, { detail: { fileId } }))
}

describe('editor save and close', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.getConnectionIdForFile.mockReset()
    mocks.getConnectionIdForFile.mockReturnValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
  })

  it.each(['typed during save', ''])(
    'preserves a newer draft %j while a write is pending',
    async (draft) => {
      const { store, writeFile, cleanup } = createSaveAndCloseFixture()
      const pendingWrite = Promise.withResolvers<void>()
      writeFile.mockReturnValueOnce(pendingWrite.promise)
      try {
        requestSaveAndClose()
        await vi.advanceTimersByTimeAsync(0)
        expect(writeFile).toHaveBeenCalledExactlyOnceWith({
          filePath: fileId,
          content: 'before close',
          connectionId: undefined,
          expectedExecutionHostId: 'local'
        })

        store.getState().setEditorDraft(fileId, draft)
        store.getState().markFileDirty(fileId, true)
        pendingWrite.resolve()
        await vi.advanceTimersByTimeAsync(0)

        expect(store.getState().openFiles).toEqual([
          expect.objectContaining({ id: fileId, isDirty: true })
        ])
        expect(store.getState().editorDrafts[fileId]).toBe(draft)

        requestSaveAndClose()
        await vi.advanceTimersByTimeAsync(0)
        expect(writeFile).toHaveBeenLastCalledWith(expect.objectContaining({ content: draft }))
        expect(store.getState().openFiles).toEqual([])
      } finally {
        pendingWrite.resolve()
        cleanup()
      }
    }
  )

  it('flushes edits buffered during the write before deciding whether to close', async () => {
    const { store, writeFile, cleanup } = createSaveAndCloseFixture()
    const pendingWrite = Promise.withResolvers<void>()
    writeFile.mockReturnValueOnce(pendingWrite.promise)
    let bufferedContent: string | undefined
    const unregister = registerPendingEditorFlush(fileId, () => {
      if (bufferedContent !== undefined) {
        store.getState().setEditorDraft(fileId, bufferedContent)
        bufferedContent = undefined
      }
    })
    try {
      requestSaveAndClose()
      await vi.advanceTimersByTimeAsync(0)
      expect(writeFile).toHaveBeenCalledOnce()

      bufferedContent = 'pending rich edit'
      pendingWrite.resolve()
      await vi.advanceTimersByTimeAsync(0)

      expect(store.getState().openFiles).toEqual([expect.objectContaining({ id: fileId })])
      expect(store.getState().editorDrafts[fileId]).toBe('pending rich edit')
      expect(writeFile).toHaveBeenCalledOnce()
    } finally {
      pendingWrite.resolve()
      unregister()
      cleanup()
    }
  })

  it('closes after saving when no newer edit remains', async () => {
    const { store, writeFile, cleanup } = createSaveAndCloseFixture()
    try {
      requestSaveAndClose()
      await vi.advanceTimersByTimeAsync(0)
      expect(writeFile).toHaveBeenCalledOnce()
      expect(store.getState().openFiles).toEqual([])
      expect(store.getState().editorDrafts[fileId]).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  it('keeps the dirty file open when the write fails', async () => {
    const { store, writeFile, cleanup } = createSaveAndCloseFixture()
    writeFile.mockRejectedValueOnce(new Error('connection lost'))
    try {
      requestSaveAndClose()
      await vi.advanceTimersByTimeAsync(0)
      expect(store.getState().openFiles).toEqual([
        expect.objectContaining({ id: fileId, isDirty: true })
      ])
      expect(store.getState().editorDrafts[fileId]).toBe('before close')
    } finally {
      cleanup()
    }
  })
})
