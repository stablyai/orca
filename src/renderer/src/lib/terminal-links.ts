export type ParsedTerminalFileLink = {
  pathText: string
  line: number | null
  column: number | null
  startIndex: number
  endIndex: number
  displayText: string
}

export type ResolvedTerminalFileLink = {
  absolutePath: string
  line: number | null
  column: number | null
}

// Ported from VSCode's terminal link detectors (MIT).
//   Local paths:  src/vs/workbench/contrib/terminalContrib/links/browser/terminalLocalLinkDetector.ts
//   Bare words:   src/vs/workbench/contrib/terminalContrib/links/browser/terminalWordLinkDetector.ts
//
// Two passes, matching VSCode's split between `TerminalLocalLinkDetector`
// (paths with a separator, including line:col suffix) and
// `TerminalWordLinkDetector` (bare whitespace-delimited tokens that only
// become links if they resolve against the cwd). The provider runs fs.stat
// on every candidate, so the word-pass stays conservative to keep fan-out
// small.

// Matches a path with at least one `/` separator, optionally followed by
// `:line` and `:col` suffixes (e.g. `src/foo.ts:12:3`, `./bin`, `/abs/path`).
const LOCAL_PATH_REGEX = /(?:\/|\.{1,2}\/|[A-Za-z0-9._-]+\/)[A-Za-z0-9._~\-/]*(?::\d+)?(?::\d+)?/g

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

type NormalizedAbsolutePath = {
  normalized: string
  comparisonKey: string
  rootKind: 'posix' | 'windows' | 'unc'
}

function normalizeSegments(pathValue: string): string[] {
  const segments = pathValue.split(/[\\/]+/)
  const stack: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (stack.length > 0) {
        stack.pop()
      }
      continue
    }
    stack.push(segment)
  }

  return stack
}

function normalizeAbsolutePath(pathValue: string): NormalizedAbsolutePath | null {
  const windowsDriveMatch = /^([A-Za-z]):[\\/]*(.*)$/.exec(pathValue)
  if (windowsDriveMatch) {
    const driveLetter = windowsDriveMatch[1].toUpperCase()
    const suffix = normalizeSegments(windowsDriveMatch[2]).join('/')
    const normalized = suffix ? `${driveLetter}:/${suffix}` : `${driveLetter}:/`
    return {
      normalized,
      comparisonKey: normalized.toLowerCase(),
      rootKind: 'windows'
    }
  }

  const uncMatch = /^\\\\([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]*(.*))?$/.exec(pathValue)
  if (uncMatch) {
    const server = uncMatch[1]
    const share = uncMatch[2]
    const suffix = normalizeSegments(uncMatch[3] ?? '').join('/')
    const normalizedRoot = `//${server}/${share}`
    const normalized = suffix ? `${normalizedRoot}/${suffix}` : normalizedRoot
    return {
      normalized,
      comparisonKey: normalized.toLowerCase(),
      rootKind: 'unc'
    }
  }

  if (pathValue.startsWith('/')) {
    const normalized = `/${normalizeSegments(pathValue).join('/')}`.replace(/\/+$/, '') || '/'
    return {
      normalized,
      comparisonKey: normalized,
      rootKind: 'posix'
    }
  }

  return null
}

function joinAbsolutePath(basePath: string, relativePath: string): string | null {
  const normalizedBase = normalizeAbsolutePath(basePath)
  if (!normalizedBase) {
    return null
  }

  return normalizeJoinedPath(normalizedBase, relativePath)
}

function normalizeJoinedPath(basePath: NormalizedAbsolutePath, relativePath: string): string {
  const normalizedBaseSegments = normalizeSegments(basePath.normalized)
  const relativeSegments = normalizeSegments(relativePath)
  const joinedSegments = [...normalizedBaseSegments, ...relativeSegments]

  if (basePath.rootKind === 'unc') {
    const [server, share, ...rest] = joinedSegments
    return rest.length > 0 ? `//${server}/${share}/${rest.join('/')}` : `//${server}/${share}`
  }

  if (basePath.rootKind === 'windows') {
    const [drive, ...rest] = joinedSegments
    return rest.length > 0 ? `${drive}/${rest.join('/')}` : drive
  }

  return `/${joinedSegments.join('/')}`.replace(/\/+$/, '') || '/'
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

function isInsideUriScheme(lineText: string, range: DetectedRange): boolean {
  if (range.text.includes('://')) {
    return true
  }
  const prefix = lineText.slice(0, range.startIndex)
  return /[A-Za-z][A-Za-z0-9+.-]*:\/\/$/.test(prefix)
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

// Ported from VSCode's TerminalLocalLinkDetector. Extracts anything that
// contains a path separator, optionally with a `:line:col` suffix — covers
// `./src/foo.ts`, `/abs/bar`, `src/foo.ts:12:3`, etc.
function detectLocalPathLinks(lineText: string): ParsedTerminalFileLink[] {
  const links: ParsedTerminalFileLink[] = []
  for (const range of detectRanges(lineText, LOCAL_PATH_REGEX)) {
    if (isInsideUriScheme(lineText, range)) {
      continue
    }
    if (!range.text.includes('/')) {
      continue
    }
    const link = toParsedLink(range)
    if (link) {
      links.push(link)
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
    const overlaps = claimedRanges.some(
      ([start, end]) => range.startIndex < end && range.endIndex > start
    )
    if (overlaps) {
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
  const claimed = pathLinks.map(({ startIndex, endIndex }): [number, number] => [
    startIndex,
    endIndex
  ])
  const wordLinks = detectBareFilenameLinks(lineText, claimed)
  return [...pathLinks, ...wordLinks]
}

export function resolveTerminalFileLink(
  parsed: ParsedTerminalFileLink,
  cwd: string
): ResolvedTerminalFileLink | null {
  const absolutePath =
    normalizeAbsolutePath(parsed.pathText)?.normalized ?? joinAbsolutePath(cwd, parsed.pathText)
  if (!absolutePath) {
    return null
  }

  return {
    absolutePath,
    line: parsed.line,
    column: parsed.column
  }
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
