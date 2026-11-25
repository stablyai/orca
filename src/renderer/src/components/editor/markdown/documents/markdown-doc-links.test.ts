import { describe, expect, it } from 'vitest'
import type { MarkdownDocument } from '../../../../../../shared/file-listing/file-document'
import { getMarkdownDocumentIndex, resolveMarkdownDocLink } from './markdown-doc-links'

function markdownDocument(relativePath: string): MarkdownDocument {
  const basename = relativePath.slice(relativePath.lastIndexOf('/') + 1)
  return {
    filePath: `/repo/${relativePath}`,
    relativePath,
    basename,
    name: basename.slice(0, -'.md'.length)
  }
}

describe('resolveMarkdownDocLink', () => {
  it('matches a note across composed and decomposed spellings without merging two files', () => {
    const storedDecomposed = markdownDocument('notes/노트.md'.normalize('NFD'))
    const storedComposed = markdownDocument('메모.md'.normalize('NFC'))
    // Two files on Linux or Windows, where both spellings can exist side by side.
    const cafeComposed = markdownDocument('café.md'.normalize('NFC'))
    const cafeDecomposed = markdownDocument('café.md'.normalize('NFD'))
    const index = getMarkdownDocumentIndex([
      storedDecomposed,
      storedComposed,
      cafeComposed,
      cafeDecomposed
    ])

    expect(resolveMarkdownDocLink('노트'.normalize('NFC'), index)).toEqual({
      status: 'resolved',
      document: storedDecomposed
    })
    expect(resolveMarkdownDocLink('메모'.normalize('NFD'), index)).toEqual({
      status: 'resolved',
      document: storedComposed
    })
    expect(resolveMarkdownDocLink('café'.normalize('NFC'), index)).toEqual({
      status: 'resolved',
      document: cafeComposed
    })
  })
})
