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
  it('limits draft invalidations to the panel that owns each keystroke', () => {
    const files = Array.from({ length: 200 }, (_, index) => makeFile(`file-${index}`))
    let editorDrafts: Record<string, string> = {}
    let wholeMapInvalidations = 0
    let scopedInvalidations = 0
    let unrelatedPanelInvalidations = 0
    const selectors = files.map(createEditorPanelDraftSelector)
    const previousSelections = selectors.map((selector) => selector({ editorDrafts }))

    for (let edit = 0; edit < 200; edit += 1) {
      const previousDrafts = editorDrafts
      editorDrafts = { ...editorDrafts, 'file-0': `edit-${edit}` }
      for (let panelIndex = 0; panelIndex < files.length; panelIndex += 1) {
        if (previousDrafts !== editorDrafts) {
          wholeMapInvalidations += 1
        }
        const nextSelection = selectors[panelIndex]({ editorDrafts })
        if (previousSelections[panelIndex] !== nextSelection) {
          scopedInvalidations += 1
          if (panelIndex !== 0) {
            unrelatedPanelInvalidations += 1
          }
          previousSelections[panelIndex] = nextSelection
        }
      }
    }

    expect(wholeMapInvalidations).toBe(40_000)
    expect(scopedInvalidations).toBe(200)
    expect(unrelatedPanelInvalidations).toBe(0)
  })

  it('includes preview and selected conflict-review drafts but excludes unrelated files', () => {
    const preview = makeFile('preview', { markdownPreviewSourceFileId: 'source' })
    const conflictReview = makeFile('review', {
      mode: 'conflict-review',
      conflictReview: { selectedFileId: 'selected' } as NonNullable<OpenFile['conflictReview']>
    })
    const editorDrafts = {
      preview: 'preview draft',
      source: '',
      review: 'review draft',
      selected: 'selected draft',
      unrelated: 'other draft'
    }
    const selectPreviewDrafts = createEditorPanelDraftSelector(preview)
    const selectConflictDrafts = createEditorPanelDraftSelector(conflictReview)
    const selectNoDrafts = createEditorPanelDraftSelector(null)

    expect(selectPreviewDrafts({ editorDrafts })).toEqual({
      preview: 'preview draft',
      source: ''
    })
    expect(selectConflictDrafts({ editorDrafts })).toEqual({
      review: 'review draft',
      selected: 'selected draft'
    })
    expect(selectNoDrafts({ editorDrafts })).toEqual({})
  })

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

    const selection = selectDrafts({ editorDrafts })
    expect(selection).toEqual({
      'C:\\repo\\src\\a.ts': 'draft a',
      'C:\\repo\\src\\b.ts': ''
    })

    expect(
      selectDrafts({ editorDrafts: { ...editorDrafts, unrelated: 'changed elsewhere' } })
    ).toBe(selection)
  })
})
