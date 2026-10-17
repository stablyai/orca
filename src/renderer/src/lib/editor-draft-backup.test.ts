import { describe, expect, it } from 'vitest'
import type { OpenFile } from '../store/slices/editor'
import { canBackUpEditorDraft, getDirtyFilesWithoutBackup } from './editor-draft-backup'
import { buildEditorSessionData } from './workspace-session'

const LIMIT = 10_000 * 1024

function file(id: string, overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: `/repo/${id}`,
    relativePath: id,
    worktreeId: 'wt-1',
    language: 'notebook',
    mode: 'edit',
    isDirty: true,
    lastKnownDiskSignature: 'sig',
    ...overrides
  }
}

describe('editor draft backup limit', () => {
  it('backs up notebooks up to the limit and any other file at any size', () => {
    expect(canBackUpEditorDraft(file('nb.ipynb'), 'x'.repeat(LIMIT))).toBe(true)
    expect(canBackUpEditorDraft(file('nb.ipynb'), 'x'.repeat(LIMIT + 1))).toBe(false)
    expect(canBackUpEditorDraft(file('data.json'), 'x'.repeat(LIMIT + 1))).toBe(true)
  })

  it('leaves a too-large notebook draft and its disk baseline out of the restart session', () => {
    const small = file('small.ipynb')
    const large = file('large.ipynb')
    const { openFilesByWorktree } = buildEditorSessionData(
      [small, large],
      { [small.id]: '{}', [large.id]: 'x'.repeat(LIMIT + 1) },
      {},
      {},
      {}
    )
    const [savedSmall, savedLarge] = openFilesByWorktree?.['wt-1'] ?? []
    expect(savedSmall).toMatchObject({ dirtyDraftContent: '{}', lastKnownDiskSignature: 'sig' })
    expect(savedLarge?.filePath).toBe(large.filePath)
    expect(savedLarge).not.toHaveProperty('dirtyDraftContent')
    expect(savedLarge).not.toHaveProperty('lastKnownDiskSignature')
  })

  it('lists only dirty files whose drafts are not backed up', () => {
    const large = file('large.ipynb')
    const clean = file('clean.ipynb', { isDirty: false })
    const small = file('small.ipynb')
    const draft = 'x'.repeat(LIMIT + 1)
    expect(
      getDirtyFilesWithoutBackup({
        openFiles: [large, clean, small],
        editorDrafts: { [large.id]: draft, [clean.id]: draft, [small.id]: '{}' }
      }).map((entry) => entry.id)
    ).toEqual([large.id])
  })
})
