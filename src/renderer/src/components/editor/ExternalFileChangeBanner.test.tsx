import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'

const toastMock = vi.hoisted(() => vi.fn())
const readRuntimeFileContentMock = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({
  toast: toastMock
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn()
  }
}))
vi.mock('@/runtime/runtime-file-client', () => ({
  readRuntimeFileContent: readRuntimeFileContentMock
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: () => null
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: () => undefined
}))

import {
  ExternalFileChangeBanner,
  keepTabEditsOverExternalChange,
  reloadTabContentFromDisk
} from './ExternalFileChangeBanner'
import { getDiskBaselineSignature } from './diff-content-signature'
import { useAppStore } from '@/store'

const file = {
  id: 'file-1',
  filePath: '/repo/notes.md',
  relativePath: 'notes.md',
  worktreeId: 'wt-1',
  mode: 'edit',
  isDirty: true,
  externalMutation: 'changed'
} as OpenFile

describe('ExternalFileChangeBanner', () => {
  const clearEditorDraft = vi.fn()
  const markFileDirty = vi.fn()
  const setExternalMutation = vi.fn()
  const setEditorDraft = vi.fn()
  const setLastKnownDiskSignature = vi.fn()

  function mockStoreState(editorDrafts: Record<string, string>, openFiles: OpenFile[] = [file]) {
    vi.mocked(useAppStore.getState).mockReturnValue({
      clearEditorDraft,
      markFileDirty,
      setExternalMutation,
      setEditorDraft,
      setLastKnownDiskSignature,
      editorDrafts,
      openFiles,
      settings: {}
    } as never)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    readRuntimeFileContentMock.mockResolvedValue({ content: 'disk content', isBinary: false })
    mockStoreState({})
  })

  it('renders the overwrite warning, all three actions, and an alert role', () => {
    const html = renderToStaticMarkup(
      <ExternalFileChangeBanner file={file} currentContent="buffer" reloadContent={vi.fn()} />
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('changed on disk')
    expect(html).toContain('Saving will overwrite')
    expect(html).toContain('Compare')
    expect(html).toContain('Reload from Disk')
    expect(html).toContain('Keep My Edits')
  })

  it('reload clears the draft, dirty flag, and mark before refetching content', () => {
    mockStoreState({ 'file-1': 'unsaved text' })
    const calls: string[] = []
    clearEditorDraft.mockImplementation(() => calls.push('clearEditorDraft'))
    markFileDirty.mockImplementation(() => calls.push('markFileDirty'))
    setExternalMutation.mockImplementation(() => calls.push('setExternalMutation'))
    const reloadContent = vi.fn(() => calls.push('reloadContent'))

    reloadTabContentFromDisk(file, reloadContent)

    expect(clearEditorDraft).toHaveBeenCalledWith('file-1')
    expect(markFileDirty).toHaveBeenCalledWith('file-1', false)
    expect(setExternalMutation).toHaveBeenCalledWith('file-1', null)
    expect(reloadContent).toHaveBeenCalledWith(file)
    // Why: the draft shadows loaded content (editBuffers ?? fileContents), so
    // the refetch must come last or the stale unsaved text stays visible.
    expect(calls).toEqual([
      'clearEditorDraft',
      'markFileDirty',
      'setExternalMutation',
      'reloadContent'
    ])
  })

  it('reload offers an undo toast that restores the discarded draft and the conflict', () => {
    mockStoreState({ 'file-1': 'discarded draft' })

    reloadTabContentFromDisk(file, vi.fn())

    expect(toastMock).toHaveBeenCalledTimes(1)
    const options = toastMock.mock.calls[0][1] as {
      action: { label: string; onClick: () => void }
    }
    vi.clearAllMocks()
    // Why: after a real reload the tab is clean with no draft — the undo
    // guard only restores over that untouched state.
    mockStoreState({}, [{ ...file, isDirty: false, externalMutation: undefined } as OpenFile])

    options.action.onClick()

    expect(setEditorDraft).toHaveBeenCalledWith('file-1', 'discarded draft')
    expect(markFileDirty).toHaveBeenCalledWith('file-1', true)
    // Why: disk still differs from the restored draft — the conflict (and its
    // autosave suspension) must return with the edits.
    expect(setExternalMutation).toHaveBeenCalledWith('file-1', 'changed')
  })

  it('undo is a no-op when the tab closed while the toast was up', () => {
    mockStoreState({ 'file-1': 'discarded draft' })

    reloadTabContentFromDisk(file, vi.fn())

    const options = toastMock.mock.calls[0][1] as {
      action: { label: string; onClick: () => void }
    }
    vi.clearAllMocks()
    mockStoreState({}, [])

    options.action.onClick()

    expect(setEditorDraft).not.toHaveBeenCalled()
    expect(markFileDirty).not.toHaveBeenCalled()
    expect(setExternalMutation).not.toHaveBeenCalled()
  })

  it('undo is a no-op when the user typed or saved after the reload', () => {
    mockStoreState({ 'file-1': 'discarded draft' })

    reloadTabContentFromDisk(file, vi.fn())

    const options = toastMock.mock.calls[0][1] as {
      action: { label: string; onClick: () => void }
    }
    vi.clearAllMocks()
    // Why: post-reload edits are newer intent than the discarded draft —
    // undoing over them would be a second silent discard.
    mockStoreState({ 'file-1': 'newer post-reload edits' }, [
      { ...file, isDirty: true, externalMutation: undefined } as OpenFile
    ])

    options.action.onClick()

    expect(setEditorDraft).not.toHaveBeenCalled()
    expect(setExternalMutation).not.toHaveBeenCalled()
  })

  it('does not toast when there was no draft to restore', () => {
    mockStoreState({})

    reloadTabContentFromDisk(file, vi.fn())

    expect(toastMock).not.toHaveBeenCalled()
  })

  it('undo restores the pre-reload disk signature with the draft', async () => {
    // Why: the reload re-stamps the baseline to the new disk content; without
    // restoring the old signature the restart scan sees disk == baseline and
    // silently drops the conflict the undo just brought back.
    mockStoreState({ 'file-1': 'discarded draft' }, [
      { ...file, lastKnownDiskSignature: 'pre-reload-signature' } as OpenFile
    ])

    reloadTabContentFromDisk(file, vi.fn())

    const options = toastMock.mock.calls[0][1] as {
      action: { label: string; onClick: () => void }
    }
    vi.clearAllMocks()
    mockStoreState({}, [{ ...file, isDirty: false, externalMutation: undefined } as OpenFile])

    options.action.onClick()

    expect(setLastKnownDiskSignature).toHaveBeenCalledWith('file-1', 'pre-reload-signature')
  })

  it('keep-my-edits clears the mark without touching the draft or dirty flag', () => {
    keepTabEditsOverExternalChange(file)

    expect(setExternalMutation).toHaveBeenCalledWith('file-1', null)
    expect(clearEditorDraft).not.toHaveBeenCalled()
    expect(markFileDirty).not.toHaveBeenCalled()
  })

  it('keep-my-edits advances the disk baseline so the dismissal survives restart', async () => {
    readRuntimeFileContentMock.mockResolvedValue({ content: 'agent content', isBinary: false })
    mockStoreState({}, [{ ...file, externalMutation: undefined } as OpenFile])

    keepTabEditsOverExternalChange(file)
    await Promise.resolve()
    await Promise.resolve()

    expect(setLastKnownDiskSignature).toHaveBeenCalledWith(
      'file-1',
      getDiskBaselineSignature('agent content')
    )
  })

  it('keep-my-edits does not stamp a baseline over a newer conflict', async () => {
    // Why: if the file changed again before the read resolved, the fresh
    // 'changed' mark owns the baseline — stamping would hide that conflict
    // from the restart scan.
    readRuntimeFileContentMock.mockResolvedValue({ content: 'even newer', isBinary: false })
    mockStoreState({}, [{ ...file, externalMutation: 'changed' } as OpenFile])

    keepTabEditsOverExternalChange(file)
    await Promise.resolve()
    await Promise.resolve()

    expect(setLastKnownDiskSignature).not.toHaveBeenCalled()
  })
})
