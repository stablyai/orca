/**
 * Shared, pure text-search helpers used by both the local main process and the
 * SSH relay. No Electron, child_process, or fs — the caller owns process
 * execution and transport-specific path translation (WSL).
 *
 * Centralizes rg/git-grep arg construction and parsing so the local and relay paths
 * can't re-diverge (notably the relay's old execFile maxBuffer that dropped matches).
 * Design doc: docs/design/share-text-search.md.
 */
import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'
import { normalizeSearchResult } from './search-match-count'
import { escapeRegex } from './string-utils'
import type { SearchFileResult, SearchOptions, SearchResult } from './code-search-types'
import { pushSearchMatch } from './text-search-match-accumulator'
import { splitSearchGlobPatterns, toGitGlobPathspec } from './text-search-glob-patterns'
import { joinSearchRoot, normalizeRelativePath, relativeToSearchRoot } from './text-search-paths'

export type SearchAccumulator = {
  fileMap: Map<string, SearchFileResult>
  totalMatches: number
  truncated: boolean
}

export function createAccumulator(): SearchAccumulator {
  return { fileMap: new Map(), totalMatches: 0, truncated: false }
}

// ─── Constants shared by both callers ────────────────────────────────

export const MAX_MATCHES_PER_FILE = 100
export const DEFAULT_SEARCH_MAX_RESULTS = 2000
export const SEARCH_TIMEOUT_MS = 15_000
export const SEARCH_JSON_STRUCTURE_LIMITS = {
  structuralTokens: 32 * 1024,
  nestingDepth: 16
} as const

// Why: keep search cheaper than opening a file; the editor read path has a larger cap (Monaco large-file handling).
const SEARCH_MAX_FILE_SIZE = 5 * 1024 * 1024

// Why: mega-byte lines (minified/generated files) × 2000-match caps blow past the 16MB SSH relay MAX_MESSAGE_SIZE; clamp each match's context.
export const MAX_LINE_CONTENT_LENGTH = 500

// ─── rg ─────────────────────────────────────────────────────────────

export type SearchOptionsLike = Pick<
  SearchOptions,
  'caseSensitive' | 'wholeWord' | 'useRegex' | 'includePattern' | 'excludePattern'
>

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
    assertJsonTextStructureWithinLimits(line, SEARCH_JSON_STRUCTURE_LIMITS)
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
    if (
      pushSearchMatch({
        fileResult,
        accumulator: acc,
        lineContent,
        matchStart: sub.start,
        matchLength: sub.end - sub.start,
        lineNumber,
        maxResults
      }) === 'stop'
    ) {
      return 'stop'
    }
  }
  return 'continue'
}

// ─── git grep ───────────────────────────────────────────────────────

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
  if (secondNullIdx !== -1) {
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
    const fileResult = getFileResult()
    return pushSearchMatch({
      fileResult,
      accumulator: acc,
      lineContent,
      matchStart: 0,
      matchLength: lineContent.length,
      lineNumber: lineNum,
      maxResults
    })
  }

  submatchRegex.lastIndex = 0
  let m: RegExpExecArray | null
  let acceptedLineMatch = false
  while ((m = submatchRegex.exec(lineContent)) !== null) {
    const fileResult = getFileResult()
    acceptedLineMatch = true
    if (
      pushSearchMatch({
        fileResult,
        accumulator: acc,
        lineContent,
        matchStart: m.index,
        matchLength: m[0].length,
        lineNumber: lineNum,
        maxResults
      }) === 'stop'
    ) {
      return 'stop'
    }
    // Prevent infinite loop on zero-length regex matches.
    if (m[0].length === 0) {
      submatchRegex.lastIndex++
    }
  }
  // Why: git grep confirmed the line but JS regex found no occurrence; keep it navigable, don't drop a git-confirmed hit.
  if (!acceptedLineMatch) {
    const fileResult = getFileResult()
    if (
      pushSearchMatch({
        fileResult,
        accumulator: acc,
        lineContent,
        matchStart: 0,
        matchLength: lineContent.length,
        lineNumber: lineNum,
        maxResults
      }) === 'stop'
    ) {
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
