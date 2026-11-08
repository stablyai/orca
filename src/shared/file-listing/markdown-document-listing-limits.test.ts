import { describe, expect, it } from 'vitest'
import type { MarkdownDocument } from './file-document'
import {
  assertMarkdownDocumentsWithinLimit,
  MarkdownDocumentListingCapacityError
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
  it('rejects aggregate metadata overflow', () => {
    expect(() =>
      assertMarkdownDocumentsWithinLimit([document('a'.repeat(100))], {
        maxMetadataBytes: 100
      })
    ).toThrow(MarkdownDocumentListingCapacityError)
  })
})
