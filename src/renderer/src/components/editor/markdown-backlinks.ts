import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import type { SearchOptions, SearchResult } from '../../../../shared/code-search-types'
import {
  createMarkdownDocumentIndex,
  parseMarkdownDocLink,
  resolveMarkdownDocLink,
  type MarkdownDocumentIndex
} from './markdown-doc-links'

export type MarkdownBacklink = {
  source: MarkdownDocument
  line: number
  lineContent: string
}

export const MARKDOWN_BACKLINK_SEARCH_MAX_RESULTS = 2000

const WIKI_LINK_PATTERN = /\[\[([^[\]\r\n]+)\]\]/g
// `[text](<path with spaces.md> "title")`, with any CommonMark title form.
const INLINE_LINK_PATTERN =
  /\]\(\s*(?:<([^>\r\n]+)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i

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

function normalizeSlashes(value: string): string {
  return value.replaceAll('\\', '/')
}

/** Resolves `./a/../b.md` against the linking note's folder, as Markdown renderers do. */
function resolveRelativeLinkPath(sourceRelativePath: string, href: string): string | null {
  let path = href.split(/[?#]/, 1)[0]
  if (!path || URL_SCHEME_PATTERN.test(path)) {
    return null
  }
  try {
    path = decodeURI(path)
  } catch {
    return null
  }
  const sourceDir = normalizeSlashes(sourceRelativePath).split('/').slice(0, -1)
  const segments = path.startsWith('/') ? [] : sourceDir
  for (const segment of normalizeSlashes(path).split('/')) {
    if (segment === '..') {
      if (segments.length === 0) {
        return null
      }
      segments.pop()
    } else if (segment && segment !== '.') {
      segments.push(segment)
    }
  }
  return segments.join('/')
}

function lineLinksTo(
  lineContent: string,
  source: MarkdownDocument,
  targetRelativePath: string,
  index: MarkdownDocumentIndex
): boolean {
  for (const match of lineContent.matchAll(WIKI_LINK_PATTERN)) {
    // Why: tables escape the alias pipe as `\|`.
    const parsed = parseMarkdownDocLink(match[1].replaceAll('\\|', '|'))
    const resolution = parsed ? resolveMarkdownDocLink(parsed.target, index) : null
    if (
      resolution?.status === 'resolved' &&
      normalizeSlashes(resolution.document.relativePath).toLowerCase() === targetRelativePath
    ) {
      return true
    }
  }
  for (const match of lineContent.matchAll(INLINE_LINK_PATTERN)) {
    // Why lowercase: wiki links already resolve case-insensitively, so both link forms agree.
    const linked = resolveRelativeLinkPath(source.relativePath, match[1] ?? match[2])
    if (linked?.toLowerCase() === targetRelativePath) {
      return true
    }
  }
  return false
}

/** Keeps only search hits whose `[[link]]` or `[text](path)` really resolves to `target`. */
export function collectMarkdownBacklinks(
  target: MarkdownDocument,
  documents: MarkdownDocument[],
  search: SearchResult
): MarkdownBacklink[] {
  const index = createMarkdownDocumentIndex(documents)
  const documentsByPath = new Map(
    documents.map((document) => [normalizeSlashes(document.filePath), document])
  )
  const targetRelativePath = normalizeSlashes(target.relativePath).toLowerCase()
  const backlinks: MarkdownBacklink[] = []
  for (const file of search.files) {
    const source = documentsByPath.get(normalizeSlashes(file.filePath))
    if (!source || normalizeSlashes(source.relativePath).toLowerCase() === targetRelativePath) {
      continue
    }
    const seenLines = new Set<number>()
    for (const match of file.matches) {
      if (
        !seenLines.has(match.line) &&
        lineLinksTo(match.lineContent, source, targetRelativePath, index)
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
