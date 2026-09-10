// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'

const toastMock = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: toastMock }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn()
  }
}))
vi.mock('@/runtime/runtime-file-client', () => ({
  readRuntimeFileContent: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: () => null
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: () => undefined
}))

import { useAppStore } from '@/store'
import {
  ORCA_EDITOR_REQUEST_FILE_RELOAD_EVENT,
  type EditorRequestFileReloadDetail
} from './editor-autosave'
import { requestEditorTabDiskReload } from './editor-tab-disk-reload'

function makeFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: 'file-1',
    filePath: '/repo/notes.md',
    relativePath: 'notes.md',
    worktreeId: 'wt-1',
    language: 'markdown',
    mode: 'edit',
    isDirty: false,
    ...overrides
  } as OpenFile
}

describe('requestEditorTabDiskReload', () => {
  const clearEditorDraft = vi.fn()
  const markFileDirty = vi.fn()
  const setExternalMutation = vi.fn()
  const dispatchedFileIds: string[] = []
  const listener = (event: Event): void => {
    dispatchedFileIds.push((event as CustomEvent<EditorRequestFileReloadDetail>).detail.fileId)
  }

  function mockStore(openFiles: OpenFile[], editorDrafts: Record<string, string> = {}): void {
    vi.mocked(useAppStore.getState).mockReturnValue({
      clearEditorDraft,
      markFileDirty,
      setExternalMutation,
      editorDrafts,
      openFiles
    } as never)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    dispatchedFileIds.length = 0
    window.addEventListener(ORCA_EDITOR_REQUEST_FILE_RELOAD_EVENT, listener)
  })

  afterEach(() => {
    window.removeEventListener(ORCA_EDITOR_REQUEST_FILE_RELOAD_EVENT, listener)
  })

  it('dispatches a reload request for a clean tab without touching the draft state', () => {
    mockStore([makeFile()])

    requestEditorTabDiskReload('file-1')

    expect(dispatchedFileIds).toEqual(['file-1'])
    expect(clearEditorDraft).not.toHaveBeenCalled()
    expect(markFileDirty).not.toHaveBeenCalled()
  })

  it('discards a dirty tab draft (with the undo toast) before dispatching', () => {
    const order: string[] = []
    clearEditorDraft.mockImplementation(() => order.push('clearEditorDraft'))
    mockStore([makeFile({ id: 'dirty-file', isDirty: true })], { 'dirty-file': 'unsaved text' })
    const trackDispatch = (): void => {
      order.push('dispatch')
    }
    window.addEventListener(ORCA_EDITOR_REQUEST_FILE_RELOAD_EVENT, trackDispatch)

    requestEditorTabDiskReload('dirty-file')
    window.removeEventListener(ORCA_EDITOR_REQUEST_FILE_RELOAD_EVENT, trackDispatch)

    expect(dispatchedFileIds).toEqual(['dirty-file'])
    expect(clearEditorDraft).toHaveBeenCalledWith('dirty-file')
    expect(markFileDirty).toHaveBeenCalledWith('dirty-file', false)
    expect(setExternalMutation).toHaveBeenCalledWith('dirty-file', null)
    expect(toastMock).toHaveBeenCalledTimes(1)
    // Why: the draft shadows loaded content, so the discard must land before
    // the owning panel refetches or the stale unsaved text stays visible.
    expect(order).toEqual(['clearEditorDraft', 'dispatch'])
  })

  it('ignores tabs that have no single reloadable disk source', () => {
    mockStore([makeFile({ mode: 'diff', diffSource: 'combined-uncommitted' })])

    requestEditorTabDiskReload('file-1')

    expect(dispatchedFileIds).toEqual([])
    expect(clearEditorDraft).not.toHaveBeenCalled()
  })

  it('ignores unknown file ids', () => {
    mockStore([makeFile()])

    requestEditorTabDiskReload('missing')

    expect(dispatchedFileIds).toEqual([])
  })
})
