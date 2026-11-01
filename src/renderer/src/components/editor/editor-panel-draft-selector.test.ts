import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { createEditorPanelDraftSelector } from './editor-panel-draft-selector'

function makeFile(id: string, overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: `/repo/${id}.ts`,
    relativePath: `${id}.ts`,
    worktreeId: 'worktree-1',
    language: 'typescript',
    mode: 'edit',
    isDirty: false,
    ...overrides
  }
}

describe('createEditorPanelDraftSelector', () => {
  it('includes overview conflict drafts and ignores unrelated draft replacements', () => {
    const conflictReview = makeFile('review', {
      filePath: 'C:\\repo',
      mode: 'conflict-review',
      conflictReview: {
        source: 'live-summary',
        snapshotTimestamp: 1,
        entries: [
          { path: 'src/a.ts', conflictKind: 'both_modified' },
          { path: 'src\\b.ts', conflictKind: 'both_modified' }
        ]
      }
    })
    const selectDrafts = createEditorPanelDraftSelector(conflictReview)
    const editorDrafts = {
      'C:\\repo\\src\\a.ts': 'draft a',
      'C:\\repo\\src\\b.ts': '',
      unrelated: 'other draft'
    }

    const selection = selectDrafts({ editorDrafts, openFiles: [] })
    expect(selection).toEqual({
      'C:\\repo\\src\\a.ts': 'draft a',
      'C:\\repo\\src\\b.ts': ''
    })

    expect(
      selectDrafts({
        editorDrafts: { ...editorDrafts, unrelated: 'changed elsewhere' },
        openFiles: []
      })
    ).toBe(selection)
  })

  it("shows an overview file open in a server tab under that tab's id, with its unsaved edits", () => {
    const conflictReview = makeFile('review', {
      filePath: '/repo',
      mode: 'conflict-review',
      conflictReview: {
        source: 'live-summary',
        snapshotTimestamp: 1,
        entries: [{ path: 'src/a.ts', conflictKind: 'both_modified' }]
      }
    })
    const serverFile = makeFile('editor:worktree-1:env-1:%2Frepo%2Fsrc%2Fa.ts', {
      filePath: '/repo/src/a.ts',
      relativePath: 'src/a.ts',
      runtimeEnvironmentId: 'env-1'
    })
    const selectDrafts = createEditorPanelDraftSelector(conflictReview)

    expect(
      selectDrafts({ editorDrafts: { [serverFile.id]: 'unsaved' }, openFiles: [serverFile] })
    ).toEqual({ [serverFile.id]: 'unsaved' })
  })

  it('follows an overview file to a tab that opens without a draft write', () => {
    const conflictReview = makeFile('review', {
      filePath: '/repo',
      mode: 'conflict-review',
      conflictReview: {
        source: 'live-summary',
        snapshotTimestamp: 1,
        entries: [{ path: 'src/a.ts', conflictKind: 'both_modified' }]
      }
    })
    const tab = makeFile('tab-a', { filePath: '/repo/src/a.ts', relativePath: 'src/a.ts' })
    const editorDrafts = { [tab.id]: 'unsaved' }
    const selectDrafts = createEditorPanelDraftSelector(conflictReview)

    expect(selectDrafts({ editorDrafts, openFiles: [] })).toEqual({})
    expect(selectDrafts({ editorDrafts, openFiles: [tab] })).toEqual({ [tab.id]: 'unsaved' })
    expect(selectDrafts({ editorDrafts, openFiles: [] })).toEqual({})
  })
})
