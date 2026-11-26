import type { MarkdownDocument } from '../../../../../../shared/file-listing/file-document'
import {
  getMarkdownDocumentIndex,
  type MarkdownDocumentIndex
} from '../../markdown/documents/markdown-doc-links'

export type DocLinkStorage = {
  documents: MarkdownDocument[]
}

declare module '@tiptap/core' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Tiptap Storage requires declaration merging.
  interface Storage {
    markdownDocLink?: DocLinkStorage
  }
}

export function getDocIndex(storage: DocLinkStorage): MarkdownDocumentIndex | null {
  if (storage.documents.length === 0) {
    return null
  }
  return getMarkdownDocumentIndex(storage.documents)
}
