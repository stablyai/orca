/* oxlint-disable max-lines -- Why: this is the single source of truth for
 * rg arg construction, rg --json parsing, git-grep submatch parsing, and
 * relative-path normalization, shared by both the local main process and
 * the SSH relay. The prior divergence between those two implementations
 * caused the maxBuffer footgun the design doc calls out; re-splitting the
 * file would re-introduce that failure mode. */
/**
 * Shared, pure text-search helpers used by both the local main process and the
 * SSH relay. No Electron, no child_process, no fs — the caller owns process
 * execution and transport-specific path translation (WSL).
 *
 * Why this module exists (design doc: docs/design/share-text-search.md):
 * Before extraction, the local (`src/main/ipc/filesystem.ts`,
 * `filesystem-search-git.ts`) and relay (`src/relay/fs-handler-utils.ts`,
 * `fs-handler-git-fallback.ts`) search implementations had diverged on
 * rg arg construction, rg --json parsing, the git-grep submatch regex,
 * relative-path normalization, and — most consequentially — the relay's
 * `execFile` + `maxBuffer: 50MB` footgun that silently dropped matches on
 * large repos. Centralizing the policy prevents future drift. Both call
 * sites must use this module; see filesystem.ts and relay/fs-handler.ts.
 */
import { join, relative } from 'path'
import type { SearchFileResult, SearchOptions, SearchResult } from './types'

export type SearchAccumulator = {
  fileMap: Map<string, SearchFileResult>
  totalMatches: number
  truncated: boolean
}

export function createAccumulator(): SearchAccumulator {
  return { fileMap: new Map(), totalMatches: 0, truncated: false }
}

// Why: collapse mixed separators and strip leading slashes so results are
// stable across Windows/Linux and never start with `/` (which would break
// `join(rootPath, relPath)` in callers).
export function normalizeRelativePath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/^\/+/, '')
}

// ─── Constants shared by both callers ────────────────────────────────

export const MAX_MATCHES_PER_FILE = 100
export const DEFAULT_SEARCH_MAX_RESULTS = 2000
export const SEARCH_TIMEOUT_MS = 15_000

// Why: the text-search path only reads files up to 5MB — this mirrors both
// the local MAX_FILE_SIZE and the relay's MAX_FILE_SIZE. Kept here so the rg
// `--max-filesize` flag stays in sync across callers.
const SEARCH_MAX_FILE_SIZE = 5 * 1024 * 1024

// Why: `lineContent` is carried per-match to the renderer. Minified bundles
// and generated files can have single lines in the megabytes; at 2000-match
// caps that serializes into frames that blow past the 16MB SSH relay
// `MAX_MESSAGE_SIZE`, producing "Message too large" errors on fs:search for
// large folders (and bloats local IPC unnecessarily). Clamping to a window
// around each match keeps the payload bounded while preserving enough
// context for the sidebar to render the highlight.
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
  // Clamp the match itself first so a pathological multi-MB regex hit
  // cannot defeat the windowing below.
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

// ─── rg ─────────────────────────────────────────────────────────────

export type SearchOptionsLike = Pick<
  SearchOptions,
  'caseSensitive' | 'wholeWord' | 'useRegex' | 'includePattern' | 'excludePattern'
>

