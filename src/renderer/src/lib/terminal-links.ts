/* eslint-disable max-lines -- Why: terminal link parsing depends on ordered passes sharing range state. */
import {
  joinAbsolutePath,
  normalizeAbsolutePath,
  resolveTildePath
} from './terminal-path-normalization'

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
const LOCAL_PATH_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[A-Za-z0-9._~\-/%+@\\]*(?::\d+)?(?::\d+)?/g

// Matches separator paths whose file or folder names include spaces. This runs
// before LOCAL_PATH_REGEX so `/Users/A/Foo Bar/file.ts` is claimed as one link
// instead of split into `/Users/A/Foo` and `Bar/file.ts`.
const SPACED_PATH_WITH_SEPARATOR_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])(?=[^()[\]{}'",;<>|`\r\n]*\s+[^()[\]{}'",;<>|`\r\n]*[\\/])[^()[\]{}'",;<>|`\r\n]+(?::\d+)?(?::\d+)?/g
const SPACED_PATH_WITH_EXTENSION_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|`\r\n]*?\s+[^()[\]{}'",;<>|`\\/ \r\n]*\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?/g
const LINE_ENDING_SPACED_PATH_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])(?=[^()[\]{}'",;<>|`\r\n]*\s+)[^()[\]{}'",;<>|`\r\n]*\S(?=\s*$)/g
const SPACED_LOCAL_PATH_REGEXES = [
  SPACED_PATH_WITH_SEPARATOR_REGEX,
  SPACED_PATH_WITH_EXTENSION_REGEX,
  LINE_ENDING_SPACED_PATH_REGEX
]

// Word separators used by the bare-filename pass. Mirrors the default set in
// VSCode's `terminal.integrated.wordSeparators` with the exception that we
// include `:` indirectly via the line:col suffix parser rather than as a
// raw separator. A word is any maximal run of non-separator characters.
// \s matches NBSP in modern JS; xterm powerline glyphs are in the PUA and
// never appear in filenames, so we don't list them explicitly.
const WORD_TOKEN_REGEX = /[^\s()[\]{}'",;<>|`]+/g

const LEADING_TRIM_CHARS = new Set(['(', '[', '{', '"', "'"])
const TRAILING_TRIM_CHARS = new Set([')', ']', '}', '"', "'", ',', ';', '.'])

function trimBoundaryPunctuation(
  value: string,
  startIndex: number
): { text: string; startIndex: number; endIndex: number } | null {
  let start = 0
  let end = value.length

  while (start < end && LEADING_TRIM_CHARS.has(value[start])) {
    start += 1
  }
  while (end > start && TRAILING_TRIM_CHARS.has(value[end - 1])) {
    end -= 1
  }

  if (start >= end) {
    return null
  }

  return {
    text: value.slice(start, end),
    startIndex: startIndex + start,
    endIndex: startIndex + end
  }
}

function parsePathWithOptionalLineColumn(value: string): {
  pathText: string
  line: number | null
  column: number | null
} | null {
  const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(value)
  if (!match) {
    return null
  }
  const pathText = match[1]
  if (!pathText || pathText.endsWith('/')) {
    return null
  }

  const line = match[2] ? Number.parseInt(match[2], 10) : null
  const column = match[3] ? Number.parseInt(match[3], 10) : null
  if ((line !== null && line < 1) || (column !== null && column < 1)) {
    return null
  }

  return { pathText, line, column }
}

// Project files that look like filenames despite having no extension. The
// word detector otherwise requires a `.` in the token to keep noise down —
// without this list, `ls` output containing `Makefile` or `LICENSE` would
// not be clickable.
const EXTENSIONLESS_FILENAMES = new Set([
  'Makefile',
  'Dockerfile',
  'Rakefile',
  'Gemfile',
  'Procfile',
  'LICENSE',
  'README',
  'CHANGELOG',
  'AUTHORS',
  'NOTICE',
  'CONTRIBUTING'
])

const BARE_FILENAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/
const URI_PREFIX_CHAR_PATTERN = /^[A-Za-z0-9+./:-]$/

// Bare words are validated against the filesystem by the provider, so this
// filter's job is to reject tokens that are obviously not filenames before
// we pay for a stat. Plain words like `src` or `my-cli` are usually
// directories or binaries and produce more noise than value — users who
// really want to open them can prefix with `./`.
function looksLikeFilename(token: string): boolean {
  if (token.length < 2 || token.length > 100) {
    return false
  }
  if (!BARE_FILENAME_PATTERN.test(token)) {
    return false
  }
  if (/^\d+$/.test(token)) {
    return false
  }
  if (token.includes('.')) {
    return !/^\.+$/.test(token)
  }
  return EXTENSIONLESS_FILENAMES.has(token)
}

type DetectedRange = { startIndex: number; endIndex: number; text: string }
// Shared tokenization: run a regex over the line, trim boundary punctuation,
// hand each surviving range to the caller. Collapses the three near-copies
// of this loop the module had grown.
function* detectRanges(lineText: string, regex: RegExp): Generator<DetectedRange> {
  for (const match of lineText.matchAll(regex)) {
    const rawStart = match.index ?? 0
    const trimmed = trimBoundaryPunctuation(match[0], rawStart)
    if (trimmed) {
      yield trimmed
    }
  }
}

function getImmediateUriPrefix(lineText: string, endIndex: number): string {
  let start = endIndex
  while (start > 0 && URI_PREFIX_CHAR_PATTERN.test(lineText[start - 1])) {
    start -= 1
  }
  return lineText.slice(start, endIndex)
}

function isInsideUriScheme(lineText: string, range: DetectedRange): boolean {
  const prefix = getImmediateUriPrefix(lineText, range.startIndex)
  // Why: local-path matching can start at the `//host/path` portion of a URL.
  return (
    range.text.includes('://') ||
    (/[A-Za-z][A-Za-z0-9+.-]*:(?:\/\/)?$/.test(prefix) &&
      (prefix.endsWith('://') || range.text.startsWith('//')))
  )
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  if (ranges.length <= 1) {
    return ranges
  }
  const sorted = ranges.slice().sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged: [number, number][] = []
  for (const range of sorted) {
    const last = merged.at(-1)
    if (!last || range[0] > last[1]) {
      merged.push([range[0], range[1]])
      continue
    }
    last[1] = Math.max(last[1], range[1])
  }
  return merged
}

function rangesOverlap(range: DetectedRange, claimedRanges: readonly [number, number][]): boolean {
  // Why: generated terminal lines can contain thousands of file-looking tokens;
  // overlap checks must stay logarithmic instead of scanning every prior range.
  let low = 0
  let high = claimedRanges.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (claimedRanges[mid][0] < range.endIndex) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  const previous = claimedRanges[low - 1]
  return previous !== undefined && previous[1] > range.startIndex
}

function insertClaimedRange(claimedRanges: [number, number][], range: [number, number]): void {
  const last = claimedRanges.at(-1)
  if (!last || last[0] <= range[0]) {
    claimedRanges.push(range)
    return
  }

  let low = 0
  let high = claimedRanges.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (claimedRanges[mid][0] <= range[0]) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  claimedRanges.splice(low, 0, range)
}

function trimSpacedPathTrailingProse(range: DetectedRange): DetectedRange {
  const filenameBeforeProseMatch = /^(.+\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?)(?:\s+.+)$/.exec(
    range.text
  )
  if (!filenameBeforeProseMatch) {
    return range
  }

  const text = filenameBeforeProseMatch[1]
  return {
    text,
    startIndex: range.startIndex,
    endIndex: range.startIndex + text.length
  }
}

function buildLineEndingSpacedPathPrefixRanges(range: DetectedRange): DetectedRange[] {
  const ranges: DetectedRange[] = []
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
  return ranges.reverse()
}

function toParsedLink(range: DetectedRange): ParsedTerminalFileLink | null {
  const parsed = parsePathWithOptionalLineColumn(range.text)
  if (!parsed) {
    return null
  }
  return {
    pathText: parsed.pathText,
    line: parsed.line,
    column: parsed.column,
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    displayText: range.text
  }
}

function sortLinksByPosition(links: ParsedTerminalFileLink[]): ParsedTerminalFileLink[] {
  return links.sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex)
}

// Ported from VSCode's TerminalLocalLinkDetector. Extracts anything that
// contains a path separator, optionally with a `:line:col` suffix — covers
// `./src/foo.ts`, `/abs/bar`, `src/foo.ts:12:3`, etc.
function detectLocalPathLinks(
  lineText: string,
  includeLineEndingPrefixCandidates = false
): ParsedTerminalFileLink[] {
  const links: ParsedTerminalFileLink[] = []
  const spacedLinks = detectSpacedLocalPathLinks(lineText, includeLineEndingPrefixCandidates)
  const spacedRanges = mergeRanges(
    spacedLinks.map(({ startIndex, endIndex }): [number, number] => [startIndex, endIndex])
  )
  for (const link of spacedLinks) {
    links.push(link)
  }
  for (const range of detectRanges(lineText, LOCAL_PATH_REGEX)) {
    if (rangesOverlap(range, spacedRanges)) {
      continue
    }
    if (isInsideUriScheme(lineText, range)) {
      continue
    }
    if (!/[\\/]/.test(range.text)) {
      continue
    }
    const link = toParsedLink(range)
    if (link) {
      links.push(link)
    }
  }
  return sortLinksByPosition(links)
}

function detectSpacedLocalPathLinks(
  lineText: string,
  includeLineEndingPrefixCandidates = false
): ParsedTerminalFileLink[] {
  const links: ParsedTerminalFileLink[] = []
  const claimedRanges: [number, number][] = []
  for (const regex of SPACED_LOCAL_PATH_REGEXES) {
    for (const range of detectRanges(lineText, regex)) {
      if (rangesOverlap(range, claimedRanges) || isInsideUriScheme(lineText, range)) {
        continue
      }
      const candidateRanges =
        includeLineEndingPrefixCandidates && regex === LINE_ENDING_SPACED_PATH_REGEX
          ? [range, ...buildLineEndingSpacedPathPrefixRanges(range)]
          : [range]
      const candidateLinks = candidateRanges
        .map((candidateRange) => toParsedLink(trimSpacedPathTrailingProse(candidateRange)))
        .filter((link): link is ParsedTerminalFileLink => link !== null)
      const link = candidateLinks[0]
      if (link) {
        for (const candidateLink of candidateLinks) {
          links.push(candidateLink)
        }
        insertClaimedRange(claimedRanges, [link.startIndex, link.endIndex])
      }
    }
  }
  return links
}

// Ported from VSCode's TerminalWordLinkDetector. Tokenizes the line on
// separators and emits filename-ish words so `ls` output becomes clickable.
// Skips ranges already claimed by the local-path pass to avoid double links
// when a bare filename happens to be a substring of a longer path.
function detectBareFilenameLinks(
  lineText: string,
  claimedRanges: readonly [number, number][]
): ParsedTerminalFileLink[] {
  const links: ParsedTerminalFileLink[] = []
  for (const range of detectRanges(lineText, WORD_TOKEN_REGEX)) {
    if (rangesOverlap(range, claimedRanges)) {
      continue
    }
    const link = toParsedLink(range)
    if (!link) {
      continue
    }
    if (!looksLikeFilename(link.pathText)) {
      continue
    }
    links.push(link)
  }
  return links
}

export function extractTerminalFileLinks(lineText: string): ParsedTerminalFileLink[] {
  const pathLinks = detectLocalPathLinks(lineText)
  const claimed = mergeRanges(
    pathLinks.map(({ startIndex, endIndex }): [number, number] => [startIndex, endIndex])
  )
  const wordLinks = detectBareFilenameLinks(lineText, claimed)
  for (const link of wordLinks) {
    pathLinks.push(link)
  }
  return pathLinks
}

export function extractTerminalFileLinkCandidates(lineText: string): ParsedTerminalFileLink[] {
  const pathLinks = detectLocalPathLinks(lineText, true)
  const claimed = mergeRanges(
    pathLinks.map(({ startIndex, endIndex }): [number, number] => [startIndex, endIndex])
  )
  const wordLinks = detectBareFilenameLinks(lineText, claimed)
  for (const link of wordLinks) {
    pathLinks.push(link)
  }
  return pathLinks
}

export function resolveTerminalFileLink(
  parsed: ParsedTerminalFileLink,
  cwd: string,
  homePath?: string | null
): ResolvedTerminalFileLink | null {
  const absolutePath = /^~[\\/]/.test(parsed.pathText)
    ? resolveTildePath(parsed.pathText, cwd, homePath)
    : (normalizeAbsolutePath(parsed.pathText)?.normalized ?? joinAbsolutePath(cwd, parsed.pathText))
  if (!absolutePath) {
    return null
  }

  return {
    absolutePath,
    line: parsed.line,
    column: parsed.column
  }
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
