import { describe, expect, it } from 'vitest'
import type { OpenFile } from '../types/open-file'
import { assertEditorBufferRecordsMatchViews } from '../../../editor-buffer-record-lifecycle'
import {
  adoptMirroredEditorBuffers,
  editorBufferRecordFromFile,
  type EditorBufferRecords
} from './editor-buffer-record'
import type { EditorBufferViewIndex } from './editor-buffer-views'

function tab(id: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: '/repo/a.ts',
    relativePath: 'a.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    mirroredFromRuntimeSession: true,
    ...patch
  }
}

/** Two host-owned views of one record. */
const SHARED: EditorBufferViewIndex = {
  editorBufferIdOf: { a: 'rec', b: 'rec' },
  editorBufferViews: { rec: ['a', 'b'] }
}

describe('mirrored editor buffer dirty state', () => {
  it.each([
    [false, true],
    [true, false]
  ])('keeps the record dirty while any host-owned view is (a=%s, b=%s)', (aDirty, bDirty) => {
    const records: EditorBufferRecords = { rec: editorBufferRecordFromFile(tab('a')) }
    const openFiles = [tab('a', { isDirty: aDirty }), tab('b', { isDirty: bDirty })]

    const adopted = adoptMirroredEditorBuffers(records, openFiles, SHARED)

    expect(adopted.editorBuffers.rec?.isDirty).toBe(true)
    // Every view mirrors the record, so a later dirty write on the clean one is not a no-op.
    expect(adopted.views.map((file) => file.isDirty)).toEqual([true, true])
    expect(() =>
      assertEditorBufferRecordsMatchViews({
        ...SHARED,
        openFiles: adopted.views,
        editorBuffers: adopted.editorBuffers
      })
    ).not.toThrow()
  })

  it('clears the record once every host-owned view reads clean', () => {
    const records: EditorBufferRecords = {
      rec: editorBufferRecordFromFile(tab('a', { isDirty: true }))
    }
    expect(
      adoptMirroredEditorBuffers(records, [tab('a'), tab('b')], SHARED).editorBuffers.rec?.isDirty
    ).toBe(false)
  })

  it('returns the same objects when the host published nothing new', () => {
    const openFiles = [tab('a', { isDirty: true }), tab('b', { isDirty: true })]
    const records: EditorBufferRecords = { rec: editorBufferRecordFromFile(openFiles[0]) }
    const adopted = adoptMirroredEditorBuffers(records, openFiles, SHARED)
    expect(adopted.editorBuffers).toBe(records)
    expect(adopted.views).toBe(openFiles)
  })

  it('no longer tolerates a view reading clean on a dirty record', () => {
    const record = editorBufferRecordFromFile(tab('a', { isDirty: true }))
    expect(() =>
      assertEditorBufferRecordsMatchViews({
        ...SHARED,
        openFiles: [tab('a', { isDirty: true }), tab('b')],
        editorBuffers: { rec: record }
      })
    ).toThrow(/"isDirty" of b/)
  })
})