/**
 * Build the rg argv used by both callers. The returned array is the COMPLETE
 * argv (flags + `--` + query + target); the caller spawns rg with it as-is.
 *
 * Both callers pass `rootPath` unchanged as `target` — do NOT translate the
 * target to a WSL-native path on the local side. On Windows/WSL, only the
 * rg *invocation* is routed through `wslAwareSpawn`; the target string keeps
 * its original shape, and rg's output paths are translated back to Windows
 * UNC via the `transformAbsPath` callback in `ingestRgJsonLine`.
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
    for (const pat of opts.includePattern
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      args.push('--glob', pat)
    }
  }
  if (opts.excludePattern) {
    for (const pat of opts.excludePattern
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      args.push('--glob', `!${pat}`)
    }
  }
  args.push('--', query, target)
  return args
}

/**
 * Ingest a single line of rg `--json` stdout. Mutates `acc`. Returns 'stop'
 * when `maxResults` is reached so the caller can kill the child; 'continue'
 * otherwise. `transformAbsPath` lets the local caller apply WSL translation
 * (parseWslPath + toWindowsWslPath); the relay passes no transform.
 *
 * Truncation ordering invariant (see design doc): this function sets
 * `acc.truncated = true` SYNCHRONOUSLY in the same tick it returns 'stop',
 * before any child-kill. Callers must NOT flip `truncated` in their own
 * code and must NOT resolve the promise before the 'stop'-return tick has
 * completed. Breaking that ordering re-introduces the silent-truncation
 * bug the relay had with execFile's maxBuffer overflow.
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
  const relPath = normalizeRelativePath(relative(rootPath, absPath))
  const lineContent = (data.lines?.text ?? '').replace(/\n$/, '')
  const lineNumber = data.line_number ?? 0
  const submatches = data.submatches ?? []

  let fileResult = acc.fileMap.get(absPath)
  if (!fileResult) {
    fileResult = { filePath: absPath, relativePath: relPath, matches: [] }
    acc.fileMap.set(absPath, fileResult)
  }

  for (const sub of submatches) {
    const clamped = clampLineContext(lineContent, sub.start, sub.end - sub.start)
    fileResult.matches.push({
      line: lineNumber,
      column: clamped.column,
      matchLength: clamped.matchLength,
      lineContent: clamped.lineContent,
      ...(clamped.displayColumn !== undefined ? { displayColumn: clamped.displayColumn } : {}),
      ...(clamped.displayMatchLength !== undefined
        ? { displayMatchLength: clamped.displayMatchLength }
        : {})
    })
    acc.totalMatches++
    if (acc.totalMatches >= maxResults) {
      acc.truncated = true
      return 'stop'
    }
  }
  return 'continue'
}

// ─── git grep ───────────────────────────────────────────────────────

// Why: esbuild's parser chokes on regex literals containing brace/bracket
// character classes, so we escape special chars with a simple loop.
const REGEX_SPECIAL = '.*+?^${}()|[]\\'
function escapeRegexSource(str: string): string {
  let out = ''
  for (let i = 0; i < str.length; i++) {
    out += REGEX_SPECIAL.includes(str[i]) ? `\\${str[i]}` : str[i]
  }
  return out
}

/**
 * Convert a user-facing glob pattern into a git pathspec.
 *
 * Why: rg globs like `*.ts` match at any directory depth, but a bare git
 * pathspec `*.ts` only matches in the repo root. Wrapping with `:(glob)` and
 * prepending `**\/` for patterns without a path separator replicates rg's
 * recursive-by-default behaviour.
 */
export function toGitGlobPathspec(glob: string, exclude?: boolean): string {
  const needsRecursive = !glob.includes('/')
  const pattern = needsRecursive ? `**/${glob}` : glob
  return exclude ? `:(exclude,glob)${pattern}` : `:(glob)${pattern}`
}

export function buildGitGrepArgs(query: string, opts: SearchOptionsLike): string[] {
  // Why: --untracked searches untracked (but not ignored) files in addition
  // to tracked ones, matching rg's default behaviour of respecting gitignore.
  // -I skips binary files; --null uses \0 as filename delimiter so filenames
  // with colons parse unambiguously. --no-recurse-submodules is needed because
  // users may have submodule.recurse=true in their git config, which conflicts
  // with --untracked and would cause git grep to fail.
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
    for (const pat of opts.includePattern
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      gitArgs.push(toGitGlobPathspec(pat))
      hasPathspecs = true
    }
  }
  if (opts.excludePattern) {
    for (const pat of opts.excludePattern
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      gitArgs.push(toGitGlobPathspec(pat, true))
      hasPathspecs = true
    }
  }
  // Why: when no include patterns are given, git grep needs a pathspec to
  // search the working tree. '.' means "everything under cwd".
  if (!hasPathspecs) {
    gitArgs.push('.')
  }
  return gitArgs
}

