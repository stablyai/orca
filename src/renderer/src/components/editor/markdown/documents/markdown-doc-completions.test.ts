import { describe, expect, it } from 'vitest'
import type { MarkdownDocument } from '../../../../../../shared/file-listing/file-document'
import {
  getMarkdownDocCompletionDocuments,
  getMarkdownDocCompletionMatches
} from './markdown-doc-completions'

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
    const composedCafe: MarkdownDocument = {
      filePath: '/repo/composed/café.md'.normalize('NFC'),
      relativePath: 'composed/café.md'.normalize('NFC'),
      basename: 'café.md'.normalize('NFC'),
      name: 'café'.normalize('NFC')
    }
    const docs = [note, cafe, composedCafe]

    expect(getMarkdownDocCompletionDocuments(docs, '노'.normalize('NFC'))).toEqual([note])
    // The stored spelling still matches its base letters, as before.
    expect(getMarkdownDocCompletionDocuments(docs, 'cafe')).toEqual([cafe])
    // A decomposed query still matches a composed document.
    expect(getMarkdownDocCompletionDocuments(docs, 'café'.normalize('NFD'))).toEqual([
      cafe,
      composedCafe
    ])
    expect(getMarkdownDocCompletionDocuments(docs, '')).toEqual([cafe, composedCafe, note])

    expect(getMarkdownDocCompletionMatches(docs, '')).toEqual([
      expect.objectContaining({
        document: cafe,
        filterText: `${cafe.name} ${'café'.normalize('NFC')}`
      }),
      expect.objectContaining({
        document: composedCafe,
        filterText: composedCafe.name
      }),
      expect.objectContaining({
        document: note,
        filterText: `${note.name} ${'노트'.normalize('NFC')}`
      })
    ])
  })
})
