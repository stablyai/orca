import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { editorSavedEventView } from './editor-saved-event-view'

function tab(id: string): OpenFile {
  return {
    id,
    filePath: '/repo/a.md',
    relativePath: 'a.md',
    worktreeId: 'wt-1',
    language: 'markdown',
    isDirty: false,
    mode: 'edit'
  }
}

describe('editorSavedEventView', () => {
  it("falls back to the record's other views when the saving view closed mid-write", () => {
    const files = [tab('unrelated'), tab('other')]
    expect(
      editorSavedEventView(files, { fileId: 'closed', recordViewIds: ['closed', 'other'] })?.id
    ).toBe('other')
    expect(editorSavedEventView(files, { fileId: 'closed' })).toBeUndefined()
  })
})
