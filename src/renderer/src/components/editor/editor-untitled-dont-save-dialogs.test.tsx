// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { StoreApi } from 'zustand/vanilla'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import {
  createFakeEditorDisk,
  createUntitledNoteStore,
  type FakeEditorDisk
} from './editor-autosave-controller-test-fixture'
import { getDiskBaselineSignature } from './diff-content-signature'
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
  const pendingEditorCloseQueueRef = { current: [fileId] }
  return {
    advanceEditorCloseQueue: vi.fn(),
    closedReactionsRef: { current: new Map() },
    inFlightSaveFileIdRef: { current: null },
    isClosingRef: { current: false },
    pendingEditorCloseQueueRef,
    queueEditorCloseRequests: vi.fn(),
    releaseCloseDialogGuardAfterDebounce: vi.fn(),
    saveDialogFileId: fileId,
    setSaveDialogFileId: vi.fn(),
    settleQueuedClose: vi.fn((settled: string) => {
      pendingEditorCloseQueueRef.current = pendingEditorCloseQueueRef.current.filter(
        (queued) => queued !== settled
      )
    }),
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
    Reflect.deleteProperty(window, 'api')
    storeHolder.store = null
  })

  it('main window discards the draft and retains the empty backing file', async () => {
    const { result } = renderHook(() =>
      useTerminalEditorCloseDialogActions(mainWindowDialogController(FILE_ID))
    )

    await act(() => result.current.handleSaveDialogDiscard())

    expect(store.getState().openFiles).toHaveLength(0)
    expect(store.getState().editorDrafts[FILE_ID]).toBeUndefined()
    expect(disk.files.get(FILE_ID)).toBe('')
  })

  it('floating panel discards the draft and retains the empty backing file', async () => {
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
    expect(store.getState().editorDrafts[FILE_ID]).toBeUndefined()
    expect(disk.files.get(FILE_ID)).toBe('')
  })
})
