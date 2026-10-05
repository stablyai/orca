// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { StoreApi } from 'zustand/vanilla'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { AppState } from '@/store'
import {
  createFakeEditorDisk,
  createUntitledNoteStore,
  type FakeEditorDisk
} from './editor-autosave-controller-test-fixture'
import { getDiskBaselineSignature } from './diff-content-signature'
import { registerEditorRecoveryResolver } from '@/lib/editor-recovery-checkpoints'
import { useTerminalSaveDialog } from '../terminal/useTerminalSaveDialog'
import {
  useTerminalEditorCloseDialogActions,
  type TerminalEditorCloseDialogActionsInput
} from '../use-terminal-editor-close-dialog-actions'

const storeHolder = vi.hoisted((): { store: StoreApi<AppState> | null } => ({ store: null }))

function requireStore(): StoreApi<AppState> {
  if (!storeHolder.store) {
    throw new Error('test store not initialised')
  }
  return storeHolder.store
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => requireStore().getState() } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: vi.fn() }))

const FILE_ID = '/repo/untitled.md'

function mainWindowDialogController(fileId: string): TerminalEditorCloseDialogActionsInput {
  return {
    advanceEditorCloseQueue: vi.fn(),
    inFlightSaveFileIdRef: { current: null },
    isClosingRef: { current: false },
    pendingEditorCloseQueueRef: { current: [fileId] },
    queueEditorCloseRequests: vi.fn(),
    releaseCloseDialogGuardAfterDebounce: vi.fn(),
    saveDialogFileId: fileId,
    setSaveDialogFileId: vi.fn(),
    waitForFileClosed: vi.fn(async () => true),
    windowCloseAfterDirtyRef: { current: null }
  }
}

describe("Don't Save in the unsaved-changes dialogs on a never-saved untitled note", () => {
  let disk: FakeEditorDisk
  let store: StoreApi<AppState>

  beforeEach(() => {
    disk = createFakeEditorDisk({ [FILE_ID]: '' })
    Object.assign(window, { api: { fs: disk.fs } })
    store = createUntitledNoteStore('untitled.md')
    storeHolder.store = store
    store.getState().setLastKnownDiskSignature(FILE_ID, getDiskBaselineSignature(''))
    store.getState().setEditorDraft(FILE_ID, 'typed but never saved')
    store.getState().markFileDirty(FILE_ID, true)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    Reflect.deleteProperty(window, 'api')
    storeHolder.store = null
  })

  it('main window removes the empty placeholder', async () => {
    const { result } = renderHook(() =>
      useTerminalEditorCloseDialogActions(mainWindowDialogController(FILE_ID))
    )

    await act(() => result.current.handleSaveDialogDiscard())

    expect(store.getState().openFiles).toHaveLength(0)
    await vi.waitFor(() => expect(disk.files.has(FILE_ID)).toBe(false))
  })

  it('floating panel removes the empty placeholder', async () => {
    const { result } = renderHook(() =>
      useTerminalSaveDialog({
        openFiles: store.getState().openFiles,
        closeFile: store.getState().closeFile
      })
    )
    act(() => result.current.requestCloseFile(FILE_ID))
    expect(result.current.saveDialogFileId).toBe(FILE_ID)

    await act(async () => {
      // Why: the hook's result type declares the discard handler as void though it returns a promise.
      await Promise.resolve(result.current.handleSaveDialogDiscard())
    })

    expect(store.getState().openFiles).toHaveLength(0)
    await vi.waitFor(() => expect(disk.files.has(FILE_ID)).toBe(false))
  })

  it('restores the main-window close prompt and releases its guard after retirement fails', async () => {
    const resolver = vi.fn(async () => {})
    resolver.mockRejectedValueOnce(new Error('Journal unavailable'))
    const unregister = registerEditorRecoveryResolver(resolver)
    const errorToast = vi.spyOn(toast, 'error').mockReturnValue('discard-error')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const controller = mainWindowDialogController(FILE_ID)
    const { result } = renderHook(() => useTerminalEditorCloseDialogActions(controller))
    try {
      await act(() => result.current.handleSaveDialogDiscard())
      expect(store.getState().openFiles[0]?.isDirty).toBe(true)
      expect(controller.setSaveDialogFileId).toHaveBeenLastCalledWith(FILE_ID)
      expect(controller.isClosingRef.current).toBe(false)
      expect(controller.advanceEditorCloseQueue).not.toHaveBeenCalled()
      expect(errorToast).toHaveBeenCalledWith('Could not discard unsaved changes. Try again.')
      expect(logged).toHaveBeenCalledOnce()
      await act(() => result.current.handleSaveDialogDiscard())
      expect(store.getState().openFiles).toHaveLength(0)
      expect(controller.advanceEditorCloseQueue).toHaveBeenCalledOnce()
    } finally {
      unregister()
    }
  })

  it('keeps the floating close prompt retryable when retirement fails', async () => {
    const resolver = vi.fn(async () => {})
    resolver.mockRejectedValueOnce(new Error('Journal unavailable'))
    const unregister = registerEditorRecoveryResolver(resolver)
    vi.spyOn(toast, 'error').mockReturnValue('discard-error')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = renderHook(() =>
      useTerminalSaveDialog({
        openFiles: store.getState().openFiles,
        closeFile: store.getState().closeFile
      })
    )
    try {
      act(() => result.current.requestCloseFile(FILE_ID))
      await act(async () => {
        await Promise.resolve(result.current.handleSaveDialogDiscard())
      })
      expect(result.current.saveDialogFileId).toBe(FILE_ID)
      expect(store.getState().openFiles[0]?.isDirty).toBe(true)
      await act(async () => {
        await Promise.resolve(result.current.handleSaveDialogDiscard())
      })
      expect(result.current.saveDialogFileId).toBeNull()
      expect(store.getState().openFiles).toHaveLength(0)
    } finally {
      unregister()
    }
  })
})
