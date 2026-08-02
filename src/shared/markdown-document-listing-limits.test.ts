import { describe, expect, it } from 'vitest'
import type { MarkdownDocument } from './types'
import {
  assertMarkdownDocumentsWithinLimit,
  createMarkdownDocumentListingBudget,
  isMarkdownDocumentListingCapacityError,
  MARKDOWN_DOCUMENT_LISTING_ERROR_CODE,
  MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE,
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
  it('preserves an under-limit listing and reports its retained estimate', () => {
    const documents = [document('README.md'), document('docs/guide.mdx')]

    expect(assertMarkdownDocumentsWithinLimit(documents)).toBeGreaterThan(0)
  })

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

  it('recognizes structured runtime and Electron-wrapped capacity failures', () => {
    const structured = Object.assign(new Error('remote listing rejected'), {
      code: MARKDOWN_DOCUMENT_LISTING_ERROR_CODE
    })
    const electronWrapped = new Error(
      `Error invoking remote method 'fs:listMarkdownDocuments': Error: ${MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE}`
    )

    expect(isMarkdownDocumentListingCapacityError(structured)).toBe(true)
    expect(isMarkdownDocumentListingCapacityError(electronWrapped)).toBe(true)
    expect(isMarkdownDocumentListingCapacityError(new Error('unrelated failure'))).toBe(false)
  })
})
