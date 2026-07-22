/* oxlint-disable max-lines -- Why: single source of truth for rg/git-grep arg
 * construction and --json/submatch parsing shared by main process and SSH relay;
 * re-splitting would re-introduce the maxBuffer divergence the design doc calls out. */
/**
 * Shared, pure text-search helpers used by both the local main process and the
 * SSH relay. No Electron, child_process, or fs — the caller owns process
 * execution and transport-specific path translation (WSL).
 *
 * Centralizes rg/git-grep arg construction and parsing so the local and relay paths
 * can't re-diverge (notably the relay's old execFile maxBuffer that dropped matches).
 * Design doc: docs/design/share-text-search.md.
 */
import { posix, win32 } from 'node:path'
import { normalizeSearchResult } from './search-match-count'
import { escapeRegex } from './string-utils'
import type { SearchFileResult, SearchMatch, SearchOptions, SearchResult } from './types'

export type SearchAccumulator = {
  fileMap: Map<string, SearchFileResult>
  totalMatches: number
  truncated: boolean
}

export function createAccumulator(): SearchAccumulator {
  return { fileMap: new Map(), totalMatches: 0, truncated: false }
}

function acceptMatch(fileResult: SearchFileResult): void {
  fileResult.matchCount = (fileResult.matchCount ?? 0) + 1
}

// Why: normalize separators and strip leading `/` so results are cross-platform stable and don't break callers' `join(rootPath, relPath)`.
export function normalizeRelativePath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/^\/+/, '')
}

function pathFlavor(rootPath: string): typeof posix | typeof win32 {
  if (/^[a-zA-Z]:[\\/]/.test(rootPath) || rootPath.startsWith('\\\\')) {
    return win32
  }
  return posix
}

function relativeToSearchRoot(rootPath: string, absPath: string): string {
  return pathFlavor(rootPath).relative(rootPath, absPath)
}

function joinSearchRoot(rootPath: string, relPath: string): string {
  return pathFlavor(rootPath).join(rootPath, relPath)
}

// ─── Constants shared by both callers ────────────────────────────────

export const MAX_MATCHES_PER_FILE = 100
export const DEFAULT_SEARCH_MAX_RESULTS = 2000
export const SEARCH_TIMEOUT_MS = 15_000

// Why: keep search cheaper than opening a file; the editor read path has a larger cap (Monaco large-file handling).
const SEARCH_MAX_FILE_SIZE = 5 * 1024 * 1024

// Why: mega-byte lines (minified/generated files) × 2000-match caps blow past the 16MB SSH relay MAX_MESSAGE_SIZE; clamp each match's context.
export const MAX_LINE_CONTENT_LENGTH = 500
const TRUNCATION_MARKER = '…'

function clampLineContext(
  text: string,
  matchStart: number,
  matchLength: number
): {
  lineContent: string
  column: number
  matchLength: number
  displayColumn?: number
  displayMatchLength?: number
} {
  if (text.length <= MAX_LINE_CONTENT_LENGTH) {
    return { lineContent: text, column: matchStart + 1, matchLength }
  }
  // Clamp the match first so a pathological multi-MB regex hit can't defeat the windowing below.
  const clampedMatchLength = Math.min(matchLength, MAX_LINE_CONTENT_LENGTH)
  const remaining = MAX_LINE_CONTENT_LENGTH - clampedMatchLength
  const leftBudget = Math.floor(remaining / 2)
  let windowStart = Math.max(0, matchStart - leftBudget)
  let windowEnd = Math.min(text.length, windowStart + MAX_LINE_CONTENT_LENGTH)
  windowStart = Math.max(0, windowEnd - MAX_LINE_CONTENT_LENGTH)

  let snippet = text.slice(windowStart, windowEnd)
  let column = matchStart - windowStart + 1
  if (windowStart > 0) {
    snippet = TRUNCATION_MARKER + snippet
    column += TRUNCATION_MARKER.length
  }
  if (windowEnd < text.length) {
    snippet = snippet + TRUNCATION_MARKER
  }
  return {
    lineContent: snippet,
    column: matchStart + 1,
    matchLength,
    displayColumn: column,
    displayMatchLength: clampedMatchLength
  }
}

