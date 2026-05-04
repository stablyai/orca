import type { MarkdownDocument } from '../../../../shared/types'

export type MarkdownDocCompletionContext = {
  partial: string
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

  const partial = linePrefix.slice(start + 2)
  if (partial.includes('[') || partial.includes(']')) {
    return null
  }

  return { partial }
}

export function getMarkdownDocCompletionDocuments(
  documents: MarkdownDocument[],
  partial: string
): MarkdownDocument[] {
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
