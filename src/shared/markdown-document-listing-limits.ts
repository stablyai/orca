import type { MarkdownDocument } from './types'
import { measureUtf8ByteLength } from './utf8-byte-limits'

export const MARKDOWN_DOCUMENT_LISTING_MAX_DOCUMENTS = 20_000
export const MARKDOWN_DOCUMENT_LISTING_MAX_METADATA_BYTES = 8 * 1024 * 1024
export const MARKDOWN_DOCUMENT_LISTING_MAX_PATH_BYTES = 64 * 1024
export const MARKDOWN_DOCUMENT_LISTING_MAX_VISITED_ENTRIES = 100_000
export const MARKDOWN_DOCUMENT_LISTING_MAX_DEPTH = 256
export const MARKDOWN_DOCUMENT_LISTING_ERROR_CODE = 'markdown_document_listing_capacity'
export const MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE =
  'Workspace is too large for Markdown link completion.'

const MARKDOWN_DOCUMENT_RETAINED_OVERHEAD_BYTES = 256

export type MarkdownDocumentListingLimits = {
  maxDocuments: number
  maxMetadataBytes: number
  maxPathBytes: number
  maxVisitedEntries: number
  maxDepth: number
}

export type MarkdownDocumentListingBudget = {
  documents: number
  metadataBytes: number
  visitedEntries: number
  limits: MarkdownDocumentListingLimits
}

export class MarkdownDocumentListingCapacityError extends Error {
  readonly code = MARKDOWN_DOCUMENT_LISTING_ERROR_CODE

  constructor() {
    super(MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE)
    this.name = 'MarkdownDocumentListingCapacityError'
  }
}

export function isMarkdownDocumentListingCapacityError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return (
    ('code' in error &&
      (error as { code?: unknown }).code === MARKDOWN_DOCUMENT_LISTING_ERROR_CODE) ||
    error.message.includes(MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE)
  )
}

export function createMarkdownDocumentListingBudget(
  requested: Partial<MarkdownDocumentListingLimits> = {}
): MarkdownDocumentListingBudget {
  return {
    documents: 0,
    metadataBytes: 0,
    visitedEntries: 0,
    limits: {
      maxDocuments: clampLimit(requested.maxDocuments, MARKDOWN_DOCUMENT_LISTING_MAX_DOCUMENTS),
      maxMetadataBytes: clampLimit(
        requested.maxMetadataBytes,
        MARKDOWN_DOCUMENT_LISTING_MAX_METADATA_BYTES
      ),
      maxPathBytes: clampLimit(requested.maxPathBytes, MARKDOWN_DOCUMENT_LISTING_MAX_PATH_BYTES),
      maxVisitedEntries: clampLimit(
        requested.maxVisitedEntries,
        MARKDOWN_DOCUMENT_LISTING_MAX_VISITED_ENTRIES
      ),
      maxDepth: clampLimit(requested.maxDepth, MARKDOWN_DOCUMENT_LISTING_MAX_DEPTH)
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

export function visitMarkdownDocumentListingEntry(
  budget: MarkdownDocumentListingBudget,
  path: string,
  depth: number
): void {
  assertMarkdownDocumentPathWithinLimit(path, budget.limits.maxPathBytes)
  if (budget.visitedEntries >= budget.limits.maxVisitedEntries || depth > budget.limits.maxDepth) {
    throw new MarkdownDocumentListingCapacityError()
  }
  budget.visitedEntries += 1
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

export function retainMarkdownRelativePath(
  budget: MarkdownDocumentListingBudget,
  rootPath: string,
  relativePath: string
): void {
  const normalizedRoot = rootPath.replace(/[\\/]+$/, '')
  const normalizedRelativePath = relativePath.replaceAll('\\', '/')
  const basename = normalizedRelativePath.slice(normalizedRelativePath.lastIndexOf('/') + 1)
  const extensionIndex = basename.lastIndexOf('.')
  retainMarkdownDocument(budget, {
    filePath: `${normalizedRoot}/${normalizedRelativePath}`,
    relativePath: normalizedRelativePath,
    basename,
    name: extensionIndex > 0 ? basename.slice(0, extensionIndex) : basename
  })
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
