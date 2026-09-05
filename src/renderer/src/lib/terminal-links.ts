import { normalizeAbsolutePath } from './terminal-path-normalization'
import { resolveExplicitFileLinkTarget } from './explicit-file-link-target'
import { detectBareFilenameLinks } from './terminal-bare-file-link-detection'
import {
  detectTerminalFileLinkRanges,
  mergeTerminalFileLinkRanges,
  terminalFileLinkRangesOverlap,
  toParsedTerminalFileLink
} from './terminal-file-link-detection-ranges'
import { detectTerminalFileUriLinks } from './terminal-file-uri-link'
import { detectSpacedLocalPathLinks } from './terminal-spaced-path-link-detection'
import { isInsideUriScheme } from './terminal-uri-scheme-boundary'

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

// Matches a path with at least one `/` separator, optionally followed by
// `:line` and `:col` suffixes (e.g. `src/foo.ts:12:3`, `./bin`, `/abs/path`).
// Why: framework route files commonly use punctuation segments like
// `app/(shop)/products/[id]/page.tsx`; keep those links whole.
const LOCAL_PATH_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[\p{L}\p{N}\p{M}._-]+[\\/])[\p{L}\p{N}\p{M}._~\-/%+@\\()[\]]*(?::\d+)?(?::\d+)?/gu

function hasPathSeparator(text: string): boolean {
  return text.includes('/') || text.includes('\\')
}

// Ported from VSCode's TerminalLocalLinkDetector. Extracts anything that
// contains a path separator, optionally with a `:line:col` suffix — covers
// `./src/foo.ts`, `/abs/bar`, `src/foo.ts:12:3`, etc.
function detectLocalPathLinks(
  lineText: string,
  includeLineEndingPrefixCandidates = false
): ParsedTerminalFileLink[] {
  if (!hasPathSeparator(lineText)) {
    return []
  }

  const links: ParsedTerminalFileLink[] = []
  const spacedLinks = detectSpacedLocalPathLinks(lineText, includeLineEndingPrefixCandidates)
  const spacedRanges = mergeTerminalFileLinkRanges(
    spacedLinks.map(({ startIndex, endIndex }): [number, number] => [startIndex, endIndex])
  )
  for (const link of spacedLinks) {
    links.push(link)
  }
  for (const range of detectTerminalFileLinkRanges(lineText, LOCAL_PATH_REGEX)) {
    if (terminalFileLinkRangesOverlap(range, spacedRanges)) {
      continue
    }
    if (isInsideUriScheme(lineText, range)) {
      continue
    }
    if (!/[\\/]/.test(range.text)) {
      continue
    }
    const link = toParsedTerminalFileLink(range)
    if (link) {
      links.push(link)
    }
  }
  return links.sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex)
}

// Runs the file-uri, local-path, and bare-filename passes in that precedence.
// `file://` and separator paths claim their ranges first so the bare-filename
// pass never re-links a token already covered by a longer explicit link.
function assembleFileLinks(
  lineText: string,
  includeLineEndingPrefixCandidates: boolean
): ParsedTerminalFileLink[] {
  const uriLinks = detectTerminalFileUriLinks(lineText)
  const pathLinks = detectLocalPathLinks(lineText, includeLineEndingPrefixCandidates)
  const explicitLinks = uriLinks.length > 0 ? [...uriLinks, ...pathLinks] : pathLinks
  const claimed = mergeTerminalFileLinkRanges(
    explicitLinks.map(({ startIndex, endIndex }): [number, number] => [startIndex, endIndex])
  )
  const wordLinks = detectBareFilenameLinks(lineText, claimed)
  for (const link of wordLinks) {
    explicitLinks.push(link)
  }
  return explicitLinks
}

export function extractTerminalFileLinks(lineText: string): ParsedTerminalFileLink[] {
  return assembleFileLinks(lineText, false)
}

export function extractTerminalFileLinkCandidates(lineText: string): ParsedTerminalFileLink[] {
  return assembleFileLinks(lineText, true)
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
  const exactLink = links.find((link) => link.startIndex === 0 && link.endIndex === linkText.length)
  return exactLink ? resolveTerminalFileLink(exactLink, cwd, homePath) : null
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
