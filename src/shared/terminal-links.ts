import { normalizeAbsolutePath } from './terminal-path-normalization'
import { resolveExplicitFileLinkTarget } from './explicit-file-link-target'
import { detectBareFilenameLinks } from './terminal-bare-file-link-detection'
import {
  hasPathSeparator,
  mergeTerminalFileLinkRanges,
  toParsedTerminalFileLink,
  trimTerminalPathBoundaryPunctuation,
  type DetectedTerminalFileLinkRange
} from './terminal-file-link-detection-ranges'
import { growSpacedPathRanges } from './terminal-spaced-path-candidates'
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
  paths: ParsedTerminalFileLink[]
  spacedPaths: ParsedTerminalFileLink[]
} {
  const paths: ParsedTerminalFileLink[] = []
  const spacedPaths: ParsedTerminalFileLink[] = []
  if (!hasPathSeparator(lineText)) {
    return { paths, spacedPaths }
  }
  let grownWordEndIndex = 0
  for (const match of lineText.matchAll(LOCAL_PATH_REGEX)) {
    const rawStart = match.index ?? 0
    const range = trimTerminalPathBoundaryPunctuation(match[0], rawStart)
    if (!range || !hasPathSeparator(range.text) || isInsideUriScheme(lineText, range)) {
      continue
    }
    const link = toParsedTerminalFileLink(range)
    if (link) {
      paths.push(link)
    }
    // Why: a path inside an earlier path's word (`a!b/c`) shares its growth; regrowing would rescan the word.
    if (rawStart < grownWordEndIndex) {
      continue
    }
    const grown = growSpacedPathRanges(lineText, range, rawStart + match[0].length)
    grownWordEndIndex = grown.wordEndIndex
    for (const spacedRange of grown.ranges) {
      const spacedLink = toParsedTerminalFileLink(spacedRange)
      if (spacedLink) {
        spacedPaths.push(spacedLink)
      }
    }
  }
  return { paths, spacedPaths }
}

export type TerminalFileLinkReadings = {
  /** Paths as written: markdown destinations, file URIs, unspaced paths, bare filenames. */
  links: ParsedTerminalFileLink[]
  /** A path continued across the following words; act on one only after the host finds it exists. */
  guesses: ParsedTerminalFileLink[]
}

export function extractTerminalFileLinkReadings(lineText: string): TerminalFileLinkReadings {
  const markdown = detectTerminalMarkdownFileLinks(lineText)
  const uriLinks = detectTerminalFileUriLinks(markdown.remainingText)
  const { paths, spacedPaths } = detectLocalPathLinks(markdown.remainingText)
  const claimingLinks = [...markdown.links, ...uriLinks, ...paths]
  const claimed = mergeTerminalFileLinkRanges(
    claimingLinks.map(({ startIndex, endIndex }): [number, number] => [startIndex, endIndex])
  )
  return {
    links: [...claimingLinks, ...detectBareFilenameLinks(markdown.remainingText, claimed)].sort(
      byStart
    ),
    guesses: spacedPaths
  }
}

export function extractTerminalFileLinks(lineText: string): ParsedTerminalFileLink[] {
  return extractTerminalFileLinkReadings(lineText).links
}

function byStart(a: ParsedTerminalFileLink, b: ParsedTerminalFileLink): number {
  return a.startIndex - b.startIndex || b.endIndex - a.endIndex
}

export function resolveTerminalFileLink(
  parsed: ParsedTerminalFileLink,
  cwd: string,
  homePath?: string | null
): ResolvedTerminalFileLink | null {
  return resolveExplicitFileLinkTarget(parsed, cwd, homePath)
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
