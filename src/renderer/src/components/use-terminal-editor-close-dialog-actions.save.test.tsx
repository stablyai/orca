// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachEditorAutosaveController } from './editor/editor-autosave-controller'
import {
  createEditorStore,
  createFakeEditorDisk
} from './editor/editor-autosave-controller-test-fixture'
import { __clearSelfWriteRegistryForTests } from './editor/editor-self-write-registry'
import {
  useTerminalEditorCloseDialogActions,
  type TerminalEditorCloseDialogActionsInput
} from './use-terminal-editor-close-dialog-actions'

const mocks = vi.hoisted(
  (): {
    store: ReturnType<typeof createEditorStore> | null
    error: ReturnType<typeof vi.fn>
  } => ({ store: null, error: vi.fn() })
)

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => {
      if (!mocks.store) {
        throw new Error('Editor store unavailable')
      }
      return mocks.store.getState()
    }
  }
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))

const fileId = '/repo/file.md'

function createFixture() {
  const store = createEditorStore()
  const settings = store.getState().settings
  if (!settings) {
    throw new Error('Editor settings unavailable')
  }
  store.setState({
    settings: { ...settings, editorAutoSave: false },
    browserTabsByWorktree: {},
    tabsByWorktree: {},
    unifiedTabsByWorktree: {}
  })
  store.getState().openFile({
    filePath: fileId,
    relativePath: 'file.md',
    worktreeId: 'wt-1',
    language: 'markdown',
    mode: 'edit'
  })
  store.getState().setEditorDraft(fileId, 'before save')
  store.getState().markFileDirty(fileId, true)
  const disk = createFakeEditorDisk({ [fileId]: 'on disk' })
  Object.assign(window, { api: { fs: disk.fs } })
  mocks.store = store
  const controller: TerminalEditorCloseDialogActionsInput = {
    advanceEditorCloseQueue: vi.fn(),
    inFlightSaveFileIdRef: { current: null },
    isClosingRef: { current: false },
    pendingEditorCloseQueueRef: { current: [fileId] },
    queueEditorCloseRequests: vi.fn(),
    releaseCloseDialogGuardAfterDebounce: vi.fn(),
    saveDialogFileId: fileId,
    setSaveDialogFileId: vi.fn(),
    windowCloseAfterDirtyRef: { current: null }
  }
  const view = renderHook(() => useTerminalEditorCloseDialogActions(controller))
  return { store, disk, controller, view }
}

beforeEach(() => mocks.error.mockReset())
afterEach(() => {
  vi.useRealTimers()
  cleanup()
  Reflect.deleteProperty(window, 'api')
  mocks.store = null
  __clearSelfWriteRegistryForTests()
})

describe('Save and Close completion in the unsaved changes dialog', () => {
  it('immediately reopens for newer edits without reporting a write failure', async () => {
    const { store, disk, controller, view } = createFixture()
    const gate = Promise.withResolvers<void>()
    disk.fs.writeFile.mockImplementationOnce(async ({ filePath, content }) => {
      await gate.promise
      disk.files.set(filePath, content)
    })
    const detach = attachEditorAutosaveController(store)
    try {
      let completion = Promise.resolve()
      act(() => {
        completion = view.result.current.handleSaveDialogSave()
      })
      await vi.waitFor(() => expect(disk.fs.writeFile).toHaveBeenCalledOnce())
      store.getState().setEditorDraft(fileId, 'newer edit')
      store.getState().markFileDirty(fileId, true)
      gate.resolve()
      await act(async () => completion)
      expect(disk.files.get(fileId)).toBe('before save')
      expect(store.getState().editorDrafts[fileId]).toBe('newer edit')
      expect(controller.setSaveDialogFileId).toHaveBeenNthCalledWith(1, null)
      expect(controller.setSaveDialogFileId).toHaveBeenNthCalledWith(2, fileId)
      expect(controller.isClosingRef.current).toBe(false)
      expect(controller.inFlightSaveFileIdRef.current).toBeNull()
      expect(controller.advanceEditorCloseQueue).not.toHaveBeenCalled()
      expect(mocks.error).not.toHaveBeenCalled()
    } finally {
      gate.resolve()
      detach()
    }
  })

  it('still reports an actual write failure and keeps the draft open', async () => {
    const { store, disk, controller, view } = createFixture()
    disk.fs.writeFile.mockRejectedValueOnce(new Error('connection lost'))
    const detach = attachEditorAutosaveController(store)
    try {
      await act(() => view.result.current.handleSaveDialogSave())
      expect(store.getState().editorDrafts[fileId]).toBe('before save')
      expect(controller.setSaveDialogFileId).toHaveBeenLastCalledWith(fileId)
      expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
        'Save timed out or failed. Fix errors before closing.'
      )
    } finally {
      detach()
    }
  })

  it('advances the close queue only after a successful save closes the file', async () => {
    const { store, disk, controller, view } = createFixture()
    const detach = attachEditorAutosaveController(store)
    try {
      await act(() => view.result.current.handleSaveDialogSave())
      expect(disk.files.get(fileId)).toBe('before save')
      expect(store.getState().openFiles).toEqual([])
      expect(controller.pendingEditorCloseQueueRef.current).toEqual([])
      expect(controller.advanceEditorCloseQueue).toHaveBeenCalledOnce()
      expect(controller.releaseCloseDialogGuardAfterDebounce).toHaveBeenCalledOnce()
      expect(mocks.error).not.toHaveBeenCalled()
    } finally {
      detach()
    }
  })

  it('reports unavailable save handling without waiting for a tab-close timeout', async () => {
    const { store, disk, controller, view } = createFixture()
    await act(() => view.result.current.handleSaveDialogSave())
    expect(store.getState().openFiles).toHaveLength(1)
    expect(disk.fs.writeFile).not.toHaveBeenCalled()
    expect(controller.setSaveDialogFileId).toHaveBeenLastCalledWith(fileId)
    expect(mocks.error).toHaveBeenCalledOnce()
  })

  it('releases the dialog when an accepted write never completes', async () => {
    vi.useFakeTimers()
    const { store, disk, controller, view } = createFixture()
    const gate = Promise.withResolvers<void>()
    disk.fs.writeFile.mockReturnValueOnce(gate.promise)
    const detach = attachEditorAutosaveController(store)
    try {
      let completion = Promise.resolve()
      act(() => {
        completion = view.result.current.handleSaveDialogSave()
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(disk.fs.writeFile).toHaveBeenCalledOnce()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
        await completion
      })
      expect(store.getState().editorDrafts[fileId]).toBe('before save')
      expect(store.getState().openFiles).toEqual([
        expect.objectContaining({ id: fileId, isDirty: true })
      ])
      expect(controller.setSaveDialogFileId).toHaveBeenLastCalledWith(fileId)
      expect(controller.isClosingRef.current).toBe(false)
      expect(controller.inFlightSaveFileIdRef.current).toBeNull()
      expect(mocks.error).toHaveBeenCalledOnce()
    } finally {
      gate.resolve()
      await vi.advanceTimersByTimeAsync(0)
      detach()
    }
  })
})
