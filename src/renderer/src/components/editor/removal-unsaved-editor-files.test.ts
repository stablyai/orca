import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { registerPendingEditorFlush } from './editor-pending-flush'
import {
  collectRemovalUnsavedFiles,
  flushRemovalPendingEdits,
  lastViewUnsavedFiles
} from './removal-unsaved-editor-files'

// Every tab of a path shares one model in this fixture.
vi.mock('./editor-model-owner', () => ({
  resolveEditorModelOwner: () => ({ environmentId: null, hostId: 'local' }),
  getEditorModelOwnerKey: () => ''
}))

function tab(id: string, filePath: string, worktreeId: string, extra: Partial<OpenFile> = {}) {
  const file: OpenFile = {
    id,
    filePath,
    relativePath: id,
    worktreeId,
    language: 'plaintext',
    isDirty: true,
    mode: 'edit',
    ...extra
  }
  return file
}

function state(openFiles: OpenFile[], extra: Record<string, unknown> = {}): AppState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these readers touch only the listed fields; the owner module is mocked.
  return {
    openFiles,
    editorDrafts: {},
    editorBufferIdOf: Object.fromEntries(openFiles.map((file) => [file.id, file.id])),
    editorBufferViews: Object.fromEntries(openFiles.map((file) => [file.id, [file.id]])),
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    markdownViewMode: {},
    editorViewMode: {},
    ...extra
  } as unknown as AppState
}

describe('lastViewUnsavedFiles', () => {
  it('lists closing tabs with unsaved text only', () => {
    const s = state(
      [
        tab('dirty', '/w/a.ts', 'wt'),
        tab('clean', '/w/b.ts', 'wt', { isDirty: false }),
        tab('drafted', '/w/c.ts', 'wt', { isDirty: false }),
        tab('elsewhere', '/o/d.ts', 'other')
      ],
      { editorDrafts: { drafted: 'typed' } }
    )
    expect(
      lastViewUnsavedFiles(s, new Set(['dirty', 'clean', 'drafted'])).map((f) => f.id)
    ).toEqual(['dirty', 'drafted'])
  })

  it('includes editable unstaged diff tabs and skips read-only views', () => {
    const s = state([
      tab('unstaged', '/w/a.ts', 'wt', { mode: 'diff', diffSource: 'unstaged' }),
      tab('staged', '/w/b.ts', 'wt', { mode: 'diff', diffSource: 'staged' }),
      tab('readonly', '/w/c.ts', 'wt', { readOnly: true })
    ])
    expect(
      lastViewUnsavedFiles(s, new Set(['unstaged', 'staged', 'readonly'])).map((f) => f.id)
    ).toEqual(['unstaged'])
  })

  it('skips a file whose record or model still has a view that stays open', () => {
    const shared = state([tab('a', '/w/a.ts', 'wt'), tab('b', '/w/a.ts', 'other')], {
      editorBufferIdOf: { a: 'rec', b: 'rec' },
      editorBufferViews: { rec: ['a', 'b'] }
    })
    expect(lastViewUnsavedFiles(shared, new Set(['a']))).toEqual([])

    const model = state([tab('a', '/w/a.ts', 'wt'), tab('b', '/w/a.ts', 'wt2')])
    expect(lastViewUnsavedFiles(model, new Set(['a']))).toEqual([])
    expect(lastViewUnsavedFiles(model, new Set(['a', 'b']))).toHaveLength(1)
  })
})

describe('collectRemovalUnsavedFiles', () => {
  it('uses the tabs the purge would close, after flushing their delayed views', () => {
    const flushed = vi.fn()
    const kept = vi.fn()
    const unregisterFlushed = registerPendingEditorFlush('a', flushed)
    const unregisterKept = registerPendingEditorFlush('b', kept)
    const s = state([tab('a', '/w/a.md', 'wt'), tab('b', '/o/b.md', 'other')])

    const files = collectRemovalUnsavedFiles(() => s, [{ id: 'wt' }])

    expect(files.map((f) => f.id)).toEqual(['a'])
    expect(flushed).toHaveBeenCalledTimes(1)
    expect(kept).not.toHaveBeenCalled()
    unregisterFlushed()
    unregisterKept()
  })

  it('keeps going when a delayed view fails to flush', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unregister = registerPendingEditorFlush('a', () => {
      throw new Error('boom')
    })
    flushRemovalPendingEdits(state([tab('a', '/w/a.md', 'wt')]), ['a'])
    expect(error).toHaveBeenCalled()
    unregister()
    error.mockRestore()
  })
})
