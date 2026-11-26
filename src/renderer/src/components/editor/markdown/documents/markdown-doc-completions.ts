import type { MarkdownDocument } from '../../../../../../shared/file-listing/file-document'
import { isClipboardTextByteLengthOverLimit } from '../../../../../../shared/clipboard/clipboard-text'
import { composeQuickOpenText } from '../../../../../../shared/quick-open/quick-open-path-search'

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

type CompletionEntry = {
  document: MarkdownDocument
  name: string
  relativePath: string
  composedName: string
  composedRelativePath: string
}

// Why: completion filtering runs per keystroke over up to 20k documents, so the normalized keys and
// sort order are built once per listing instead of on every keystroke.
const completionEntriesByDocuments = new WeakMap<readonly MarkdownDocument[], CompletionEntry[]>()

function getCompletionEntries(documents: readonly MarkdownDocument[]): CompletionEntry[] {
  let entries = completionEntriesByDocuments.get(documents)
  if (!entries) {
    entries = documents
      .map((document) => {
        const name = normalizeCompletionText(document.name)
        const relativePath = normalizeCompletionText(document.relativePath)
        return {
          document,
          name,
          relativePath,
          composedName: composeQuickOpenText(name),
          composedRelativePath: composeQuickOpenText(relativePath)
        }
      })
      .sort((a, b) => a.document.relativePath.localeCompare(b.document.relativePath))
    completionEntriesByDocuments.set(documents, entries)
  }
  return entries
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
  // Why: macOS lists names as stored, often decomposed (NFD), while typed text is usually composed
  // (NFC). Compare as stored first so every earlier match stays, then compare both sides composed.
  const composedPartial = composeQuickOpenText(normalizedPartial)
  const matches: MarkdownDocument[] = []
  for (const entry of getCompletionEntries(documents)) {
    if (
      entry.name.startsWith(normalizedPartial) ||
      entry.relativePath.startsWith(normalizedPartial) ||
      entry.composedName.startsWith(composedPartial) ||
      entry.composedRelativePath.startsWith(composedPartial)
    ) {
      matches.push(entry.document)
    }
  }
  return matches
}
