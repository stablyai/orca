import type { MarkdownDocument } from '../../../../shared/types'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'

export type MarkdownDocCompletionContext = {
  partial: string
}

export const MARKDOWN_DOC_COMPLETION_QUERY_MAX_BYTES = 2 * 1024

export function isMarkdownDocCompletionQueryTooLarge(
  query: string,
  maxBytes = MARKDOWN_DOC_COMPLETION_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

function normalizeCompletionText(value: string): string {
  return value.trim().replaceAll('\\', '/').toLowerCase()
}

export function getMarkdownDocCompletionContext(
  linePrefix: string
): MarkdownDocCompletionContext | null {
  const start = linePrefix.lastIndexOf('[[')
  if (start === -1) {
    return null
  }

  if (linePrefix.length - start - 2 > MARKDOWN_DOC_COMPLETION_QUERY_MAX_BYTES) {
    return null
  }

  const partial = linePrefix.slice(start + 2)
  if (isMarkdownDocCompletionQueryTooLarge(partial)) {
    return null
  }
  if (partial.includes('[') || partial.includes(']') || partial.includes('|')) {
    return null
  }

  return { partial }
}

export function getMarkdownDocCompletionDocuments(
  documents: MarkdownDocument[],
  partial: string
): MarkdownDocument[] {
  if (isMarkdownDocCompletionQueryTooLarge(partial)) {
    return []
  }

  const normalizedPartial = normalizeCompletionText(partial)
  return documents
    .filter((document) => {
      if (!normalizedPartial) {
        return true
      }
      return (
        normalizeCompletionText(document.name).startsWith(normalizedPartial) ||
        normalizeCompletionText(document.relativePath).startsWith(normalizedPartial)
      )
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}
