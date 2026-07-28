import { describe, expect, it } from 'vitest'
import type { MarkdownDocument } from './types'
import {
  assertMarkdownDocumentsWithinLimit,
  createMarkdownDocumentListingBudget,
  isMarkdownDocumentListingCapacityError,
  MARKDOWN_DOCUMENT_LISTING_ERROR_CODE,
  MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE,
  MARKDOWN_DOCUMENT_LISTING_MAX_DEPTH,
  MARKDOWN_DOCUMENT_LISTING_MAX_DOCUMENTS,
  MARKDOWN_DOCUMENT_LISTING_MAX_METADATA_BYTES,
  MARKDOWN_DOCUMENT_LISTING_MAX_PATH_BYTES,
  MARKDOWN_DOCUMENT_LISTING_MAX_VISITED_ENTRIES,
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

  it('applies the default visited-entry ceiling of 100,000 when none is requested', () => {
    // Why: the cases above pass explicit small limits, which only exercise clamping. Seeding
    // relative to the constant would also pass at any constant value, so use the literal ceiling —
    // raising the module constant has to fail here.
    const belowCeiling = createMarkdownDocumentListingBudget()
    belowCeiling.visitedEntries = 99_998
    visitMarkdownDocumentListingEntry(belowCeiling, 'last.md', 1)
    expect(belowCeiling.visitedEntries).toBe(99_999)

    const atCeiling = createMarkdownDocumentListingBudget()
    atCeiling.visitedEntries = 100_000
    expect(() => visitMarkdownDocumentListingEntry(atCeiling, 'overflow.md', 1)).toThrow(
      MarkdownDocumentListingCapacityError
    )
  })

  it('applies the default metadata ceiling of 8 MiB when none is requested', () => {
    const belowCeiling = createMarkdownDocumentListingBudget()
    belowCeiling.metadataBytes = 8 * 1024 * 1024 - 4_096
    retainMarkdownDocument(belowCeiling, document('fits.md'))

    const atCeiling = createMarkdownDocumentListingBudget()
    atCeiling.metadataBytes = 8 * 1024 * 1024
    expect(() => retainMarkdownDocument(atCeiling, document('overflow.md'))).toThrow(
      MarkdownDocumentListingCapacityError
    )
  })

  it('applies the default depth ceiling of 256 when none is requested', () => {
    const budget = createMarkdownDocumentListingBudget()
    const path = `${'nested/'.repeat(256)}deep.md`

    visitMarkdownDocumentListingEntry(budget, path, 256)
    expect(() => visitMarkdownDocumentListingEntry(budget, path, 257)).toThrow(
      MarkdownDocumentListingCapacityError
    )
  })

  it('clamps a caller request above the module ceiling rather than honoring it', () => {
    // Why: limits arrive from the renderer and the relay. A caller asking for a larger budget than
    // the module allows must be clamped down, or the ceiling is advisory rather than enforced.
    const budget = createMarkdownDocumentListingBudget({
      maxDocuments: Number.MAX_SAFE_INTEGER,
      maxMetadataBytes: Number.MAX_SAFE_INTEGER,
      maxPathBytes: Number.MAX_SAFE_INTEGER,
      maxVisitedEntries: Number.MAX_SAFE_INTEGER,
      maxDepth: Number.MAX_SAFE_INTEGER
    })

    expect(budget.limits).toEqual({
      maxDocuments: MARKDOWN_DOCUMENT_LISTING_MAX_DOCUMENTS,
      maxMetadataBytes: MARKDOWN_DOCUMENT_LISTING_MAX_METADATA_BYTES,
      maxPathBytes: MARKDOWN_DOCUMENT_LISTING_MAX_PATH_BYTES,
      maxVisitedEntries: MARKDOWN_DOCUMENT_LISTING_MAX_VISITED_ENTRIES,
      maxDepth: MARKDOWN_DOCUMENT_LISTING_MAX_DEPTH
    })
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
