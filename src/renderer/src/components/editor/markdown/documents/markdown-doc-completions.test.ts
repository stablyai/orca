import { describe, expect, it } from 'vitest'
import type { MarkdownDocument } from '../../../../../../shared/file-listing/file-document'
import { getMarkdownDocCompletionDocuments } from './markdown-doc-completions'

describe('getMarkdownDocCompletionDocuments', () => {
  it('offers a note stored decomposed for a composed prefix and keeps its stored matches', () => {
    const note: MarkdownDocument = {
      filePath: '/repo/notes/노트.md'.normalize('NFD'),
      relativePath: 'notes/노트.md'.normalize('NFD'),
      basename: '노트.md'.normalize('NFD'),
      name: '노트'.normalize('NFD')
    }
    const cafe: MarkdownDocument = {
      filePath: '/repo/café.md'.normalize('NFD'),
      relativePath: 'café.md'.normalize('NFD'),
      basename: 'café.md'.normalize('NFD'),
      name: 'café'.normalize('NFD')
    }

    expect(getMarkdownDocCompletionDocuments([note, cafe], '노'.normalize('NFC'))).toEqual([note])
    // The stored spelling still matches its base letters, as before.
    expect(getMarkdownDocCompletionDocuments([note, cafe], 'cafe')).toEqual([cafe])
    expect(getMarkdownDocCompletionDocuments([note, cafe], '')).toEqual([cafe, note])
  })
})
