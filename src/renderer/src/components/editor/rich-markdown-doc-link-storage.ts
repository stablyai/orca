import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import { createMarkdownDocumentIndex, type MarkdownDocumentIndex } from './markdown-doc-links'

export type DocLinkStorage = {
  documents: MarkdownDocument[]
  _cachedDocs: MarkdownDocument[] | null
  _cachedIndex: MarkdownDocumentIndex | null
}

declare module '@tiptap/core' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Tiptap Storage requires declaration merging.
  interface Storage {
    markdownDocLink?: DocLinkStorage
  }
}

export function getDocIndex(storage: DocLinkStorage): MarkdownDocumentIndex | null {
  if (storage.documents.length === 0) {
    // Why: clear the cache so stale MarkdownDocument references aren't retained
    // after the document list empties (e.g., when switching worktrees).
    storage._cachedDocs = null
    storage._cachedIndex = null
    return null
  }
  if (storage._cachedDocs !== storage.documents) {
    storage._cachedIndex = createMarkdownDocumentIndex(storage.documents)
    storage._cachedDocs = storage.documents
  }
  return storage._cachedIndex
}
