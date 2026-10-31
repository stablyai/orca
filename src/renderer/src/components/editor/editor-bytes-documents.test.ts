import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'

const state = vi.hoisted(() => {
  const openFiles: { id: string; isDirty: boolean; externalMutation?: string }[] = [
    { id: 'book', isDirty: false }
  ]
  const tab = (id: string) => openFiles.find((file) => file.id === id)
  const editorBufferIdOf: Record<string, string> = {}
  const editorBufferViews: Record<string, string[]> = {}
  return {
    openFiles,
    editorBufferIdOf,
    editorBufferViews,
    markFileDirty: vi.fn((id: string, dirty: boolean) => {
      const found = tab(id)
      if (found) {
        found.isDirty = dirty
      }
    }),
    setExternalMutation: vi.fn((id: string, mutation: string | null) => {
      const found = tab(id)
      if (found) {
        found.externalMutation = mutation ?? undefined
      }
    })
  }
})
const storeListener = vi.hoisted(() => {
  const holder: { current: ((next: unknown, prev: unknown) => void) | null } = { current: null }
  return holder
})
vi.mock('@/store', () => ({
  useAppStore: {
    subscribe: (listener: (next: unknown, prev: unknown) => void) => {
      storeListener.current = listener
      return () => {}
    },
    getState: () => state
  }
}))
const writeRuntimeFileBytes = vi.fn()
vi.mock('@/runtime/runtime-file-bytes-write', () => ({
  writeRuntimeFileBytes: (...args: unknown[]) => writeRuntimeFileBytes(...args)
}))

import {
  editorBytesDocument,
  editorBytesEdits,
  loadEditorBytes,
  releaseEditorBytes,
  retainEditorBytes,
  saveEditorBytesDraft,
  setEditorBytesDraft
} from './editor-bytes-documents'
import { bytesDocumentBoxes, rekeyEditorBytesDocuments } from './editor-bytes-document-boxes'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the save reads only openFiles, markFileDirty and setExternalMutation.
const getState = () => state as unknown as AppState
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the save reads only id, filePath and runtimeEnvironmentId.
const file = { id: 'book', filePath: '/repo/book.xlsx' } as OpenFile
const context = { target: { kind: 'local' as const }, worktreeId: 'wt', worktreePath: '/repo' }
const save = () => saveEditorBytesDraft(getState, file, context, 'user', () => false)
const loaded = new Uint8Array([0x50, 0x4b, 1])
const edited = { bytes: new Uint8Array([0x50, 0x4b, 2, 0xff]), fileType: 'xlsx' }
const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const load = (id: string, bytes: Uint8Array<ArrayBuffer>, editsAtRead = editorBytesEdits(id)) =>
  loadEditorBytes(id, { bytes, fileType: 'xlsx' }, hex(bytes), editsAtRead)

beforeEach(async () => {
  writeRuntimeFileBytes.mockReset()
  state.openFiles[0].isDirty = false
  state.openFiles[0].externalMutation = undefined
  load('book', loaded)
})

describe('binary custom editor saves', () => {
  it('saves the edit guarded by the loaded hash, then holds the saved bytes as the baseline', async () => {
    setEditorBytesDraft('book', edited)
    expect(state.markFileDirty).toHaveBeenLastCalledWith('book', true)
    expect(editorBytesDocument('book')).toBe(edited)
    writeRuntimeFileBytes.mockResolvedValue({ ok: true })
    await expect(save()).resolves.toBe('written')
    expect(writeRuntimeFileBytes).toHaveBeenCalledWith(
      context,
      '/repo/book.xlsx',
      edited.bytes,
      undefined,
      { expectedSha256: hex(loaded), allowMissing: true },
      expect.any(Function)
    )
    expect(state.openFiles[0].isDirty).toBe(false)
    // The next edit is guarded by what was just written.
    setEditorBytesDraft('book', { bytes: new Uint8Array([3]), fileType: 'xlsx' })
    await save()
    expect(writeRuntimeFileBytes.mock.calls[1][4]).toEqual({
      expectedSha256: hex(edited.bytes),
      allowMissing: true
    })
  })

  it('keeps the edit unsaved and marks the outside change when the file moved on', async () => {
    setEditorBytesDraft('book', edited)
    writeRuntimeFileBytes.mockResolvedValue({ ok: false, diskConflict: 'changed' })
    await expect(save()).resolves.toBe('blocked-stale')
    expect(state.openFiles[0].isDirty).toBe(true)
    expect(state.openFiles[0].externalMutation).toBe('changed')
    expect(editorBytesDocument('book')).toBe(edited)
  })

  it('writes unguarded only for the banner Overwrite', async () => {
    setEditorBytesDraft('book', edited)
    writeRuntimeFileBytes.mockResolvedValue({ ok: true })
    await saveEditorBytesDraft(getState, file, context, 'overwrite', () => false)
    expect(writeRuntimeFileBytes.mock.calls[0][4]).toEqual({})
  })
})

