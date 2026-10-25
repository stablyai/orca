import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import type { SearchOptions, SearchResult } from '../../../../shared/code-search-types'
import { createMarkdownLinkResolver, markdownDocumentKey } from './markdown-link-resolver'

export type MarkdownBacklink = {
  source: MarkdownDocument
  line: number
  lineContent: string
}

export const MARKDOWN_BACKLINK_SEARCH_MAX_RESULTS = 2000

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Every link to a note contains its name, plain or URL-encoded, so one search finds all candidate lines. */
export function markdownBacklinkSearchOptions(
  target: MarkdownDocument,
  rootPath: string
): SearchOptions {
  const encoded = encodeURI(target.name)
  return {
    query:
      encoded === target.name
        ? escapeRegExp(target.name)
        : `${escapeRegExp(target.name)}|${escapeRegExp(encoded)}`,
    rootPath,
    caseSensitive: false,
    useRegex: true,
    includePattern: '*.md,*.mdx,*.markdown',
    maxResults: MARKDOWN_BACKLINK_SEARCH_MAX_RESULTS
  }
}

/** Keeps only search hits whose `[[link]]` or `[text](path)` really resolves to `target`. */
export function collectMarkdownBacklinks(
  target: MarkdownDocument,
  documents: MarkdownDocument[],
  search: SearchResult
): MarkdownBacklink[] {
  const resolver = createMarkdownLinkResolver(documents)
  const targetKey = markdownDocumentKey(target)
  const backlinks: MarkdownBacklink[] = []
  for (const file of search.files) {
    const source = resolver.documentForFile(file.filePath, file.relativePath)
    if (!source || markdownDocumentKey(source) === targetKey) {
      continue
    }
    const seenLines = new Set<number>()
    for (const match of file.matches) {
      if (
        !seenLines.has(match.line) &&
        resolver
          .linkTargets(match.lineContent, source)
          .some((linked) => markdownDocumentKey(linked) === targetKey)
      ) {
        seenLines.add(match.line)
        backlinks.push({ source, line: match.line, lineContent: match.lineContent.trim() })
      }
    }
  }
  return backlinks.sort(
    (a, b) => a.source.relativePath.localeCompare(b.source.relativePath) || a.line - b.line
  )
}
