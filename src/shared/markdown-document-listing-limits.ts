import type { MarkdownDocument } from './filesystem-entry-types'
import { measureUtf8ByteLength } from './utf8-byte-limits'

export const MARKDOWN_DOCUMENT_LISTING_MAX_DOCUMENTS = 20_000
export const MARKDOWN_DOCUMENT_LISTING_MAX_METADATA_BYTES = 8 * 1024 * 1024
export const MARKDOWN_DOCUMENT_LISTING_MAX_PATH_BYTES = 64 * 1024
export const MARKDOWN_DOCUMENT_LISTING_ERROR_CODE = 'markdown_document_listing_capacity'
const MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE =
  'Workspace is too large for Markdown link completion.'

const MARKDOWN_DOCUMENT_RETAINED_OVERHEAD_BYTES = 256

export type MarkdownDocumentListingLimits = {
  maxDocuments: number
  maxMetadataBytes: number
  maxPathBytes: number
}

export type MarkdownDocumentListingBudget = {
  documents: number
  metadataBytes: number
  limits: MarkdownDocumentListingLimits
}

export class MarkdownDocumentListingCapacityError extends Error {
  readonly code = MARKDOWN_DOCUMENT_LISTING_ERROR_CODE

  constructor() {
    super(MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE)
    this.name = 'MarkdownDocumentListingCapacityError'
  }
}

export function createMarkdownDocumentListingBudget(
  requested: Partial<MarkdownDocumentListingLimits> = {}
): MarkdownDocumentListingBudget {
  return {
    documents: 0,
    metadataBytes: 0,
    limits: {
      maxDocuments: clampLimit(requested.maxDocuments, MARKDOWN_DOCUMENT_LISTING_MAX_DOCUMENTS),
      maxMetadataBytes: clampLimit(
        requested.maxMetadataBytes,
        MARKDOWN_DOCUMENT_LISTING_MAX_METADATA_BYTES
      ),
      maxPathBytes: clampLimit(requested.maxPathBytes, MARKDOWN_DOCUMENT_LISTING_MAX_PATH_BYTES)
    }
  }
}

export function assertMarkdownDocumentPathWithinLimit(
  path: string,
  maxPathBytes = MARKDOWN_DOCUMENT_LISTING_MAX_PATH_BYTES
): void {
  if (measureUtf8ByteLength(path, { stopAfterBytes: maxPathBytes }).exceededLimit) {
    throw new MarkdownDocumentListingCapacityError()
  }
}

export function estimateMarkdownDocumentRetainedBytes(document: MarkdownDocument): number {
  return (
    (document.filePath.length +
      document.relativePath.length +
      document.basename.length +
      document.name.length) *
      2 +
    MARKDOWN_DOCUMENT_RETAINED_OVERHEAD_BYTES
  )
}

export function retainMarkdownDocument(
  budget: MarkdownDocumentListingBudget,
  document: MarkdownDocument
): void {
  if (
    !document ||
    typeof document.filePath !== 'string' ||
    typeof document.relativePath !== 'string' ||
    typeof document.basename !== 'string' ||
    typeof document.name !== 'string'
  ) {
    throw new MarkdownDocumentListingCapacityError()
  }
  assertMarkdownDocumentPathWithinLimit(document.filePath, budget.limits.maxPathBytes)
  assertMarkdownDocumentPathWithinLimit(document.relativePath, budget.limits.maxPathBytes)
  const retainedBytes = estimateMarkdownDocumentRetainedBytes(document)
  if (
    budget.documents >= budget.limits.maxDocuments ||
    budget.metadataBytes + retainedBytes > budget.limits.maxMetadataBytes
  ) {
    throw new MarkdownDocumentListingCapacityError()
  }
  budget.documents += 1
  budget.metadataBytes += retainedBytes
}

export function assertMarkdownDocumentsWithinLimit(
  documents: unknown,
  requested: Partial<MarkdownDocumentListingLimits> = {}
): number {
  const budget = createMarkdownDocumentListingBudget(requested)
  if (!Array.isArray(documents)) {
    throw new MarkdownDocumentListingCapacityError()
  }
  if (documents.length > budget.limits.maxDocuments) {
    throw new MarkdownDocumentListingCapacityError()
  }
  for (const document of documents) {
    retainMarkdownDocument(budget, document as MarkdownDocument)
  }
  return budget.metadataBytes
}

function clampLimit(value: number | undefined, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return maximum
  }
  return Math.min(value, maximum)
}
