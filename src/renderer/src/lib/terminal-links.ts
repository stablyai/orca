import { normalizeAbsolutePath } from './terminal-path-normalization'
import {
  parseExplicitFileLinkTarget,
  resolveExplicitFileLinkTarget
} from './explicit-file-link-target'
import { detectBareFilenameLinks } from './terminal-bare-file-link-detection'
import {
  mergeTerminalFileLinkRanges,
  toParsedTerminalFileLink,
  type DetectedTerminalFileLinkRange
} from './terminal-file-link-detection-ranges'
import {
  ROOTED_PATH_START_PATTERN,
  growSpacedPathRanges,
  trimTerminalPathBoundaryPunctuation
} from '../../../shared/terminal-spaced-path-candidates'
import { detectTerminalFileUriLinks } from './terminal-file-uri-link'
import { detectTerminalMarkdownFileLinks } from './terminal-markdown-file-links'

export type ParsedTerminalFileLink = {
  pathText: string
  line: number | null
  column: number | null
  startIndex: number
  endIndex: number
  displayText: string
}

export type ResolvedTerminalFileLink = Pick<ParsedTerminalFileLink, 'line' | 'column'> & {
  absolutePath: string
}

// Ported from VSCode's terminal link detectors (MIT): local paths from
// `terminalLocalLinkDetector.ts`, bare words from `terminalWordLinkDetector.ts`.
// Two passes match VSCode's split: separator paths, plus conservative bare
// filename tokens that only become links if they resolve against the cwd.

// Match separator paths with optional :line:col; preserve route punctuation (app/(shop)/[id]), Japanese middle dots and tildes without swallowing prose.
const LOCAL_PATH_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[\p{L}\p{N}\p{M}._-]+[\\/])[\p{L}\p{N}\p{M}._~\-/%+@\\()[\]\u30FB\uFF65\u301C\uFF5E]*(?::\d+)?(?::\d+)?/gu

const URI_PREFIX_CHAR_PATTERN = /^[A-Za-z0-9+./:-]$/

function hasPathSeparator(text: string): boolean {
  return text.includes('/') || text.includes('\\')
}

function getImmediateUriPrefix(lineText: string, endIndex: number): string {
  let start = endIndex
  while (start > 0 && URI_PREFIX_CHAR_PATTERN.test(lineText[start - 1])) {
    start -= 1
  }
  return lineText.slice(start, endIndex)
}

function isInsideUriScheme(lineText: string, range: DetectedTerminalFileLinkRange): boolean {
  const prefix = getImmediateUriPrefix(lineText, range.startIndex)
  // Why: local-path matching can start at the `//host/path` portion of a URL.
  return (
    range.text.includes('://') ||
    (/[A-Za-z][A-Za-z0-9+.-]*:(?:\/\/)?$/.test(prefix) &&
      (prefix.endsWith('://') || range.text.startsWith('//')))
  )
}

/** Separator paths plus their spaced extensions, ported from VS Code TerminalLocalLinkDetector. */
function detectLocalPathLinks(lineText: string): {
  links: ParsedTerminalFileLink[]
  pathRanges: [number, number][]
} {
  const links: ParsedTerminalFileLink[] = []
  const pathRanges: [number, number][] = []
  if (!hasPathSeparator(lineText)) {
    return { links, pathRanges }
  }
  for (const match of lineText.matchAll(LOCAL_PATH_REGEX)) {
    const rawStart = match.index ?? 0
    const range = trimTerminalPathBoundaryPunctuation(match[0], rawStart)
    if (!range || !hasPathSeparator(range.text) || isInsideUriScheme(lineText, range)) {
      continue
    }
    const link = toParsedTerminalFileLink(range)
    if (link) {
      links.push(link)
      pathRanges.push([link.startIndex, link.endIndex])
    }
    for (const spacedRange of growSpacedPathRanges(lineText, range, rawStart + match[0].length)) {
      const spacedLink = toParsedTerminalFileLink(spacedRange)
      if (spacedLink) {
        links.push(spacedLink)
      }
    }
  }
  return { links, pathRanges }
}

/** Every plausible reading, overlaps included; callers keep exact matches or the longest that exists. */
export function extractTerminalFileLinks(lineText: string): ParsedTerminalFileLink[] {
  const markdown = detectTerminalMarkdownFileLinks(lineText)
  const uriLinks = detectTerminalFileUriLinks(markdown.remainingText)
  const pathLinks = detectLocalPathLinks(markdown.remainingText)
  const explicitLinks = [...markdown.links, ...uriLinks, ...pathLinks.links]
  // Why only unspaced ranges: a spaced guess must not hide a bare filename inside the prose it spans.
  const claimed = mergeTerminalFileLinkRanges([
    ...[...markdown.links, ...uriLinks].map(({ startIndex, endIndex }): [number, number] => [
      startIndex,
      endIndex
    ]),
    ...pathLinks.pathRanges
  ])
  for (const link of detectBareFilenameLinks(markdown.remainingText, claimed)) {
    explicitLinks.push(link)
  }
  return explicitLinks.sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex)
}

export function resolveTerminalFileLink(
  parsed: ParsedTerminalFileLink,
  cwd: string,
  homePath?: string | null
): ResolvedTerminalFileLink | null {
  return resolveExplicitFileLinkTarget(parsed, cwd, homePath)
}

export function resolveTerminalFileLinkText(
  linkText: string,
  cwd: string,
  homePath?: string | null
): ResolvedTerminalFileLink | null {
  const links = extractTerminalFileLinks(linkText)
  const exactLink =
    links.find((link) => link.startIndex === 0 && link.endIndex === linkText.length) ??
    // Why: hyperlink text names its whole target, so a rooted path needs no detection (double spaces, long names).
    (ROOTED_PATH_START_PATTERN.test(linkText) ? parseExplicitFileLinkTarget(linkText) : null)
  return exactLink ? resolveExplicitFileLinkTarget(exactLink, cwd, homePath) : null
}

export function isPathInsideWorktree(filePath: string, worktreePath: string): boolean {
  const normalizedFile = normalizeAbsolutePath(filePath)
  const normalizedWorktree = normalizeAbsolutePath(worktreePath)
  if (
    !normalizedFile ||
    !normalizedWorktree ||
    normalizedFile.rootKind !== normalizedWorktree.rootKind
  ) {
    return false
  }
  if (normalizedFile.comparisonKey === normalizedWorktree.comparisonKey) {
    return true
  }
  return normalizedFile.comparisonKey.startsWith(`${normalizedWorktree.comparisonKey}/`)
}

export function toWorktreeRelativePath(filePath: string, worktreePath: string): string | null {
  const normalizedFile = normalizeAbsolutePath(filePath)
  const normalizedWorktree = normalizeAbsolutePath(worktreePath)
  if (
    !normalizedFile ||
    !normalizedWorktree ||
    normalizedFile.rootKind !== normalizedWorktree.rootKind
  ) {
    return null
  }
  if (normalizedFile.comparisonKey === normalizedWorktree.comparisonKey) {
    return ''
  }
  if (!normalizedFile.comparisonKey.startsWith(`${normalizedWorktree.comparisonKey}/`)) {
    return null
  }
  return normalizedFile.normalized.slice(normalizedWorktree.normalized.length + 1)
}
