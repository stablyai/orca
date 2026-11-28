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

export type MarkdownDocCompletionMatch = {
  readonly document: MarkdownDocument
  readonly filterText: string
}

type CompletionEntry = MarkdownDocCompletionMatch & {
  name: string
  relativePath: string
  composedName: string | null
  composedRelativePath: string | null
}

// Why: completion filtering runs per keystroke over up to 20k documents, so the normalized keys,
// Monaco filterText, and sort order are built once per listing instead of on every keystroke.
const completionEntriesByDocuments = new WeakMap<readonly MarkdownDocument[], CompletionEntry[]>()

function getCompletionEntries(documents: readonly MarkdownDocument[]): CompletionEntry[] {
  let entries = completionEntriesByDocuments.get(documents)
  if (!entries) {
    entries = documents
      .map((document) => {
        const name = normalizeCompletionText(document.name)
        const relativePath = normalizeCompletionText(document.relativePath)
        const composedName = composeQuickOpenText(name)
        const composedRelativePath = composeQuickOpenText(relativePath)
        const composedDisplayName = composeQuickOpenText(document.name)
        return {
          document,
          name,
          relativePath,
          composedName: composedName === name ? null : composedName,
          composedRelativePath: composedRelativePath === relativePath ? null : composedRelativePath,
          // Why: Monaco filters the typed text as is against filterText, cut at 128 characters.
          // The stored name goes first so every match the label alone had stays; the composed
          // name after it lets text typed composed (NFC) match a name stored decomposed (NFD).
          filterText:
            composedDisplayName === document.name
              ? document.name
              : `${document.name} ${composedDisplayName}`
        }
      })
      .sort((a, b) => a.document.relativePath.localeCompare(b.document.relativePath))
    completionEntriesByDocuments.set(documents, entries)
  }
  return entries
}

function matchesCompletionEntry(
  entry: CompletionEntry,
  normalizedPartial: string,
  composedPartial: string,
  hasComposedPartial: boolean
): boolean {
  if (
    entry.name.startsWith(normalizedPartial) ||
    entry.relativePath.startsWith(normalizedPartial)
  ) {
    return true
  }
  if (hasComposedPartial) {
    return (
      (entry.composedName ?? entry.name).startsWith(composedPartial) ||
      (entry.composedRelativePath ?? entry.relativePath).startsWith(composedPartial)
    )
  }
  return (
    (entry.composedName !== null && entry.composedName.startsWith(composedPartial)) ||
    (entry.composedRelativePath !== null && entry.composedRelativePath.startsWith(composedPartial))
  )
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

export function getMarkdownDocCompletionMatches(
  documents: readonly MarkdownDocument[],
  partial: string
): readonly MarkdownDocCompletionMatch[] {
  if (isMarkdownDocCompletionQueryTooLarge(partial)) {
    return []
  }

  const entries = getCompletionEntries(documents)
  const normalizedPartial = normalizeCompletionText(partial)
  if (normalizedPartial.length === 0) {
    return entries
  }

  // Why: macOS lists names as stored, often decomposed (NFD), while typed text is usually composed
  // (NFC). Compare as stored first so every earlier match stays, then compare both sides composed.
  const composedPartial = composeQuickOpenText(normalizedPartial)
  const hasComposedPartial = composedPartial !== normalizedPartial
  const matches: CompletionEntry[] = []
  for (const entry of entries) {
    if (matchesCompletionEntry(entry, normalizedPartial, composedPartial, hasComposedPartial)) {
      matches.push(entry)
    }
  }
  return matches
}

export function getMarkdownDocCompletionDocuments(
  documents: readonly MarkdownDocument[],
  partial: string
): MarkdownDocument[] {
  return getMarkdownDocCompletionMatches(documents, partial).map((entry) => entry.document)
}