// Why: shared by rg and git-grep to preserve the synchronous truncation ordering callers require.
function pushMatch(
  fileResult: SearchFileResult,
  acc: SearchAccumulator,
  clamped: ReturnType<typeof clampLineContext>,
  lineNumber: number,
  maxResults: number
): 'continue' | 'stop' {
  // Why: direct assignment avoids conditional-spread allocations on the per-match hot path.
  const match: SearchMatch = {
    line: lineNumber,
    column: clamped.column,
    matchLength: clamped.matchLength,
    lineContent: clamped.lineContent
  }
  if (clamped.displayColumn !== undefined) {
    match.displayColumn = clamped.displayColumn
  }
  if (clamped.displayMatchLength !== undefined) {
    match.displayMatchLength = clamped.displayMatchLength
  }
  fileResult.matches.push(match)
  acceptMatch(fileResult)
  acc.totalMatches++
  if (acc.totalMatches >= maxResults) {
    acc.truncated = true
    return 'stop'
  }
  return 'continue'
}

// ─── rg ─────────────────────────────────────────────────────────────

export type SearchOptionsLike = Pick<
  SearchOptions,
  'caseSensitive' | 'wholeWord' | 'useRegex' | 'includePattern' | 'excludePattern'
>

export function splitSearchGlobPatterns(patterns: string): string[] {
  const out: string[] = []
  let current = ''
  let escaping = false
  for (const ch of patterns) {
    if (escaping) {
      current += `\\${ch}`
      escaping = false
      continue
    }
    if (ch === '\\') {
      escaping = true
      continue
    }
    if (ch === ',') {
      const trimmed = current.trim()
      if (trimmed) {
        out.push(trimmed)
      }
      current = ''
      continue
    }
    current += ch
  }
  if (escaping) {
    current += '\\'
  }
  const trimmed = current.trim()
  if (trimmed) {
    out.push(trimmed)
  }
  return out
}

/**
 * Build the complete rg argv (flags + `--` + query + target) for both callers to spawn as-is.
 *
 * Constraint: pass `rootPath` unchanged as `target` — do NOT WSL-translate it; only the rg
 * invocation is routed through `wslAwareSpawn`, and output paths are translated back in `ingestRgJsonLine`.
 */
export function buildRgArgs(query: string, target: string, opts: SearchOptionsLike): string[] {
  const args: string[] = [
    '--json',
    '--hidden',
    '--glob',
    '!.git',
    '--max-count',
    String(MAX_MATCHES_PER_FILE),
    '--max-filesize',
    `${Math.floor(SEARCH_MAX_FILE_SIZE / 1024 / 1024)}M`
  ]
  if (!opts.caseSensitive) {
    args.push('--ignore-case')
  }
  if (opts.wholeWord) {
    args.push('--word-regexp')
  }
  if (!opts.useRegex) {
    args.push('--fixed-strings')
  }
  if (opts.includePattern) {
    for (const pat of splitSearchGlobPatterns(opts.includePattern)) {
      args.push('--glob', pat)
    }
  }
  if (opts.excludePattern) {
    for (const pat of splitSearchGlobPatterns(opts.excludePattern)) {
      args.push('--glob', `!${pat}`)
    }
  }
  args.push('--', query, target)
  return args
}

/**
 * Ingest a single line of rg `--json` stdout, mutating `acc`. Returns 'stop' when
 * `maxResults` is reached (so the caller can kill the child), else 'continue'.
 * `transformAbsPath` lets the local caller apply WSL translation; the relay passes none.
 *
 * Invariant: sets `acc.truncated = true` synchronously in the same tick it returns
 * 'stop'; callers must not flip `truncated` or resolve before that tick (see design doc).
 */
