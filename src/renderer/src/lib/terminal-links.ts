import { normalizeAbsolutePath } from './terminal-path-normalization'
import { resolveExplicitFileLinkTarget } from './explicit-file-link-target'
import { detectBareFilenameLinks } from './terminal-bare-file-link-detection'
import {
  detectTerminalFileLinkRanges,
  insertTerminalFileLinkClaimedRange,
  mergeTerminalFileLinkRanges,
  terminalFileLinkRangesOverlap,
  toParsedTerminalFileLink,
  type DetectedTerminalFileLinkRange
} from './terminal-file-link-detection-ranges'
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

// Claim spaced paths before ordinary paths to avoid splitting /Users/A/Foo Bar/file.ts. Broad linear scans avoid overlapping-whitespace backtracking on ConPTY dashboards; filter candidates in code.
const SPACED_PATH_WITH_SEPARATOR_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|`\r\n]+(?::\d+)?(?::\d+)?/g
// Why this shares the broad candidate shape: extension paths with prose after
// them still need trimming, but the whitespace/extension test stays in code.
const SPACED_PATH_WITH_EXTENSION_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|`\r\n]+(?::\d+)?(?::\d+)?/g
// Why this is also broad: the candidates path runs on hover, including huge
// space-padded TUI lines, so reject line-ending spaced paths outside the regex.
const LINE_ENDING_SPACED_PATH_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|`\r\n]+(?::\d+)?(?::\d+)?/g
const SPACED_LOCAL_PATH_REGEXES = [
  SPACED_PATH_WITH_SEPARATOR_REGEX,
  SPACED_PATH_WITH_EXTENSION_REGEX,
  LINE_ENDING_SPACED_PATH_REGEX
]

const URI_PREFIX_CHAR_PATTERN = /^[A-Za-z0-9+./:-]$/

function hasPathSeparator(text: string): boolean {
  return text.includes('/') || text.includes('\\')
}

function hasSeparatorAfterWhitespace(text: string): boolean {
  let sawWhitespace = false
  for (const char of text) {
    if (/\s/.test(char)) {
      sawWhitespace = true
      continue
    }
    if (sawWhitespace && (char === '/' || char === '\\')) {
      return true
    }
  }
  return false
}

function hasInternalWhitespaceBeforeTrimmedEnd(text: string): boolean {
  const trimmed = text.trimEnd()
  return /\s/.test(trimmed)
}

function isAtTrimmedLineEnd(lineText: string, endIndex: number): boolean {
  return lineText.slice(endIndex).trim().length === 0
}

function hasSpacedPathExtension(text: string): boolean {
  const trimmedRange = trimSpacedPathTrailingProse({
    text,
    startIndex: 0,
    endIndex: text.length
  })
  const trimmedText = trimmedRange.text.trimEnd()
  return /\s/.test(trimmedText) && /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?$/.test(trimmedText)
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

function trimSpacedPathTrailingProse(
  range: DetectedTerminalFileLinkRange
): DetectedTerminalFileLinkRange {
  // Trim prose/unrelated paths after extension-terminated candidates. Extend only path-like added segments (v1.2 reports/result.json), never prose such as failed to start app.py.
  let selected: string | null = null
  const extensionPrefixPattern = /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?(?=\s+|$)/g
  const pathStartPattern = /(?:^|\s)(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/g
  let pathStartCount = 0
  let nextPathStart = pathStartPattern.exec(range.text)
  let match: RegExpExecArray | null
  while ((match = extensionPrefixPattern.exec(range.text)) !== null) {
    const end = match.index + match[0].length
    const text = range.text.slice(0, end)
    while (nextPathStart && nextPathStart.index + nextPathStart[0].length <= end) {
      pathStartCount += 1
      nextPathStart = pathStartPattern.exec(range.text)
    }
    if (pathStartCount > 1) {
      continue
    }
    if (
      end < range.text.length ||
      selected === null ||
      /[\\/]/.test(range.text.slice(selected.length, end))
    ) {
      selected = text
    }
  }
  if (!selected) {
    return range
  }
  return {
    text: selected,
    startIndex: range.startIndex,
    endIndex: range.startIndex + selected.length
  }
}

function trimTrailingWhitespace(
  range: DetectedTerminalFileLinkRange
): DetectedTerminalFileLinkRange {
  const text = range.text.trimEnd()
  return {
    text,
    startIndex: range.startIndex,
    endIndex: range.startIndex + text.length
  }
}

function buildLineEndingSpacedPathPrefixRanges(
  range: DetectedTerminalFileLinkRange
): DetectedTerminalFileLinkRange[] {
  const ranges: DetectedTerminalFileLinkRange[] = []
  for (const match of range.text.matchAll(/\s+/g)) {
    const endIndex = match.index ?? 0
    const text = range.text.slice(0, endIndex).trimEnd()
    if (text.includes(' ')) {
      ranges.push({
        text,
        startIndex: range.startIndex,
        endIndex: range.startIndex + text.length
      })
    }
  }
  return ranges.toReversed()
}

/** Detect separator paths with optional :line:col, ported from VS Code TerminalLocalLinkDetector. */
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

function detectSpacedLocalPathLinks(
  lineText: string,
  includeLineEndingPrefixCandidates = false
): ParsedTerminalFileLink[] {
  const links: ParsedTerminalFileLink[] = []
  const claimedRanges: [number, number][] = []
  for (const regex of SPACED_LOCAL_PATH_REGEXES) {
    for (const range of detectTerminalFileLinkRanges(lineText, regex)) {
      if (regex === SPACED_PATH_WITH_SEPARATOR_REGEX && !hasSeparatorAfterWhitespace(range.text)) {
        continue
      }
      if (regex === SPACED_PATH_WITH_EXTENSION_REGEX && !hasSpacedPathExtension(range.text)) {
        continue
      }
      if (
        regex === LINE_ENDING_SPACED_PATH_REGEX &&
        (!hasInternalWhitespaceBeforeTrimmedEnd(range.text) ||
          !isAtTrimmedLineEnd(lineText, range.endIndex))
      ) {
        continue
      }
      if (
        terminalFileLinkRangesOverlap(range, claimedRanges) ||
        isInsideUriScheme(lineText, range)
      ) {
        continue
      }
      const candidateRanges =
        includeLineEndingPrefixCandidates && regex === LINE_ENDING_SPACED_PATH_REGEX
          ? [range, ...buildLineEndingSpacedPathPrefixRanges(range)]
          : [range]
      const candidateLinks = candidateRanges
        .map((candidateRange) =>
          toParsedTerminalFileLink(
            trimSpacedPathTrailingProse(trimTrailingWhitespace(candidateRange))
          )
        )
        .filter((link): link is ParsedTerminalFileLink => link !== null)
      const link = candidateLinks[0]
      if (link) {
        for (const candidateLink of candidateLinks) {
          links.push(candidateLink)
        }
        insertTerminalFileLinkClaimedRange(claimedRanges, [link.startIndex, link.endIndex])
      }
    }
  }
  return links
}

/** Claim Markdown destinations/file URIs/paths before bare filenames so longer explicit links keep their ranges. */
function assembleFileLinks(
  lineText: string,
  includeLineEndingPrefixCandidates: boolean
): ParsedTerminalFileLink[] {
  const markdown = detectTerminalMarkdownFileLinks(lineText)
  const uriLinks = detectTerminalFileUriLinks(markdown.remainingText)
  const pathLinks = detectLocalPathLinks(markdown.remainingText, includeLineEndingPrefixCandidates)
  const explicitLinks = [...markdown.links, ...uriLinks, ...pathLinks]
  const claimed = mergeTerminalFileLinkRanges(
    explicitLinks.map(({ startIndex, endIndex }): [number, number] => [startIndex, endIndex])
  )
  for (const link of detectBareFilenameLinks(markdown.remainingText, claimed)) {
    explicitLinks.push(link)
  }
  return explicitLinks.sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex)
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