describe('binary custom editor views', () => {
  it('keeps the bytes while another split pane still shows the file', () => {
    retainEditorBytes('book')
    retainEditorBytes('book')
    releaseEditorBytes('book')
    setEditorBytesDraft('book', edited)
    expect(editorBytesDocument('book')).toBe(edited)
    releaseEditorBytes('book')
  })

  it('keeps an edit guarded by the bytes it started from when a later read lands', async () => {
    setEditorBytesDraft('book', edited)
    const newer = new Uint8Array([9])
    load('book', newer)
    writeRuntimeFileBytes.mockResolvedValue({ ok: true })
    await save()
    expect(writeRuntimeFileBytes.mock.calls[0]?.[4]).toEqual({
      expectedSha256: hex(loaded),
      allowMissing: true
    })
  })
})

describe('binary custom editor reloads', () => {
  it('keeps the same document when a reload reads unchanged bytes', async () => {
    const before = editorBytesDocument('book')
    const reread = new Uint8Array(loaded)
    load('book', reread)
    // A new object would resend the document and turn the frame's in-flight edit into a conflict.
    expect(editorBytesDocument('book')).toBe(before)
  })
})

describe('binary custom editor tabs', () => {
  it('skips the tab sweep on store writes that leave the tabs and bytes alone', () => {
    storeListener.current?.(state, { ...state, openFiles: [...state.openFiles] })
    const find = vi.spyOn(state.openFiles, 'find')
    for (let i = 0; i < 3; i++) {
      storeListener.current?.(state, { ...state })
    }
    expect(find).not.toHaveBeenCalled()
    setEditorBytesDraft('book', edited)
    find.mockClear()
    storeListener.current?.(state, { ...state })
    expect(find).toHaveBeenCalled()
    find.mockRestore()
  })

  it('ignores a read that started before an edit and save it does not include', async () => {
    const editsAtRead = editorBytesEdits('book')
    setEditorBytesDraft('book', edited)
    writeRuntimeFileBytes.mockResolvedValue({ ok: true })
    await save()
    load('book', loaded, editsAtRead)
    expect(editorBytesDocument('book')).toBe(edited)
  })

  it('moves an unsaved edit with its tab when the file is renamed', () => {
    setEditorBytesDraft('book', edited)
    rekeyEditorBytesDocuments([{ oldFileId: 'book', newFileId: 'renamed' }])
    expect(editorBytesDocument('renamed')).toBe(edited)
    expect(editorBytesDocument('book')).toBeNull()
    rekeyEditorBytesDocuments([{ oldFileId: 'renamed', newFileId: 'book' }])
  })

  it('shares one draft between tabs of one file, which share one dirty flag', async () => {
    state.editorBufferIdOf = { book: 'record', twin: 'record' }
    state.editorBufferViews = { record: ['book', 'twin'] }
    state.openFiles.push({ id: 'twin', isDirty: false })
    load('twin', new Uint8Array(loaded))
    setEditorBytesDraft('twin', edited)
    expect(editorBytesDocument('book')).toBe(edited)
    // The saving tab closes mid-write; its twin still ends up clean against the written bytes.
    writeRuntimeFileBytes.mockImplementation(async () => {
      bytesDocumentBoxes.delete('book')
      return { ok: true }
    })
    await save()
    expect(state.markFileDirty).toHaveBeenLastCalledWith('twin', false, { written: true })
    bytesDocumentBoxes.set('book', bytesDocumentBoxes.get('twin')!)

    // The tab holding a draft closes before its twin has shown it: the twin inherits the draft.
    setEditorBytesDraft('book', edited)
    bytesDocumentBoxes.delete('twin')
    const previous = { ...state, openFiles: [...state.openFiles] }
    state.openFiles.splice(0, 1)
    storeListener.current?.(state, previous)
    expect(editorBytesDocument('twin')).toBe(edited)
    state.openFiles.unshift({ id: 'book', isDirty: false })
    bytesDocumentBoxes.set('book', bytesDocumentBoxes.get('twin')!)
    state.openFiles.pop()
    state.editorBufferIdOf = {}
    state.editorBufferViews = {}
  })
})