export function ingestRgJsonLine(
  line: string,
  rootPath: string,
  acc: SearchAccumulator,
  maxResults: number,
  transformAbsPath?: (p: string) => string
): 'continue' | 'stop' {
  if (acc.totalMatches >= maxResults) {
    return 'stop'
  }
  if (!line) {
    return 'continue'
  }
  let msg: {
    type?: string
    data?: {
      path?: { text?: string }
      submatches?: { start: number; end: number }[]
      line_number?: number
      lines?: { text?: string }
    }
  }
  try {
    msg = JSON.parse(line)
  } catch {
    return 'continue'
  }
  if (msg.type !== 'match' || !msg.data) {
    return 'continue'
  }
  const data = msg.data
  const rawPath = data.path?.text
  if (typeof rawPath !== 'string') {
    return 'continue'
  }
  const absPath = transformAbsPath ? transformAbsPath(rawPath) : rawPath
  const relPath = normalizeRelativePath(relativeToSearchRoot(rootPath, absPath))
  const lineContent = (data.lines?.text ?? '').replace(/\n$/, '')
  const lineNumber = data.line_number ?? 0
  let submatches = data.submatches ?? []
  if (submatches.length === 0) {
    // Why: some rg matches report a line but no submatch ranges; surface a navigable line-level result instead of a count-0 row.
    submatches = [{ start: 0, end: lineContent.length > 0 ? 1 : 0 }]
  }

  for (const sub of submatches) {
    let fileResult = acc.fileMap.get(absPath)
    if (!fileResult) {
      fileResult = { filePath: absPath, relativePath: relPath, matches: [], matchCount: 0 }
      acc.fileMap.set(absPath, fileResult)
    }
    const clamped = clampLineContext(lineContent, sub.start, sub.end - sub.start)
    if (pushMatch(fileResult, acc, clamped, lineNumber, maxResults) === 'stop') {
      return 'stop'
    }
  }
  return 'continue'
}

// ─── git grep ───────────────────────────────────────────────────────

/**
 * Convert a user-facing glob pattern into a git pathspec.
 *
 * Why: bare git pathspecs only match the repo root, so wrap with `:(glob)` and prepend `**\/` to replicate rg's recursive-by-default globbing.
 */
export function toGitGlobPathspec(glob: string, exclude?: boolean): string {
  const needsRecursive = !glob.includes('/')
  const pattern = needsRecursive ? `**/${glob}` : glob
  return exclude ? `:(exclude,glob)${pattern}` : `:(glob)${pattern}`
}

export function buildGitGrepArgs(query: string, opts: SearchOptionsLike): string[] {
  // Why: --no-recurse-submodules avoids failing when submodule.recurse=true conflicts with --untracked; --null disambiguates colon-containing filenames.
  const gitArgs: string[] = [
    '-c',
    'submodule.recurse=false',
    'grep',
    '-n',
    '-I',
    '--null',
    '--no-color',
    '--untracked',
    '--no-recurse-submodules'
  ]
  if (!opts.caseSensitive) {
    gitArgs.push('-i')
  }
  if (opts.wholeWord) {
    gitArgs.push('-w')
  }
  if (!opts.useRegex) {
    gitArgs.push('--fixed-strings')
  } else {
    gitArgs.push('--extended-regexp')
  }

  gitArgs.push('-e', query, '--')

  let hasPathspecs = false
  if (opts.includePattern) {
    for (const pat of splitSearchGlobPatterns(opts.includePattern)) {
      gitArgs.push(toGitGlobPathspec(pat))
      hasPathspecs = true
    }
  }
  if (opts.excludePattern) {
    for (const pat of splitSearchGlobPatterns(opts.excludePattern)) {
      gitArgs.push(toGitGlobPathspec(pat, true))
      hasPathspecs = true
    }
  }
  // Why: git grep needs a pathspec to search the working tree; '.' means everything under cwd.
  if (!hasPathspecs) {
    gitArgs.push('.')
  }
  return gitArgs
}

/**
 * Build the JS regex to locate all submatch column positions in a matched line
 * (git grep reports only the first hit per line).
 *
 * @returns `null` when the query is valid git-grep ERE but not a valid JS RegExp
 * (POSIX classes, back-ref numbering, `\<`/`\>` anchors); callers then fall back to a whole-line highlight.
 */
