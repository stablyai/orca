import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import {
  createMarkdownDocumentIndex,
  parseMarkdownDocLink,
  resolveMarkdownDocLink
} from './markdown-doc-links'

const WIKI_LINK_PATTERN = /\[\[([^[\]\r\n]+)\]\]/g
// `[text](<path with spaces.md> "title")`, with any CommonMark title form.
const INLINE_LINK_PATTERN =
  /\]\(\s*(?:<([^>\r\n]+)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i

export function normalizeSlashes(value: string): string {
  return value.replaceAll('\\', '/')
}

/** Case-folded key; wiki links already resolve case-insensitively, so both link forms agree. */
export function markdownDocumentKey(document: MarkdownDocument): string {
  return normalizeSlashes(document.relativePath).toLowerCase()
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

export type MarkdownLinkResolver = {
  documentForFile: (filePath: string, relativePath?: string) => MarkdownDocument | undefined
  /** Notes that `[[link]]` or `[text](path)` links on one line of `source` point to. */
  linkTargets: (lineContent: string, source: MarkdownDocument) => MarkdownDocument[]
}

export function createMarkdownLinkResolver(documents: MarkdownDocument[]): MarkdownLinkResolver {
  const index = createMarkdownDocumentIndex(documents)
  const byFilePath = new Map(
    documents.map((document) => [normalizeSlashes(document.filePath), document])
  )
  const byKey = new Map(documents.map((document) => [markdownDocumentKey(document), document]))
  return {
    // Why the fallback: search returns canonical paths, which differ from the listing when the root is aliased.
    documentForFile: (filePath, relativePath) =>
      byFilePath.get(normalizeSlashes(filePath)) ??
      (relativePath ? byKey.get(normalizeSlashes(relativePath).toLowerCase()) : undefined),
    linkTargets: (lineContent, source) => {
      const targets: MarkdownDocument[] = []
      for (const match of lineContent.matchAll(WIKI_LINK_PATTERN)) {
        // Why: tables escape the alias pipe as `\|`.
        const parsed = parseMarkdownDocLink(match[1].replaceAll('\\|', '|'))
        const resolution = parsed ? resolveMarkdownDocLink(parsed.target, index) : null
        if (resolution?.status === 'resolved') {
          targets.push(resolution.document)
        }
      }
      for (const match of lineContent.matchAll(INLINE_LINK_PATTERN)) {
        const linked = resolveRelativeLinkPath(source.relativePath, match[1] ?? match[2])
        const document = linked ? byKey.get(linked.toLowerCase()) : undefined
        if (document) {
          targets.push(document)
        }
      }
      return targets
    }
  }
}