/**
 * Build the JS regex used to locate all submatch column positions within a
 * matched line. git grep only reports the first hit per line; we need this
 * to populate SearchMatch[] for every occurrence.
 *
 * Returns `null` when `useRegex` is true and the query is valid ERE for git
 * grep but not a valid JS `RegExp` (common mismatches: POSIX classes like
 * `[[:alpha:]]`, back-reference numbering differences, `\<` / `\>` word
 * anchors). Callers fall back to a whole-line highlight so git-reported
 * hits still appear in results instead of silently failing the request.
 */
export function buildSubmatchRegex(
  query: string,
  opts: { useRegex?: boolean; wholeWord?: boolean; caseSensitive?: boolean }
): RegExp | null {
  let pattern = opts.useRegex ? query : escapeRegexSource(query)
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

  // Why: with --null -n the output format is filename\0linenum:content.
  const nullIdx = line.indexOf('\0')
  if (nullIdx === -1) {
    return 'continue'
  }
  const relPath = normalizeRelativePath(line.substring(0, nullIdx))
  const rest = line.substring(nullIdx + 1)
  const colonIdx = rest.indexOf(':')
  if (colonIdx === -1) {
    return 'continue'
  }
  const lineNum = parseInt(rest.substring(0, colonIdx), 10)
  if (isNaN(lineNum)) {
    return 'continue'
  }
  const lineContent = rest.substring(colonIdx + 1).replace(/\n$/, '')

  const absPath = join(rootPath, relPath)
  let fileResult = acc.fileMap.get(absPath)
  if (!fileResult) {
    fileResult = { filePath: absPath, relativePath: relPath, matches: [] }
    acc.fileMap.set(absPath, fileResult)
  }

  // Why: git grep already confirmed the line matched — if we can't build a
  // JS-side regex to find exact submatch positions (e.g. user typed a POSIX
  // class that git accepts but JS RegExp rejects), fall back to a single
  // whole-line highlight so the result still shows up in the UI.
  if (submatchRegex === null) {
    const clamped = clampLineContext(lineContent, 0, lineContent.length)
    fileResult.matches.push({
      line: lineNum,
      column: clamped.column,
      matchLength: clamped.matchLength,
      lineContent: clamped.lineContent,
      ...(clamped.displayColumn !== undefined ? { displayColumn: clamped.displayColumn } : {}),
      ...(clamped.displayMatchLength !== undefined
        ? { displayMatchLength: clamped.displayMatchLength }
        : {})
    })
    acc.totalMatches++
    if (acc.totalMatches >= maxResults) {
      acc.truncated = true
      return 'stop'
    }
    return 'continue'
  }

  submatchRegex.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = submatchRegex.exec(lineContent)) !== null) {
    const clamped = clampLineContext(lineContent, m.index, m[0].length)
    fileResult.matches.push({
      line: lineNum,
      column: clamped.column,
      matchLength: clamped.matchLength,
      lineContent: clamped.lineContent,
      ...(clamped.displayColumn !== undefined ? { displayColumn: clamped.displayColumn } : {}),
      ...(clamped.displayMatchLength !== undefined
        ? { displayMatchLength: clamped.displayMatchLength }
        : {})
    })
    acc.totalMatches++
    if (acc.totalMatches >= maxResults) {
      acc.truncated = true
      return 'stop'
    }
    // Prevent infinite loop on zero-length regex matches.
    if (m[0].length === 0) {
      submatchRegex.lastIndex++
    }
  }
  return 'continue'
}

// ─── finalize ───────────────────────────────────────────────────────

export function finalize(acc: SearchAccumulator): SearchResult {
  return {
    files: Array.from(acc.fileMap.values()),
    totalMatches: acc.totalMatches,
    truncated: acc.truncated
  }
}
