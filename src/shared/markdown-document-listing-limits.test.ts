import { describe, expect, it } from 'vitest'
import type { MarkdownDocument } from './filesystem-entry-types'
import {
  assertMarkdownDocumentsWithinLimit,
  createMarkdownDocumentListingBudget,
  MARKDOWN_DOCUMENT_LISTING_ERROR_CODE,
  MarkdownDocumentListingCapacityError,
  retainMarkdownDocument,
  visitMarkdownDocumentListingEntry
} from './markdown-document-listing-limits'

function document(path: string): MarkdownDocument {
  return {
    filePath: `/repo/${path}`,
    relativePath: path,
    basename: path,
    name: path
  }
}

describe('Markdown document listing limits', () => {
  it('rejects the first document beyond the count limit with a typed error', () => {
    const budget = createMarkdownDocumentListingBudget({ maxDocuments: 2 })
    retainMarkdownDocument(budget, document('one.md'))
    retainMarkdownDocument(budget, document('two.md'))

    expect(() => retainMarkdownDocument(budget, document('three.md'))).toThrow(
      MarkdownDocumentListingCapacityError
    )
    expect(() => retainMarkdownDocument(budget, document('three.md'))).toThrow(
      expect.objectContaining({ code: MARKDOWN_DOCUMENT_LISTING_ERROR_CODE })
    )
  })

  it('rejects aggregate metadata, visited-entry, path, and depth overflow', () => {
    expect(() =>
      assertMarkdownDocumentsWithinLimit([document('a'.repeat(100))], {
        maxMetadataBytes: 100
      })
    ).toThrow(MarkdownDocumentListingCapacityError)

    const visited = createMarkdownDocumentListingBudget({
      maxVisitedEntries: 1,
      maxPathBytes: 4,
      maxDepth: 1
    })
    visitMarkdownDocumentListingEntry(visited, 'a', 1)
    expect(() => visitMarkdownDocumentListingEntry(visited, 'b', 1)).toThrow(
      MarkdownDocumentListingCapacityError
    )

    const path = createMarkdownDocumentListingBudget({ maxPathBytes: 4 })
    expect(() => visitMarkdownDocumentListingEntry(path, 'ééé', 1)).toThrow(
      MarkdownDocumentListingCapacityError
    )

    const depth = createMarkdownDocumentListingBudget({ maxDepth: 1 })
    expect(() => visitMarkdownDocumentListingEntry(depth, 'a/b', 2)).toThrow(
      MarkdownDocumentListingCapacityError
    )
  })
})