export function buildSubmatchRegex(
  query: string,
  opts: { useRegex?: boolean; wholeWord?: boolean; caseSensitive?: boolean }
): RegExp | null {
  let pattern = opts.useRegex ? query : escapeRegex(query)
  if (opts.wholeWord) {
    pattern = `\\b${pattern}\\b`
  }
  try {
    return new RegExp(pattern, `g${opts.caseSensitive ? '' : 'i'}`)
  } catch {
    return null
  }
}

export function ingestGitGrepLine(
  line: string,
  rootPath: string,
  submatchRegex: RegExp | null,
  acc: SearchAccumulator,
  maxResults: number
): 'continue' | 'stop' {
  if (acc.totalMatches >= maxResults) {
    return 'stop'
  }
  if (!line) {
    return 'continue'
  }

  // Why: modern git with --null -n emits filename\0linenum\0content; keep the colon parser too for hosts with older git output.
  const nullIdx = line.indexOf('\0')
  if (nullIdx === -1) {
    return 'continue'
  }
  const relPath = normalizeRelativePath(line.substring(0, nullIdx))
  const rest = line.substring(nullIdx + 1)
  const secondNullIdx = rest.indexOf('\0')
  let lineNumberText: string
  let lineContent: string
  if (secondNullIdx >= 0) {
    lineNumberText = rest.substring(0, secondNullIdx)
    lineContent = rest.substring(secondNullIdx + 1).replace(/\n$/, '')
  } else {
    const colonIdx = rest.indexOf(':')
    if (colonIdx === -1) {
      return 'continue'
    }
    lineNumberText = rest.substring(0, colonIdx)
    lineContent = rest.substring(colonIdx + 1).replace(/\n$/, '')
  }
  if (!/^\d+$/.test(lineNumberText)) {
    return 'continue'
  }
  const lineNum = Number(lineNumberText)

  const absPath = joinSearchRoot(rootPath, relPath)
  const getFileResult = (): SearchFileResult => {
    let fileResult = acc.fileMap.get(absPath)
    if (!fileResult) {
      fileResult = { filePath: absPath, relativePath: relPath, matches: [], matchCount: 0 }
      acc.fileMap.set(absPath, fileResult)
    }
    return fileResult
  }

  // Why: no JS-side submatch regex (git accepts patterns JS RegExp rejects); fall back to whole-line highlight so the hit still shows.
  if (submatchRegex === null) {
    const clamped = clampLineContext(lineContent, 0, lineContent.length)
    const fileResult = getFileResult()
    return pushMatch(fileResult, acc, clamped, lineNum, maxResults)
  }

  submatchRegex.lastIndex = 0
  let m: RegExpExecArray | null
  let acceptedLineMatch = false
  while ((m = submatchRegex.exec(lineContent)) !== null) {
    const clamped = clampLineContext(lineContent, m.index, m[0].length)
    const fileResult = getFileResult()
    acceptedLineMatch = true
    if (pushMatch(fileResult, acc, clamped, lineNum, maxResults) === 'stop') {
      return 'stop'
    }
    // Prevent infinite loop on zero-length regex matches.
    if (m[0].length === 0) {
      submatchRegex.lastIndex++
    }
  }
  // Why: git grep confirmed the line but JS regex found no occurrence; keep it navigable, don't drop a git-confirmed hit.
  if (!acceptedLineMatch) {
    const clamped = clampLineContext(lineContent, 0, lineContent.length)
    const fileResult = getFileResult()
    if (pushMatch(fileResult, acc, clamped, lineNum, maxResults) === 'stop') {
      return 'stop'
    }
  }
  return 'continue'
}

// ─── finalize ───────────────────────────────────────────────────────

export function finalize(acc: SearchAccumulator): SearchResult {
  return normalizeSearchResult({
    files: Array.from(acc.fileMap.values()).filter((file) => file.matches.length > 0),
    totalMatches: acc.totalMatches,
    truncated: acc.truncated
  })
}
