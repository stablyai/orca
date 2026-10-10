import { describe, expect, it } from 'vitest'
import type { MarkdownDocument } from './filesystem-entry-types'
import {
  assertMarkdownDocumentsWithinLimit,
  createMarkdownDocumentListingBudget,
  MARKDOWN_DOCUMENT_LISTING_ERROR_CODE,
  MarkdownDocumentListingCapacityError,
  retainMarkdownDocument
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

  it('rejects aggregate metadata overflow', () => {
    expect(() =>
      assertMarkdownDocumentsWithinLimit([document('a'.repeat(100))], {
        maxMetadataBytes: 100
      })
    ).toThrow(MarkdownDocumentListingCapacityError)
  })

  it('bounds UTF-8 bytes in both live document paths before retaining metadata', () => {
    const budget = createMarkdownDocumentListingBudget({ maxPathBytes: 4 })
    expect(() => retainMarkdownDocument(budget, { ...document('a'), filePath: 'ééé' })).toThrow(
      MarkdownDocumentListingCapacityError
    )
    expect(() => retainMarkdownDocument(budget, { ...document('ééé'), filePath: 'a' })).toThrow(
      MarkdownDocumentListingCapacityError
    )
    expect(budget.documents).toBe(0)
    expect(budget.metadataBytes).toBe(0)
    retainMarkdownDocument(budget, { ...document('éé'), filePath: 'éé' })
    expect(budget.documents).toBe(1)
  })
})
